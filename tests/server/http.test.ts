import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { type AddressInfo } from "node:net";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace, officeDbFile, stateDir } from "../../src/domain/paths.ts";

import type { HarnessPort } from "../../src/harness/port.ts";
import { projectConfigFile } from "../../src/config/naming.ts";
import { seedOffice, writeJsonFile } from "../helpers/office.ts";
import { createHttpServer, type ServerDeps } from "../../src/server/http.ts";
import { createPiHarness } from "../../src/harness/pi-durable.ts";
import { KeyedQueue } from "../../src/app/send.ts";
import { Outbox } from "../../src/app/outbox.ts";
import { ensureMeeting } from "../../src/app/meetings.ts";
import { openMessageStore, type MessageStore } from "../../src/store/messages.ts";
import { openSessionStore, type SessionStore } from "../../src/store/sessions.ts";
import { openMeetingStore, type MeetingStore } from "../../src/store/meetings.ts";
import type { QueuedItemView } from "../../src/app/outbox.ts";
import type { MeetingMessage } from "../../src/app/meeting-messages.ts";
import { messagesHtml } from "../../web/render.ts";
import { SseHub, type ServerEvent } from "../../src/server/sse.ts";
import { Pump } from "../../src/server/pump.ts";
import type { WorkspaceConfig } from "../../src/domain/config.ts";
import { PermissionRequestStore } from "../../src/domain/permission-requests.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-http-"));
const publicDir = path.join(root, "public");
fs.mkdirSync(publicDir, { recursive: true });
fs.writeFileSync(path.join(publicDir, "index.html"), "<html>Office</html>");
fs.writeFileSync(path.join(root, "secret.txt"), "top-secret");

// 接线前提（对齐 main.ts）：stateDir 先建，三个库实例注入 HTTP；每个用例一套，afterEach 关闭并清目录。
let messageStore: MessageStore | undefined;
function getStore(): MessageStore {
  if (messageStore === undefined) {
    fs.mkdirSync(stateDir(createWorkspace(root)), { recursive: true });
    messageStore = openMessageStore(officeDbFile(createWorkspace(root)));
  }
  return messageStore;
}

let sessionStore: SessionStore | undefined;
function getSessions(): SessionStore {
  if (sessionStore === undefined) {
    fs.mkdirSync(stateDir(createWorkspace(root)), { recursive: true });
    sessionStore = openSessionStore(officeDbFile(createWorkspace(root)));
  }
  return sessionStore;
}

let meetingStore: MeetingStore | undefined;
function getMeetings(): MeetingStore {
  if (meetingStore === undefined) {
    fs.mkdirSync(stateDir(createWorkspace(root)), { recursive: true });
    meetingStore = openMeetingStore(officeDbFile(createWorkspace(root)));
  }
  return meetingStore;
}

afterEach(() => {
  messageStore?.close();
  messageStore = undefined;
  sessionStore?.close();
  sessionStore = undefined;
  meetingStore?.close();
  meetingStore = undefined;
  fs.rmSync(path.join(root, "agents"), { recursive: true, force: true });
  fs.rmSync(path.join(root, "work"), { recursive: true, force: true });
  fs.rmSync(path.join(root, "projects"), { recursive: true, force: true });
  fs.rmSync(path.join(root, "openstaffs/.data"), { recursive: true, force: true });
});

function start(deps: Omit<ServerDeps, "store" | "sessions" | "meetings">): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createHttpServer({ ...deps, store: getStore(), sessions: getSessions(), meetings: getMeetings() });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

const configured: WorkspaceConfig = { providers: { faux: { apiKey: "k" } }, model: "faux/faux-model", port: 4319 };

