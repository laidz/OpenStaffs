import { randomUUID } from "node:crypto";
import { parseMembers } from "../domain/access-control.ts";
import { loadEmployee } from "../domain/employee.ts";
import type { Workspace } from "../domain/paths.ts";
import type { HarnessPort, InputMeta, SubmissionStatus } from "../harness/port.ts";
import { openDm, openGroup, newSession, relationKey, type Relation, type SessionDefaults } from "./conversations.ts";
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

/** 群没有成员（members.md 为空）时拒绝发送。 */
export class EmptyGroupError extends Error {}

/** 群聊消息没有 @ 到任何成员时拒绝发送（不再广播）。 */
export class NoTargetsError extends Error {}

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
  options: { queue: KeyedQueue; defaults?: SessionDefaults; requestId?: string; newSession?: boolean },
): Promise<{ roomMessageId: string; deliveries: DeliveryReport[] }> {
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

  const roomMessageId = `rm_${randomUUID()}`;
  const deliveries = await Promise.all(
    targets.map((target) =>
      options.queue.run(relationKey(relation, target.memberId), async (): Promise<DeliveryReport> => {
        const group = relation.kind === "group" ? relation.project : undefined;
        const convId =
          options.newSession === true
            ? await newSession(ws, harness, relation, target.memberId, options.defaults)
            : group === undefined
              ? await openDm(ws, harness, target.memberId, options.defaults)
              : await openGroup(ws, harness, group, target.memberId, options.defaults);
        const meta: InputMeta = {
          kind: "chat.message",
          data: { author: "boss", roomMessageId },
          ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
        };
        const receipt = await harness.submit(convId, target.body, meta);
        return { memberId: target.memberId, convId, submissionId: receipt.id, status: receipt.status };
      }),
    ),
  );
  return { roomMessageId, deliveries };
}

/** 发送者标注：`爱丽丝（alice）`；无 alias 或与 id 相同 → 直接用 id。 */
function senderLabel(ws: Workspace, senderId: string): string {
  let alias: string | undefined;
  try {
    alias = loadEmployee(ws, senderId).alias;
  } catch {
    alias = undefined;
  }
  return alias === undefined || alias === senderId ? senderId : `${alias}（${senderId}）`;
}

/**
 * 群成员回复里的 @前缀触发：把回复投递给被 @ 到的成员（排除发送者自己与老板——老板待办走 bossDirected 口径）。
 * 副本以 chat.mention 落盘（不参与房间/历史显示，防重复气泡），正文带发送者标注，让被触发者知道是谁在找他。
 * 不 @ 到任何成员时返回空（非错误）：没写 @ 开头的回复由显示层补 @老板、视为发给老板。
 */
export async function triggerFromGroupReply(
  ws: Workspace,
  harness: HarnessPort,
  options: {
    queue: KeyedQueue;
    defaults?: SessionDefaults;
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
        const convId = await openGroup(ws, harness, options.project, delivery.to, options.defaults);
        const receipt = await harness.submit(convId, `${label}：${delivery.body}`, meta);
        return { memberId: delivery.to, convId, submissionId: receipt.id, status: receipt.status };
      }),
    ),
  );
}
