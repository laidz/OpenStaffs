import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { KeyedQueue } from "../../src/app/send.ts";
import { PermissionRequestStore, readPermissionRequests } from "../../src/domain/permission-requests.ts";
import { PermissionRequestNotFoundError, permissionFilePath, permissionRequestView, resolvePermissionRequest } from "../../src/app/permission-flow.ts";
import type { ChatMessage, ConversationSpec, HarnessPort, InputMeta } from "../../src/harness/port.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-flow-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function seedEmployee(id: string, alias?: string): void {
  const dir = path.join(root, "agents", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "AGENTS.md"), `你是 ${id}。`);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ model: "faux/faux-model", ...(alias === undefined ? {} : { alias }) }));
}

function seedGroup(project: string, members: string[]): void {
  const dir = path.join(root, "projects", project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "members.md"), ["# 成员", ...members.map((m) => `- ${m}`), ""].join("\n"));
}

class FakePort implements HarnessPort {
  readonly starts: ConversationSpec[] = [];
  readonly submits: { convId: string; text: string; meta?: InputMeta }[] = [];
  async open(): Promise<void> {}
  async close(): Promise<void> {}
  async startSession(spec: ConversationSpec): Promise<string> {
    this.starts.push(spec);
    return `conv-${this.starts.length}`;
  }
  async attach(convId: string): Promise<boolean> { return convId.startsWith("conv-"); }
  async append(): Promise<void> {}
  async abort(): Promise<void> {}
  sessionInfo(): undefined { return undefined; }
  async sessionUsage(): Promise<never> { throw new Error("FakePort 不提供会话信息"); }
  async submit(convId: string, text: string, meta?: InputMeta) {
    this.submits.push({ convId, text, meta });
    return { id: `sub-${this.submits.length}`, status: "placed" as const };
  }
  async withdrawSubmission(): Promise<boolean> { return false; }
  async watch(): Promise<() => Promise<void>> { return async () => {}; }
  async send(convId: string, text: string): Promise<ChatMessage> { return { id: "x", role: "assistant", text }; }
  async transcript(): Promise<ChatMessage[]> { return []; }
}

const defaults = { model: "faux/faux-model" };

function setup() {
  const ws = createWorkspace(root);
  const store = new PermissionRequestStore(ws);
  const port = new FakePort();
  const register = vi.fn(async () => {});
  const broadcast = vi.fn();
  const deps = { ws, harness: port, store, queue: new KeyedQueue(), defaults, register, broadcast };
  return { ws, store, port, register, broadcast, deps };
}