describe("HTTP 骨架", () => {
  it("未配置：status 可用、其余 API 409、静态可用", async () => {
    const ws = createWorkspace(root);
    const { base, close } = await start({ ws, getConfig: () => undefined, getHarness: () => undefined, queue: new KeyedQueue(), publicDir, port: 4319 });
    try {
      const status = await fetch(`${base}/api/status`);
      expect(status.status).toBe(200);
      expect(await status.json()).toEqual({ configured: false, root: ws.root, port: 4319, bossName: "老板" });

      expect((await fetch(`${base}/api/org`)).status).toBe(409);
      expect((await fetch(`${base}/api/pins`)).status).toBe(409);
      expect((await fetch(`${base}/api/permission-requests`)).status).toBe(409);
      expect(
        (await fetch(`${base}/api/permission-requests/pr_x/resolve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision: "accept" }),
        })).status,
      ).toBe(409);

      const page = await fetch(`${base}/`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("Office");
    } finally {
      await close();
    }
  });

  it("status 永不回显 apiKey；org/projects 列表（含 alias 与模型兜底）", async () => {
    seedOffice(root, {
      agents: [
        { id: "alice", alias: "爱丽丝", model: "anthropic/claude-x", prompt: "你是 alice。" },
        { id: "carol", prompt: "你是 carol。" },
      ],
      projects: [{ id: "yt", alias: "油管项目", members: ["alice", "ghost"] }],
    });

    const ws = createWorkspace(root);
    const { base, close } = await start({ ws, getConfig: () => configured, getHarness: () => undefined, queue: new KeyedQueue(), publicDir, port: 4319 });
    try {
      const status = (await (await fetch(`${base}/api/status`)).json()) as Record<string, unknown>;
      expect(status.apiKey).toBeUndefined();
      expect(status.configured).toBe(true);
      expect(status.model).toBe("faux/faux-model");
      expect(status.providers).toEqual(["faux"]);
      expect(status.bossName).toBe("老板");

      const org = (await (await fetch(`${base}/api/org`)).json()) as { root: { people: { id: string; alias?: string; model: string }[] } };
      expect(org.root.people.map((e) => e.id)).toEqual(["alice", "carol"]);
      expect(org.root.people[0]).toEqual({ id: "alice", alias: "爱丽丝", model: "anthropic/claude-x" }); // 员工可用别的供应商
      expect(org.root.people[1]!.model).toBe("faux/faux-model"); // 兜底全局

      const projects = (await (await fetch(`${base}/api/projects`)).json()) as { id: string; alias: string; members: { id: string; alias?: string }[] }[];
      expect(projects).toEqual([
        { id: "yt", alias: "油管项目", members: [{ id: "alice", alias: "爱丽丝" }, { id: "ghost" }] },
      ]);
    } finally {
      await close();
    }
  });

  it("GET /api/org：部门树 + 人（含模型兜底）；/api/employees 已移除", async () => {
    seedOffice(root, {
      departments: [{ path: "eng", alias: "研发部", head: ["alice"] }],
      agents: [
        { id: "alice", department: "eng", alias: "爱丽丝", model: "anthropic/claude-x", prompt: "你是 alice。" },
        { id: "bob", department: "eng/platform", prompt: "你是 bob。" },
        { id: "staff0", prompt: "管家" },
      ],
    });

    const ws = createWorkspace(root);
    const { base, close } = await start({ ws, getConfig: () => configured, getHarness: () => undefined, queue: new KeyedQueue(), publicDir, port: 4319 });
    try {
      const org = (await (await fetch(`${base}/api/org`)).json()) as { root: { path: string; name: string; people: { id: string; alias?: string; model: string }[]; departments: unknown[] } };
      expect(org.root.path).toBe("");
      expect(org.root.name).toBe("办公室");
      expect(org.root.people.map((p) => p.id)).toEqual(["staff0"]);
      expect(org.root.departments).toHaveLength(1);
      const eng = org.root.departments[0] as { name: string; people: { id: string; alias?: string; model: string }[]; departments: { name: string; people: { id: string; model: string }[] }[] };
      expect(eng.name).toBe("研发部");
      expect(eng.people[0]).toEqual({ id: "alice", alias: "爱丽丝", model: "anthropic/claude-x" });
      expect(eng.departments[0]!.name).toBe("platform");
      expect(eng.departments[0]!.people[0]).toEqual({ id: "bob", model: "faux/faux-model" }); // 兜底全局模型
      expect((await fetch(`${base}/api/employees`)).status).toBe(404);
    } finally {
      await close();
    }
  });

  it("静态文件：防路径穿越、404", async () => {
    const ws = createWorkspace(root);
    const { base, close } = await start({ ws, getConfig: () => configured, getHarness: () => undefined, queue: new KeyedQueue(), publicDir, port: 4319 });
    try {
      expect((await fetch(`${base}/nope.txt`)).status).toBe(404);
      // 原始 http 请求绕过 fetch 的路径规范化
      const status = await new Promise<number>((resolve) => {
        const req = http.request({ host: "127.0.0.1", port: new URL(base).port, path: "/..%2Fsecret.txt" }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.end();
      });
      expect(status).toBe(404);
    } finally {
      await close();
    }
  });

  it("静态路径畸形百分号编码（/%ZZ）：404 而非 500", async () => {
    const ws = createWorkspace(root);
    const { base, close } = await start({ ws, getConfig: () => configured, getHarness: () => undefined, queue: new KeyedQueue(), publicDir, port: 4319 });
    try {
      const { status, body } = await new Promise<{ status: number; body: string }>((resolve) => {
        const req = http.request({ host: "127.0.0.1", port: new URL(base).port, path: "/%ZZ" }, (res) => {
          let raw = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (raw += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: raw }));
        });
        req.end();
      });
      expect(status).toBe(404);
      expect(JSON.parse(body)).toEqual({ error: "文件不存在" });
    } finally {
      await close();
    }
  });
});

async function startWithFaux(
  employeeIds: string[],
  groupMembers: string[],
  options: { bossName?: string; thinkingLevel?: string; reasoning?: boolean } = {},
): Promise<{ base: string; close: () => Promise<void>; store: PermissionRequestStore; events: ServerEvent[] }> {
  seedOffice(root, {
    agents: employeeIds.map((id) => ({ id, alias: id === "alice" ? "爱丽丝" : id, model: "faux/faux-model", prompt: `你是 ${id}。` })),
    ...(groupMembers.length > 0 ? { projects: [{ id: "yt", members: groupMembers }] } : {}),
  });
  const config = {
    ...configured,
    ...(options.bossName === undefined ? {} : { bossName: options.bossName }),
    ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
  };
  // 称谓解析（bossNamesFor/readBossName）读的是 openstaffs/.data/config.json 文件，内存 getConfig 只服务 defaults；
  // 故自定义称谓必须落盘才生效（与 pump-trigger 用例同一真相源约定）。
  if (options.bossName !== undefined) {
    fs.mkdirSync(path.join(root, "openstaffs/.data"), { recursive: true });
    fs.writeFileSync(path.join(root, "openstaffs/.data", "config.json"), JSON.stringify(config));
  }
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "faux-model", ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }) }],
  });
  faux.setResponses(Array.from({ length: 20 }, (_, i) => fauxAssistantMessage(`收到${i}`)));
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = createPiHarness({ root, sqlitePath: path.join(root, `openstaffs/.data/state-${Date.now()}-${Math.random()}.sqlite`), models });
  await harness.open();
  const ws = createWorkspace(root);
  const store = new PermissionRequestStore(ws);
  // 会议视图读自有库：agent 回复要靠 pump 落库（对齐 main.ts 的接线）。
  const events: ServerEvent[] = [];
  const hub = {
    broadcast: (event: ServerEvent) => events.push(event),
    add: () => ({ pending: 0, close: () => {} }),
    size: 0,
  } as unknown as SseHub;
  const pump = new Pump({ ws, harness, hub, store: getStore(), meetings: getMeetings(), sessions: getSessions() });
  const server = createHttpServer({
    ws, store: getStore(), meetings: getMeetings(), sessions: getSessions(),
    getConfig: () => config, getHarness: () => harness, queue: new KeyedQueue(), publicDir, port: 4319,
    permissionRequests: store, pump, hub,
    titles: { store: getMeetings(), notify: (event) => hub.broadcast({ type: "meeting.title", ...event }) },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await harness.close();
    },
    store,
    events,
  };
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function postMessage(base: string, subjectKey: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/api/subjects/${encodeURIComponent(subjectKey)}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

type MeetingViewBody = {
  meetingId: string;
  messages: MeetingMessage[];
  pinned: string[];
  queued: QueuedItemView[];
  meeting: { title?: string };
};

async function meetingView(base: string, meetingId: string): Promise<MeetingViewBody> {
  return (await (await fetch(`${base}/api/meetings/${encodeURIComponent(meetingId)}/messages`)).json()) as MeetingViewBody;
}

describe("会议 API", () => {
  it("私聊：发消息 202 → 会议视图出现 boss 与员工回复（含 speaker 形状）；subject 视图给当前会议", async () => {
    const { base, close } = await startWithFaux(["alice"], []);
    try {
      const post = await postMessage(base, "dm:alice", { text: "你好", requestId: "t-1" });
      expect(post.status).toBe(202);
      const accepted = (await post.json()) as { meetingId: string; messageId: string; deliveries: { memberId: string; convId: string }[] };
      expect(accepted.meetingId).toMatch(/^mtg_/);
      expect(accepted.deliveries[0]!.memberId).toBe("alice");

      const merged = await waitFor(async () => {
        const body = await meetingView(base, accepted.meetingId);
        return body.messages.some((m) => m.speaker.kind === "employee") ? body : undefined;
      });
      expect(merged.messages[0]).toMatchObject({ speaker: { kind: "boss" }, text: "你好" });
      expect(merged.messages[1]).toMatchObject({ speaker: { kind: "employee", id: "alice", alias: "爱丽丝" }, text: "收到0" });

      const subject = (await (await fetch(`${base}/api/subjects/dm%3Aalice`)).json()) as {
        key: string;
        current?: { meetingId: string };
        meetings: { meetingId: string }[];
      };
      expect(subject.key).toBe("dm:alice");
      expect(subject.current?.meetingId).toBe(accepted.meetingId);
      expect(subject.meetings.map((meeting) => meeting.meetingId)).toEqual([accepted.meetingId]);
    } finally {
      await close();
    }
  });

  it("群聊：@alice 定向（正文保留 @）、不 @ / 只 @老板 400、空成员群 400", async () => {
    const { base, close } = await startWithFaux(["alice", "bob"], ["alice", "bob"]);
    try {
      const mentioned = await postMessage(base, "group:yt", { text: "@alice 做视频" });
      expect(mentioned.status).toBe(202);
      const accepted = (await mentioned.json()) as { meetingId: string; deliveries: { memberId: string }[] };
      expect(accepted.deliveries.map((d) => d.memberId)).toEqual(["alice"]);

      const merged = await waitFor(async () => {
        const body = await meetingView(base, accepted.meetingId);
        return body.messages.some((m) => m.speaker.kind === "employee") ? body : undefined;
      });
      expect(merged.messages[0]).toMatchObject({ speaker: { kind: "boss" }, text: "@alice 做视频" });

      expect((await postMessage(base, "group:yt", { text: "全体汇报" })).status).toBe(400);
      expect(((await (await postMessage(base, "group:yt", { text: "@老板 收到" })).json()) as { error: string }).error).toBe("消息需要 @ 至少一位群成员");

      // 空成员群（项目 config 的 members 为空）：合法群但没人可投 → 400「群还没有成员」
      writeJsonFile(projectConfigFile(createWorkspace(root), "empty"), { members: [] });
      const empty = await postMessage(base, "group:empty", { text: "在吗" });
      expect(empty.status).toBe(400);
      expect(((await empty.json()) as { error: string }).error).toBe("群还没有成员");
    } finally {
      await close();
    }
  });

  it("群聊 @alice @bob：写路径恰广播 1 条库行（store:<seq>），不按成员会话 N 份回显", async () => {
    const { base, close, events } = await startWithFaux(["alice", "bob"], ["alice", "bob"]);
    try {
      const post = await postMessage(base, "group:yt", { text: "@alice @bob 全体汇报" });
      expect(post.status).toBe(202);
      const accepted = (await post.json()) as { meetingId: string };

      const broadcast = await waitFor(async () => events.find((e) => e.type === "meeting.message" && e.message.speaker.kind === "boss"));
      if (broadcast.type !== "meeting.message") throw new Error("缺少老板广播");
      const bossEvents = events.filter((e) => e.type === "meeting.message" && e.message.speaker.kind === "boss");
      expect(bossEvents).toHaveLength(1);
      const seq = getStore().byMeeting(accepted.meetingId)[0]!.seq;
      expect(broadcast.meetingId).toBe(accepted.meetingId);
      expect(broadcast.message.convId).toBe("store");
      expect(broadcast.message.entryId).toBe(String(seq));
      expect(broadcast.message.text).toBe("@alice @bob 全体汇报");
    } finally {
      await close();
    }
  }, 30_000);

  it("老板库行广播附 UI 用 messageId（排队占位据此贴真气泡）；GET 会议视图不带", async () => {
    const { base, close, events } = await startWithFaux(["alice"], []);
    try {
      const post = await postMessage(base, "dm:alice", { text: "第一句" });
      expect(post.status).toBe(202);
      const accepted = (await post.json()) as { meetingId: string; messageId: string };

      const broadcast = events.find((event) => event.type === "meeting.message" && event.message.speaker.kind === "boss");
      if (broadcast?.type !== "meeting.message") throw new Error("缺少老板广播");
      expect(broadcast.message.messageId).toBe(accepted.messageId);
      expect(broadcast.message.entryId).toBe("1");

      const view = await meetingView(base, accepted.meetingId);
      expect(view.messages[0]).toMatchObject({ text: "第一句" });
      expect(view.messages[0]!.messageId).toBeUndefined();
    } finally {
      await close();
    }
  }, 30_000);

  it("新建会议：只开新线程，旧会议不结束、随时可继续聊", async () => {
    const { base, close } = await startWithFaux(["alice"], []);
    try {
      const first = (await (await postMessage(base, "dm:alice", { text: "第一场" })).json()) as { meetingId: string };
      await waitFor(async () => {
        const body = await meetingView(base, first.meetingId);
        return body.messages.some((m) => m.speaker.kind === "employee") ? body : undefined;
      });

      // 「新建会议」= 第一条消息落定时才建：先发一条带 newMeeting 的消息
      const freshPost = await postMessage(base, "dm:alice", { text: "第二场", newMeeting: true });
      expect(freshPost.status).toBe(202);
      const second = (await freshPost.json()) as { meetingId: string };
      expect(second.meetingId).not.toBe(first.meetingId);

      const subject = (await (await fetch(`${base}/api/subjects/dm%3Aalice`)).json()) as {
        current?: { meetingId: string };
        meetings: { meetingId: string }[];
      };
      expect(subject.current?.meetingId).toBe(second.meetingId); // 最新创建的是「当前」
      expect(subject.meetings).toHaveLength(2);
      expect(subject.meetings.map((m) => m.meetingId)).toEqual([second.meetingId, first.meetingId]);

      // 旧会议不结束：还能继续聊；新会议从新消息开始
      const old = await meetingView(base, first.meetingId);
      expect(old.messages.map((m) => m.text)).toContain("第一场");
      const next = await meetingView(base, second.meetingId);
      expect(next.messages[0]).toMatchObject({ text: "第二场" });
      expect(next.messages.every((m) => !m.text.includes("第一场"))).toBe(true);

      const resumed = await fetch(`${base}/api/meetings/${encodeURIComponent(first.meetingId)}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "补一句" }),
      });
      expect(resumed.status).toBe(202);
      const oldAfter = await meetingView(base, first.meetingId);
      expect(oldAfter.messages.map((m) => m.text)).toContain("补一句");
    } finally {
      await close();
    }
  }, 30_000);

  it("删除会议：会议行 / 消息 / 会话映射一并清；当前会议回退到上一场", async () => {
    const { base, close } = await startWithFaux(["alice"], []);
    try {
      const first = (await (await postMessage(base, "dm:alice", { text: "留着" })).json()) as { meetingId: string };
      const second = (await (await postMessage(base, "dm:alice", { text: "要删的", newMeeting: true })).json()) as { meetingId: string };

      const deleted = await fetch(`${base}/api/meetings/${second.meetingId}`, { method: "DELETE" });
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toMatchObject({ ok: true, meetingId: second.meetingId, subjectKey: "dm:alice" });

      expect((await fetch(`${base}/api/meetings/${second.meetingId}`)).status).toBe(404);
      const subject = (await (await fetch(`${base}/api/subjects/dm%3Aalice`)).json()) as {
        current?: { meetingId: string };
        meetings: { meetingId: string }[];
      };
      expect(subject.current?.meetingId).toBe(first.meetingId);
      expect(subject.meetings.map((m) => m.meetingId)).toEqual([first.meetingId]);
      expect((await meetingView(base, first.meetingId)).messages.map((m) => m.text)).toContain("留着");

      // 删不存在的会议 → 404
      expect((await fetch(`${base}/api/meetings/mtg_nope`, { method: "DELETE" })).status).toBe(404);
    } finally {
      await close();
    }
  }, 30_000);

  it("会话信息：模型全值 / 思考强度 / 上下文用量与窗口；不存在的会议 404", async () => {
    const { base, close } = await startWithFaux(["alice"], []);
    try {
      const accepted = (await (await postMessage(base, "dm:alice", { text: "你好", requestId: "info-1" })).json()) as { meetingId: string };
      const info = await waitFor(async () => {
        const res = await fetch(`${base}/api/meetings/${accepted.meetingId}/sessions/info`);
        const body = (await res.json()) as { sessions: { memberId: string; model: string; thinkingLevel: string | null; contextUsed: number; contextWindow?: number }[] };
        return body.sessions.length > 0 && body.sessions[0]!.contextUsed > 0 ? body : undefined;
      });
      expect(info.sessions[0]).toMatchObject({
        memberId: "alice",
        model: "faux/faux-model",
        thinkingLevel: "off",
        contextWindow: 128000,
      });
      expect((await fetch(`${base}/api/meetings/mtg_nope/sessions/info`)).status).toBe(404);
    } finally {
      await close();
    }
  });

  it("全局 thinkingLevel 进入新会话；模型不支持该档 → 信息条返回 null", async () => {
    const { base, close } = await startWithFaux(["alice"], [], { thinkingLevel: "high", reasoning: false });
    try {
      const accepted = (await (await postMessage(base, "dm:alice", { text: "你好", requestId: "info-2" })).json()) as { meetingId: string };
      const info = await waitFor(async () => {
        const res = await fetch(`${base}/api/meetings/${accepted.meetingId}/sessions/info`);
        const body = (await res.json()) as { sessions: { thinkingLevel: string | null; contextUsed: number }[] };
        return body.sessions.length > 0 && body.sessions[0]!.contextUsed > 0 ? body : undefined;
      });
      expect(info.sessions[0]!.thinkingLevel).toBeNull();
    } finally {
      await close();
    }
  });

  it("会议标题：subject 下发 title；PATCH 改名走 manual 并广播；400 / 404 边界", async () => {
    const { base, close, events } = await startWithFaux(["alice"], []);
    try {
      const accepted = (await (await postMessage(base, "dm:alice", { text: "帮我看看登录", requestId: "title-1" })).json()) as { meetingId: string };

      const subject = (await (await fetch(`${base}/api/subjects/dm%3Aalice`)).json()) as { meetings: { title?: string }[] };
      expect(subject.meetings[0]!.title).toBeTruthy();

      const patched = await fetch(`${base}/api/meetings/${accepted.meetingId}/title`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "  我自己改的  " }),
      });
      expect(patched.status).toBe(200);
      expect(await patched.json()).toEqual({ meetingId: accepted.meetingId, title: "我自己改的", titleSource: "manual" });
      expect(getMeetings().get(accepted.meetingId)).toMatchObject({ title: "我自己改的", titleSource: "manual" });
      expect(events.some((event) => event.type === "meeting.title" && event.meetingId === accepted.meetingId && event.title === "我自己改的")).toBe(true);

      const after = (await (await fetch(`${base}/api/subjects/dm%3Aalice`)).json()) as { meetings: { title?: string }[] };
      expect(after.meetings[0]!.title).toBe("我自己改的");

      const patch = (meetingId: string, body: unknown) =>
        fetch(`${base}/api/meetings/${meetingId}/title`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      expect((await patch(accepted.meetingId, { title: "   " })).status).toBe(400);
      expect((await patch(accepted.meetingId, { title: "字".repeat(41) })).status).toBe(400);
      expect((await patch(accepted.meetingId, {})).status).toBe(400);
      expect((await patch("mtg_nope", { title: "随便" })).status).toBe(404);
    } finally {
      await close();
    }
  });

  it("interrupt：会议级中断返回 aborted（无在跑也 200）；不存在的会议 404", async () => {
    const { base, close } = await startWithFaux(["alice"], []);
    try {
      const accepted = (await (await postMessage(base, "dm:alice", { text: "你好" })).json()) as { meetingId: string };
      const res = await fetch(`${base}/api/meetings/${accepted.meetingId}/interrupt`, { method: "POST" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { aborted: string[] };
      expect(Array.isArray(body.aborted)).toBe(true);
      expect((await fetch(`${base}/api/meetings/mtg_nope/interrupt`, { method: "POST" })).status).toBe(404);
    } finally {
      await close();
    }
  });

  it("不存在的主题 404；主题键 / 会议 id 畸形编码 404", async () => {
    const { base, close } = await startWithFaux([], []);
    try {
      expect((await fetch(`${base}/api/subjects/dm%3Anobody/messages`)).status).toBe(404);
      expect((await fetch(`${base}/api/subjects/group%3Anone/messages`)).status).toBe(404);
      expect((await fetch(`${base}/api/subjects/dm%3A..%2F..%2F..%2Fetc/messages`)).status).toBe(404);
      expect((await fetch(`${base}/api/meetings/%2E%2E%2Fetc/messages`)).status).toBe(404);

      const malformed = await new Promise<number>((resolve) => {
        const req = http.request({ host: "127.0.0.1", port: new URL(base).port, path: "/api/subjects/dm:%ZZ/messages" }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.end();
      });
      expect(malformed).toBe(404);
    } finally {
      await close();
    }
  });

  it("pin 闭环：pin 一条 → 主题红点 1 → 取消 → 0；不存在的消息 404", async () => {
    const { base, close } = await startWithFaux(["alice"], []);
    try {
      const accepted = (await (await postMessage(base, "dm:alice", { text: "请回答" })).json()) as { meetingId: string };

      const merged = await waitFor(async () => {
        const body = await meetingView(base, accepted.meetingId);
        return body.messages.some((m) => m.speaker.kind === "employee") ? body : undefined;
      });
      expect(merged.pinned).toEqual([]);
      const before = (await (await fetch(`${base}/api/pins`)).json()) as { total: number; subjects: Record<string, number> };
      expect(before.subjects["dm:alice"] ?? 0).toBe(0);

      const employee = merged.messages.find((m) => m.speaker.kind === "employee")!;
      const pin = await fetch(`${base}/api/meetings/${accepted.meetingId}/pin`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ convId: employee.convId, entryId: employee.entryId, pinned: true }),
      });
      expect(pin.status).toBe(200);
      expect((await pin.json()) as { ok: boolean; count: number }).toMatchObject({ ok: true, count: 1 });

      const after = (await (await fetch(`${base}/api/pins`)).json()) as { total: number; subjects: Record<string, number> };
      expect(after.subjects["dm:alice"]).toBe(1);

      const merged2 = await meetingView(base, accepted.meetingId);
      expect(merged2.pinned).toEqual([`${employee.convId}:${employee.entryId}`]);

      const unpin = await fetch(`${base}/api/meetings/${accepted.meetingId}/pin`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ convId: employee.convId, entryId: employee.entryId, pinned: false }),
      });
      expect((await unpin.json()) as { count: number }).toMatchObject({ count: 0 });
      const cleared = (await (await fetch(`${base}/api/pins`)).json()) as { total: number; subjects: Record<string, number> };
      expect(cleared.subjects["dm:alice"] ?? 0).toBe(0);

      const ghost = await fetch(`${base}/api/meetings/${accepted.meetingId}/pin`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ convId: "store", entryId: "999", pinned: true }),
      });
      expect(ghost.status).toBe(404);
    } finally {
      await close();
    }
  });

  it("称谓自定义：群回复 fallback 用真称谓（@掌柜）", async () => {
    const { base, close } = await startWithFaux(["alice"], ["alice"], { bossName: "掌柜" });
    try {
      const status = (await (await fetch(`${base}/api/status`)).json()) as { bossName: string };
      expect(status.bossName).toBe("掌柜");
      const accepted = (await (await postMessage(base, "group:yt", { text: "@alice 你好" })).json()) as { meetingId: string };
      const merged = await waitFor(async () => {
        const body = await meetingView(base, accepted.meetingId);
        return body.messages.some((m) => m.speaker.kind === "employee") ? body : undefined;
      });
      expect(merged.messages.some((m) => m.text === "@掌柜 收到0")).toBe(true);
    } finally {
      await close();
    }
  });
});

