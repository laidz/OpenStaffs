import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspace, officeDbFile, stateDir, type Workspace } from "../../src/domain/paths.ts";
import { PermissionRequestStore, readPermissionRequests } from "../../src/domain/permission-requests.ts";
import { createPiHarness } from "../../src/harness/pi-durable.ts";
import type { HarnessPort } from "../../src/harness/port.ts";
import { resolveSession } from "../../src/app/conversations.ts";
import type { MeetingMessage } from "../../src/app/meeting-messages.ts";
import { openMessageStore } from "../../src/store/messages.ts";
import { openSessionStore, type SessionStore } from "../../src/store/sessions.ts";
import { openMeetingStore, type MeetingStore } from "../../src/store/meetings.ts";
import { createNewMeeting, ensureMeeting } from "../../src/app/meetings.ts";
import { openStaffsToolDefs, type ToolContext } from "../../src/tools/registry.ts";
import type { Relation } from "../../src/domain/types.ts";
import { seedOffice } from "../helpers/office.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-tools-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function seedEmployee(id: string, alias?: string, prompt = `你是 ${id}。`): void {
  seedOffice(root, { agents: [{ id, alias, model: "faux/faux-model", prompt }] });
}

function seedProject(id: string, memberIds: string[], alias?: string): void {
  seedOffice(root, { projects: [{ id, members: memberIds, alias }] });
}

function fauxHarness(count = 4) {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
  faux.setResponses(Array.from({ length: count }, (_, i) => fauxAssistantMessage(`答${i}`)));
  const models = createModels();
  models.setProvider(faux.provider);
  return createPiHarness({ root, sqlitePath: path.join(root, "openstaffs/.data", "state.sqlite"), models });
}

function tool(name: string) {
  const found = openStaffsToolDefs.find((t) => t.name === name);
  if (found === undefined) throw new Error(`工具不存在：${name}`);
  return found;
}

function ctxFor(ws: Workspace, selfId: string, relation: Relation, harness = {} as HarnessPort): ToolContext {
  return {
    ws,
    harness,
    selfId,
    relation,
    meetingId: meetingIdOf(ws, relation),
    meetings: meetingsOf(ws),
    sessions: sessionsOf(ws),
  };
}

/** 会话表（唯一真相）：按空间开库（调用方保证 stateDir 已存在或可建）。 */
function sessionsOf(ws: Workspace): SessionStore {
  fs.mkdirSync(stateDir(ws), { recursive: true });
  return openSessionStore(officeDbFile(ws));
}

/** 会议表：按空间开库。 */
function meetingsOf(ws: Workspace): MeetingStore {
  fs.mkdirSync(stateDir(ws), { recursive: true });
  return openMeetingStore(officeDbFile(ws));
}

/** 该主题的进行中会议 id（没有就建一场）——工具的 meetingId 就取自它。 */
function meetingIdOf(ws: Workspace, relation: Relation): string {
  return ensureMeeting({ ws, meetings: meetingsOf(ws) }, relation, new Date("2026-10-26T10:00:00.000Z")).meetingId;
}

/** 往自有消息库塞行（meeting_history 读库）：先建 stateDir，开库写完即关。 */
function seedStore(
  ws: Workspace,
  meetingId: string,
  rows: { fromId: string; toIds: string[]; text: string }[],
): void {
  fs.mkdirSync(stateDir(ws), { recursive: true });
  const store = openMessageStore(officeDbFile(ws));
  try {
    for (const row of rows) store.append({ sendTime: new Date().toISOString(), meetingId, ...row });
  } finally {
    store.close();
  }
}

/** 读自有库某会议的行（写完即关；调用方保证 stateDir 已存在）。 */
function rowsOf(ws: Workspace, meetingId: string) {
  const store = openMessageStore(officeDbFile(ws));
  try {
    return store.byMeeting(meetingId);
  } finally {
    store.close();
  }
}

const dm = (employeeId: string): Relation => ({ kind: "dm", employeeId });

/** 在「该主题的进行中会议」里解析 conv（工具/发送路径同款入口）。 */
const openIn = (ws: Workspace, harness: HarnessPort, relation: Relation, memberId: string) =>
  resolveSession(
    { ws, harness, sessions: sessionsOf(ws) },
    ensureMeeting({ ws, meetings: meetingsOf(ws) }, relation, new Date("2026-10-26T10:00:00.000Z")),
    memberId,
  );

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("waitFor 超时");
}

