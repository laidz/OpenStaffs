import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { resolveSkillRefs } from "../../src/capabilities/skills.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-skillref-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function skill(dir: string, name: string): void {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\n---\n正文`);
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
