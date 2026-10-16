import type { EmployeeId } from "./types.ts";

export const BOSS_ID = "boss";

export type MentionResult = {
  targets: string[];
  body: string;
  broadcast: boolean;
};

export function parseMentions(
  text: string,
  knownEmployees: EmployeeId[],
  bossNames: string[] = ["老板", "boss"],
): MentionResult {
  const targets: string[] = [];
  const body = text
    .replace(/@([^\s@]+)/gu, (match, name: string) => {
      if (knownEmployees.includes(name)) {
        if (!targets.includes(name)) targets.push(name);
        return "";
      }
      if (bossNames.includes(name)) {
        if (!targets.includes(BOSS_ID)) targets.push(BOSS_ID);
        return "";
      }
      return match;
    })
    .replace(/\s+/gu, " ")
    .trim();
  return { targets, body, broadcast: targets.length === 0 };
}
