import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspace, messagesDbFile, stateDir } from "../../src/domain/paths.ts";
import { loadPerson } from "../../src/domain/org.ts";
import { agentPermissionFileOf } from "../../src/app/conversations.ts";
import { KeyedQueue } from "../../src/app/send.ts";
import { PermissionRequestStore, readPermissionRequests } from "../../src/domain/permission-requests.ts";
import { PermissionRequestNotFoundError, permissionFilePath, permissionRequestView, resolvePermissionRequest } from "../../src/app/permission-flow.ts";
import type { RoomMessage } from "../../src/app/rooms.ts";
import { openMessageStore, type MessageStore } from "../../src/store/messages.ts";
import type { ChatMessage, ConversationSpec, HarnessPort, InputMeta } from "../../src/harness/port.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-flow-"));
/** 用例里开的自有消息库实例（afterEach 关闭，避免句柄泄漏）。 */
const stores: MessageStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** 人 = `agents/[<部门>/]<id>.agent.config.json`（dept 缺省 = 根部 agents/）。 */
function seedEmployee(id: string, alias?: string, dept?: string): void {
  const dir = dept === undefined ? path.join(root, "agents") : path.join(root, "agents", dept);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.agent.config.json`),
    JSON.stringify({ model: "faux/faux-model", prompt: `你是 ${id}。`, ...(alias === undefined ? {} : { alias }) }),
  );
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
  const broadcastMessage = vi.fn<(roomKey: string, message: RoomMessage) => void>();
  // 自有消息库（P1）：审批结果也落库（对齐 http.ts 注入）。openMessageStore 不建父目录 → 先建 stateDir。
  fs.mkdirSync(stateDir(ws), { recursive: true });
  const messages = openMessageStore(messagesDbFile(ws));
  stores.push(messages);
  const deps = { ws, harness: port, store, queue: new KeyedQueue(), defaults, register, broadcast, messages, broadcastMessage };
  return { ws, store, port, register, broadcast, broadcastMessage, messages, deps };
}

describe("授权请求处理", () => {
  it("accept：写人级 permission.json（<人所在目录>/<id>.permission.json），投递「已完成授权」、清请求、广播", async () => {
    seedEmployee("alice", "爱丽丝", "eng"); // 人落在 agents/eng/
    const { ws, store, port, register, broadcast, deps } = setup();
    const target = path.join(root, "outside", "shared");
    const request = store.add({ agentId: "alice", roomKey: "dm:alice", paths: [target], reason: "要写共享目录" });

    const result = await resolvePermissionRequest(deps, request.id, "accept");
    expect(result).toEqual({ ok: true });
    expect(permissionFilePath(ws, "alice")).toBe(path.join(root, "agents", "eng", "alice.permission.json"));
    expect(JSON.parse(fs.readFileSync(permissionFilePath(ws, "alice"), "utf8"))).toEqual([target]);
    // 与装配层的落点函数同源（R-P2-5）：授权文件与人定义同目录、同主干
    expect(agentPermissionFileOf(loadPerson(ws, "alice"))).toBe(permissionFilePath(ws, "alice"));
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

  it("accept：审批结果消息落库并广播库行（老板形态、键 store:<seq>）", async () => {
    seedEmployee("alice", "爱丽丝");
    const { store, messages, broadcastMessage, deps } = setup();
    const request = store.add({ agentId: "alice", roomKey: "dm:alice", paths: [path.join(root, "outside")], reason: "r" });

    await resolvePermissionRequest(deps, request.id, "accept");

    const rows = messages.listByRoom("dm:alice");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ room: "dm:alice", projectId: null, fromId: "__boss", toIds: ["alice"], text: "已完成授权" });
    expect(broadcastMessage).toHaveBeenCalledTimes(1);
    const [roomKey, message] = broadcastMessage.mock.calls[0]!;
    expect(roomKey).toBe("dm:alice");
    expect(message).toMatchObject({ convId: "store", entryId: String(rows[0]!.seq), speaker: { kind: "boss" }, text: "已完成授权" });
    // 与 HTTP 发送同口径：广播附仅 UI 用的 roomMessageId（不入库），「排队中」占位据此贴真气泡。
    expect(message.roomMessageId).toMatch(/^rm_/u);
    expect(rows[0]).not.toHaveProperty("roomMessageId");
  });

  it("群聊 accept：库行广播带重建头部 @（@alice 已完成授权）", async () => {
    seedEmployee("alice");
    seedGroup("yt", ["alice"]);
    const { store, messages, broadcastMessage, deps } = setup();
    const request = store.add({ agentId: "alice", roomKey: "group:yt", paths: [path.join(root, "x")], reason: "r" });

    await resolvePermissionRequest(deps, request.id, "accept");

    const rows = messages.listByRoom("group:yt");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ projectId: "yt", fromId: "__boss", toIds: ["alice"], text: "已完成授权" });
    expect(broadcastMessage).toHaveBeenCalledTimes(1);
    expect(broadcastMessage.mock.calls[0]![1]).toMatchObject({ convId: "store", text: "@alice 已完成授权" });
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

  it("发起者已不存在：accept 抛 NotFound（不落文件、不投递、请求保留）；reject 可清理", async () => {
    const { ws, store, port, deps } = setup();
    const request = store.add({ agentId: "ghost", roomKey: "dm:ghost", paths: [path.join(root, "x")], reason: "r" });
    await expect(resolvePermissionRequest(deps, request.id, "accept")).rejects.toThrow(PermissionRequestNotFoundError);
    expect(store.get(request.id)).toBeDefined();
    // 找不到人 → 回落 agents/ghost.permission.json（依旧不存在）
    expect(fs.existsSync(permissionFilePath(ws, "ghost"))).toBe(false);
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
    // 人级权限文件 `agents/eng/alice.permission.json` 的位置被同名**目录**占着 →
    // appendPermissionPaths 的落盘（写临时文件后 rename）失败
    seedEmployee("alice", undefined, "eng");
    fs.mkdirSync(path.join(root, "agents", "eng", "alice.permission.json"), { recursive: true });
    const { store, port, broadcast, deps } = setup();
    const request = store.add({ agentId: "alice", roomKey: "dm:alice", paths: [path.join(root, "x")], reason: "r" });

    await expect(resolvePermissionRequest(deps, request.id, "accept")).rejects.toThrow();
    expect(store.get(request.id)).toBeDefined();
    expect(port.submits).toEqual([]);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("投递失败：授权已生效、请求仍移除、返回 warning", async () => {
    seedEmployee("alice");
    const { ws, store, port, broadcast, broadcastMessage, deps } = setup();
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
    expect(broadcastMessage).not.toHaveBeenCalled(); // 没落库就没有库行可广播
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
