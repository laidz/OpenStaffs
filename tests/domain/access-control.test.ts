import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { isProtectedConfigName, isWriteAllowed, parseMembers, projectsOf, type AccessContext } from "../../src/domain/access-control.ts";

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
    writableDirs: [],
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
  it("运行时目录（自己的工作目录）可写；目录外仍拒绝", () => {
    const work = path.join(tmp, "work", "alice");
    const c = ctx({ cwd: work, writableDirs: [work] });
    expect(isWriteAllowed(c, "note.md")).toBe(true);
    expect(isWriteAllowed(c, "sub/a.md")).toBe(true);
    expect(isWriteAllowed(c, path.join(tmp, "agents", "bob.agent.config.json"))).toBe(false);
  });

  it("主管穿透：管理子树内可写（含孙级），兄弟部门 / 子树外不可写", () => {
    const managed = path.join(tmp, "agents", "eng");
    const boss = ctx({ cwd: path.join(tmp, "work", "alice"), writableDirs: [path.join(tmp, "work", "alice"), managed] });
    expect(isWriteAllowed(boss, path.join(tmp, "agents", "eng", "platform", "notes.md"))).toBe(true);
    expect(isWriteAllowed(boss, path.join(tmp, "agents", "sales", "notes.md"))).toBe(false);
    expect(isWriteAllowed(boss, path.join(tmp, "agents", "eng", "alice.agent.config.json"))).toBe(false); // 配置文件不可写
    expect(isWriteAllowed(boss, path.join(tmp, "agents", "eng", "department.config.json"))).toBe(false);
  });

  it("受保护的配置文件名一律不可写（含人级权限文件与部门声明）", () => {
    const c = ctx({ cwd: tmp, writableDirs: [tmp] });
    expect(isWriteAllowed(c, "agents/alice.agent.config.json")).toBe(false);
    expect(isWriteAllowed(c, "agents/eng/department.config.json")).toBe(false);
    expect(isWriteAllowed(c, "agents/alice.permission.json")).toBe(false);
    expect(isWriteAllowed(c, "projects/yt/permission.json")).toBe(false);
    expect(isProtectedConfigName("bob.agent.config.json")).toBe(true);
    expect(isProtectedConfigName("notes.md")).toBe(false);
  });

  it("受保护配置名的大小写变体同样不可写（目标卷可能大小写不敏感）", () => {
    const c = ctx({ cwd: tmp, writableDirs: [tmp] });
    expect(isProtectedConfigName("Bob.AGENT.CONFIG.JSON")).toBe(true);
    expect(isProtectedConfigName("PERMISSION.JSON")).toBe(true);
    expect(isWriteAllowed(c, "agents/Bob.AGENT.CONFIG.JSON")).toBe(false);
    expect(isWriteAllowed(c, "agents/eng/DEPARTMENT.CONFIG.JSON")).toBe(false);
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
