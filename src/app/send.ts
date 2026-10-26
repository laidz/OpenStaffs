import { randomUUID } from "node:crypto";
import { parseMembers } from "../domain/access-control.ts";
import { bossNamesFor } from "../domain/config.ts";
import type { McpSessionResolver } from "../domain/mcp.ts";
import { personDisplayName } from "../domain/org.ts";
import type { Workspace } from "../domain/paths.ts";
import type { HarnessPort, InputMeta, SubmissionStatus } from "../harness/port.ts";
import type { MessageStore } from "../store/messages.ts";
import { BOSS_PARTICIPANT, type StoredMessage } from "../store/row.ts";
import { openDm, openGroup, newSession, relationKey, type Relation, type SessionDefaults } from "./conversations.ts";
import { parseAgentReply, stripLeadingMentions } from "./message-row.ts";
import { nameNewSession, type SessionTitleDeps } from "./sessions.ts";
import { hasBodyAfterPrefix, planRouting } from "./routing.ts";

/** per-key 串行队列：同 key 串行（FIFO）、异 key 并行；前序失败不连坐后续。 */
export class KeyedQueue {
  #tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#tails.get(key) ?? Promise.resolve();
    const result = prev.catch(() => undefined).then(fn);
    this.#tails.set(
      key,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }
}

/** 群没有成员（项目 config 的 members 为空）时拒绝发送。 */
export class EmptyGroupError extends Error {}

/** 群聊消息没有 @ 到任何成员时拒绝发送（不再广播）。 */
export class NoTargetsError extends Error {}

/** 房间键（与 store / SSE 同口径）：私聊 `dm:<id>`、群聊 `group:<项目>`（不含成员）。 */
function roomKeyOf(relation: Relation): string {
  return relation.kind === "dm" ? `dm:${relation.employeeId}` : `group:${relation.project}`;
}

export type DeliveryReport = { memberId: string; convId: string; submissionId: string; status: SubmissionStatus };

/**
 * 发送编排：私聊直投原文；群聊按正文 @ 定向（不 @ 到任何成员即拒绝，不再广播）。
 * 只等全部 admission 落盘（模型回答并行在途，经 watch 推流）。
 *
 * options.newSession = true 时，投递这一刻对每个目标成员**真正新开会话**（结束旧链、开新条）：
 * 于是「点了新开会话却什么都没发」不产生空会话；排队中被撤回 / 中断也不产生会话。
 */
export async function sendToRoom(
  ws: Workspace,
  harness: HarnessPort,
  relation: Relation,
  text: string,
  options: {
    queue: KeyedQueue;
    defaults?: SessionDefaults;
    requestId?: string;
    newSession?: boolean;
    mcp?: McpSessionResolver;
    store?: MessageStore;
    /** 会话标题依赖（写库 + 广播 + 命名器）；缺省 = 不命名（不改行为）。 */
    titles?: SessionTitleDeps;
  },
): Promise<{ roomMessageId: string; deliveries: DeliveryReport[]; recorded?: StoredMessage }> {
  const body = text.trim();
  if (body === "") throw new Error("消息不能为空");

  const targets: { memberId: string; body: string }[] = [];
  if (relation.kind === "dm") {
    targets.push({ memberId: relation.employeeId, body });
  } else {
    const memberIds = parseMembers(ws, relation.project);
    if (memberIds.length === 0) throw new EmptyGroupError("群还没有成员");
    const deliveries = planRouting(body, memberIds);
    if (deliveries.length === 0) throw new NoTargetsError("消息需要 @ 至少一位群成员");
    for (const delivery of deliveries) {
      targets.push({ memberId: delivery.to, body: delivery.body });
    }
  }

  // 落库：一次投递 = 一行（正文已剥离头部 @；toIds 是本条消息头部 @ 块点到的参与者，含 '__boss'，可据此重建头部 @）。
  // 返回值带回刚落的行（recorded）：调用方（http / permission-flow）据此广播库行（R-P1-12「谁写谁广播」；
  // 广播不放这里——sendToRoom 没有 hub）。
  let recorded: StoredMessage | undefined;
  if (options.store !== undefined) {
    const { toIds, text: stripped } =
      relation.kind === "dm"
        ? { toIds: [relation.employeeId], text: stripLeadingMentions(body) }
        : parseAgentReply(body, parseMembers(ws, relation.project), bossNamesFor(ws));
    if (stripped !== "") {
      recorded = options.store.append({
        sendTime: new Date().toISOString(),
        projectId: relation.kind === "group" ? relation.project : null,
        fromId: BOSS_PARTICIPANT,
        toIds,
        text: stripped,
      });
    }
  }

  const roomMessageId = `rm_${randomUUID()}`;
  const deliveries = await Promise.all(
    targets.map((target) =>
      options.queue.run(relationKey(relation, target.memberId), async (): Promise<DeliveryReport> => {
        const group = relation.kind === "group" ? relation.project : undefined;
        const opened =
          options.newSession === true
            ? await newSession(ws, harness, relation, target.memberId, options.defaults, options.mcp)
            : group === undefined
              ? await openDm(ws, harness, target.memberId, options.defaults, options.mcp)
              : await openGroup(ws, harness, group, target.memberId, options.defaults, options.mcp);
        const convId = opened.convId;
        const meta: InputMeta = {
          kind: "chat.message",
          data: { author: "boss", roomMessageId },
          ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
        };
        const receipt = await harness.submit(convId, target.body, meta);
        // 新会话：立刻落时间标题（兜底）+ 后台命名（不阻塞投递）；复用旧会话不动标题。
        if (opened.created && options.titles !== undefined) {
          nameNewSession(options.titles, roomKeyOf(relation), convId, target.body);
        }
        return { memberId: target.memberId, convId, submissionId: receipt.id, status: receipt.status };
      }),
    ),
  );
  return { roomMessageId, deliveries, ...(recorded === undefined ? {} : { recorded }) };
}

