import { randomUUID } from "node:crypto";
import { bossNamesFor } from "../domain/config.ts";
import type { McpSessionResolver } from "../domain/mcp.ts";
import { personDisplayName } from "../domain/org.ts";
import type { Workspace } from "../domain/paths.ts";
import type { HarnessPort, InputMeta, SubmissionStatus } from "../harness/port.ts";
import type { MeetingRecord } from "../store/meetings.ts";
import type { MessageStore } from "../store/messages.ts";
import { BOSS_PARTICIPANT, type StoredMessage } from "../store/row.ts";
import type { SessionStore } from "../store/sessions.ts";
import { queueKey, resolveSession, type SessionDefaults } from "./conversations.ts";
import { participantIds, subjectOf } from "./meetings.ts";
import { nameNewMeeting, type MeetingTitleDeps } from "./meeting-titles.ts";
import { parseAgentReply, stripLeadingMentions } from "./message-row.ts";
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

export type DeliveryReport = { memberId: string; convId: string; submissionId: string; status: SubmissionStatus };

/**
 * 会议内投递：私聊直投原文；群聊按正文 @ 定向（不 @ 到任何成员即拒绝，不再广播）。
 * 只等全部 admission 落盘（模型回答并行在途，经 watch 推流）。
 *
 * **目标只决定投给谁的 conv，不决定消息归属**：一次投递落一行，`meetingId` 永远是本会议。
 */
export async function sendToMeeting(
  ws: Workspace,
  harness: HarnessPort,
  meeting: MeetingRecord,
  text: string,
  options: {
    queue: KeyedQueue;
    /** 会话表（唯一真相）：靠它把 (会议, 成员) 解析成 convId。 */
    sessions: SessionStore;
    defaults?: SessionDefaults;
    requestId?: string;
    mcp?: McpSessionResolver;
    store?: MessageStore;
    /** 会议标题依赖（写库 + 广播 + 命名器）；缺省 = 不命名（不改行为）。 */
    titles?: MeetingTitleDeps;
  },
): Promise<{ messageId: string; deliveries: DeliveryReport[]; recorded?: StoredMessage }> {
  const body = text.trim();
  if (body === "") throw new Error("消息不能为空");

  // 成员始终按**当前**主题成员算（群加人立刻可投递；退群的人不再投递）。
  const memberIds = participantIds(ws, subjectOf(meeting));
  const targets: { memberId: string; body: string }[] = [];
  if (meeting.kind === "dm") {
    targets.push({ memberId: meeting.subjectId, body });
  } else {
    if (memberIds.length === 0) throw new EmptyGroupError("群还没有成员");
    const deliveries = planRouting(body, memberIds);
    if (deliveries.length === 0) throw new NoTargetsError("消息需要 @ 至少一位群成员");
    for (const delivery of deliveries) targets.push({ memberId: delivery.to, body: delivery.body });
  }

  // 落库：一次投递 = 一行（正文已剥离头部 @；toIds 是本条消息头部 @ 块点到的参与者，含 '__boss'，
  // 可据此重建头部 @）。返回值带回刚落的行，调用方据此广播库行（「谁写谁广播」）。
  let recorded: StoredMessage | undefined;
  if (options.store !== undefined) {
    const { toIds, text: stripped } =
      meeting.kind === "dm"
        ? { toIds: [meeting.subjectId], text: stripLeadingMentions(body) }
        : parseAgentReply(body, memberIds, bossNamesFor(ws));
    if (stripped !== "") {
      recorded = options.store.append({
        sendTime: new Date().toISOString(),
        meetingId: meeting.meetingId,
        fromId: BOSS_PARTICIPANT,
        toIds,
        text: stripped,
      });
    }
  }

  const messageId = `msg_${randomUUID()}`;
  const deliveries = await Promise.all(
    targets.map((target) =>
      options.queue.run(queueKey(meeting.meetingId, target.memberId), async (): Promise<DeliveryReport> => {
        const opened = await resolveSession(
          {
            ws,
            harness,
            sessions: options.sessions,
            ...(options.defaults === undefined ? {} : { defaults: options.defaults }),
            ...(options.mcp === undefined ? {} : { mcp: options.mcp }),
          },
          meeting,
          target.memberId,
        );
        const meta: InputMeta = {
          kind: "chat.message",
          data: { author: "boss", messageId },
          ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
        };
        const receipt = await harness.submit(opened.convId, target.body, meta);
        // 会议还没有标题（= 这场会议的第一条消息）：落时间标题（兜底）+ 后台命名（不阻塞投递）。
        // 一场会议一个标题：群里一条消息 @ 多人会建多条 conv，不能各命名一次。
        if (opened.created && options.titles !== undefined && options.titles.store.get(meeting.meetingId)?.title === undefined) {
          nameNewMeeting(options.titles, meeting.meetingId, target.body);
        }
        return { memberId: target.memberId, convId: opened.convId, submissionId: receipt.id, status: receipt.status };
      }),
    ),
  );
  return { messageId, deliveries, ...(recorded === undefined ? {} : { recorded }) };
}

/** 发送者标注：`爱丽丝（alice）`；无 alias 或与 id 相同 → 直接用 id。 */
export function senderLabel(ws: Workspace, senderId: string): string {
  const alias = personDisplayName(ws, senderId);
  return alias === senderId ? senderId : `${alias}（${senderId}）`;
}

/**
 * 群成员回复里的 @前缀触发：把回复投递给**本会议内**被 @ 到的成员（排除发送者自己与老板——
 * 老板待办走 bossDirected 口径）。
 * 副本以 chat.mention 投递（不参与会议/历史显示，防重复气泡），正文带发送者标注，让被触发者知道是谁在找他。
 * 不落库：同一句话由 pump 的 message 分支落一行（一次投递 = 一条记录），此处只发投递副本。
 * 不 @ 到任何成员时返回空（非错误）：没写 @ 开头的回复由显示层补 @老板、视为发给老板。
 */
export async function triggerFromMeetingReply(
  ws: Workspace,
  harness: HarnessPort,
  options: {
    queue: KeyedQueue;
    sessions: SessionStore;
    defaults?: SessionDefaults;
    mcp?: McpSessionResolver;
    meeting: MeetingRecord;
    senderId: string;
    convId: string;
    entryId: string;
    text: string;
  },
): Promise<DeliveryReport[]> {
  if (options.meeting.kind !== "group") return [];
  const memberIds = participantIds(ws, subjectOf(options.meeting));
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
      options.queue.run(queueKey(options.meeting.meetingId, delivery.to), async (): Promise<DeliveryReport> => {
        const { convId } = await resolveSession(
          {
            ws,
            harness,
            sessions: options.sessions,
            ...(options.defaults === undefined ? {} : { defaults: options.defaults }),
            ...(options.mcp === undefined ? {} : { mcp: options.mcp }),
          },
          options.meeting,
          delivery.to,
        );
        const receipt = await harness.submit(convId, `${label}：${delivery.body}`, meta);
        return { memberId: delivery.to, convId, submissionId: receipt.id, status: receipt.status };
      }),
    ),
  );
}
