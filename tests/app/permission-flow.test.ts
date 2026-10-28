import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspace, officeDbFile, stateDir } from "../../src/domain/paths.ts";
import { KeyedQueue } from "../../src/app/send.ts";
import { PermissionRequestStore, readPermissionRequests } from "../../src/domain/permission-requests.ts";
import { PermissionRequestNotFoundError, permissionRequestView, resolvePermissionRequest } from "../../src/app/permission-flow.ts";
import { seedOffice } from "../helpers/office.ts";
import type { MeetingMessage } from "../../src/app/meeting-messages.ts";
import { openMessageStore, type MessageStore } from "../../src/store/messages.ts";
import { openSessionStore, type SessionStore } from "../../src/store/sessions.ts";
import { openMeetingStore, type MeetingStore } from "../../src/store/meetings.ts";
import { ensureMeeting } from "../../src/app/meetings.ts";
import type { ChatMessage, ConversationSpec, HarnessPort, InputMeta } from "../../src/harness/port.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-flow-"));
/** 用例里开的自有消息库实例（afterEach 关闭，避免句柄泄漏）。 */
const stores: MessageStore[] = [];
/** 用例里开的会话表实例（同上）。 */
const sessionStores: SessionStore[] = [];
/** 用例里开的会议表实例（同上）。 */
const meetingStores: MeetingStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const store of sessionStores.splice(0)) store.close();
  for (const store of meetingStores.splice(0)) store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** 人 = `agents/[<部门>/]<id>.agent.config.json`（dept 缺省 = 根部 agents/）。 */
function seedEmployee(id: string, alias?: string, dept?: string): void {
  seedOffice(root, {
    agents: [{
      id,
      ...(dept === undefined ? {} : { department: dept }),
      ...(alias === undefined ? {} : { alias }),
      model: "faux/faux-model",
      prompt: `你是 ${id}。`,
    }],
  });
}

/** 群 = `projects/<id>.project.config.json` 的 members（D22 扁平 config）。 */
function seedGroup(project: string, members: string[]): void {
  seedOffice(root, { projects: [{ id: project, members }] });
}

/** 人配置的落点（授权追加目标）。 */
function agentConfigPath(id: string, dept?: string): string {
  return dept === undefined
    ? path.join(root, "agents", `${id}.agent.config.json`)
    : path.join(root, "agents", dept, `${id}.agent.config.json`);
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
  bindSession(): void {}
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
  async context(): Promise<{ instructions: string; items: never[] }> {
    return { instructions: "", items: [] };
  }

  async transcript(): Promise<ChatMessage[]> { return []; }
}

const defaults = { model: "faux/faux-model" };

function setup() {
  const ws = createWorkspace(root);
  const store = new PermissionRequestStore(ws);
  const port = new FakePort();
  const register = vi.fn(async () => {});
  const broadcast = vi.fn();
  const broadcastMessage = vi.fn<(meetingId: string, message: MeetingMessage) => void>();
  // 自有消息库（P1）：审批结果也落库（对齐 http.ts 注入）。openMessageStore 不建父目录 → 先建 stateDir。
  fs.mkdirSync(stateDir(ws), { recursive: true });
  const messages = openMessageStore(officeDbFile(ws));
  stores.push(messages);
  const meetings = openMeetingStore(officeDbFile(ws));
  meetingStores.push(meetings);
  const sessions = openSessionStore(officeDbFile(ws));
  sessionStores.push(sessions);
  /** 该主题的进行中会议（授权请求挂在它上面）。 */
  const meetingFor = (relation: { kind: "dm"; employeeId: string } | { kind: "group"; project: string }) =>
    ensureMeeting({ ws, meetings }, relation, new Date("2026-10-26T10:00:00.000Z"));
  const deps = { ws, harness: port, store, queue: new KeyedQueue(), defaults, register, broadcast, messages, broadcastMessage, sessions, meetings };
  return { ws, store, port, register, broadcast, broadcastMessage, messages, meetings, meetingFor, deps };
}

