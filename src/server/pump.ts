import { findPerson, loadOrg } from "../domain/org.ts";
import { loadEmployee } from "../domain/employee.ts";
import { bossNamesFor, readBossName } from "../domain/config.ts";
import type { McpSessionResolver } from "../domain/mcp.ts";
import type { Workspace } from "../domain/paths.ts";
import type { ChatMessage, HarnessEvent, HarnessPort } from "../harness/port.ts";
import { KeyedQueue, triggerFromMeetingReply } from "../app/send.ts";
import { Outbox } from "../app/outbox.ts";
import { accessFor, type SessionDefaults } from "../app/conversations.ts";
import { participantIds, subjectOf } from "../app/meetings.ts";
import { toMeetingMessage } from "../app/meeting-messages.ts";
import { parseAgentReply } from "../app/message-row.ts";
import { looksDegenerate } from "../app/loop-guard.ts";
import type { MeetingKind, MeetingStore } from "../store/meetings.ts";
import type { MessageStore } from "../store/messages.ts";
import type { SessionStore } from "../store/sessions.ts";
import type { StoredMessage } from "../store/row.ts";
import type { SseHub } from "./sse.ts";

export type MeetingRef = {
  meetingId: string;
  memberId: string;
  /** 会议类型（dm / group）：决定展示层是否重建头部 @。register 时按会议表带回。 */
  kind: MeetingKind;
  /** 人级展示名（register 时按 org 解析；缺省 = id）。 */
  alias?: string;
};

type Deps = {
  ws: Workspace;
  harness: HarnessPort;
  hub: SseHub;
  /** 与 HTTP 发送共享的 per-key 队列：同成员的老板消息与 @触发按顺序进入。缺省自建。 */
  queue?: KeyedQueue;
  /** 与 HTTP 端点共享的待发表：输入「出队」时据此广播 meeting.dequeued。缺省自建。 */
  outbox?: Outbox;
  /** 触发投递时的会话默认模型（缺省 = 员工自配/无兜底）。 */
  getDefaults?: () => SessionDefaults | undefined;
  /** 群回复触发新会话时的 MCP 扩展选择。 */
  mcp?: McpSessionResolver;
  /** 自有消息库：agent 回复（run 结束）恰落一行。必填：全进程唯一实例由 main.ts 创建并注入。 */
  store: MessageStore;
  /** 会议表：订阅时反查 relation / kind，广播带 meetingId。 */
  meetings: MeetingStore;
  /** 会话表（唯一真相）：重启扫描 / 解析会议成员都靠它。 */
  sessions: SessionStore;
};

/** in-flight 注册的占位：promise 供并发复用；state.cancelled 标记 in-flight 期间的 unregister。 */
type Pending = { promise: Promise<void>; state: { cancelled: boolean } };

/** 订阅活跃会话的归一化事件并广播。 */
export class Pump {
  #refs = new Map<string, () => Promise<void>>();
  /** 同一 convId 的并发 register 复用同一 in-flight 占用，防双订阅/重复广播（delta 无去重字段，重影可感）。 */
  #pending = new Map<string, Pending>();
  /** 正在跑（run start → end）的会话；只服务于「运行中」展示，不参与调度。 */
  #running = new Set<string>();
  /** 流式文本尾部（按 conv × channel），用于识别模型重复循环；run 起止时清。 */
  #textTail = new Map<string, string>();
  /** 已因重复循环中止的会话：后续 delta / 最终 message 一律丢弃，等下个 run start 解除。 */
  #loopAborted = new Set<string>();
  readonly #deps: Deps;
  readonly #queue: KeyedQueue;
  readonly #outbox: Outbox;
  readonly #getDefaults: () => SessionDefaults | undefined;

  // 不用参数属性：Node 的 strip-only TS 模式（npm start = node src/server/main.ts）不支持。
  constructor(deps: Deps) {
    this.#deps = deps;
    this.#queue = deps.queue ?? new KeyedQueue();
    this.#outbox = deps.outbox ?? new Outbox();
    this.#getDefaults = deps.getDefaults ?? (() => undefined);
  }

