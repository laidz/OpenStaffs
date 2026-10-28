import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspace, officeDbFile, stateDir } from "../../src/domain/paths.ts";

import { createPiHarness } from "../../src/harness/pi-durable.ts";
import type { HarnessEvent, HarnessPort } from "../../src/harness/port.ts";
import { KeyedQueue } from "../../src/app/send.ts";
import { Outbox } from "../../src/app/outbox.ts";
import { resolveSession } from "../../src/app/conversations.ts";
import { openMessageStore, type MessageStore } from "../../src/store/messages.ts";
import { openSessionStore, type SessionStore } from "../../src/store/sessions.ts";
import { openMeetingStore, type MeetingStore } from "../../src/store/meetings.ts";
import { ensureMeeting } from "../../src/app/meetings.ts";
import { SseHub, type ServerEvent } from "../../src/server/sse.ts";
import { Pump } from "../../src/server/pump.ts";
import { createHttpServer } from "../../src/server/http.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-sse-"));

// 接线前提（对齐 main.ts）：stateDir 先建；每个用例一套库，afterEach 关闭并清目录。
let store: MessageStore | undefined;
function getStore(): MessageStore {
  if (store === undefined) {
    fs.mkdirSync(stateDir(createWorkspace(root)), { recursive: true });
    store = openMessageStore(officeDbFile(createWorkspace(root)));
  }
  return store;
}

// 会话表（唯一真相）：与消息同库文件；每个用例一份。
let sessionStore: SessionStore | undefined;
let meetingStore: MeetingStore | undefined;
function getMeetings(): MeetingStore {
  if (meetingStore === undefined) {
    fs.mkdirSync(stateDir(createWorkspace(root)), { recursive: true });
    meetingStore = openMeetingStore(officeDbFile(createWorkspace(root)));
  }
  return meetingStore;
}

/** 主题键（dm:<员工> / group:<项目>）→ 该主题进行中会议 id。 */
function mtg(key: string): string {
  const ws = createWorkspace(root);
  if (key.startsWith("dm:")) return ensureMeeting({ ws, meetings: getMeetings() }, { kind: "dm", employeeId: key.slice(3) }, new Date("2026-10-26T10:00:00.000Z")).meetingId;
  return ensureMeeting({ ws, meetings: getMeetings() }, { kind: "group", project: key.slice(6) }, new Date("2026-10-26T10:00:00.000Z")).meetingId;
}
/** 发送 / 主题入口路径（服务端按主题解析当前会议）。 */
const subjectPath = (key: string, tail = ""): string => `/api/subjects/${encodeURIComponent(key)}${tail}`;
/** 会议维度路径（消息 / pin / 会话 …）。 */
const meetingPath = (key: string, tail: string): string => `/api/meetings/${encodeURIComponent(mtg(key))}${tail}`;

function getSessions(): SessionStore {
  if (sessionStore === undefined) {
    fs.mkdirSync(stateDir(createWorkspace(root)), { recursive: true });
    sessionStore = openSessionStore(officeDbFile(createWorkspace(root)));
  }
  return sessionStore;
}

afterEach(() => {
  meetingStore?.close();
  meetingStore = undefined;
  store?.close();
  store = undefined;
  sessionStore?.close();
  sessionStore = undefined;
  fs.rmSync(path.join(root, "agents"), { recursive: true, force: true });
  fs.rmSync(path.join(root, "work"), { recursive: true, force: true });
  fs.rmSync(path.join(root, "projects"), { recursive: true, force: true });
  fs.rmSync(path.join(root, "openstaffs/.data"), { recursive: true, force: true });
});

function fakeRes(): { res: ServerResponse; writes: string[] } {
  const writes: string[] = [];
  const res = {
    writeHead: () => res,
    write: (chunk: string) => {
      writes.push(String(chunk));
      return true;
    },
    once: () => res,
    end: () => {},
  } as unknown as ServerResponse;
  return { res, writes };
}