describe("待发队列 API（排队中了要看得见、可单条撤回）", () => {
  async function startQueued(): Promise<{
    base: string;
    close: () => Promise<void>;
    release: () => void;
    events: ServerEvent[];
  }> {
    fs.mkdirSync(path.join(root, "agents"), { recursive: true });
    fs.writeFileSync(path.join(root, "agents", "alice.agent.config.json"), JSON.stringify({ model: "faux/faux-model", prompt: "你是 alice。" }));

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
    // 第一条卡住不返回 → alice 一直在跑，后面的消息只能排队
    faux.setResponses([async () => {
      await gate;
      return fauxAssistantMessage("第一轮回复");
    }, fauxAssistantMessage("第二轮回复")]);
    const models = createModels();
    models.setProvider(faux.provider);
    const harness = createPiHarness({ root, sqlitePath: path.join(root, `openstaffs/.data/state-queue-${Date.now()}.sqlite`), models });
    await harness.open();
    const ws = createWorkspace(root);
    const events: ServerEvent[] = [];
    const hub = {
      broadcast: (event: ServerEvent) => events.push(event),
      add: () => ({ pending: 0, close: () => {} }),
      size: 0,
    } as unknown as SseHub;
    const pump = new Pump({ ws, harness, hub, store: getStore(), meetings: getMeetings(), sessions: getSessions() });
    const server = createHttpServer({
      ws,
      store: getStore(),
      meetings: getMeetings(),
      sessions: getSessions(),
      getConfig: () => configured,
      getHarness: () => harness,
      queue: new KeyedQueue(),
      outbox: new Outbox(),
      hub,
      pump,
      publicDir,
      port: 4319,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
      base: `http://127.0.0.1:${port}`,
      release,
      events,
      close: async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await harness.close();
      },
    };
  }

  function post(base: string, body: unknown): Promise<Response> {
    return postMessage(base, "dm:alice", body as Record<string, unknown>);
  }

  async function room(base: string, meetingId: string): Promise<MeetingViewBody> {
    return meetingView(base, meetingId);
  }

  it("员工在跑：第二条以 queued 返回 + 进待发表 + 广播；撤回后不再投递", async () => {
    const { base, close, release, events } = await startQueued();
    try {
      const first = await post(base, { text: "第一轮" });
      expect(first.status).toBe(202);
      const firstBody = (await first.json()) as { meetingId: string; deliveries: { status: string }[] };
      expect(firstBody.deliveries[0]!.status).toBe("placed");

      const second = await post(base, { text: "第二条" });
      expect(second.status).toBe(202);
      const accepted = (await second.json()) as { meetingId: string; messageId: string; deliveries: { status: string; submissionId: string }[] };
      expect(accepted.deliveries[0]!.status).toBe("queued");

      const queuedEvent = await waitFor(async () => events.find((e) => e.type === "meeting.queued"));
      expect(queuedEvent.type === "meeting.queued" ? queuedEvent.item : undefined).toMatchObject({
        submissionId: accepted.deliveries[0]!.submissionId,
        memberId: "alice",
        messageId: accepted.messageId,
        text: "第二条",
      });

      const withQueued = await room(base, accepted.meetingId);
      expect(withQueued.queued.map((item) => item.text)).toEqual(["第二条"]);
      expect(withQueued.messages.map((m) => m.text)).toEqual(["第一轮", "第二条"]);

      const cancel = await fetch(`${base}/api/meetings/${accepted.meetingId}/queue/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId: accepted.messageId }),
      });
      expect(cancel.status).toBe(200);
      expect(((await cancel.json()) as { cancelled: string[] }).cancelled).toEqual([accepted.deliveries[0]!.submissionId]);
      expect(events.some((e) => e.type === "meeting.dequeued" && e.reason === "cancelled")).toBe(true);

      expect((await room(base, accepted.meetingId)).queued).toEqual([]);

      // 撤回的输入绝不投递：放开第一轮后，该会话 transcript 里只有第一轮与其回复
      release();
      await waitFor(async () => ((await room(base, accepted.meetingId)).messages.some((m) => m.text === "第一轮回复") ? true : undefined));
      const participants = (await (await fetch(`${base}/api/meetings/${accepted.meetingId}/sessions`)).json()) as {
        participants: { memberId: string; convId?: string }[];
      };
      const convId = participants.participants[0]!.convId!;
      const history = (await (await fetch(`${base}/api/meetings/${accepted.meetingId}/sessions/${convId}/messages`)).json()) as { messages: { text: string }[] };
      expect(history.messages.map((m) => m.text)).toEqual(["第一轮", "第一轮回复"]);
    } finally {
      await close();
    }
  }, 30_000);

  it("GET 会议：仍在排队的库行回填 messageId（与 SSE 同口径），渲染不出重复气泡", async () => {
    const { base, close, release } = await startQueued();
    try {
      const first = (await (await post(base, { text: "第一轮" })).json()) as { meetingId: string };
      const second = await post(base, { text: "第二条" });
      const accepted = (await second.json()) as { messageId: string; deliveries: { status: string }[] };
      expect(accepted.deliveries[0]!.status).toBe("queued");

      const view = await room(base, first.meetingId);
      expect(view.messages.find((m) => m.text === "第二条")!.messageId).toBe(accepted.messageId);
      expect(view.messages.find((m) => m.text === "第一轮")!.messageId).toBeUndefined();

      const html = messagesHtml(view.messages, "老板", view.pinned, view.queued);
      expect(html.match(/class="msg boss/g)).toHaveLength(2);
      expect(html).not.toContain('class="msg boss queued"');
    } finally {
      release();
      await close();
    }
  }, 30_000);

  it("撤不回已开始投递的：409 + 明确文案；messageId 必填 400", async () => {
    const { base, close, release } = await startQueued();
    try {
      const first = (await (await post(base, { text: "第一轮" })).json()) as { meetingId: string; messageId: string };
      const conflict = await fetch(`${base}/api/meetings/${first.meetingId}/queue/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId: first.messageId }),
      });
      expect(conflict.status).toBe(409);
      expect(((await conflict.json()) as { error: string }).error).toContain("撤不回");

      const missing = await fetch(`${base}/api/meetings/${first.meetingId}/queue/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(missing.status).toBe(400);
    } finally {
      release();
      await close();
    }
  }, 30_000);
});

describe("授权请求 API", () => {
  it("GET 列表（新在前、带 agentName/来源）；accept 写权限并投递「已完成授权」；处理后列表清空", async () => {
    const { base, close, store } = await startWithFaux(["alice"], []);
    try {
      const target = path.join(root, "outside", "shared");
      const ws = createWorkspace(root);
      const meeting = ensureMeeting({ ws, meetings: getMeetings() }, { kind: "dm", employeeId: "alice" }, new Date());
      const { request: added } = store.add({ agentId: "alice", meetingId: meeting.meetingId, tools: ["write"], paths: [target], reason: "要写共享目录" });

      const list = (await (await fetch(`${base}/api/permission-requests`)).json()) as {
        requests: { id: string; agentName: string; where: string; paths: string[]; reason: string }[];
      };
      expect(list.requests).toHaveLength(1);
      expect(list.requests[0]).toMatchObject({ id: added.id, agentName: "爱丽丝", where: "私聊 · 爱丽丝", paths: [target], reason: "要写共享目录" });

      const resolve = await fetch(`${base}/api/permission-requests/${added.id}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "accept" }),
      });
      expect(resolve.status).toBe(200);
      expect(await resolve.json()).toEqual({ ok: true });

      expect(
        (JSON.parse(fs.readFileSync(path.join(root, "agents", "alice.agent.config.json"), "utf8")) as { permissions?: { write?: string[] } })
          .permissions?.write,
      ).toEqual([target]);
      await waitFor(async () => {
        const body = await meetingView(base, meeting.meetingId);
        return body.messages.some((m) => m.speaker.kind === "boss" && m.text === "已完成授权") ? body : undefined;
      });
      const after = (await (await fetch(`${base}/api/permission-requests`)).json()) as { requests: unknown[] };
      expect(after.requests).toEqual([]);
    } finally {
      await close();
    }
  });

  it("群聊 accept：消息以 @alice 已完成授权 开头（只触发该成员）", async () => {
    const { base, close, store } = await startWithFaux(["alice"], ["alice"]);
    try {
      const ws = createWorkspace(root);
      const meeting = ensureMeeting({ ws, meetings: getMeetings() }, { kind: "group", project: "yt" }, new Date());
      const { request: added } = store.add({ agentId: "alice", meetingId: meeting.meetingId, tools: ["write"], paths: [path.join(root, "outside")], reason: "r" });
      const resolve = await fetch(`${base}/api/permission-requests/${added.id}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "accept" }),
      });
      expect(resolve.status).toBe(200);
      const merged = await waitFor(async () => {
        const body = await meetingView(base, meeting.meetingId);
        return body.messages.some((m) => m.text === "@alice 已完成授权") ? body : undefined;
      });
      expect(merged.messages.some((m) => m.text === "@alice 已完成授权")).toBe(true);
    } finally {
      await close();
    }
  });

  it("reject 不写文件；未知 id 404；非法 decision 400", async () => {
    const { base, close, store } = await startWithFaux(["alice"], []);
    try {
      const ws = createWorkspace(root);
      const meeting = ensureMeeting({ ws, meetings: getMeetings() }, { kind: "dm", employeeId: "alice" }, new Date());
      const { request: added } = store.add({ agentId: "alice", meetingId: meeting.meetingId, tools: ["write"], paths: [path.join(root, "outside")], reason: "r" });
      const reject = await fetch(`${base}/api/permission-requests/${added.id}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "reject" }),
      });
      expect(reject.status).toBe(200);
      expect(
        (JSON.parse(fs.readFileSync(path.join(root, "agents", "alice.agent.config.json"), "utf8")) as { permissions?: unknown })
          .permissions,
      ).toBeUndefined();

      const bad = await fetch(`${base}/api/permission-requests/${added.id}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "maybe" }),
      });
      expect(bad.status).toBe(400);
      const missing = await fetch(`${base}/api/permission-requests/pr_ghost/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "accept" }),
      });
      expect(missing.status).toBe(404);
    } finally {
      await close();
    }
  });
});