describe("office_list", () => {
  it("列出成员与项目，并标出我在不在群里", async () => {
    seedEmployee("alice", "爱丽丝");
    seedEmployee("bob");
    seedProject("demo", ["alice", "bob"], "演示项目");
    const out = await tool("office_list").run({}, ctxFor(createWorkspace(root), "alice", dm("alice")));
    expect(out).toContain("爱丽丝");
    expect(out).toContain("演示项目");
    expect(out).toContain("bob");
    expect(out).toContain("true"); // demo 含 alice
    expect(out).toContain("（办公室直属）"); // 人在 agents/ 根 → 直属
  });
});

describe("member_profile", () => {
  it("读成员展示名 + config 的 prompt 正文", async () => {
    seedEmployee("bob", "Bob", "职责：后端工程师。");
    const out = await tool("member_profile").run({ member: "bob" }, ctxFor(createWorkspace(root), "alice", dm("alice")));
    expect(out).toContain("Bob");
    expect(out).toContain("后端工程师");
  });

  it("没配 prompt → 明确提示未配置（不返回空正文）", async () => {
    seedOffice(root, { agents: [{ id: "bob", alias: "Bob", model: "faux/faux-model" }] });
    const out = await tool("member_profile").run({ member: "bob" }, ctxFor(createWorkspace(root), "alice", dm("alice")));
    expect(out).toContain("Bob");
    expect(out).toContain("（未配置 prompt）");
  });
});

describe("meeting_history", () => {
  it("读指定房间的历史（自有库），群聊按 toIds 重建头部 @、标注发言人", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    seedProject("demo", ["alice", "bob"], "演示项目");
    const ws = createWorkspace(root);
    const meetingId = meetingIdOf(ws, { kind: "group", project: "demo" });
    seedStore(ws, meetingId, [
      { fromId: "__boss", toIds: ["alice"], text: "任务X" },
      { fromId: "alice", toIds: ["__boss"], text: "答0" },
    ]);
    const out = await tool("meeting_history").run({ meeting: meetingId }, ctxFor(ws, "alice", { kind: "group", project: "demo" }));
    // 群聊展示时由收件人重建头部 @（任务X 是 @alice 的）
    expect(out).toContain("老板：@alice 任务X");
    expect(out).toContain("alice：@老板 答0");
  });

  it("limit 取最近若干条；meeting 缺省 = 当前会议；meetingId 不存在报错", async () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const harness = fauxHarness();
    await harness.open();
    try {
      const out = await tool("meeting_history").run({}, ctxFor(ws, "alice", dm("alice"), harness));
      expect(out).toBe("（暂无消息）");
      await expect(tool("meeting_history").run({ meeting: "mtg_bogus" }, ctxFor(ws, "alice", dm("alice"), harness))).rejects.toThrow("会议不存在");

      seedStore(ws, meetingIdOf(ws, dm("alice")), [
        { fromId: "__boss", toIds: ["alice"], text: "一" },
        { fromId: "alice", toIds: ["__boss"], text: "二" },
        { fromId: "__boss", toIds: ["alice"], text: "三" },
      ]);
      expect(await tool("meeting_history").run({ limit: 2 }, ctxFor(ws, "alice", dm("alice"), harness))).toBe("alice：二\n老板：三");
    } finally {
      await harness.close();
    }
  });

  it("只读本会议：上一场会议的消息不出现在当前会议的历史里（会议即窗口）", async () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const previous = meetingIdOf(ws, dm("alice"));
    seedStore(ws, previous, [{ fromId: "__boss", toIds: ["alice"], text: "上一场会议" }]);
    // 新建一场会议（上一场 closed），它自己那行消息
    const meetings = meetingsOf(ws);
    const current = createNewMeeting({ ws, meetings }, dm("alice"), new Date("2026-10-26T11:00:00.000Z"));
    seedStore(ws, current.meetingId, [
      { fromId: "__boss", toIds: ["alice"], text: "新一轮" },
      { fromId: "alice", toIds: ["__boss"], text: "新一轮的回复" },
    ]);
    const out = await tool("meeting_history").run({}, ctxFor(ws, "alice", dm("alice")));
    expect(out).toBe("老板：新一轮\nalice：新一轮的回复");
    expect(out).not.toContain("上一场会议");
  });

  it("`openstaffs/.data` 尚未创建（stateDir 不存在）→ 返回「（暂无消息）」，不抛「unable to open database file」", async () => {
    const freshRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-tools-nostate-"));
    try {
      expect(fs.existsSync(stateDir(createWorkspace(freshRoot)))).toBe(false);
      const out = await tool("meeting_history").run({}, ctxFor(createWorkspace(freshRoot), "alice", dm("alice")));
      expect(out).toBe("（暂无消息）");
    } finally {
      fs.rmSync(freshRoot, { recursive: true, force: true });
    }
  });
});

