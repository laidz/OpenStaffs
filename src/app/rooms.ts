import type { ChatMessage } from "../harness/port.ts";
import { loadEmployee } from "../domain/employee.ts";
import { BOSS_ID, leadingMentionLength, parseMentions } from "../domain/mention.ts";
import type { Workspace } from "../domain/paths.ts";
import { BOSS_PARTICIPANT, SYSTEM_PARTICIPANT, type StoredMessage } from "../store/row.ts";
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
 *   群聊里工具投递（send_message member:<id>）的消息落在**收件人**的会话 → 显示层补 `@收件人`（正文自带
 *   @前缀块则不改写）；其余群消息照旧：没写 @ / @ 不到有效对象 → 补 `@老板`；
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
      // 工具投递（send_message member:<id>）：消息落在**收件人**的会话里 → 收件人 = 本会话的主人。
      const recipient = isGroup && member.memberId !== author ? member.memberId : undefined;
      const trimmed = chat.text.trim();
      const prefixEnd = leadingMentionLength(trimmed);
      const deliveries = prefixEnd === 0 ? [] : planRouting(trimmed, memberIds);
      const reachesOtherMember = hasBodyAfterPrefix(trimmed) && deliveries.some((delivery) => delivery.to !== author);
      const bossTargeted = parseMentions(trimmed, memberIds, bossNames).targets.includes(BOSS_ID);
      // 与 assistant 分支同口径：群消息一律以 @ 开头且落到确定对象（投递到某成员 → 补 @收件人；否则照旧补 @老板）。
      const needsHeader =
        trimmed !== "" &&
        (recipient !== undefined ? prefixEnd === 0 : prefixEnd === 0 || (!reachesOtherMember && !bossTargeted));
      const fallback = isGroup && needsHeader;
      const mention = recipient !== undefined ? `@${recipient}` : `@${bossNames[0]!}`;
      return {
        convId: member.convId,
        entryId: chat.id,
        roomKey,
        speaker: { kind: "employee", id: author },
        text: fallback ? `${mention} ${chat.text}` : chat.text,
        bossDirected: isGroup ? recipient === undefined && (fallback || bossTargeted) : true,
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

/**
 * 单条会话的原文视图：会话 transcript 直接归一化（**不合并、不去重**）；合成条目（pi.compaction 等）跳过。
 * 「某条会话的原文」端点专用——房间视图已改读自有库（见 toRoomMessage）。
 */
export function roomMessagesOfTranscript(
  roomKey: string,
  member: MemberTranscript,
  memberIds: string[] = [],
  bossNames: string[] = ["老板", "boss"],
): RoomMessage[] {
  const out: RoomMessage[] = [];
  for (const chat of member.messages) {
    const message = normalizeChatMessage(roomKey, member, chat, memberIds, bossNames);
    if (message !== undefined) out.push(message);
  }
  return out;
}

/** 员工 alias 项；未给工作区 / 取不到 → 空对象（不带 alias，也不抛）。 */
function aliasOf(ws: Workspace | undefined, id: string): { alias?: string } {
  if (ws === undefined) return {};
  try {
    const alias = loadEmployee(ws, id).alias;
    return alias === undefined ? {} : { alias };
  } catch {
    return {};
  }
}

/**
 * 自有库一行 → 房间消息（UI 形态，RoomMessage 不变，故 pins / web / 去重链路零改动）。
 * - 键：convId="store"、entryId=String(seq) → `"store:<seq>"`（seq 全局单调，全库唯一）。旧 `convId:entryId`
 *   pin 键失效属 D30 允许的破坏性更新（不做迁移）。
 * - 群聊按 toIds 重建头部 @（spec §13：text 已剥离头部，展示时由收件人重建）；私聊不加头。
 * - speaker：`__boss` / `__system` → 老板形态（系统消息也按老板显示，不引入第三种 speaker）；否则员工 + alias。
 * - bossDirected：私聊恒 true；群聊看 toIds 是否含 `__boss`。
 * - 不带 roomMessageId（那是「排队中」的 UI 概念，由 outbox / SSE 那条链路单独携带）。
 */
export function toRoomMessage(stored: StoredMessage, bossName: string, ws?: Workspace): RoomMessage {
  const isGroup = stored.room.startsWith("group:");
  const nameOf = (id: string): string =>
    id === BOSS_PARTICIPANT ? bossName : id === SYSTEM_PARTICIPANT ? "系统" : id;
  // 群聊按 toIds 逐人重建头部 @ 块（与发送侧 `stripLeadingMentions` 严格互逆，多人也要各自带 @）。
  const text = isGroup && stored.toIds.length > 0 ? `${stored.toIds.map((id) => `@${nameOf(id)}`).join(" ")} ${stored.text}` : stored.text;
  const speaker: RoomSpeaker =
    stored.fromId === BOSS_PARTICIPANT || stored.fromId === SYSTEM_PARTICIPANT
      ? { kind: "boss" }
      : { kind: "employee", id: stored.fromId, ...aliasOf(ws, stored.fromId) };
  return {
    convId: "store",
    entryId: String(stored.seq),
    roomKey: stored.room,
    speaker,
    text,
    bossDirected: isGroup ? stored.toIds.includes(BOSS_PARTICIPANT) : true,
  };
}
