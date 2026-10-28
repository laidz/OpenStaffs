/** 保留 id：老板 / 系统（不是员工，也不是会议参与者之外的东西）。 */
export const BOSS_PARTICIPANT = "__boss";
export const SYSTEM_PARTICIPANT = "__system";

/**
 * 自有消息库里的一行 = 一次发言（一次投递落一行）。
 * 房间概念已由**会议**取代：`meetingId` 是唯一的归属键（见 store/meetings.ts）；
 * 头部 @ 不落库（写库前剥掉），由 `toIds` 在展示层重建。
 */
export type StoredMessage = {
  id: string;
  /** 全局单调（全库唯一），房间视图 / pin 键都用它。 */
  seq: number;
  /** ISO 时间戳（只落库；喂模型不带时间）。 */
  sendTime: string;
  meetingId: string;
  /** 参与者 id：agent id，或保留 id `__boss` / `__system`。 */
  fromId: string;
  /** 参与者 id 列表（可含 `__boss` / `__system`）。 */
  toIds: string[];
  /** 已剥离头部 @ 块的内容。 */
  text: string;
};
