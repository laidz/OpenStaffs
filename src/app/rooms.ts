import type { ChatMessage } from "../harness/port.ts";
import { BOSS_ID, leadingMentionLength, parseMentions } from "../domain/mention.ts";
import { hasBodyAfterPrefix, planRouting } from "./routing.ts";
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
  /** 是否“发给老板”（群聊待办/红点口径）：私聊恒 true；群聊 = 前缀块含 @老板，或没写 @ / @ 了无有效对象时被系统视为发给老板。 */
  bossDirected: boolean;
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

/** entry data.author（发言者 id）；缺省 undefined。 */
function authorOf(chat: ChatMessage): string | undefined {
  const data = typeof chat.data === "object" && chat.data !== null ? (chat.data as Record<string, unknown>) : {};
  return typeof data.author === "string" && data.author.trim() !== "" ? data.author.trim() : undefined;
}

/**
 * 单条聊天消息 → 房间消息。
 * - assistant → 员工发言；**群消息一律以 @ 开头、且必须落到确定对象**：没写 @、或开头 @ 了但这条回复
 *   解析不出有效对象（写错 id / 标点粘连 / 只 @ 自己 / 只有 @ 没正文）→ 视为“发给老板”：显示/历史层
 *   补当前称谓（bossNames 首项，缺省「老板」，不改写落盘原文）；
 * - user 且 kind 为 chat.message / pi.user：data.author 是员工 id（员工主动发言 / 工具投递）→ 归属该员工；否则 → 老板发言；
 * - 其余 user 条目（如 pi.compaction / pi.reset 等合成条目）→ undefined（跳过）。
 * bossDirected：群聊按前缀块是否含负责人（双认列表）判定（见 RoomMessage）；私聊发言一律算给老板。
 */
export function normalizeChatMessage(
  roomKey: string,
  member: MemberTranscript,
  chat: ChatMessage,
  memberIds: string[] = [],
  bossNames: string[] = ["老板", "boss"],
): RoomMessage | undefined {
  const isGroup = roomKey.startsWith("group:");
  if (chat.role === "assistant") {
    const trimmed = chat.text.trim();
    const prefixEnd = leadingMentionLength(trimmed);
    const deliveries = prefixEnd === 0 ? [] : planRouting(trimmed, memberIds);
    const reachesOtherMember = hasBodyAfterPrefix(trimmed) && deliveries.some((delivery) => delivery.to !== member.memberId);
    const bossTargeted = parseMentions(trimmed, memberIds, bossNames).targets.includes(BOSS_ID);
    const fallback = isGroup && trimmed !== "" && (prefixEnd === 0 || (!reachesOtherMember && !bossTargeted));
    return {
      convId: member.convId,
      entryId: chat.id,
      roomKey,
      speaker: { kind: "employee", id: member.memberId, ...(member.alias === undefined ? {} : { alias: member.alias }) },
      text: fallback ? `@${bossNames[0]!} ${chat.text}` : chat.text,
      bossDirected: isGroup ? fallback || bossTargeted : true,
    };
  }
  if (chat.role === "user" && (chat.kind === "chat.message" || chat.kind === "pi.user")) {
    const author = authorOf(chat);
    if (author !== undefined && author !== BOSS_ID) {
      return {
        convId: member.convId,
        entryId: chat.id,
        roomKey,
        speaker: { kind: "employee", id: author },
        text: chat.text,
        bossDirected: isGroup ? parseMentions(chat.text.trim(), memberIds, bossNames).targets.includes(BOSS_ID) : true,
      };
    }
    return {
      convId: member.convId,
      entryId: chat.id,
      roomKey,
      speaker: { kind: "boss" },
      text: chat.text,
      bossDirected: false,
      ...bossDataOf(chat),
    };
  }
  return undefined;
}

/** 合并各成员活跃会话的 transcript：按 entryId 排序；老板消息按 roomMessageId 去重取最小 entryId。 */
export function mergeRoomMessages(
  roomKey: string,
  members: MemberTranscript[],
  memberIds: string[] = [],
  bossNames: string[] = ["老板", "boss"],
): RoomMessage[] {
  const all: RoomMessage[] = [];
  for (const member of members) {
    for (const chat of member.messages) {
      const message = normalizeChatMessage(roomKey, member, chat, memberIds, bossNames);
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

/** 未读数（老板待办口径）：entryId 严格大于 watermark 且“发给老板”的员工消息；群聊里成员互聊不点红点。 */
export function countUnread(messages: RoomMessage[], watermark: number | undefined): number {
  const seen = watermark === undefined ? 0 : watermark;
  return messages.filter((m) => m.speaker.kind === "employee" && m.bossDirected && Number(m.entryId) > seen).length;
}