describe("授权请求处理", () => {
  it("accept：把路径追加进发起者 agent config 的 permissions.write，其余字段不动", async () => {
    seedEmployee("alice", "爱丽丝", "eng"); // 人落在 agents/eng/
    const { ws, store, port, register, broadcast, meetingFor, deps } = setup();
    const target = path.join(root, "outside", "shared");
    const { request } = store.add({ agentId: "alice", meetingId: meetingFor({ kind: "dm", employeeId: "alice" }).meetingId, tools: ["write"], paths: [target], reason: "要写共享目录" });

    const result = await resolvePermissionRequest(deps, request.id, "accept");
    expect(result).toEqual({ ok: true });
    const parsed = JSON.parse(fs.readFileSync(agentConfigPath("alice", "eng"), "utf8")) as Record<string, unknown>;
    expect(parsed.prompt).toBe("你是 alice。");
    expect(parsed.alias).toBe("爱丽丝");
    expect(parsed.model).toBe("faux/faux-model");
    expect(parsed.permissions).toEqual({ write: [target] });
    expect(port.submits).toHaveLength(1);
    expect(port.submits[0]!.text).toBe("已完成授权");
    expect(port.submits[0]!.meta?.kind).toBe("chat.message");
    expect(port.submits[0]!.meta?.requestId).toBe(`permission:${request.id}`);
    expect((port.submits[0]!.meta?.data as { author?: string }).author).toBe("boss");
    expect(register).toHaveBeenCalledWith("conv-1", { meetingId: meetingFor({ kind: "dm", employeeId: "alice" }).meetingId, memberId: "alice" });
    expect(broadcast).toHaveBeenCalledWith(request.id);
    expect(store.list()).toEqual([]);
    expect(readPermissionRequests(ws)).toEqual([]);
  });

  it("accept：一次请求多种权限 → 同一组目录分别写进 permissions.read / write / bash", async () => {
    seedEmployee("alice");
    const { store, deps, meetingFor } = setup();
    const target = path.join(root, "outside", "docs");
    const { request } = store.add({
      agentId: "alice",
      meetingId: meetingFor({ kind: "dm", employeeId: "alice" }).meetingId,
      tools: ["read", "write", "bash"],
      paths: [target],
      reason: "读、写、跑命令",
    });

    const result = await resolvePermissionRequest(deps, request.id, "accept");

    expect(result).toEqual({ ok: true });
    const parsed = JSON.parse(fs.readFileSync(agentConfigPath("alice"), "utf8")) as { permissions?: Record<string, string[]> };
    expect(parsed.permissions?.read).toEqual([target]);
    expect(parsed.permissions?.write).toEqual([target]);
    expect(parsed.permissions?.bash).toEqual([target]);
  });

  it("accept：审批结果消息落库并广播库行（老板形态、键 store:<seq>）", async () => {
    seedEmployee("alice", "爱丽丝");
    const { store, messages, broadcastMessage, deps, meetingFor } = setup();
    const { request } = store.add({ agentId: "alice", meetingId: meetingFor({ kind: "dm", employeeId: "alice" }).meetingId, tools: ["write"], paths: [path.join(root, "outside")], reason: "r" });

    await resolvePermissionRequest(deps, request.id, "accept");

    const meetingId = meetingFor({ kind: "dm", employeeId: "alice" }).meetingId;
    const rows = messages.byMeeting(meetingId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ meetingId, fromId: "__boss", toIds: ["alice"], text: "已完成授权" });
    expect(broadcastMessage).toHaveBeenCalledTimes(1);
    const [broadcastId, message] = broadcastMessage.mock.calls[0]!;
    expect(broadcastId).toBe(meetingId);
    expect(message).toMatchObject({ convId: "store", entryId: String(rows[0]!.seq), speaker: { kind: "boss" }, text: "已完成授权" });
    // 与 HTTP 发送同口径：广播附仅 UI 用的 messageId（不入库），「排队中」占位据此贴真气泡。
    expect(message.messageId).toMatch(/^msg_/u);
    expect(rows[0]).not.toHaveProperty("messageId");
  });

  it("群聊 accept：库行广播带重建头部 @（@alice 已完成授权）", async () => {
    seedEmployee("alice");
    seedGroup("yt", ["alice"]);
    const { store, messages, broadcastMessage, deps, meetingFor } = setup();
    const { request } = store.add({ agentId: "alice", meetingId: meetingFor({ kind: "group", project: "yt" }).meetingId, tools: ["write"], paths: [path.join(root, "x")], reason: "r" });

    await resolvePermissionRequest(deps, request.id, "accept");

    const rows = messages.byMeeting(meetingFor({ kind: "group", project: "yt" }).meetingId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fromId: "__boss", toIds: ["alice"], text: "已完成授权" });
    expect(broadcastMessage).toHaveBeenCalledTimes(1);
    expect(broadcastMessage.mock.calls[0]![1]).toMatchObject({ convId: "store", text: "@alice 已完成授权" });
  });

  it("reject：不写任何文件、投递「已拒绝授权」", async () => {
    seedEmployee("alice");
    const { store, port, deps, meetingFor } = setup();
    const { request } = store.add({ agentId: "alice", meetingId: meetingFor({ kind: "dm", employeeId: "alice" }).meetingId, tools: ["write"], paths: [path.join(root, "x")], reason: "r" });

    const result = await resolvePermissionRequest(deps, request.id, "reject");
    expect(result).toEqual({ ok: true });
    const parsed = JSON.parse(fs.readFileSync(agentConfigPath("alice"), "utf8")) as { permissions?: unknown };
    expect(parsed.permissions).toBeUndefined();
    expect(port.submits[0]!.text).toBe("已拒绝授权");
    expect(store.list()).toEqual([]);
  });

  it("发起者已不存在：accept 抛 NotFound（不落文件、不投递、请求保留）；reject 可清理", async () => {
    const { store, port, deps, meetingFor } = setup();
    const { request } = store.add({ agentId: "ghost", meetingId: meetingFor({ kind: "dm", employeeId: "ghost" }).meetingId, tools: ["write"], paths: [path.join(root, "x")], reason: "r" });
    await expect(resolvePermissionRequest(deps, request.id, "accept")).rejects.toThrow(PermissionRequestNotFoundError);
    expect(store.get(request.id)).toBeDefined();
    // 人不存在的授权落点（agents/ghost.agent.config.json）依旧不存在
    expect(fs.existsSync(agentConfigPath("ghost"))).toBe(false);
    expect(port.submits).toEqual([]);
    await resolvePermissionRequest(deps, request.id, "reject"); // 拒绝不检查目录，可清卡片
    expect(store.get(request.id)).toBeUndefined();
  });

  it("群聊：投递文本以 @<agentId> 开头（只触发该成员）", async () => {
    seedEmployee("alice");
    seedGroup("yt", ["alice"]);
    const { store, port, deps, meetingFor } = setup();
    const { request } = store.add({ agentId: "alice", meetingId: meetingFor({ kind: "group", project: "yt" }).meetingId, tools: ["write"], paths: [path.join(root, "x")], reason: "r" });

    await resolvePermissionRequest(deps, request.id, "accept");
    expect(port.submits[0]!.text).toBe("@alice 已完成授权");
  });

  it("未知 id / 并发同 id → PermissionRequestNotFoundError；并发只有一个成功", async () => {
    seedEmployee("alice");
    const { store, deps, meetingFor } = setup();
    await expect(resolvePermissionRequest(deps, "pr_none", "accept")).rejects.toThrow(PermissionRequestNotFoundError);

    const { request } = store.add({ agentId: "alice", meetingId: meetingFor({ kind: "dm", employeeId: "alice" }).meetingId, tools: ["write"], paths: [path.join(root, "x")], reason: "r" });
    const first = resolvePermissionRequest(deps, request.id, "accept");
    const second = resolvePermissionRequest(deps, request.id, "accept");
    await expect(second).rejects.toThrow(PermissionRequestNotFoundError);
    await first;
  });

  it("写盘失败：抛错、请求保留、不投递、不广播", async () => {
    // 人配置的**临时文件**路径被同名目录占着 → appendPermissionPaths 的落盘（写临时文件后 rename）失败；
    // 人本身仍可正常加载（配置内容完好），失败只发生在写权限这一步。
    seedEmployee("alice", undefined, "eng");
    fs.mkdirSync(`${agentConfigPath("alice", "eng")}.tmp`, { recursive: true });
    const { store, port, broadcast, deps, meetingFor } = setup();
    const { request } = store.add({ agentId: "alice", meetingId: meetingFor({ kind: "dm", employeeId: "alice" }).meetingId, tools: ["write"], paths: [path.join(root, "x")], reason: "r" });

    await expect(resolvePermissionRequest(deps, request.id, "accept")).rejects.toThrow();
    expect(store.get(request.id)).toBeDefined();
    expect(port.submits).toEqual([]);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("投递失败：授权已生效、请求仍移除、返回 warning", async () => {
    seedEmployee("alice");
    const { store, port, broadcast, broadcastMessage, deps, meetingFor } = setup();
    port.submit = async () => {
      throw new Error("投递炸了");
    };
    const target = path.join(root, "outside");
    const { request } = store.add({ agentId: "alice", meetingId: meetingFor({ kind: "dm", employeeId: "alice" }).meetingId, tools: ["write"], paths: [target], reason: "r" });

    const result = await resolvePermissionRequest(deps, request.id, "accept");
    expect(result.ok).toBe(true);
    expect(result.warning).toContain("通知消息投递失败");
    const parsed = JSON.parse(fs.readFileSync(agentConfigPath("alice"), "utf8")) as { permissions: { write: string[] } };
    expect(parsed.permissions.write).toEqual([target]);
    expect(store.list()).toEqual([]);
    expect(broadcast).toHaveBeenCalledWith(request.id);
    expect(broadcastMessage).not.toHaveBeenCalled(); // 没落库就没有库行可广播
  });
});

describe("permissionRequestView", () => {
  it("补 agentName（alias 回落 id）", () => {
    const ws = createWorkspace(root);
    seedEmployee("bob", "Bob哥");
    const view = permissionRequestView(ws, { id: "pr_x", agentId: "bob", meetingId: "mtg_1", tools: ["write"], paths: ["/x"], reason: "r", createdAt: "t" });
    expect(view.agentName).toBe("Bob哥");
    const ghost = permissionRequestView(ws, { id: "pr_y", agentId: "ghost", meetingId: "mtg_1", tools: ["write"], paths: ["/x"], reason: "r", createdAt: "t" });
    expect(ghost.agentName).toBe("ghost");
  });
});