describe("send_message", () => {
  it("target=boss：向老板私聊投递一条（归属自己），不触发自己再回答", async () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const harness = fauxHarness();
    await harness.open();
    try {
      const out = await tool("send_message").run({ target: "boss", text: "汇报一下" }, ctxFor(ws, "alice", dm("alice"), harness));
      expect(out).toContain("老板");
      const { convId: dmConv } = await openIn(ws, harness, dm("alice"), "alice");
      const history = await harness.transcript(dmConv);
      const posted = history.find((m) => m.text === "汇报一下");
      expect((posted?.data as { author?: string } | undefined)?.author).toBe("alice");
      // 不触发模型回答：append 只有 chat.message 条目，没有模型产出的 pi.assistant 条目。
      expect(history.some((m) => m.kind === "pi.assistant")).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("target=member：在当前群里触发该成员（投递到他的群会话）", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    seedProject("demo", ["alice", "bob"], "演示项目");
    const ws = createWorkspace(root);
    const harness = fauxHarness();
    await harness.open();
    try {
      await tool("send_message").run({ target: "member:bob", text: "bob 帮我看下" }, ctxFor(ws, "alice", { kind: "group", project: "demo" }, harness));
      const { convId: bobConv } = await openIn(ws, harness, { kind: "group", project: "demo" }, "bob");
      const history = await harness.transcript(bobConv);
      const delivered = history.find((m) => m.text.endsWith("bob 帮我看下"));
      expect(delivered?.text).toBe("alice：bob 帮我看下"); // 必须自报身份，接收者才知道回告谁
      expect((delivered?.data as { author?: string } | undefined)?.author).toBe("alice");
      await waitFor(async () => (await harness.transcript(bobConv)).some((m) => m.role === "assistant"));
    } finally {
      await harness.close();
    }
  });

  it("target=member：私聊里用 / 非本会议成员 → 报错", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    seedProject("demo", ["alice"], "演示项目");
    const ws = createWorkspace(root);
    await expect(tool("send_message").run({ target: "member:bob", text: "x" }, ctxFor(ws, "alice", dm("alice")))).rejects.toThrow("私聊会议");
    await expect(
      tool("send_message").run({ target: "member:bob", text: "x" }, ctxFor(ws, "alice", { kind: "group", project: "demo" })),
    ).rejects.toThrow("不是本会议成员");
  });

  it("无法识别的 target → 报错", async () => {
    seedEmployee("alice");
    await expect(tool("send_message").run({ target: "wat", text: "x" }, ctxFor(createWorkspace(root), "alice", dm("alice")))).rejects.toThrow("target");
  });

  it("target=boss：落一行到**本会议**并广播库行（不再搬到私聊房间）", async () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const meetingId = meetingIdOf(ws, dm("alice"));
    const harness = fauxHarness();
    await harness.open();
    const broadcasts: { meetingId: string; message: MeetingMessage }[] = [];
    try {
      const ctx = { ...ctxFor(ws, "alice", dm("alice"), harness), broadcast: (id: string, message: MeetingMessage) => broadcasts.push({ meetingId: id, message }) };
      await tool("send_message").run({ target: "boss", text: "@老板 汇报进展" }, ctx);

      const rows = rowsOf(ws, meetingId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ meetingId, fromId: "alice", toIds: ["__boss"], text: "汇报进展" });

      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0]!.meetingId).toBe(meetingId);
      expect(broadcasts[0]!.message).toMatchObject({
        convId: "store",
        entryId: String(rows[0]!.seq),
        speaker: { kind: "employee", id: "alice" },
        text: "汇报进展",
      });
    } finally {
      await harness.close();
    }
  });

  it("target=member：在群房间落一行并广播库行", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    seedProject("demo", ["alice", "bob"], "演示项目");
    const ws = createWorkspace(root);
    const meetingId = meetingIdOf(ws, { kind: "group", project: "demo" });
    const harness = fauxHarness();
    await harness.open();
    const broadcasts: { meetingId: string; message: MeetingMessage }[] = [];
    try {
      const ctx = { ...ctxFor(ws, "alice", { kind: "group", project: "demo" }, harness), broadcast: (id: string, message: MeetingMessage) => broadcasts.push({ meetingId: id, message }) };
      await tool("send_message").run({ target: "member:bob", text: "@bob 帮我看下" }, ctx);

      const rows = rowsOf(ws, meetingId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ meetingId, fromId: "alice", toIds: ["bob"], text: "帮我看下" });
      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0]!.meetingId).toBe(meetingId);
      expect(broadcasts[0]!.message).toMatchObject({ convId: "store", entryId: String(rows[0]!.seq), text: "@bob 帮我看下" });
    } finally {
      await harness.close();
    }
  });

  it("空正文（剥头后为空）不落行、不广播", async () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const meetingId = meetingIdOf(ws, dm("alice"));
    const harness = fauxHarness();
    await harness.open();
    const broadcasts: unknown[] = [];
    try {
      const ctx = { ...ctxFor(ws, "alice", dm("alice"), harness), broadcast: (id: string, message: MeetingMessage) => broadcasts.push({ meetingId: id, message }) };
      await tool("send_message").run({ target: "boss", text: "@老板" }, ctx);
      expect(rowsOf(ws, meetingId)).toEqual([]);
      expect(broadcasts).toEqual([]);
    } finally {
      await harness.close();
    }
  });
});