describe("SseHub", () => {
  it("广播写入客户端；慢客户端溢出丢弃 delta、保留权威事件；断开清理", async () => {
    const hub = new SseHub();
    const client = hub.add({ on: () => {} } as never, fakeRes().res);
    expect(hub.size).toBe(1);
    for (let i = 0; i < 300; i++) {
      hub.broadcast({ type: "meeting.delta", meetingId: "dm:a", convId: "c", memberId: "a", channel: "text", delta: `d${i}` });
    }
    hub.broadcast({ type: "meeting.message", meetingId: "dm:a", message: { convId: "c", entryId: "1", speaker: { kind: "boss" }, text: "权威", bossDirected: false } });
    expect(client.pending).toBeLessThanOrEqual(200);
    client.close();
    expect(hub.size).toBe(0);
  });

  it("授权事件可序列化广播（permission.request / permission.resolved）", () => {
    const hub = new SseHub();
    const { res, writes } = fakeRes();
    hub.add({ on: () => {} } as never, res);
    hub.broadcast({
      type: "permission.request",
      request: { id: "pr_1", agentId: "alice", agentName: "爱丽丝", meetingId: "dm:alice", tools: ["write"], paths: ["/x"], reason: "r", createdAt: "t", where: "私聊 · alice" },
    });
    hub.broadcast({ type: "permission.resolved", id: "pr_1" });
    expect(writes.some((w) => w.includes("permission.request"))).toBe(true);
    expect(writes.some((w) => w.includes("permission.resolved"))).toBe(true);
  });
});

async function collect(body: ReadableStream<Uint8Array>, sink: ServerEvent[]): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    let chunk: { done: boolean; value?: Uint8Array };
    try {
      chunk = await reader.read();
    } catch {
      return; // 客户端在测试清理阶段中止连接：读取失败，静默结束
    }
    if (chunk.done) return;
    buffer += decoder.decode(chunk.value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (line !== undefined) sink.push(JSON.parse(line.slice(6)) as ServerEvent);
    }
  }
}