describe("员工会话上下文 API", () => {
  it("列出活跃会话（运行中优先）+ 返回完整上下文；非本人员工/会话 404", async () => {
    seedOffice(root, {
      agents: [
        { id: "alice", alias: "爱丽丝", model: "faux/faux-model" },
        { id: "bob", alias: "鲍勃", model: "faux/faux-model" },
      ],
      projects: [{ id: "yt", alias: "油管", members: ["alice"] }, { id: "seo", members: ["bob"] }],
    });
    const ws = createWorkspace(root);
    const dm = ensureMeeting({ ws, meetings: getMeetings() }, { kind: "dm", employeeId: "alice" }, new Date());
    const yt = ensureMeeting({ ws, meetings: getMeetings() }, { kind: "group", project: "yt" }, new Date());
    const seo = ensureMeeting({ ws, meetings: getMeetings() }, { kind: "group", project: "seo" }, new Date());
    const seeded = getSessions();
    seeded.open({ convId: "conv_dm", meetingId: dm.meetingId, memberId: "alice", started: "2026-10-25T10:00:00+08:00" });
    seeded.open({ convId: "conv_yt", meetingId: yt.meetingId, memberId: "alice", started: "2026-10-25T10:01:00+08:00" });
    seeded.open({ convId: "conv_bob", meetingId: seo.meetingId, memberId: "bob", started: "2026-10-25T10:02:00+08:00" });

    const harness = {
      sessionUsage: async (convId: string) => ({
        model: { provider: "faux", modelId: "faux-model" },
        thinkingLevel: "medium",
        contextUsed: convId === "conv_dm" ? 10 : 20,
      }),
      context: async (convId: string) => ({
        instructions: "你是 alice。",
        items: [{ role: "user" as const, text: `问题 ${convId}` }],
      }),
    } as unknown as HarnessPort;
    const pump = {
      register: async () => {},
      unregister: async () => {},
      isRunning: (id: string) => id === "conv_yt",
    };
    const { base, close } = await start({
      ws,
      getConfig: () => configured,
      getHarness: () => harness,
      queue: new KeyedQueue(),
      publicDir,
      port: 4319,
      pump,
    });
    try {
      const list = (await (await fetch(`${base}/api/employees/alice/sessions`)).json()) as {
        employee: { id: string; alias?: string };
        sessions: Record<string, unknown>[];
      };
      expect(list.employee).toEqual({ id: "alice", alias: "爱丽丝" });
      expect(list.sessions.map((session) => session["convId"])).toEqual(["conv_yt", "conv_dm"]);
      expect(list.sessions[0]).toMatchObject({
        kind: "group", subjectKey: "group:yt", projectId: "yt", projectAlias: "油管", running: true, model: "faux/faux-model", contextUsed: 20,
      });

      const context = (await (await fetch(`${base}/api/employees/alice/sessions/conv_dm/context`)).json()) as {
        instructions: string;
        items: { role: string; text: string }[];
        subjectKey: string;
      };
      expect(context.instructions).toContain("你是 alice。");
      expect(context.subjectKey).toBe("dm:alice");
      expect(context.items).toEqual([{ role: "user", text: "问题 conv_dm" }]);

      expect((await fetch(`${base}/api/employees/nobody/sessions`)).status).toBe(404);
      expect((await fetch(`${base}/api/employees/alice/sessions/nope/context`)).status).toBe(404);
      // 越权：alice 的 URL 不能取 bob 的会话上下文
      expect((await fetch(`${base}/api/employees/alice/sessions/conv_bob/context`)).status).toBe(404);
    } finally {
      await close();
    }
  });
});

