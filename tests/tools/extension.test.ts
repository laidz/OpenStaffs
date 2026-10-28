import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";import { seedOffice } from "../helpers/office.ts";
import { PermissionRequestStore } from "../../src/domain/permission-requests.ts";
import { openSessionStore, type SessionStore } from "../../src/store/sessions.ts";
import { openMeetingStore, type MeetingStore } from "../../src/store/meetings.ts";
import { ensureMeeting } from "../../src/app/meetings.ts";
import { officeDbFile, stateDir } from "../../src/domain/paths.ts";
import { openMessageStore } from "../../src/store/messages.ts";
import { createPiHarness } from "../../src/harness/pi-durable.ts";
import type { ConversationSpec, HarnessPort } from "../../src/harness/port.ts";
import { createOpenStaffsToolsExtension } from "../../src/tools/extension.ts";

type ToolResultLike = { output?: unknown; isError?: boolean };

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-ext-"));
/** 会话表（唯一真相，与消息同库）：每个用例一套（用例会删目录）。 */
let extensionsSessions: SessionStore;
let extensionsMeetings: MeetingStore;
beforeEach(() => {
  fs.mkdirSync(path.join(root, "openstaffs/.data"), { recursive: true });
  extensionsMeetings = openMeetingStore(path.join(root, "openstaffs/.data", "openstaffs.sqlite"));
  extensionsSessions = openSessionStore(path.join(root, "openstaffs/.data", "openstaffs.sqlite"));
});
afterEach(() => {
  extensionsSessions.close();
  extensionsMeetings.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** 该主题的进行中会议（会话快照里要带 meetingId）。 */
function meetingIdOf(ws: ReturnType<typeof createWorkspace>, relation: { kind: "dm"; employeeId: string } | { kind: "group"; project: string }): string {
  return ensureMeeting({ ws, meetings: extensionsMeetings }, relation, new Date("2026-10-26T10:00:00.000Z")).meetingId;
}

function fauxModels() {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
  faux.setResponses([fauxAssistantMessage("ok")]);
  const models = createModels();
  models.setProvider(faux.provider);
  return models;
}

describe("OpenStaffs 工具扩展", () => {
  it("暴露 12 个工具，名字唯一", () => {
    const ext = createOpenStaffsToolsExtension({
      ws: createWorkspace(root),
      getHarness: () => ({} as HarnessPort),
      meetings: extensionsMeetings,
      sessions: extensionsSessions,
    });
    expect((ext.tools ?? []).map((t) => t.name).sort()).toEqual([
      "meeting_history", "member_profile", "memory_add", "memory_get", "memory_list", "memory_profile",
      "memory_remove", "memory_update", "office_list", "request_permission", "send_message",
    ]);
  });

  it("execute 经 sessionInfo 解析身份/关系；未注册会话 → isError", async () => {
    seedOffice(root, { agents: [{ id: "alice", model: "faux/faux-model", prompt: "你是 alice。" }] });
    const dir = path.join(root, "work", "alice");
    fs.mkdirSync(dir, { recursive: true });

    const ws = createWorkspace(root);
    let harness: ReturnType<typeof createPiHarness>;
    const ext = createOpenStaffsToolsExtension({ ws, getHarness: () => harness, meetings: extensionsMeetings, sessions: extensionsSessions });
    harness = createPiHarness({ root, sqlitePath: path.join(root, "openstaffs/.data", "state.sqlite"), models: fauxModels(), extensions: [ext] });
    await harness.open();
    try {
      const spec: ConversationSpec = {
        cwd: dir,
        relation: { kind: "dm", employeeId: "alice" },
        meetingId: meetingIdOf(ws, { kind: "dm", employeeId: "alice" }),
        instructions: "你是 alice。",
        model: { provider: "faux", modelId: "faux-model" },
        access: { root, cwd: dir, selfId: "alice", permissions: {} },
      };
      const convId = await harness.startSession(spec);
      const officeList = (ext.tools ?? []).find((t) => t.name === "office_list")!;
      const ok = (await officeList.execute({}, { conversationId: convId } as never, {} as never)) as ToolResultLike;
      expect(ok.isError).toBeFalsy();
      expect(JSON.stringify(ok.output)).toContain("alice");

      const missing = (await officeList.execute({}, { conversationId: "conv:不存在" } as never, {} as never)) as ToolResultLike;
      expect(missing.isError).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("注入 permissions 后 request_permission 可用：落库一条请求、无错误", async () => {
    seedOffice(root, { agents: [{ id: "alice", model: "faux/faux-model", prompt: "你是 alice。" }] });
    const dir = path.join(root, "work", "alice");
    fs.mkdirSync(dir, { recursive: true });

    const ws = createWorkspace(root);
    const store = new PermissionRequestStore(ws);
    let harness: ReturnType<typeof createPiHarness>;
    const ext = createOpenStaffsToolsExtension({
      ws,
      getHarness: () => harness,
      permissions: { store, notify: () => {} },
      meetings: extensionsMeetings,
      sessions: extensionsSessions,
    });
    harness = createPiHarness({ root, sqlitePath: path.join(root, "openstaffs/.data", "state.sqlite"), models: fauxModels(), extensions: [ext] });
    await harness.open();
    try {
      const spec: ConversationSpec = {
        cwd: dir,
        relation: { kind: "dm", employeeId: "alice" },
        meetingId: meetingIdOf(ws, { kind: "dm", employeeId: "alice" }),
        instructions: "你是 alice。",
        model: { provider: "faux", modelId: "faux-model" },
        access: { root, cwd: dir, selfId: "alice", permissions: {} },
      };
      const convId = await harness.startSession(spec);
      const tool = (ext.tools ?? []).find((t) => t.name === "request_permission")!;
      const result = (await tool.execute({ tools: ["write"], paths: ["x.md"], reason: "r" }, { conversationId: convId } as never, {} as never)) as ToolResultLike;
      expect(result.isError).toBeFalsy();
      expect(store.list()).toHaveLength(1);
      expect(store.list()[0]).toMatchObject({ agentId: "alice", meetingId: meetingIdOf(ws, { kind: "dm", employeeId: "alice" }), reason: "r" });
    } finally {
      await harness.close();
    }
  });

  it("群聊会话：会议归属跟着会话走（send_message member 可用 / 授权记到群会议）", async () => {
    seedOffice(root, {
      agents: [
        { id: "alice", model: "faux/faux-model", prompt: "你是 alice。" },
        { id: "bob", model: "faux/faux-model", prompt: "你是 bob。" },
      ],
      projects: [{ id: "demo", members: ["alice", "bob"] }],
    });
    // 关键：群聊会话与私聊会话的 cwd 是同一个（员工自己的工作目录），不能靠 cwd 区分房间
    const dir = path.join(root, "work", "alice");
    fs.mkdirSync(dir, { recursive: true });
    const ws = createWorkspace(root);
    fs.mkdirSync(stateDir(ws), { recursive: true });
    const groupMeeting = meetingIdOf(ws, { kind: "group", project: "demo" });
    const dmMeeting = meetingIdOf(ws, { kind: "dm", employeeId: "alice" });
    const store0 = openMessageStore(officeDbFile(ws));
    try {
      store0.append({ sendTime: new Date().toISOString(), meetingId: groupMeeting, fromId: "__boss", toIds: ["alice"], text: "群里的话" });
      store0.append({ sendTime: new Date().toISOString(), meetingId: dmMeeting, fromId: "__boss", toIds: ["alice"], text: "私聊的话" });
    } finally {
      store0.close();
    }

    const permissions = new PermissionRequestStore(ws);
    let harness: ReturnType<typeof createPiHarness>;
    const ext = createOpenStaffsToolsExtension({ ws, getHarness: () => harness, permissions: { store: permissions, notify: () => {} }, meetings: extensionsMeetings, sessions: extensionsSessions });
    harness = createPiHarness({ root, sqlitePath: path.join(root, "openstaffs/.data", "state-group.sqlite"), models: fauxModels(), extensions: [ext] });
    await harness.open();
    try {
      const convId = await harness.startSession({
        cwd: dir,
        relation: { kind: "group", project: "demo" },
        meetingId: meetingIdOf(ws, { kind: "group", project: "demo" }),
        instructions: "你是 alice。",
        model: { provider: "faux", modelId: "faux-model" },
        access: { root, cwd: dir, selfId: "alice", permissions: {} },
      });
      const run = async (name: string, args: Record<string, unknown>): Promise<ToolResultLike> =>
        (await (ext.tools ?? []).find((t) => t.name === name)!.execute(args, { conversationId: convId } as never, {} as never)) as ToolResultLike;

      // 1) meeting_history 无参 = 当前会议（群聊），不是私聊会议
      const history = await run("meeting_history", {});
      expect(history.isError).toBeFalsy();
      expect(JSON.stringify(history.output)).toContain("群里的话");
      expect(JSON.stringify(history.output)).not.toContain("私聊的话");

      // 2) send_message member:<id> 在群里可用（旧 bug：报「只能在群聊里用（当前是私聊）」）
      const sent = await run("send_message", { target: "member:bob", text: "在吗" });
      expect(sent.isError).toBeFalsy();

      // 3) 授权请求记到群房间（旧 bug：记成 dm:alice）
      const asked = await run("request_permission", { tools: ["write"], paths: ["x.md"], reason: "r" });
      expect(asked.isError).toBeFalsy();
      expect(permissions.list().at(-1)).toMatchObject({ agentId: "alice", meetingId: meetingIdOf(ws, { kind: "group", project: "demo" }) });
    } finally {
      await harness.close();
    }
  });
});