async function waitUntil(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil 超时");
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

describe("SSE 全链路", () => {
  it("发消息后推送：room.message(user) → delta → room.message(assistant)；pin 后推 room.pins", async () => {
    fs.mkdirSync(path.join(root, "agents"), { recursive: true });
    fs.writeFileSync(path.join(root, "agents", "alice.agent.config.json"), JSON.stringify({ model: "faux/faux-model", prompt: "你是 alice。" }));

    // tokensPerSecond/tokenSize：放慢流式输出，使 delta 跨过 pi-durable 的 100ms partial 落盘窗口（否则 faux 瞬时出稿、无增量事件）。
    // 回答文本足够长（29 字 ≈ 400ms 流式）以保证 delta 断言稳定；仍以 "流式回答内容" 开头。
    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }], tokensPerSecond: 20, tokenSize: { min: 1, max: 1 } });
    faux.setResponses([fauxAssistantMessage("流式回答内容：这是一段足够长的回答，用来跨过增量落盘窗口。")]);
    const models = createModels();
    models.setProvider(faux.provider);
    const ws = createWorkspace(root);
    const harness = createPiHarness({ root, sqlitePath: path.join(root, "openstaffs/.data", "state.sqlite"), models });
    await harness.open();

    const hub = new SseHub();
    const pump = new Pump({ ws, harness, hub, store: getStore(), meetings: getMeetings(), sessions: getSessions() });
    const server = createHttpServer({
      ws,
      store: getStore(),
      meetings: getMeetings(),
      sessions: getSessions(),
      getConfig: () => ({ providers: { faux: { apiKey: "k" } }, model: "faux/faux-model", port: 4319 }),
      getHarness: () => harness,
      queue: new KeyedQueue(),
      publicDir: path.join(root, "public"),
      port: 4319,
      pump,
      hub,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const events: ServerEvent[] = [];
    const abort = new AbortController();
    const sseRes = await fetch(`${base}/api/events`, { signal: abort.signal });
    expect(sseRes.status).toBe(200);
    void collect(sseRes.body!, events);

    try {
      // 先用一条消息把会话立起来（POST /messages 内 sendToRoom 先 submit、后注册订阅：
      // 新会话的首条老板消息不经 SSE 推来，订阅在它之后才建立；后续消息才会被推）。
      const bootstrap = await fetch(`${base}${subjectPath("dm:alice", "/messages")}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "预热" }),
      });
      expect(bootstrap.status).toBe(202);
      await waitUntil(() => events.some((e) => e.type === "meeting.message" && e.message.speaker.kind === "employee"));

      // 已有订阅：老板消息 → 流式增量 → 员工消息 全链路可见
      const post = await fetch(`${base}${subjectPath("dm:alice", "/messages")}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "你好" }),
      });
      expect(post.status).toBe(202);

      await waitUntil(() => events.some((e) => e.type === "meeting.message" && e.message.speaker.kind === "boss" && e.message.text === "你好"));
      expect(events.some((e) => e.type === "meeting.delta" && e.delta.length > 0)).toBe(true);
      const assistant = events.find((e) => e.type === "meeting.message" && e.message.speaker.kind === "employee");
      expect(assistant?.type === "meeting.message" ? assistant.message.text : "").toContain("流式回答内容");
      // 新消息到达不改变红点（pin 由老板主动触发）→ 不应有 room.pins
      expect(events.some((e) => e.type === "meeting.pins")).toBe(false);

      // 老板 pin 一条 → 服务端落盘并广播新的红点计数
      const employee = events.find((e) => e.type === "meeting.message" && e.message.speaker.kind === "employee");
      if (employee?.type !== "meeting.message") throw new Error("缺少员工消息");
      const pin = await fetch(`${base}${meetingPath("dm:alice", "/pin")}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ convId: employee.message.convId, entryId: employee.message.entryId, pinned: true }),
      });
      expect(pin.status).toBe(200);
      await waitUntil(() => events.some((e) => e.type === "meeting.pins" && e.meetingId === mtg("dm:alice") && e.count === 1));
    } finally {
      abort.abort(); // 客户端断开（hub 依 req close 清理）；否则常驻 SSE 连接会让 server.close() 一直阻塞
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await harness.close();
    }
  }, 30_000);
});

describe("待发队列全链路（Pi submission 事件驱动）", () => {
  it("忙时发送 → room.queued；投递开始 → room.dequeued(delivered)；消息照常落盘", async () => {
    fs.mkdirSync(path.join(root, "agents"), { recursive: true });
    fs.writeFileSync(path.join(root, "agents", "alice.agent.config.json"), JSON.stringify({ model: "faux/faux-model", prompt: "你是 alice。" }));

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
    faux.setResponses([
      async () => {
        await gate; // 第一轮卡住 → alice 忙
        return fauxAssistantMessage("第一轮回复");
      },
      fauxAssistantMessage("第二轮回复"),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const ws = createWorkspace(root);
    const harness = createPiHarness({ root, sqlitePath: path.join(root, "openstaffs/.data", "state-outbox.sqlite"), models });
    await harness.open();

    const hub = new SseHub();
    const outbox = new Outbox();
    const pump = new Pump({ ws, harness, hub, outbox, store: getStore(), meetings: getMeetings(), sessions: getSessions() });
    const server = createHttpServer({
      ws,
      store: getStore(),
      meetings: getMeetings(),
      sessions: getSessions(),
      getConfig: () => ({ providers: { faux: { apiKey: "k" } }, model: "faux/faux-model", port: 4319 }),
      getHarness: () => harness,
      queue: new KeyedQueue(),
      outbox,
      publicDir: path.join(root, "public"),
      port: 4319,
      pump,
      hub,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const events: ServerEvent[] = [];
    const abort = new AbortController();
    const sseRes = await fetch(`${base}/api/events`, { signal: abort.signal });
    void collect(sseRes.body!, events);
    const send = (text: string) =>
      fetch(`${base}${subjectPath("dm:alice", "/messages")}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });

    try {
      const first = await send("第一轮");
      expect(((await first.json()) as { deliveries: { status: string }[] }).deliveries[0]!.status).toBe("placed");
      const participants = (await (await fetch(`${base}${meetingPath("dm:alice", "/sessions")}`)).json()) as { participants: { memberId: string; convId?: string }[] };
      await pump.register(participants.participants[0]!.convId!, { meetingId: mtg("dm:alice"), memberId: "alice" });

      const second = await send("第二条");
      const accepted = (await second.json()) as { messageId: string; deliveries: { submissionId: string; status: string }[] };
      expect(accepted.deliveries[0]!.status).toBe("queued");

      // 入队事件：前端据此在消息区显示「排队中」
      await waitUntil(() => events.some((e) => e.type === "meeting.queued"));
      const queuedEvent = events.find((e) => e.type === "meeting.queued");
      expect(queuedEvent?.type === "meeting.queued" ? queuedEvent.item : undefined).toMatchObject({
        submissionId: accepted.deliveries[0]!.submissionId,
        messageId: accepted.messageId,
        memberId: "alice",
      });

      // 放开第一轮：Pi 在轮次边界把排队的输入落盘 → pump 收到 submission 事件 → 广播出队
      release();
      await waitUntil(() => events.some((e) => e.type === "meeting.dequeued" && e.submissionId === accepted.deliveries[0]!.submissionId));
      const dequeued = events.find((e) => e.type === "meeting.dequeued");
      expect(dequeued?.type === "meeting.dequeued" ? dequeued.reason : "").toBe("delivered");

      // 照常投递：第二条进了 transcript，待发表清空
      const merged = await waitFor(async () => {
        const body = (await (await fetch(`${base}${meetingPath("dm:alice", "/messages")}`)).json()) as { messages: { text: string }[]; queued: unknown[] };
        return body.messages.some((m) => m.text === "第二轮回复") ? body : undefined;
      });
      // 排队的输入在发送时即落自有库（seq = 发送顺序）→ 房间视图按序显示：第一轮、第二条、第一轮回复、第二轮回复
      expect(merged.messages.map((m) => m.text)).toEqual(["第一轮", "第二条", "第一轮回复", "第二轮回复"]);
      expect(merged.queued).toEqual([]);
    } finally {
      release();
      abort.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await harness.close();
    }
  }, 30_000);
});

