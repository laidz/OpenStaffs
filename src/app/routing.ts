import { BOSS_ID, leadingMentionLength, parseMentions } from "../domain/mention.ts";

// 本文件进入浏览器 bundle（web/composer.ts 复用）：不得引入 node 内置模块。

export type Delivery = { to: string; body: string };

/** 前缀块之外是否还有正文（用于“只有 @、没有内容”的判定）。 */
export function hasBodyAfterPrefix(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.slice(leadingMentionLength(trimmed)).trim() !== "";
}

/**
 * 群聊路由：只认正文开头的 @ 前缀块（界面勾选写入的位置），命中成员各投一份（正文原样，含 @）。
 * 正文中/尾的 @ 不触发；不 @ 到任何成员 → 空投递（由调用方拒绝发送）；不再有“不点名 = 广播”。
 */
export function planRouting(text: string, memberIds: string[]): Delivery[] {
  const mention = parseMentions(text, memberIds);
  return mention.targets
    // BOSS_ID 是“老板”哨兵（@老板 / @boss 写法），不是群成员：显式排除，避免误投给同名成员。
    .filter((target) => target !== BOSS_ID && memberIds.includes(target))
    .map((to) => ({ to, body: mention.body }));
}