  async register(convId: string, ref: { meetingId: string; memberId: string }): Promise<void> {
    if (this.#refs.has(convId)) return;
    const meeting = this.#deps.meetings.get(ref.meetingId);
    if (meeting === undefined) throw new Error(`会议不存在：${ref.meetingId}`);
    // 订阅时补登记「这条会话属于谁、在哪场会议、能用什么权限」：
    // 重启后 pump 只订阅不重配会话，但工具层（`sessionInfo`）与访问控制钩子（access）都靠这份登记；
    // 只补身份不补 access 的表现是员工每个工具调用都被「访问控制：未注册的会话」拦下。
    const relation = subjectOf(meeting);
    const speaker = loadEmployee(this.#deps.ws, ref.memberId);
    this.#deps.harness.bindSession(convId, {
      selfId: ref.memberId,
      relation,
      meetingId: meeting.meetingId,
      access: accessFor(this.#deps.ws, relation, speaker),
    });
    const inFlight = this.#pending.get(convId);
    if (inFlight !== undefined) return inFlight.promise;
    // 内部展示名改走 org（人 = 文件后 alias 由人级配置决定）；随订阅带上，回调侧不必再扫盘。
    const alias = findPerson(loadOrg(this.#deps.ws), ref.memberId)?.alias;
    const fullRef: MeetingRef = { meetingId: meeting.meetingId, memberId: ref.memberId, kind: meeting.kind, ...(alias === undefined ? {} : { alias }) };
    const state = { cancelled: false };
    const task = (async () => {
      const unsubscribe = await this.#deps.harness.watch(convId, (event) => this.#onEvent(convId, fullRef, event));
      // in-flight 期间被 unregister：立即退订，不写入 #refs（不留"幽灵订阅"）。
      if (state.cancelled) {
        await unsubscribe();
        return;
      }
      this.#refs.set(convId, unsubscribe);
    })();
    const pending: Pending = { promise: task, state };
    this.#pending.set(convId, pending);
    try {
      await task;
    } finally {
      if (this.#pending.get(convId) === pending) this.#pending.delete(convId);
    }
  }

  /** 该会话当前是否在跑（run start 到 end 之间）。 */
  isRunning(convId: string): boolean {
    return this.#running.has(convId);
  }

  async unregister(convId: string): Promise<void> {
    this.#running.delete(convId);
    const pending = this.#pending.get(convId);
    if (pending !== undefined) {
      // 清占位 + 标记取消：in-flight 的 watch 建立后自退订；之后的新 register 会重新建立订阅。
      pending.state.cancelled = true;
      this.#pending.delete(convId);
    }
    const unsubscribe = this.#refs.get(convId);
    if (unsubscribe === undefined) return;
    this.#refs.delete(convId);
    await unsubscribe();
  }

  /** 启动/重启后扫描全部活跃会话并订阅；单个会话失败只记日志，不锁死启动。 */
  async registerAll(): Promise<void> {
    // 一条查询拿全（会话表 + 会议表是唯一真相）：会议已结束的 conv 不再订阅。
    for (const session of this.#deps.sessions.listAll()) {
      await this.#registerSafe(session.convId, { meetingId: session.meetingId, memberId: session.memberId });
    }
  }

  /** 坏链/缺失会话不应锁死启动：单个订阅失败记日志后继续。 */
  async #registerSafe(convId: string, ref: { meetingId: string; memberId: string }): Promise<void> {
    try {
      await this.register(convId, ref);
    } catch (error) {
      console.error(`[openstaffs] 会话订阅失败（convId=${convId}，meetingId=${ref.meetingId}）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 流式重复循环护栏：累积文本尾部，命中判定就中止本轮并广播失败；
   * 返回 false = 本条 delta 起不再往外播（避免继续把垃圾推到 UI）。
   */
  #guardDelta(convId: string, ref: MeetingRef, channel: "text" | "thinking", delta: string): boolean {
    if (this.#loopAborted.has(convId)) return false;
    const key = `${convId}:${channel}`;
    const next = (this.#textTail.get(key) ?? "") + delta;
    // 只留尾部 8000 字：足够识别重复，又不会把长上下文堆在内存里。
    const tail = next.length > 8000 ? next.slice(-8000) : next;
    this.#textTail.set(key, tail);
    if (!looksDegenerate(tail)) return true;
    this.#loopAborted.add(convId);
    console.warn(`[openstaffs] 模型输出疑似重复循环（convId=${convId}，${channel}），已中止本轮`);
    this.#deps.hub.broadcast({
      type: "meeting.failed", meetingId: ref.meetingId, convId, memberId: ref.memberId,
      message: "模型输出异常（疑似重复循环），已中止本轮；请重试或换个说法。", kind: "model",
    });
    void this.#deps.harness.abort(convId).catch(() => undefined);
    return false;
  }

  /**
   * 游戏规则：本回调绝不抛错。
   * Pi 的 watch 机制下 listener 抛错会被静默终结订阅（无 onReport、无日志），
   * 表现为"连接还在但再无事件"——因此整个事件处理包 try/catch 自保。
   */
  #onEvent(convId: string, ref: MeetingRef, event: HarnessEvent): void {
    try {
      const hub = this.#deps.hub;
      switch (event.type) {
        case "delta": {
          if (!this.#guardDelta(convId, ref, event.channel, event.delta)) return;
          hub.broadcast({ type: "meeting.delta", meetingId: ref.meetingId, convId, memberId: ref.memberId, channel: event.channel, delta: event.delta });
          return;
        }
        case "message": {
          const bossNames = bossNamesFor(this.#deps.ws);
          const bossName = readBossName(this.#deps.ws);
          const meeting = this.#deps.meetings.get(ref.meetingId);
          const memberIds = meeting === undefined ? [] : participantIds(this.#deps.ws, subjectOf(meeting));
          if (event.message.role === "assistant") {
            // 工具代写的「己方发言」（send_message boss/member：append 落盘为 assistant 形态 + kind=chat.message）：
            // 由写路径自己落库 + 广播库行（R-P1-12「谁写谁广播」）；这里再落一次会同句两行 / 两气泡 → 只做 @触发。
            if (event.message.kind === "chat.message") {
              void this.#triggerFromReply(convId, ref, event.message);
              return;
            }
            // 重复循环的残句：流式阶段已中止 / 或只在最终消息才暴露 → 一律不落库、不触发 @。
            if (this.#loopAborted.has(convId) || looksDegenerate(event.message.text)) {
              if (!this.#loopAborted.has(convId)) {
                this.#loopAborted.add(convId);
                console.warn(`[openstaffs] 模型输出疑似重复循环（convId=${convId}），已丢弃本条`);
                hub.broadcast({
                  type: "meeting.failed", meetingId: ref.meetingId, convId, memberId: ref.memberId,
                  message: "模型输出异常（疑似重复循环），本条已丢弃；请重试或换个说法。", kind: "model",
                });
              }
              return;
            }
            const reply = parseAgentReply(event.message.text, memberIds, bossNames);
            // 空正文（含「只有 @ 没正文」）不落行；群聊一次 @ 多人仍 1 行（toIds 数组）。
            if (reply.text !== "") {
              // 落库单独自保：写库失败只记日志——不连坐本该照常的 meeting.message 广播与群内 @触发。
              let stored: StoredMessage | undefined;
              try {
                stored = this.#deps.store.append({
                  sendTime: new Date().toISOString(),
                  meetingId: ref.meetingId,
                  fromId: ref.memberId,
                  toIds: reply.toIds,
                  text: reply.text,
                });
              } catch (error) {
                console.error(`[openstaffs] 消息落库失败（${ref.meetingId}/${ref.memberId}）：${error instanceof Error ? error.message : String(error)}`);
              }
              // 广播该库行（键 store:<seq>）——与 GET 会议视图 / pins 同源（否则 SSE 与历史两套键会重复、pin 失配）。
              if (stored !== undefined) {
                hub.broadcast({ type: "meeting.message", meetingId: ref.meetingId, message: toMeetingMessage(stored, ref.kind, bossName, this.#deps.ws) });
              }
              // 群回复开头的 @触发其他成员（老板消息在发送时已路由；转发副本 kind=chat.mention 不在此列）。
              void this.#triggerFromReply(convId, ref, event.message);
            }
            return;
          }
          // v.s. R-P1-12：user 条目（含 pi.user）一律不再广播——那是对别处已落库 / 已广播发言的回显；
          // 老板侧气泡与工具代写的己方发言由各自写路径（HTTP / permission-flow / send_message）广播库行。
          return;
        }
        case "run":
        case "tool":
        case "toolCall":
          if (event.type === "run") {
            if (event.phase === "start") {
              this.#running.add(convId);
              // 新一轮：清掉上一轮的重复检测状态（上一轮的残句已经在 message 阶段被丢弃）
              this.#textTail.delete(`${convId}:text`);
              this.#textTail.delete(`${convId}:thinking`);
              this.#loopAborted.delete(convId);
            } else {
              this.#running.delete(convId);
              this.#textTail.delete(`${convId}:text`);
              this.#textTail.delete(`${convId}:thinking`);
            }
          }
          hub.broadcast({
            type: "meeting.activity", meetingId: ref.meetingId, convId, memberId: ref.memberId,
            kind: event.type, phase: event.type === "toolCall" ? "start" : event.phase,
            ...(event.type === "tool" ? { name: event.name, ...(event.hint === undefined ? {} : { hint: event.hint }) } : {}),
            ...(event.type === "toolCall" ? { name: event.name } : {}),
          });
          return;
        case "failed":
          hub.broadcast({ type: "meeting.failed", meetingId: ref.meetingId, convId, memberId: ref.memberId, message: event.message, kind: event.kind });
          return;
        // 输入的受理状态变化：只关心「从待发表出队」——投递开始（placed/done）或撤回、中断（unanswered）。
        case "submission": {
          if (event.status === "queued") return;
          const item = this.#outbox.take(event.id);
          if (item === undefined) return;
          hub.broadcast({
            type: "meeting.dequeued",
            meetingId: item.meetingId,
            submissionId: item.submissionId,
            reason: event.status === "unanswered" ? "aborted" : "delivered",
          });
          return;
        }
      }
    } catch {
      // 事件处理失败绝不能外抛（见上：抛错会被 Pi 静默终结订阅）；广播失败不影响会话运行。
    }
  }

  /** 群回复的 @前缀触发：把回复投递给本会议内被 @ 到的成员，并订阅新触发的会话；失败只记日志。 */
  async #triggerFromReply(convId: string, ref: MeetingRef, message: ChatMessage): Promise<void> {
    try {
      if (ref.kind !== "group") return;
      const meeting = this.#deps.meetings.get(ref.meetingId);
      if (meeting === undefined) return;
      const defaults = this.#getDefaults();
      const reports = await triggerFromMeetingReply(this.#deps.ws, this.#deps.harness, {
        queue: this.#queue,
        sessions: this.#deps.sessions,
        ...(defaults === undefined ? {} : { defaults }),
        ...(this.#deps.mcp === undefined ? {} : { mcp: this.#deps.mcp }),
        meeting,
        senderId: ref.memberId,
        convId,
        entryId: message.id,
        text: message.text,
      });
      for (const report of reports) {
        try {
          await this.register(report.convId, { meetingId: meeting.meetingId, memberId: report.memberId });
        } catch {
          // 订阅失败不影响投递（重启扫描兜底）
        }
      }
    } catch (error) {
      console.error(`[openstaffs] 群回复触发失败（${ref.meetingId}/${ref.memberId}）：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
