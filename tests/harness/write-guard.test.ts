import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/domain/access-control.ts";
import { WriteGuard } from "../../src/harness/write-guard.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-guard-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const cwd = path.join(root, "work", "alice");
beforeEach(() => fs.mkdirSync(cwd, { recursive: true }));

function ctx(at = cwd): AccessContext {
  return { root, cwd: at, selfId: "alice", permissions: {} };
}

function guard(): WriteGuard {
  return new WriteGuard(root);
}

function before(g: WriteGuard, conv: string, name: string, at: string, p = cwd) {
  return g.beforeTool(ctx(p), conv, name, name === "bash" ? { command: at } : { path: at });
}

describe("并发写保护", () => {
  it("新文件可以直接写，并记下版本", () => {
    const g = guard();
    expect(before(g, "c1", "write", "new.md")).toBeUndefined();
    fs.writeFileSync(path.join(cwd, "new.md"), "v1");
    g.afterTool(ctx(), "c1", "write", { path: "new.md" }, false);
    // 写成功后版本已刷新，同一会话可以继续写
    expect(before(g, "c1", "write", "new.md")).toBeUndefined();
  });

  it("已存在的文件没读过 → 拦住", () => {
    fs.writeFileSync(path.join(cwd, "note.md"), "old");
    const verdict = before(guard(), "c1", "write", "note.md");
    expect(verdict?.block).toContain("先");
  });

  it("读过之后可以写；写成功后版本刷新", () => {
    fs.writeFileSync(path.join(cwd, "note.md"), "old");
    const g = guard();
    expect(before(g, "c1", "read", "note.md")).toBeUndefined();
    expect(before(g, "c1", "write", "note.md")).toBeUndefined();
    fs.writeFileSync(path.join(cwd, "note.md"), "new");
    g.afterTool(ctx(), "c1", "write", { path: "note.md" }, false);
    expect(before(g, "c1", "write", "note.md")).toBeUndefined();
  });

  it("读过之后文件被改动 → 拦住", () => {
    const file = path.join(cwd, "note.md");
    fs.writeFileSync(file, "old");
    const g = guard();
    before(g, "c1", "read", "note.md");
    fs.writeFileSync(file, "changed by another session");
    const verdict = before(g, "c1", "write", "note.md");
    expect(verdict?.block).toContain("已被其他会话修改");
  });

  it("不同会话之间也互相保护", () => {
    fs.writeFileSync(path.join(cwd, "note.md"), "old");
    const g = guard();
    expect(before(g, "c1", "read", "note.md")).toBeUndefined();
    expect(before(g, "c2", "write", "note.md")?.block).toContain("先");
  });

  it("read 失败不留下版本戳（没真读到就不能写）", () => {
    fs.writeFileSync(path.join(cwd, "note.md"), "old");
    const g = guard();
    expect(before(g, "c1", "read", "note.md")).toBeUndefined();
    g.afterTool(ctx(), "c1", "read", { path: "note.md" }, true);
    expect(before(g, "c1", "write", "note.md")?.block).toContain("先");
  });

  it("写保护只覆盖 work/，其它目录不拦", () => {
    const agents = path.join(root, "agents", "alice");
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(path.join(agents, "note.md"), "old");
    const g = guard();
    expect(before(g, "c1", "write", "note.md", agents)).toBeUndefined();
  });

  it("并发写同一个新文件：后到的会话被拦住", () => {
    const g = guard();
    expect(before(g, "c1", "write", "same.md")).toBeUndefined();
    const verdict = before(g, "c2", "write", "same.md");
    expect(verdict?.block).toContain("正在写");
  });

  it("edit 与 write 同样受保护", () => {
    fs.writeFileSync(path.join(cwd, "note.md"), "old");
    expect(before(guard(), "c1", "edit", "note.md")?.block).toContain("先");
  });

  it("bash 不参与检查", () => {
    fs.writeFileSync(path.join(cwd, "note.md"), "old");
    expect(before(guard(), "c1", "bash", "note.md")).toBeUndefined();
  });
});
