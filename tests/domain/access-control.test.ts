import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { isWriteAllowed, parseMembers, projectsOf, type AccessContext } from "../../src/domain/access-control.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-acl-"));
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
const ws = createWorkspace(tmp);

function member(name: string, lines: string[]) {
  const dir = path.join(tmp, "projects", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "members.md"), ["# 成员", ...lines].join("\n"));
}

function ctx(): AccessContext {
  return { root: ws.root, cwd: path.join(tmp, "projects", "yt"), selfId: "alice", memberProjects: ["yt"] };
}

describe("parseMembers", () => {
  it("读成员，忽略注释与空行，支持 - 前缀", () => {
    member("yt", ["- alice", "bob", "", "# 注释", "* carol"]);
    expect(parseMembers(ws, "yt")).toEqual(["alice", "bob", "carol"]);
  });

  it("members.md 缺失时返回空（权限从严）", () => {
    expect(parseMembers(ws, "missing")).toEqual([]);
  });
});

describe("projectsOf", () => {
  it("找出员工是成员的项目", () => {
    member("yt", ["alice"]);
    member("xhs", ["bob"]);
    expect(projectsOf(ws, "alice")).toEqual(["yt"]);
  });
});

describe("isWriteAllowed", () => {
  it("允许写自己的工作区", () => {
    expect(isWriteAllowed(ctx(), "agents/alice/note.md")).toBe(true);
  });

  it("允许写所在项目（相对 cwd 与绝对路径都行）", () => {
    expect(isWriteAllowed(ctx(), "data/out.md")).toBe(true);
    expect(isWriteAllowed(ctx(), path.join(tmp, "projects", "yt", "data", "out.md"))).toBe(true);
  });

  it("拒绝写别人的工作区或不在的项目", () => {
    expect(isWriteAllowed(ctx(), "agents/bob/x.md")).toBe(false);
    expect(isWriteAllowed(ctx(), "projects/other/x.md")).toBe(false);
  });

  it("拒绝越界写法", () => {
    expect(isWriteAllowed(ctx(), "../../etc/passwd")).toBe(false);
    expect(isWriteAllowed(ctx(), "agents/alice/../bob/x.md")).toBe(false);
    expect(isWriteAllowed(ctx(), "/etc/passwd")).toBe(false);
    expect(isWriteAllowed(ctx(), "")).toBe(false);
  });
});
