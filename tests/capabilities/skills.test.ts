import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { renderSkillCatalog, resolveSkillRefs, skillNamesFrom } from "../../src/capabilities/skills.ts";
import { FRAMEWORK_SKILLS_DIR } from "../../src/domain/skills.ts";
import { emptyConfigFields, type LoadedConfig, type ScopeKind } from "../../src/config/schema.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-skillref-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function skill(dir: string, name: string): void {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\n---\n正文`);
}

/** 夹具：一层作用域配置（只关心 skills 字段）。 */
function loaded(scope: ScopeKind, id: string, skills: string[]): LoadedConfig {
  return {
    scope,
    id,
    file: path.join(root, "fake", `${id}.config.json`),
    baseDir: root,
    fields: { ...emptyConfigFields(), skills },
    issues: [],
  };
}

test("按名解析到 openstaffs/skills/<技能名>/；缺失进 missing（不崩）", () => {
  const ws = createWorkspace(root);
  const spaceSkills = path.join(root, "openstaffs", "skills");
  skill(spaceSkills, "report");
  const result = resolveSkillRefs(ws, ["report", "nope", "report"]);
  expect(result.resolved).toEqual([{ name: "report", dir: path.join(spaceSkills, "report") }]);
  expect(result.missing).toEqual(["nope"]);
});

test("missing 也去重保序（先出现者胜）", () => {
  const ws = createWorkspace(root);
  const result = resolveSkillRefs(ws, ["nope", "nope"]);
  expect(result.resolved).toEqual([]);
  expect(result.missing).toEqual(["nope"]);
});

test("外部技能根作为后备（老板配的 skillPaths），同名先命中者胜", () => {
  const ws = createWorkspace(root);
  const extra = path.join(root, "external-skills");
  skill(path.join(root, "openstaffs", "skills"), "report");
  skill(extra, "report");
  skill(extra, "only-external");
  expect(resolveSkillRefs(ws, ["report"]).resolved[0]!.dir).toBe(path.join(root, "openstaffs", "skills", "report"));
  expect(resolveSkillRefs(ws, ["only-external"], [extra]).resolved[0]!.dir).toBe(path.join(extra, "only-external"));
});

test("不安全的技能名（含 / 或 .. 或点开头）→ missing，不探测目录", () => {
  const ws = createWorkspace(root);
  expect(resolveSkillRefs(ws, ["../etc", "a/b", ".hidden"]).missing).toEqual(["../etc", "a/b", ".hidden"]);
});

test("skillNamesFrom：各层 skills 累加、保序、不去重、空串丢弃（D10）", () => {
  const names = skillNamesFrom([
    loaded("space", "space", ["a", "b"]),
    loaded("department", "eng", ["b", "  "]),
    loaded("project", "yt", [""]),
    loaded("agent", "alice", ["c"]),
  ]);
  expect(names).toEqual(["a", "b", "b", "c"]);
});

test("skillNamesFrom：没有配置层 → 空数组", () => {
  expect(skillNamesFrom([])).toEqual([]);
});

test("renderSkillCatalog：按名解析各层技能；名字不存在 → 跳过（不崩）；恒含系统内置", () => {
  const ws = createWorkspace(root);
  skill(path.join(root, "openstaffs", "skills"), "report");
  const text = renderSkillCatalog(ws, [
    loaded("space", "space", ["report", "nope"]),
    loaded("agent", "alice", ["also-nope", ""]),
  ]);
  expect(text).toContain(path.join(root, "openstaffs", "skills", "report", "SKILL.md"));
  expect(text).not.toContain("nope");
  // 系统内置技能恒含（不受 config 引用影响）
  expect(text).toContain(path.join(FRAMEWORK_SKILLS_DIR, "openstaffs", "SKILL.md"));
});

test("renderSkillCatalog：同名重复只出一份（先出现者胜）", () => {
  const ws = createWorkspace(root);
  skill(path.join(root, "openstaffs", "skills"), "dup");
  const text = renderSkillCatalog(ws, [
    loaded("space", "space", ["dup"]),
    loaded("department", "eng", ["dup"]),
    loaded("agent", "alice", ["dup", "dup"]),
  ]);
  // 同一技能只列一份：按其 SKILL.md 路径出现次数计数（不依赖条目前缀格式）
  const dupPath = path.join(root, "openstaffs", "skills", "dup", "SKILL.md");
  expect(text.split(dupPath).length - 1).toBe(1);
});

test("renderSkillCatalog：外部技能根作为后备（空间目录缺席时命中外部库）", () => {
  const ws = createWorkspace(root);
  const extra = path.join(root, "external-skills");
  skill(extra, "only-external");
  const withoutExtra = renderSkillCatalog(ws, [loaded("agent", "alice", ["only-external"])]);
  expect(withoutExtra).not.toContain("only-external");
  const withExtra = renderSkillCatalog(ws, [loaded("agent", "alice", ["only-external"])], [extra]);
  expect(withExtra).toContain(path.join(extra, "only-external", "SKILL.md"));
});
