import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { parseMembers } from "../../src/domain/access-control.ts";
import { createProject } from "../../src/domain/project.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-proj-"));
beforeEach(() => { fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root, { recursive: true }); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const ws = createWorkspace(root);

describe("createProject", () => {
  it("创建项目目录（AGENTS.md + data/ + members.md + project.json）", () => {
    createProject(ws, "yt-001", ["alice", "bob"], "YouTube 增长");
    const dir = path.join(root, "projects", "yt-001");
    expect(fs.existsSync(path.join(dir, "AGENTS.md"))).toBe(true);
    expect(fs.statSync(path.join(dir, "data")).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(dir, "members.md"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"))).toEqual({ alias: "YouTube 增长" });
    expect(parseMembers(ws, "yt-001")).toEqual(["alice", "bob"]);
  });

  it("alias 缺省 = id", () => {
    createProject(ws, "xhs-01", []);
    expect(JSON.parse(fs.readFileSync(path.join(root, "projects", "xhs-01", "project.json"), "utf8"))).toEqual({ alias: "xhs-01" });
    expect(parseMembers(ws, "xhs-01")).toEqual([]);
  });

  it("项目已存在时报错", () => {
    createProject(ws, "dup", []);
    expect(() => createProject(ws, "dup", [])).toThrow("项目已存在");
  });

  it("非法 id 报错", () => {
    for (const bad of ["", "  ", "a/b", "a\\b", "..", ".", ".hidden", "a/../b", "a b "]) {
      expect(() => createProject(ws, bad, [])).toThrow("项目 id");
    }
  });
});
