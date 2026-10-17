import { planRouting } from "../src/app/routing.ts";
import { leadingMentionLength } from "../src/domain/mention.ts";

/** 正文里有效 @ 对象的成员（与后端路由完全一致——UI 门禁以它为唯一真相源；与发送同口径：先 trim）。 */
export function targetsOf(text: string, memberIds: string[]): string[] {
  return planRouting(text.trim(), memberIds).map((delivery) => delivery.to);
}

/** 去掉开头 @ 前缀块后的正文（判断“有没有真正的消息内容”；与发送同口径：先 trim）。 */
export function bodyWithoutPrefix(text: string): string {
  const trimmed = text.trim();
  return trimmed.slice(leadingMentionLength(trimmed)).trim();
}

/** 群聊可发送判定：至少一位有效对象 + 前缀外还有正文（避免只 @ 人的空消息误触员工）。 */
export function groupSendable(text: string, memberIds: string[]): boolean {
  return targetsOf(text, memberIds).length > 0 && bodyWithoutPrefix(text) !== "";
}

/**
 * 勾选/取消勾选：把前缀块按 token 列表重建——插入/移除 @id，多余空白与重复 token 归一。
 * 正文中/尾的同形 @ 只是文字，不碰；前缀块未变化时原样返回。
 */
export function toggleTarget(text: string, id: string, checked: boolean): string {
  const lead = text.length - text.trimStart().length;
  const core = text.slice(lead);
  const end = leadingMentionLength(core);
  const tokens = [...core.slice(0, end).matchAll(/@([^\s@]+)/gu)].map((match) => match[1]!);
  const next = checked
    ? (tokens.includes(id) ? tokens : [...tokens, id])
    : tokens.filter((token) => token !== id);
  if (next.length === tokens.length) return text;
  const rebuilt = next.length === 0 ? "" : `${next.map((token) => `@${token}`).join(" ")} `;
  return `${text.slice(0, lead)}${rebuilt}${core.slice(end)}`;
}

/** 发送成功后保留的草稿：只保留 @ 前缀（复选框保持勾选，接着发下一条）。 */
export function draftAfterSend(targets: string[]): string {
  return targets.length === 0 ? "" : `${targets.map((id) => `@${id}`).join(" ")} `;
}
