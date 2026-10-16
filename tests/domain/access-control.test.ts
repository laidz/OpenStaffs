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

function ctx(extra: Partial<AccessContext> = {}): AccessContext {
  return {
    root: ws.root,
    cwd: path.join(tmp, "projects", "yt"),
    selfId: "alice",
    memberProjects: ["yt"],
    permissionFiles: [],
    ...extra,
  };
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
  it("允许写自己的工作区（私聊 cwd = 员工目录）", () => {
    const c = ctx({ cwd: path.join(tmp, "agents", "alice") });
    expect(isWriteAllowed(c, "note.md")).toBe(true);
    expect(isWriteAllowed(c, "data/x.md")).toBe(true);
  });

  it("允许写所在项目（群聊 cwd = 项目目录）", () => {
    expect(isWriteAllowed(ctx(), "data/out.md")).toBe(true);
    expect(isWriteAllowed(ctx(), path.join(tmp, "projects", "yt", "data", "out.md"))).toBe(true);
  });

  it("相对 path 一律按 cwd 解析（与工具落点一致）", () => {
    expect(isWriteAllowed(ctx(), "agents/bob/x.md")).toBe(true);
    expect(isWriteAllowed(ctx(), "projects/other/x.md")).toBe(true);
  });

  it("拒绝真正的工作区外（爬到根外或绝对外部）", () => {
    expect(isWriteAllowed(ctx(), "../../agents/bob/x.md")).toBe(false);
    expect(isWriteAllowed(ctx(), "../../etc/passwd")).toBe(false);
    expect(isWriteAllowed(ctx(), "/etc/passwd")).toBe(false);
    expect(isWriteAllowed(ctx(), "")).toBe(false);
  });

  it("permission.json 授权可写界外", () => {
    const perm = path.join(tmp, "projects", "yt", "permission.json");
    fs.mkdirSync(path.dirname(perm), { recursive: true });
    fs.writeFileSync(perm, JSON.stringify(["../../agents/bob/"]));
    const c = ctx({ permissionFiles: [perm] });
    expect(isWriteAllowed(c, "../../agents/bob/x.md")).toBe(true);
    expect(isWriteAllowed(c, "../../agents/carol/x.md")).toBe(false);
  });

  it("授权文件损坏 → 退回基线，不放大权限", () => {
    const c = ctx({ permissionFiles: [path.join(tmp, "projects", "yt", "nope.json")] });
    expect(isWriteAllowed(c, "../../agents/bob/x.md")).toBe(false);
  });

  it("拒绝写任何 permission.json（授权文件由老板维护，防止自写提权）", () => {
    expect(isWriteAllowed(ctx(), "permission.json")).toBe(false);
    const self = ctx({ cwd: path.join(tmp, "agents", "alice") });
    expect(isWriteAllowed(self, "permission.json")).toBe(false);
    const grant = path.join(tmp, "projects", "yt", "grant.json");
    fs.mkdirSync(path.dirname(grant), { recursive: true });
    fs.writeFileSync(grant, JSON.stringify(["../../"]));
    const g = ctx({ permissionFiles: [grant] });
    expect(isWriteAllowed(g, "../../agents/alice/permission.json")).toBe(false);
  });
});
