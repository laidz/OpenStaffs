import { BOSS_ID, leadingMentionLength, parseMentions } from "../domain/mention.ts";
import { BOSS_PARTICIPANT } from "../store/row.ts";

// 口径：正文与收件人必须同源——先 trim 再解析（leadingMentionLength 的正则锚定 ^@，不认前导空白）。

/** 剥离正文开头的 @ 前缀块；返回剩余正文（trim）。 */
export function stripLeadingMentions(text: string): string {
  const trimmed = text.trim();
  return trimmed.slice(leadingMentionLength(trimmed)).trim();
}

/** agent 回复 → 收件人 + 纯正文；只 @ 无正文 → toIds=[]。 */
export function parseAgentReply(
  raw: string,
  memberIds: string[],
  bossNames: string[],
): { toIds: string[]; text: string } {
  const s = raw.trim();
  const text = stripLeadingMentions(s);
  const targets = parseMentions(s, memberIds, bossNames).targets;
  const toIds = targets.map((t) => (t === BOSS_ID ? BOSS_PARTICIPANT : t));
  if (text === "") return { toIds: [], text: "" };
  return { toIds: toIds.length === 0 ? [BOSS_PARTICIPANT] : toIds, text };
}