describe("推流韧性（Task 10 裁决 A1/A3 + 修复轮 F1/F2）", () => {
  function writeEmployee(id: string): void {
    fs.mkdirSync(path.join(root, "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "agents", `${id}.agent.config.json`),
      JSON.stringify({ model: "faux/faux-model", prompt: `你是 ${id}。` }),
    );
  }

  function fauxHarness(suffix: string): ReturnType<typeof createPiHarness> {
    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
    faux.setResponses([fauxAssistantMessage("好的")]);
    const models = createModels();
    models.setProvider(faux.provider);
    return createPiHarness({ root, sqlitePath: path.join(root, "openstaffs/.data", `state-${suffix}.sqlite`), models });
  }

  it("A3（R7）：pump.register 抛错不让已 admitted 的 POST 变 500，消息照常落盘", async () => {
    writeEmployee("alice");
    const ws = createWorkspace(root);
    const harness = fauxHarness("a3");
    await harness.open();
    const server = createHttpServer({
      ws,
      store: getStore(),
      meetings: getMeetings(),
      sessions: getSessions(),
      getConfig: () => ({ providers: { faux: { apiKey: "k" } }, model: "faux/faux-model", port: 4319 }),
      getHarness: () => harness,
      queue: new KeyedQueue(),
      publicDir: path.join(root, "public"),
      port: 4319,
      pump: { register: async () => { throw new Error("订阅失败"); }, unregister: async () => {} },
      hub: new SseHub(),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const post = await fetch(`http://127.0.0.1:${port}${subjectPath("dm:alice", "/messages")}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "你好" }),
      });
      expect(post.status).toBe(202);
      // pump.register 抛错 → 没有订阅，agent 回复不入自有库；但老板消息已落库（admission 不受订阅失败影响）。
      const merged = await waitFor(async () => {
        const res = await fetch(`http://127.0.0.1:${port}${meetingPath("dm:alice", "/messages")}`);
        const body = (await res.json()) as { messages: { speaker: { kind: string }; text: string }[] };
        return body.messages.some((m) => m.speaker.kind === "boss" && m.text === "你好") ? body : undefined;
      });
      expect(merged.messages.some((m) => m.speaker.kind === "boss" && m.text === "你好")).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await harness.close();
    }
  }, 30_000);

  it("A1（R4）：hub.broadcast 抛错不终结订阅（listener 必须自保，Pi 会静默终结抛错的订阅）", async () => {
    writeEmployee("alice");
    const ws = createWorkspace(root);
    const harness = fauxHarness("a1");
    await harness.open();
    let calls = 0;
    const seen: string[] = [];
    const hub = {
      broadcast: (event: ServerEvent) => {
        calls++;
        seen.push(event.type);
        throw new Error("广播失败"); // 模拟坏客户端/序列化失败：泵的回调必须吞掉
      },
      add: () => ({ pending: 0, close: () => {} }),
      size: 0,
    } as unknown as SseHub;
    const pump = new Pump({ ws, harness, hub, store: getStore(), meetings: getMeetings(), sessions: getSessions() });
    let convId: string | undefined;
    try {
      convId = (await resolveSession({ ws, harness, sessions: getSessions(), defaults: { model: "faux/faux-model" } }, { meetingId: mtg("dm:alice"), kind: "dm", subjectId: "alice", subjectLabel: "alice", createdAt: "" }, "alice")).convId;
      await pump.register(convId, { meetingId: mtg("dm:alice"), memberId: "alice" });
      await harness.submit(convId, "你好");
      // 若抛错穿透到 Pi 的 listener，订阅会被静默终结 → 只会看到第一次广播就再无事件。
      await waitUntil(() => calls > 1);
      await waitUntil(() => seen.includes("meeting.message"));
      expect(seen.includes("meeting.activity")).toBe(true);
    } finally {
      if (convId !== undefined) await pump.unregister(convId);
      await harness.close();
    }
  }, 30_000);

  it("F1：同一 convId 并发 register 只建立一次 watch（in-flight 去重，防双订阅/重影）", async () => {
    writeEmployee("alice");
    const ws = createWorkspace(root);
    let watchCalls = 0;
    const unsubscribed: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = {
      bindSession: () => {},
      watch: async (convId: string) => {
        watchCalls++;
        await gate; // 卡住 watch：两次 register 落在同一 in-flight 窗口
        return async () => {
          unsubscribed.push(convId);
        };
      },
    } as unknown as HarnessPort;
    const pump = new Pump({ ws, harness, hub: new SseHub(), store: getStore(), meetings: getMeetings(), sessions: getSessions() });
    const first = pump.register("c1", { meetingId: mtg("dm:alice"), memberId: "alice" });
    const second = pump.register("c1", { meetingId: mtg("dm:alice"), memberId: "alice" });
    release();
    await Promise.all([first, second]);
    expect(watchCalls).toBe(1);
    await pump.unregister("c1");
    expect(unsubscribed).toEqual(["c1"]); // 只有一条订阅被退订（无泄漏）
  }, 30_000);

  it("F1b：in-flight 期间 unregister 立即退订、不留幽灵订阅（占位清理）", async () => {
    writeEmployee("alice");
    const ws = createWorkspace(root);
    let watchCalls = 0;
    const unsubscribed: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = {
      bindSession: () => {},
      watch: async (convId: string) => {
        watchCalls++;
        await gate;
        return async () => {
          unsubscribed.push(convId);
        };
      },
    } as unknown as HarnessPort;
    const pump = new Pump({ ws, harness, hub: new SseHub(), store: getStore(), meetings: getMeetings(), sessions: getSessions() });
    const inFlight = pump.register("c1", { meetingId: mtg("dm:alice"), memberId: "alice" });
    await pump.unregister("c1"); // watch 尚未建立：占位被清
    release();
    await inFlight;
    expect(unsubscribed).toEqual(["c1"]); // 建立后立刻退订，不写入 #refs
    // 占位与订阅都已清：再次 register 能正常建立新订阅
    await pump.register("c1", { meetingId: mtg("dm:alice"), memberId: "alice" });
    expect(watchCalls).toBe(2);
    await pump.unregister("c1");
  }, 30_000);

  it("F1c：register 失败清占位（finally 清理），之后同名 register 可重试", async () => {
    writeEmployee("alice");
    const ws = createWorkspace(root);
    let watchCalls = 0;
    let fail = true;
    const harness = {
      bindSession: () => {},
      watch: async () => {
        watchCalls++;
        if (fail) throw new Error("会议不存在");
        return async () => {};
      },
    } as unknown as HarnessPort;
    const pump = new Pump({ ws, harness, hub: new SseHub(), store: getStore(), meetings: getMeetings(), sessions: getSessions() });
    await expect(pump.register("c1", { meetingId: mtg("dm:alice"), memberId: "alice" })).rejects.toThrow("会议不存在");
    fail = false;
    await pump.register("c1", { meetingId: mtg("dm:alice"), memberId: "alice" });
    expect(watchCalls).toBe(2); // 占位已清：第二次是真正的新订阅，而非复用失败的旧 promise
    await pump.unregister("c1");
  }, 30_000);

  it("F2a：发送（含 newSession）的 pump.register 失败仍 202 + 投递回执（会话已建，订阅由重启扫描兜底）", async () => {
    writeEmployee("alice");
    const ws = createWorkspace(root);
    const harness = fauxHarness("f2a");
    await harness.open();
    const server = createHttpServer({
      ws,
      store: getStore(),
      meetings: getMeetings(),
      sessions: getSessions(),
      getConfig: () => ({ providers: { faux: { apiKey: "k" } }, model: "faux/faux-model", port: 4319 }),
      getHarness: () => harness,
      queue: new KeyedQueue(),
      publicDir: path.join(root, "public"),
      port: 4319,
      pump: { register: async () => { throw new Error("订阅失败"); }, unregister: async () => {} },
      hub: new SseHub(),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}${meetingPath("dm:alice", "/messages")}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "你好", newSession: true }),
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as { deliveries?: { convId?: unknown }[] };
      expect(body.deliveries).toHaveLength(1);
      expect(typeof body.deliveries![0]!.convId).toBe("string");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await harness.close();
    }
  }, 30_000);

  it("Pump：submission 事件 → 待发表出队并广播 room.dequeued（投递开始 delivered / 撤回与中断 aborted）", async () => {
    writeEmployee("alice");
    const ws = createWorkspace(root);
    const outbox = new Outbox();
    let listener: ((event: HarnessEvent) => void) | undefined;
    const harness = {
      bindSession: () => {},
      watch: async (_convId: string, fn: (event: HarnessEvent) => void) => {
        listener = fn;
        return async () => {};
      },
    } as unknown as HarnessPort;
    const events: ServerEvent[] = [];
    const hub = {
      broadcast: (event: ServerEvent) => events.push(event),
      add: () => ({ pending: 0, close: () => {} }),
      size: 0,
    } as unknown as SseHub;
    const pump = new Pump({ ws, harness, hub, outbox, store: getStore(), meetings: getMeetings(), sessions: getSessions() });
    const item = { meetingId: "dm:alice", memberId: "alice", messageId: "rm_1", text: "在吗", convId: "c1", storeSeq: 1 };
    try {
      outbox.add({ ...item, submissionId: "11" });
      outbox.add({ ...item, submissionId: "12" });
      await pump.register("c1", { meetingId: mtg("dm:alice"), memberId: "alice" });

      // 受理即 queued：还在排队，不出队
      listener!({ type: "submission", convId: "c1", id: "11", status: "queued" });
      expect(events).toEqual([]);
      expect(outbox.size).toBe(2);

      // 投递开始（placed）→ 出队 + 广播 delivered
      listener!({ type: "submission", convId: "c1", id: "11", status: "placed" });
      expect(events).toEqual([{ type: "meeting.dequeued", meetingId: "dm:alice", submissionId: "11", reason: "delivered" }]);
      expect(outbox.size).toBe(1);

      // 撤回 / 中断（unanswered）→ 出队 + 广播 aborted
      listener!({ type: "submission", convId: "c1", id: "12", status: "unanswered" });
      expect(events[1]).toEqual({ type: "meeting.dequeued", meetingId: "dm:alice", submissionId: "12", reason: "aborted" });
      expect(outbox.size).toBe(0);

      // 不在待发表里的 submission（员工之间的触发、被动写入）：静默忽略
      listener!({ type: "submission", convId: "c1", id: "99", status: "done" });
      expect(events).toHaveLength(2);
    } finally {
      await pump.unregister("c1");
    }
  }, 30_000);

  it("F2b：registerAll 单个会话订阅失败不锁死启动（per-session 容错后继续）", async () => {
    writeEmployee("alice");
    writeEmployee("bob");
    const ws = createWorkspace(root);
    const now = new Date().toISOString();
    getSessions().open({ convId: "bad-session", meetingId: mtg("dm:alice"), memberId: "alice", started: now });
    getSessions().open({ convId: "good-session", meetingId: mtg("dm:bob"), memberId: "bob", started: now });
    const watched: string[] = [];
    const harness = {
      bindSession: () => {},
      watch: async (convId: string) => {
        if (convId === "bad-session") throw new Error("会议不存在");
        watched.push(convId);
        return async () => {};
      },
    } as unknown as HarnessPort;
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "));
    });
    const pump = new Pump({ ws, harness, hub: new SseHub(), store: getStore(), meetings: getMeetings(), sessions: getSessions() });
    try {
      await expect(pump.registerAll()).resolves.toBeUndefined();
      expect(watched).toEqual(["good-session"]); // 坏链之后的会话照常订阅
      expect(errors.some((line) => line.includes("bad-session"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  }, 30_000);
});
