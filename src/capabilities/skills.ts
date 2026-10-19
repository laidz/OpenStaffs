// src/capabilities/skills.ts —— 技能按名引用解析（D17）。
// B5 裁定：本文件是技能引用解析的**唯一实现**；后续阶段只能 import 与追加导出，不得改写其行为。
import fs from "node:fs";
import path from "node:path";
import { spaceSkillsDir, type Workspace } from "../domain/paths.ts";
import { FRAMEWORK_SKILLS_DIR, listSkills, renderSkills } from "../domain/skills.ts";
import type { LoadedConfig } from "../config/schema.ts";

export type SkillRef = { name: string; dir: string };

/** 技能名必须能安全拼进路径：非空、无空白 / 路径分隔符 / NUL、不以点开头。 */
function isSafeSkillName(name: string): boolean {
  return (
    name.trim() !== "" &&
    !/\s/u.test(name) &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0") &&
    !name.startsWith(".")
  );
}

/**
 * 按名解析技能（D17）：主根 `openstaffs/skills/`，后备是老板配的外部技能库；
 * 缺失 / 不安全的名字进 missing（不抛）。去重保序（先出现者胜）。
 */
export function resolveSkillRefs(
  ws: Workspace,
  names: readonly string[],
  extraRoots: readonly string[] = [],
): { resolved: SkillRef[]; missing: string[] } {
  const roots = [spaceSkillsDir(ws), ...extraRoots];
  const resolved: SkillRef[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const rawName of names) {
    const name = rawName.trim();
    if (seen.has(name)) continue;
    seen.add(name);
    if (!isSafeSkillName(name)) {
      missing.push(name);
      continue;
    }
    const hit = roots.map((root) => path.join(root, name)).find((dir) => fs.existsSync(path.join(dir, "SKILL.md")));
    if (hit === undefined) {
      missing.push(name);
      continue;
    }
    resolved.push({ name, dir: hit });
  }
  return { resolved, missing };
}

/** 累加作用域链各层的 skills 名（D10：不去重、空串丢弃），保序。 */
export function skillNamesFrom(scopes: readonly LoadedConfig[]): string[] {
  const names: string[] = [];
  for (const scope of scopes) {
    for (const raw of scope.fields.skills) {
      const name = raw.trim();
      if (name !== "") names.push(name);
    }
  }
  return names;
}

/**
 * 会话的「可用技能」段：作用域链累加的技能名 → 按名解析目录，**恒含系统内置技能**；
 * 无可用技能时仍会列出系统内置技能（本段恒非空，不返回空串）。
 */
export function renderSkillCatalog(
  ws: Workspace,
  scopes: readonly LoadedConfig[],
  extraRoots: readonly string[] = [],
): string {
  const names = skillNamesFrom(scopes);
  const { resolved } = resolveSkillRefs(ws, names, extraRoots);
  return renderSkills(listSkills([...resolved.map((skill) => skill.dir), FRAMEWORK_SKILLS_DIR]));
}
