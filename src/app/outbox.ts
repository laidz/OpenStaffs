import { randomUUID } from "node:crypto";

/** 一条排队中的投递（老板的消息 × 一个目标成员）；只存在于内存，进程内即真相。 */
export type QueuedDelivery = {
  /** Pi 的 submission id：撤回与出队的唯一句柄。 */
  submissionId: string;
  roomKey: string;
  memberId: string;
  /** 房间级去重键：同一次发送的 N 份投递共享（前端据此合并成一条气泡）。 */
  roomMessageId: string;
  text: string;
  convId: string;
  /**
   * 这次发送对应的库行 seq（`sendToRoom` 落库那一行）。
   * GET 房间视图据此把仍在排队的库行回填 roomMessageId —— 与 SSE 广播同口径，
   * 刷新 / 换标签页时「排队中」贴到真气泡上，不出「真气泡 + 灰占位」两条。
   * 无对应库行（正文为空没落行）时为 0（seq 从 1 起，永不命中）。
   */
  storeSeq: number;
  /** 入队序（跨 submission 单调递增）：前端按投递顺序排列。 */
  seq: number;
};

/** 给前端的视图（内部字段 convId/seq 不外泄）。 */
export type QueuedItemView = {
  submissionId: string;
  roomKey: string;
  memberId: string;
  roomMessageId: string;
  text: string;
};

export function queuedItemView(item: QueuedDelivery): QueuedItemView {
  return {
    submissionId: item.submissionId,
    roomKey: item.roomKey,
    memberId: item.memberId,
    roomMessageId: item.roomMessageId,
    text: item.text,
  };
}

/**
 * 待发表：老板已提交、但还没被员工取走的输入（Pi submission 状态 = queued）。
 *
 * 真相源是 Pi 自己的 inbox（durable）；本表只是「谁在排队」的进程内索引，用于展示与撤回：
 * 进程重启后表为空 —— 还在队的输入不会丢（Pi 侧照常投递），只是不再显示「排队中」。
 */
export class Outbox {
  #items = new Map<string, QueuedDelivery>();
  #seq = 0;

  /** 入队；同 submissionId 重复入队只保留首条（幂等）。 */
  add(item: Omit<QueuedDelivery, "seq">): QueuedDelivery {
    const existing = this.#items.get(item.submissionId);
    if (existing !== undefined) return existing;
    const entry: QueuedDelivery = { ...item, seq: ++this.#seq };
    this.#items.set(item.submissionId, entry);
    return entry;
  }

  /** 出队（投递开始 / 撤回 / 中断）：移出并返回该条；不在表里返回 undefined。 */
  take(submissionId: string): QueuedDelivery | undefined {
    const item = this.#items.get(submissionId);
    if (item === undefined) return undefined;
    this.#items.delete(submissionId);
    return item;
  }

  /** 某房间的待发条目（按投递顺序）。 */
  list(roomKey: string): QueuedDelivery[] {
    return [...this.#items.values()].filter((item) => item.roomKey === roomKey).sort((a, b) => a.seq - b.seq);
  }

  /** 某房间同一次发送的待发条目（撤回 = 整条消息所有还没开始的投递）。 */
  byRoomMessage(roomKey: string, roomMessageId: string): QueuedDelivery[] {
    return this.list(roomKey).filter((item) => item.roomMessageId === roomMessageId);
  }

  /**
   * 某房间仍在排队的投递：库行 seq → roomMessageId（GET 房间视图回填用）。
   * 同一行 seq 命中的 N 份投递共享同一 roomMessageId，值一致。
   */
  roomMessageIdByStoreSeq(roomKey: string): Map<number, string> {
    const map = new Map<number, string>();
    for (const item of this.#items.values()) {
      if (item.roomKey === roomKey) map.set(item.storeSeq, item.roomMessageId);
    }
    return map;
  }

  /** 当前待发总数（排障 / 测试用）。 */
  get size(): number {
    return this.#items.size;
  }
}

/** 生成房间级去重键（与消息编排同源，便于测试单独使用）。 */
export function newRoomMessageId(): string {
  return `rm_${randomUUID()}`;
}