describe("定义文件 API（侧栏 {} 按钮）", () => {
  it("agent / department / project 三类都能取原文；缺文件 → text:null；不存在 / 越界 → 404", async () => {
    seedOffice(root, {
      departments: [{ path: "eng", alias: "研发" }],
      agents: [{ id: "alice", department: "eng", model: "faux/faux-model", prompt: "你是 alice。" }],
      projects: [{ id: "yt", alias: "油管", members: ["alice"] }],
    });
    const ws = createWorkspace(root);
    const { base, close } = await start({
      ws,
      getConfig: () => configured,
      getHarness: () => undefined,
      queue: new KeyedQueue(),
      publicDir,
      port: 4319,
    });
    const get = async (query: string): Promise<{ scope: string; id: string; file: string; text: string | null }> =>
      (await (await fetch(`${base}/api/config?${query}`)).json()) as { scope: string; id: string; file: string; text: string | null };
    try {
      const agent = await get("scope=agent&id=alice");
      expect(agent.file).toBe(path.join("agents", "eng", "alice.agent.config.json"));
      expect(agent.text).toContain("你是 alice。");

      const dept = await get("scope=department&id=eng");
      expect(dept.file).toBe(path.join("agents", "eng", "department.config.json"));
      expect(dept.text).toContain("研发");

      // 根部门没写 department.config.json：文件路径照给，正文 null（前端提示「该层没有配置文件」）
      const rootDept = await get("scope=department&id=");
      expect(rootDept.file).toBe(path.join("agents", "department.config.json"));
      expect(rootDept.text).toBeNull();

      const project = await get("scope=project&id=yt");
      expect(project.file).toBe(path.join("projects", "yt.project.config.json"));
      expect(project.text).toContain("油管");

      expect((await fetch(`${base}/api/config?scope=agent&id=ghost`)).status).toBe(404);
      expect((await fetch(`${base}/api/config?scope=agent&id=..%2Fbob`)).status).toBe(404);
      expect((await fetch(`${base}/api/config?scope=project&id=..%2F..%2Fetc`)).status).toBe(404);
      expect((await fetch(`${base}/api/config?scope=nope&id=alice`)).status).toBe(404);
    } finally {
      await close();
    }
  });
});
