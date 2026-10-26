export type StoredMessage = {
  id: string;
  seq: number;
  /** ISO 时间戳（只落库；喂模型不带时间）。 */
  sendTime: string;
  /** 派生索引键：'dm:<agentId>' | 'group:<projectId>'。 */
  room: string;
  /** 群聊 = 项目 id；私聊 = null。 */
  projectId: string | null;
  /** 参与者 id：agent id，或保留 id '__boss' / '__system'。 */
  fromId: string;
  /** 参与者 id 列表（可含 '__boss' / '__system'）。 */
  toIds: string[];
  /** 已剥离头部 @ 块的内容。 */
  text: string;
  /** 本行是本房间**当前一轮**的起点（老板点「新开会话」后发出的第一条）；其余行不带。 */
  sessionStart?: boolean;
};

export const BOSS_PARTICIPANT = "__boss";
export const SYSTEM_PARTICIPANT = "__system";

/** 由 projectId 与参与者推出房间键（私聊取非 boss/system 的一方）。 */
export function roomKeyOfMessage(m: { projectId: string | null; fromId: string; toIds: string[] }): string {
  if (m.projectId !== null) return `group:${m.projectId}`;
  const agent = [m.fromId, ...m.toIds].find((id) => id !== BOSS_PARTICIPANT && id !== SYSTEM_PARTICIPANT);
  return `dm:${agent ?? ""}`;
}
