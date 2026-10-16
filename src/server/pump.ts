import { loadEmployee, listEmployees } from "../domain/employee.ts";
import { listProjects } from "../domain/project.ts";
import type { Workspace } from "../domain/paths.ts";
import type { HarnessEvent, HarnessPort } from "../harness/port.ts";
import { activeMemberSessions, roomTranscripts } from "../app/conversations.ts";
import { countUnread, mergeRoomMessages, normalizeChatMessage, parseRoomKey, type MemberTranscript } from "../app/rooms.ts";
import { readSeen } from "../app/unread.ts";
import type { SseHub } from "./sse.ts";

export type RoomRef = { roomKey: string; memberId: string; alias?: string };

type Deps = { ws: Workspace; harness: HarnessPort; hub: SseHub };

/** in-flight 注册的占位：promise 供并发复用；state.cancelled 标记 in-flight 期间的 unregister。 */
type Pending = { promise: Promise<void>; state: { cancelled: boolean } };

/** 订阅活跃会话的归一化事件并广播；员工发言后重算未读。 */
export class Pump {
  #refs = new Map<string, () => Promise<void>>();
  /** 同一 convId 的并发 register 复用同一 in-flight 占用，防双订阅/重复广播（delta 无去重字段，重影可感）。 */
  #pending = new Map<string, Pending>();
  readonly #deps: Deps;

  // 不用参数属性：Node 的 strip-only TS 模式（npm start = node src/server/main.ts）不支持，会在加载时抛 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
  constructor(deps: Deps) {
    this.#deps = deps;
  }

  async register(convId: string, ref: { roomKey: string; memberId: string }): Promise<void> {
    if (this.#refs.has(convId)) return;
    const inFlight = this.#pending.get(convId);
    if (inFlight !== undefined) return inFlight.promise;
    let alias: string | undefined;
    try {
      alias = loadEmployee(this.#deps.ws, ref.memberId).alias;
    } catch {
      alias = undefined;
    }
    const fullRef: RoomRef = { ...ref, ...(alias === undefined ? {} : { alias }) };
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

  async unregister(convId: string): Promise<void> {
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
    const ws = this.#deps.ws;
    for (const employee of listEmployees(ws)) {
      for (const session of activeMemberSessions(ws, { kind: "dm", employeeId: employee.id })) {
        await this.#registerSafe(session.convId, { roomKey: `dm:${employee.id}`, memberId: employee.id });
      }
    }
    for (const project of listProjects(ws)) {
      for (const session of activeMemberSessions(ws, { kind: "group", project: project.id })) {
        await this.#registerSafe(session.convId, { roomKey: `group:${project.id}`, memberId: session.memberId });
      }
    }
  }

  /** 坏链/缺失会话不应锁死启动：单个订阅失败记日志后继续。 */
  async #registerSafe(convId: string, ref: { roomKey: string; memberId: string }): Promise<void> {
    try {
      await this.register(convId, ref);
    } catch (error) {
      console.error(`[openstaffs] 会话订阅失败（convId=${convId}，roomKey=${ref.roomKey}）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 游戏规则：本回调绝不抛错。
   * Pi 的 watch 机制下 listener 抛错会被静默终结订阅（无 onReport、无日志），
   * 表现为"连接还在但再无事件"——因此整个事件处理包 try/catch 自保。
   */
  #onEvent(convId: string, ref: RoomRef, event: HarnessEvent): void {
    try {
      const hub = this.#deps.hub;
      switch (event.type) {
        case "delta":
          hub.broadcast({ type: "room.delta", roomKey: ref.roomKey, convId, memberId: ref.memberId, channel: event.channel, delta: event.delta });
          return;
        case "message": {
          const member: MemberTranscript = { memberId: ref.memberId, ...(ref.alias === undefined ? {} : { alias: ref.alias }), convId, messages: [] };
          const message = normalizeChatMessage(ref.roomKey, member, event.message);
          if (message === undefined) return;
          hub.broadcast({ type: "room.message", roomKey: ref.roomKey, message });
          if (message.speaker.kind === "employee") void this.#pushUnread(ref.roomKey);
          return;
        }
        case "run":
        case "tool":
          hub.broadcast({
            type: "room.activity", roomKey: ref.roomKey, convId, memberId: ref.memberId,
            kind: event.type, phase: event.phase,
            ...(event.type === "tool" ? { name: event.name } : {}),
          });
          return;
        case "failed":
          // kind：失败类别（如 model/tool），原样透传给前端（暂不消费）。
          hub.broadcast({ type: "room.failed", roomKey: ref.roomKey, convId, memberId: ref.memberId, message: event.message, kind: event.kind });
          return;
      }
    } catch {
      // 事件处理失败绝不能外抛（见上：抛错会被 Pi 静默终结订阅）；广播失败不影响会话运行。
    }
  }

  async #pushUnread(roomKey: string): Promise<void> {
    try {
      const relation = parseRoomKey(roomKey);
      if (relation === undefined) return;
      const members = await roomTranscripts(this.#deps.ws, this.#deps.harness, relation);
      const messages = mergeRoomMessages(roomKey, members);
      const seen = readSeen(this.#deps.ws);
      this.#deps.hub.broadcast({ type: "room.unread", roomKey, count: countUnread(messages, seen.seen[roomKey]) });
    } catch {
      // 未读重算失败不影响推流
    }
  }
}