describe("授权请求处理", () => {
  it("accept：写员工 permission.json、投递「已完成授权」（老板形态 + 去重键）、清请求、广播", async () => {
    seedEmployee("alice", "爱丽丝");
    const { ws, store, port, register, broadcast, deps } = setup();
    const target = path.join(root, "outside", "shared");
    const request = store.add({ agentId: "alice", roomKey: "dm:alice", paths: [target], reason: "要写共享目录" });

    const result = await resolvePermissionRequest(deps, request.id, "accept");
    expect(result).toEqual({ ok: true });
    expect(JSON.parse(fs.readFileSync(permissionFilePath(ws, "alice"), "utf8"))).toEqual([target]);
    expect(port.submits).toHaveLength(1);
    expect(port.submits[0]!.text).toBe("已完成授权");
    expect(port.submits[0]!.meta?.kind).toBe("chat.message");
    expect(port.submits[0]!.meta?.requestId).toBe(`permission:${request.id}`);
    expect((port.submits[0]!.meta?.data as { author?: string }).author).toBe("boss");
    expect(register).toHaveBeenCalledWith("conv-1", { roomKey: "dm:alice", memberId: "alice" });
    expect(broadcast).toHaveBeenCalledWith(request.id);
    expect(store.list()).toEqual([]);
    expect(readPermissionRequests(ws)).toEqual([]);
  });

  it("reject：不写任何文件、投递「已拒绝授权」", async () => {
    seedEmployee("alice");
    const { ws, store, port, deps } = setup();
    const request = store.add({ agentId: "alice", roomKey: "dm:alice", paths: [path.join(root, "x")], reason: "r" });

    const result = await resolvePermissionRequest(deps, request.id, "reject");
    expect(result).toEqual({ ok: true });
    expect(fs.existsSync(permissionFilePath(ws, "alice"))).toBe(false);
    expect(port.submits[0]!.text).toBe("已拒绝授权");
    expect(store.list()).toEqual([]);
  });

  it("发起者目录已不存在：accept 抛 NotFound（不落文件、不投递、请求保留）；reject 可清理", async () => {
    const { ws, store, port, deps } = setup();
    const request = store.add({ agentId: "ghost", roomKey: "dm:ghost", paths: [path.join(root, "x")], reason: "r" });
    await expect(resolvePermissionRequest(deps, request.id, "accept")).rejects.toThrow(PermissionRequestNotFoundError);
    expect(store.get(request.id)).toBeDefined();
    expect(fs.existsSync(path.join(root, "agents", "ghost"))).toBe(false);
    expect(port.submits).toEqual([]);
    await resolvePermissionRequest(deps, request.id, "reject"); // 拒绝不检查目录，可清卡片
    expect(store.get(request.id)).toBeUndefined();
  });

  it("群聊：投递文本以 @<agentId> 开头（只触发该成员）", async () => {
    seedEmployee("alice");
    seedGroup("yt", ["alice"]);
    const { store, port, deps } = setup();
    const request = store.add({ agentId: "alice", roomKey: "group:yt", paths: [path.join(root, "x")], reason: "r" });

    await resolvePermissionRequest(deps, request.id, "accept");
    expect(port.submits[0]!.text).toBe("@alice 已完成授权");
  });

  it("未知 id / 并发同 id → PermissionRequestNotFoundError；并发只有一个成功", async () => {
    seedEmployee("alice");
    const { store, deps } = setup();
    await expect(resolvePermissionRequest(deps, "pr_none", "accept")).rejects.toThrow(PermissionRequestNotFoundError);

    const request = store.add({ agentId: "alice", roomKey: "dm:alice", paths: [path.join(root, "x")], reason: "r" });
    const first = resolvePermissionRequest(deps, request.id, "accept");
    const second = resolvePermissionRequest(deps, request.id, "accept");
    await expect(second).rejects.toThrow(PermissionRequestNotFoundError);
    await first;
  });

  it("写盘失败：抛错、请求保留、不投递、不广播", async () => {
    // agents/alice 是文件（不是目录）→ appendPermissionPaths 的 mkdir 失败
    fs.mkdirSync(path.join(root, "agents"), { recursive: true });
    fs.writeFileSync(path.join(root, "agents", "alice"), "not a dir");
    const { store, port, broadcast, deps } = setup();
    const request = store.add({ agentId: "alice", roomKey: "dm:alice", paths: [path.join(root, "x")], reason: "r" });

    await expect(resolvePermissionRequest(deps, request.id, "accept")).rejects.toThrow();
    expect(store.get(request.id)).toBeDefined();
    expect(port.submits).toEqual([]);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("投递失败：授权已生效、请求仍移除、返回 warning", async () => {
    seedEmployee("alice");
    const { ws, store, port, broadcast, deps } = setup();
    port.submit = async () => {
      throw new Error("投递炸了");
    };
    const target = path.join(root, "outside");
    const request = store.add({ agentId: "alice", roomKey: "dm:alice", paths: [target], reason: "r" });

    const result = await resolvePermissionRequest(deps, request.id, "accept");
    expect(result.ok).toBe(true);
    expect(result.warning).toContain("通知消息投递失败");
    expect(JSON.parse(fs.readFileSync(permissionFilePath(ws, "alice"), "utf8"))).toEqual([target]);
    expect(store.list()).toEqual([]);
    expect(broadcast).toHaveBeenCalledWith(request.id);
  });
});

describe("permissionRequestView", () => {
  it("补 agentName（alias 回落 id）", () => {
    const ws = createWorkspace(root);
    seedEmployee("bob", "Bob哥");
    const view = permissionRequestView(ws, { id: "pr_x", agentId: "bob", roomKey: "dm:bob", paths: ["/x"], reason: "r", createdAt: "t" });
    expect(view.agentName).toBe("Bob哥");
    const ghost = permissionRequestView(ws, { id: "pr_y", agentId: "ghost", roomKey: "dm:ghost", paths: ["/x"], reason: "r", createdAt: "t" });
    expect(ghost.agentName).toBe("ghost");
  });
});
