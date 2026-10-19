import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createWorkspace, spaceSkillsDir } from "../../src/domain/paths.ts";
import { FRAMEWORK_SKILLS_DIR } from "../../src/domain/skills.ts";
import { runtimeGrantsFor } from "../../src/permissions/runtime.ts";

/** agents/eng（head=alice），alice 在 eng；bob 也在 eng 但不是任何部门的 head。 */
function seedWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-perm-runtime-"));
  fs.mkdirSync(path.join(root, "agents", "eng"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", "eng", "department.config.json"), JSON.stringify({ head: ["alice"] }));
  for (const id of ["alice", "bob"]) {
    fs.writeFileSync(path.join(root, "agents", "eng", `${id}.agent.config.json`), JSON.stringify({ model: "x" }));
  }
  return root;
}

test("主管：管理部门目录（+ 其人所在目录）进 managedWriteDirs；技能根进 readRoots", () => {
  const ws = createWorkspace(seedWorkspace());
  const grants = runtimeGrantsFor({ ws, agentId: "alice", workdir: "/office/work/alice", extraReadRoots: ["/extra"] });
  expect(grants.workdir).toBe("/office/work/alice");
  expect(grants.readRoots).toEqual([spaceSkillsDir(ws), "/extra", FRAMEWORK_SKILLS_DIR]);
  expect(new Set(grants.managedWriteDirs)).toEqual(new Set([path.join(ws.root, "agents", "eng")]));
});

test("非主管：managedWriteDirs 为空（不是任何部门 head）", () => {
  const ws = createWorkspace(seedWorkspace());
  const grants = runtimeGrantsFor({ ws, agentId: "bob", workdir: "/office/work/bob" });
  expect(grants.managedWriteDirs).toEqual([]);
  expect(grants.readRoots).toEqual([spaceSkillsDir(ws), FRAMEWORK_SKILLS_DIR]);
});