/** 发送者标注：`爱丽丝（alice）`；无 alias 或与 id 相同 → 直接用 id。 */
function senderLabel(ws: Workspace, senderId: string): string {
  const alias = personDisplayName(ws, senderId);
  return alias === senderId ? senderId : `${alias}（${senderId}）`;
}

/**
 * 群成员回复里的 @前缀触发：把回复投递给被 @ 到的成员（排除发送者自己与老板——老板待办走 bossDirected 口径）。
 * 副本以 chat.mention 投递（不参与房间/历史显示，防重复气泡），正文带发送者标注，让被触发者知道是谁在找他。
 * 不落库：同一句话由 pump 的 message 分支落一行（一次投递 = 一条记录），此处只发投递副本。
 * 不 @ 到任何成员时返回空（非错误）：没写 @ 开头的回复由显示层补 @老板、视为发给老板。
 */
export async function triggerFromGroupReply(
  ws: Workspace,
  harness: HarnessPort,
  options: {
    queue: KeyedQueue;
    defaults?: SessionDefaults;
    mcp?: McpSessionResolver;
    project: string;
    senderId: string;
    convId: string;
    entryId: string;
    text: string;
  },
): Promise<DeliveryReport[]> {
  const memberIds = parseMembers(ws, options.project);
  if (memberIds.length === 0) return [];
  // 与老板侧同标准：只有 @ 前缀、没有正文的回复不触发任何人（避免空消息把成员叫起来）。
  if (!hasBodyAfterPrefix(options.text)) return [];
  // 与发送同口径：按 trim 后的正文解析（只认开头 @ 前缀块）。
  const deliveries = planRouting(options.text.trim(), memberIds).filter((delivery) => delivery.to !== options.senderId);
  if (deliveries.length === 0) return [];
  const label = senderLabel(ws, options.senderId);
  const meta: InputMeta = {
    kind: "chat.mention",
    data: { author: options.senderId, source: `${options.convId}:${options.entryId}` },
    requestId: `mention:${options.convId}:${options.entryId}`,
  };
  return await Promise.all(
    deliveries.map((delivery) =>
      options.queue.run(relationKey({ kind: "group", project: options.project }, delivery.to), async (): Promise<DeliveryReport> => {
        const { convId } = await openGroup(ws, harness, options.project, delivery.to, options.defaults, options.mcp);
        const receipt = await harness.submit(convId, `${label}：${delivery.body}`, meta);
        return { memberId: delivery.to, convId, submissionId: receipt.id, status: receipt.status };
      }),
    ),
  );
}
