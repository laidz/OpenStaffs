import { randomUUID } from "node:crypto";
import { parseMembers } from "../domain/access-control.ts";
import type { Workspace } from "../domain/paths.ts";
import type { HarnessPort, InputMeta } from "../harness/port.ts";
import { openDm, openGroup, relationKey, type Relation, type SessionDefaults } from "./conversations.ts";
import { planRouting } from "./routing.ts";

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

export type DeliveryReport = { memberId: string; convId: string };

/**
 * 发送编排：私聊直投原文；群聊走 planRouting（@定向/广播）。
 * 只等全部 admission 落盘（模型回答并行在途，经 watch 推流）。
 */
export async function sendToRoom(
  ws: Workspace,
  harness: HarnessPort,
  relation: Relation,
  text: string,
  options: { queue: KeyedQueue; defaults?: SessionDefaults; requestId?: string },
): Promise<{ roomMessageId: string; deliveries: DeliveryReport[] }> {
  const body = text.trim();
  if (body === "") throw new Error("消息不能为空");

  const targets: { memberId: string; body: string }[] = [];
  if (relation.kind === "dm") {
    targets.push({ memberId: relation.employeeId, body });
  } else {
    const memberIds = parseMembers(ws, relation.project);
    if (memberIds.length === 0) throw new EmptyGroupError("群还没有成员");
    for (const delivery of planRouting(body, memberIds).deliveries) {
      targets.push({ memberId: delivery.to, body: delivery.body });
    }
  }

  const roomMessageId = `rm_${randomUUID()}`;
  const deliveries = await Promise.all(
    targets.map((target) =>
      options.queue.run(relationKey(relation, target.memberId), async (): Promise<DeliveryReport> => {
        const convId =
          relation.kind === "dm"
            ? await openDm(ws, harness, relation.employeeId, options.defaults)
            : await openGroup(ws, harness, relation.project, target.memberId, options.defaults);
        const meta: InputMeta = {
          kind: "chat.message",
          data: { author: "boss", roomMessageId },
          ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
        };
        await harness.submit(convId, target.body, meta);
        return { memberId: target.memberId, convId };
      }),
    ),
  );
  return { roomMessageId, deliveries };
}
