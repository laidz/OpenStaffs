import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createWorkspace, projectsDir } from "../../src/domain/paths.ts";
import { listProjects, loadProject } from "../../src/domain/project.ts";
import { parseMembers, projectsOf } from "../../src/domain/access-control.ts";

let root = "";
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-project-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** 项目 = 手写的扁平 config 文件（没有建群 API：老板 / staff0 直接写文件）。 */
function writeProject(id: string, body: unknown): void {
  const ws = createWorkspace(root);
  fs.mkdirSync(projectsDir(ws), { recursive: true });
  fs.writeFileSync(path.join(projectsDir(ws), `${id}.project.config.json`), `${JSON.stringify(body, null, 2)}\n`);
}

test("读项目：alias / members / prompt / permissions（D22/D26）", () => {
  const ws = createWorkspace(root);
  writeProject("yt", { alias: "YouTube 增长", members: ["alice", "bob"], permissions: { write: ["./"] } });
  const project = loadProject(ws, "yt");
  expect(project.alias).toBe("YouTube 增长");
  expect(project.config.fields.members).toEqual(["alice", "bob"]);
  expect(parseMembers(ws, "yt")).toEqual(["alice", "bob"]);
  expect(projectsOf(ws, "alice")).toEqual(["yt"]);
});

test("alias 缺省 = id；缺失 / 坏 JSON → 成员为空、列表里也不出现", () => {
  const ws = createWorkspace(root);
  writeProject("xhs-01", { members: [] });
  expect(loadProject(ws, "xhs-01").alias).toBe("xhs-01");
  expect(parseMembers(ws, "nope")).toEqual([]);
  expect(listProjects(ws).map((project) => project.id)).toEqual(["xhs-01"]);
  fs.writeFileSync(path.join(projectsDir(ws), "broken.project.config.json"), "{坏");
  expect(listProjects(ws).map((project) => project.id)).toEqual(["xhs-01"]);
  expect(parseMembers(ws, "broken")).toEqual([]);
});

test("列表按 id 排序；坏 JSON 跳过，其余照读", () => {
  const ws = createWorkspace(root);
  writeProject("beta", { members: ["alice"] });
  writeProject("alpha", { alias: "阿尔法", members: ["bob"] });
  expect(listProjects(ws).map((project) => project.id)).toEqual(["alpha", "beta"]);
  expect(listProjects(ws).map((project) => project.alias)).toEqual(["阿尔法", "beta"]);
  fs.writeFileSync(path.join(projectsDir(ws), "beta.project.config.json"), "{坏");
  expect(listProjects(ws).map((project) => project.id)).toEqual(["alpha"]);
});
