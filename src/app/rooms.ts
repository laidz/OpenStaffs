import type { ChatMessage } from "../harness/port.ts";
import type { Relation } from "./conversations.ts";

export type RoomSpeaker = { kind: "boss" } | { kind: "employee"; id: string; alias?: string };

export type RoomMessage = {
  convId: string;
  entryId: string;
  roomKey: string;
  speaker: RoomSpeaker;
  text: string;
  /** 老板发言的房间级去重键（同一次发送的 N 份只有一份被保留）。 */
  roomMessageId?: string;
};

export type MemberTranscript = {
  memberId: string;
  alias?: string;
  convId: string;
  messages: ChatMessage[];
};

export function roomKeyOf(relation: Relation): string {
  return relation.kind === "dm" ? `dm:${relation.employeeId}` : `group:${relation.project}`;
}

/** 房间 id 安全校验（对齐 domain/project.ts 的 assertValidProjectId）：拒绝空/空白/路径分隔符/NUL/点开头。 */
function isSafeRoomId(id: string): boolean {
  return (
    id.trim() !== "" &&
    !/\s/u.test(id) &&
    !id.includes("/") &&
    !id.includes("\\") &&
    !id.includes("\0") &&
    id !== "." &&
    id !== ".." &&
    !id.startsWith(".")
  );
}

export function parseRoomKey(key: string): Relation | undefined {
  if (key.startsWith("dm:") && isSafeRoomId(key.slice(3))) return { kind: "dm", employeeId: key.slice(3) };
  if (key.startsWith("group:") && isSafeRoomId(key.slice(6))) return { kind: "group", project: key.slice(6) };
  return undefined;
}

function bossDataOf(chat: ChatMessage): { roomMessageId?: string } {
  const data = typeof chat.data === "object" && chat.data !== null ? (chat.data as Record<string, unknown>) : {};
  return typeof data.roomMessageId === "string" ? { roomMessageId: data.roomMessageId } : {};
}

/**
 * 单条聊天消息 → 房间消息。
 * - assistant → 员工发言；
 * - user 且 kind 为 chat.message / pi.user → 老板发言；
 * - 其余 user 条目（如 pi.compaction / pi.reset 等合成条目）→ undefined（跳过）。
 */
export function normalizeChatMessage(roomKey: string, member: MemberTranscript, chat: ChatMessage): RoomMessage | undefined {
  if (chat.role === "assistant") {
    return {
      convId: member.convId,
      entryId: chat.id,
      roomKey,
      speaker: { kind: "employee", id: member.memberId, ...(member.alias === undefined ? {} : { alias: member.alias }) },
      text: chat.text,
    };
  }
  if (chat.role === "user" && (chat.kind === "chat.message" || chat.kind === "pi.user")) {
    return {
      convId: member.convId,
      entryId: chat.id,
      roomKey,
      speaker: { kind: "boss" },
      text: chat.text,
      ...bossDataOf(chat),
    };
  }
  return undefined;
}

/** 合并各成员活跃会话的 transcript：按 entryId 排序；老板消息按 roomMessageId 去重取最小 entryId。 */
export function mergeRoomMessages(roomKey: string, members: MemberTranscript[]): RoomMessage[] {
  const all: RoomMessage[] = [];
  for (const member of members) {
    for (const chat of member.messages) {
      const message = normalizeChatMessage(roomKey, member, chat);
      if (message !== undefined) all.push(message);
    }
  }
  const deduped = new Map<string, RoomMessage>();
  const plain: RoomMessage[] = [];
  for (const message of all) {
    if (message.roomMessageId === undefined) {
      plain.push(message);
      continue;
    }
    const existing = deduped.get(message.roomMessageId);
    if (existing === undefined || Number(message.entryId) < Number(existing.entryId)) {
      deduped.set(message.roomMessageId, message);
    }
  }
  return [...plain, ...deduped.values()].sort((a, b) => Number(a.entryId) - Number(b.entryId));
}

/** 未读数：entryId 严格大于 watermark 的员工消息。 */
export function countUnread(messages: RoomMessage[], watermark: number | undefined): number {
  const seen = watermark === undefined ? 0 : watermark;
  return messages.filter((m) => m.speaker.kind === "employee" && Number(m.entryId) > seen).length;
}