describe("request_permission", () => {
  function ctxWithStore(ws: Workspace, selfId: string, relation: Relation) {
    const store = new PermissionRequestStore(ws);
    const notify = vi.fn();
    return { ctx: { ...ctxFor(ws, selfId, relation), permissions: { store, notify } }, store, notify };
  }

  it("发起成功：相对路径按会话 cwd 归一为绝对并去重；权限必填；store 落盘；notify 广播", async () => {
    seedEmployee("alice", "爱丽丝");
    const ws = createWorkspace(root);
    const { ctx, store, notify } = ctxWithStore(ws, "alice", dm("alice"));
    const out = await tool("request_permission").run(
      { tools: ["write"], paths: ["notes/a.md", "./notes/a.md", "/abs/x"], reason: "整理笔记" },
      ctx,
    );
    const expected = path.join(root, "work", "alice", "notes", "a.md");
    expect(out).toContain("发起授权请求");
    expect(out).toContain("权限：[write]");
    expect(out).toContain("2 个目录");
    expect(out).toContain(expected);
    expect(out).toContain("/abs/x");
    expect(out).toContain("不要尝试访问这些路径");
    const requests = store.list();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.agentId).toBe("alice");
    expect(requests[0]!.meetingId).toBe(meetingIdOf(ws, dm("alice")));
    expect(requests[0]!.tools).toEqual(["write"]);
    expect(requests[0]!.paths).toEqual([expected, "/abs/x"]);
    expect(requests[0]!.reason).toBe("整理笔记");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(readPermissionRequests(ws)).toHaveLength(1);
  });

  it("群聊：会议 id 与相对路径按会话工作目录（work/<自己>）解析，D25 项目无工作目录", async () => {
    seedEmployee("alice");
    seedProject("demo", ["alice"]);
    const ws = createWorkspace(root);
    const { ctx, store } = ctxWithStore(ws, "alice", { kind: "group", project: "demo" });
    await tool("request_permission").run({ tools: ["read"], paths: ["data/x"], reason: "r" }, ctx);
    expect(store.list()[0]!.meetingId).toBe(meetingIdOf(ws, { kind: "group", project: "demo" }));
    expect(store.list()[0]!.paths).toEqual([path.join(root, "work", "alice", "data", "x")]);
  });

  it("校验：paths 空 / reason 空白 / tools 缺失或为空 → 报错（没有 write 缺省）", async () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const { ctx } = ctxWithStore(ws, "alice", dm("alice"));
    await expect(tool("request_permission").run({ tools: ["write"], paths: [], reason: "r" }, ctx)).rejects.toThrow("paths 不能为空");
    await expect(tool("request_permission").run({ tools: ["write"], paths: ["  "], reason: "r" }, ctx)).rejects.toThrow("paths 不能为空");
    await expect(tool("request_permission").run({ tools: ["write"], paths: ["a"], reason: "" }, ctx)).rejects.toThrow("reason 不能为空");
    await expect(tool("request_permission").run({ paths: ["a"], reason: "r" }, ctx)).rejects.toThrow("tools 不能为空");
    await expect(tool("request_permission").run({ tools: [" "], paths: ["a"], reason: "r" }, ctx)).rejects.toThrow("tools 不能为空");
  });

  it("tools 多值：一次请求可含 read+write；非法工具名报错", async () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const { ctx, store } = ctxWithStore(ws, "alice", dm("alice"));
    const out = await tool("request_permission").run({ tools: ["read", "write"], paths: ["dir"], reason: "读写" }, ctx);
    expect(out).toContain("权限：[read+write]");
    expect(store.list()[0]!.tools).toEqual(["read", "write"]);
    await expect(
      tool("request_permission").run({ tools: ["bad/tool"], paths: ["b"], reason: "r" }, ctx),
    ).rejects.toThrow("tools 不合法");
  });

  it("同目录追加权限：并进同一张卡（提示已并入）；完全重复 → 提示勿重复发起", async () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const { ctx, store } = ctxWithStore(ws, "alice", dm("alice"));
    const first = await tool("request_permission").run({ tools: ["write"], paths: ["a"], reason: "要写" }, ctx);
    expect(first).toContain("已向");
    const second = await tool("request_permission").run({ tools: ["read"], paths: ["a"], reason: "要读" }, ctx);
    expect(second).toContain("并入");
    expect(second).toContain("权限：[write+read]");
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]!.tools).toEqual(["write", "read"]);
    const third = await tool("request_permission").run({ tools: ["read"], paths: ["a"], reason: "再要读" }, ctx);
    expect(third).toContain("已有完全相同");
    expect(store.list()).toHaveLength(1);
  });

  it("重复申请：同路径集合不新建，返回提示；称谓进入文案", async () => {
    seedEmployee("alice");
    fs.mkdirSync(path.join(root, "openstaffs/.data"), { recursive: true });
    fs.writeFileSync(path.join(root, "openstaffs/.data", "config.json"), JSON.stringify({ bossName: "掌柜" }));
    const ws = createWorkspace(root);
    const { ctx, store, notify } = ctxWithStore(ws, "alice", dm("alice"));
    const first = await tool("request_permission").run({ tools: ["write"], paths: ["a", "b"], reason: "r" }, ctx);
    expect(first).toContain("「掌柜」");
    const second = await tool("request_permission").run({ tools: ["write"], paths: ["b", "a"], reason: "r2" }, ctx);
    expect(second).toContain("已有完全相同");
    expect(store.list()).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(2); // 合并 / 重复也要重新广播，前端按 id 原地更新
  });
});

