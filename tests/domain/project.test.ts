import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createWorkspace, projectsDir } from "../../src/domain/paths.ts";
import { createProject, listProjects, loadProject } from "../../src/domain/project.ts";
import { parseMembers, projectsOf } from "../../src/domain/access-control.ts";
import { defaultPermissionTable } from "../../src/permissions/defaults.ts";

let root = "";
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-project-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test("建群 = 写扁平 config：alias / members / prompt / 默认 permissions（D14/D22/D26）", () => {
  const ws = createWorkspace(root);
  createProject(ws, "yt", ["alice", "bob"], "YouTube 增长");
  const file = path.join(projectsDir(ws), "yt.project.config.json");
  expect(fs.existsSync(file)).toBe(true);
  expect(fs.existsSync(path.join(root, "projects", "yt"))).toBe(false);
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
    alias: "YouTube 增长",
    members: ["alice", "bob"],
    permissions: defaultPermissionTable(),
  });
  expect(parseMembers(ws, "yt")).toEqual(["alice", "bob"]);
  expect(projectsOf(ws, "alice")).toEqual(["yt"]);
});

test("alias 缺省 = id；重复立项抛错；缺失/坏 JSON → 成员为空、列表里也不出现", () => {
  const ws = createWorkspace(root);
  createProject(ws, "xhs-01", []);
  expect(loadProject(ws, "xhs-01").alias).toBe("xhs-01");
  expect(() => createProject(ws, "xhs-01", [])).toThrow();
  expect(parseMembers(ws, "nope")).toEqual([]);
  expect(listProjects(ws).map((project) => project.id)).toEqual(["xhs-01"]);
  fs.writeFileSync(path.join(projectsDir(ws), "broken.project.config.json"), "{坏");
  expect(listProjects(ws).map((project) => project.id)).toEqual(["xhs-01"]);
  expect(parseMembers(ws, "broken")).toEqual([]);
});

test("alias 两端空白被 trim；非法 id 抛错（含内部空白/制表符）", () => {
  const ws = createWorkspace(root);
  createProject(ws, "trim-p", [], "  YouTube  ");
  expect(loadProject(ws, "trim-p").alias).toBe("YouTube");
  for (const bad of ["", "  ", "a/b", "a\\b", "..", ".", ".hidden", "a/../b", "a b ", "a b", "a\tb"]) {
    expect(() => createProject(ws, bad, [])).toThrow("项目 id");
  }
});

test("列表按 id 排序；坏 JSON 跳过，其余照读", () => {
  const ws = createWorkspace(root);
  createProject(ws, "beta", ["alice"]);
  createProject(ws, "alpha", ["bob"], "阿尔法");
  expect(listProjects(ws).map((project) => project.id)).toEqual(["alpha", "beta"]);
  expect(listProjects(ws).map((project) => project.alias)).toEqual(["阿尔法", "beta"]);
  fs.writeFileSync(path.join(projectsDir(ws), "beta.project.config.json"), "{坏");
  expect(listProjects(ws).map((project) => project.id)).toEqual(["alpha"]);
});
