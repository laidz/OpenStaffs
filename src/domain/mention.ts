import type { EmployeeId } from "./types.ts";

export const BOSS_ID = "boss";

export type MentionResult = {
  targets: string[];
  body: string;
};

// 本文件进入浏览器 bundle（web/composer.ts 复用前缀块规则）：不得引入 node 内置模块。

/** 正文开头 @ 前缀块的字符长度：连续的 @token（以空白分隔；最后一个可无尾随空白）。 */
export function leadingMentionLength(text: string): number {
  let end = 0;
  for (;;) {
    const match = /^@[^\s@]+(?:\s+|$)/u.exec(text.slice(end));
    if (match === null) return end;
    end += match[0].length;
  }
}

/**
 * 解析 @提及：只认**正文开头的 @ 前缀块**（界面勾选即写在这里），命中的员工 id / 老板名进 targets（去重保序）。
 * 正文中/尾的 @ 只是文字，不触发任何人；正文原样保留 @（@ 是消息对象在聊天记录里的标记）。
 */
export function parseMentions(
  text: string,
  knownEmployees: EmployeeId[],
  bossNames: string[] = ["老板", "boss"],
): MentionResult {
  const targets: string[] = [];
  const prefix = text.slice(0, leadingMentionLength(text));
  for (const match of prefix.matchAll(/@([^\s@]+)/gu)) {
    const name = match[1]!;
    if (knownEmployees.includes(name)) {
      if (!targets.includes(name)) targets.push(name);
    } else if (bossNames.includes(name)) {
      if (!targets.includes(BOSS_ID)) targets.push(BOSS_ID);
    }
  }
  const body = text.replace(/\s+/gu, " ").trim();
  return { targets, body };
}