describe("注册表", () => {
  it("暴露 11 个工具且名字唯一（new_meeting 已移除：会议没有「结束」，也不允许 agent 新建/销毁）", () => {
    const names = openStaffsToolDefs.map((t) => t.name).sort();
    expect(names).toEqual([
      "meeting_history", "member_profile", "memory_add", "memory_get", "memory_list", "memory_profile",
      "memory_remove", "memory_update", "office_list", "request_permission", "send_message",
    ]);
  });
});

describe("称谓消费", () => {
  it("自定义 bossName：send_message 返回与 meeting_history 输出用真称谓", async () => {
    seedEmployee("alice");
    fs.mkdirSync(path.join(root, "openstaffs/.data"), { recursive: true });
    fs.writeFileSync(path.join(root, "openstaffs/.data", "config.json"), JSON.stringify({ bossName: "掌柜" }));
    const ws = createWorkspace(root);
    const harness = fauxHarness();
    await harness.open();
    try {
      const out = await tool("send_message").run({ target: "boss", text: "汇报一下" }, ctxFor(ws, "alice", dm("alice"), harness));
      expect(out).toContain("掌柜");

      seedStore(ws, meetingIdOf(ws, dm("alice")), [{ fromId: "__boss", toIds: ["alice"], text: "任务Y" }]);
      const history = await tool("meeting_history").run({}, ctxFor(ws, "alice", dm("alice"), harness));
      expect(history).toContain("掌柜：任务Y");
    } finally {
      await harness.close();
    }
  });
});
