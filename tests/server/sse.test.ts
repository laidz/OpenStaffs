import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspace, conversationIdsFile, employeeDir } from "../../src/domain/paths.ts";
import { startNewSession } from "../../src/domain/conversation-chain.ts";
import { createPiHarness } from "../../src/harness/pi-durable.ts";
import type { HarnessPort } from "../../src/harness/port.ts";
import { KeyedQueue } from "../../src/app/send.ts";
import { openDm } from "../../src/app/conversations.ts";
import { SseHub, type ServerEvent } from "../../src/server/sse.ts";
import { Pump } from "../../src/server/pump.ts";
import { createHttpServer } from "../../src/server/http.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-sse-"));
afterEach(() => {
  fs.rmSync(path.join(root, "agents"), { recursive: true, force: true });
  fs.rmSync(path.join(root, "projects"), { recursive: true, force: true });
  fs.rmSync(path.join(root, ".openstaffs"), { recursive: true, force: true });
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
      hub.broadcast({ type: "room.delta", roomKey: "dm:a", convId: "c", memberId: "a", channel: "text", delta: `d${i}` });
    }
    hub.broadcast({ type: "room.message", roomKey: "dm:a", message: { convId: "c", entryId: "1", roomKey: "dm:a", speaker: { kind: "boss" }, text: "权威" } });
    expect(client.pending).toBeLessThanOrEqual(200);
    client.close();
    expect(hub.size).toBe(0);
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
  it("发消息后推送：room.message(user) → delta → room.message(assistant) → room.unread", async () => {
    const dir = path.join(root, "agents", "alice");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "你是 alice。");
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ provider: "faux", modelId: "faux-model" }));

    // tokensPerSecond/tokenSize：放慢流式输出，使 delta 跨过 pi-durable 的 100ms partial 落盘窗口（否则 faux 瞬时出稿、无增量事件）。
    // 回答文本足够长（29 字 ≈ 400ms 流式）以保证 delta 断言稳定；仍以 "流式回答内容" 开头。
    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }], tokensPerSecond: 20, tokenSize: { min: 1, max: 1 } });
    faux.setResponses([fauxAssistantMessage("流式回答内容：这是一段足够长的回答，用来跨过增量落盘窗口。")]);
    const models = createModels();
    models.setProvider(faux.provider);
    const ws = createWorkspace(root);
    const harness = createPiHarness({ root, sqlitePath: path.join(root, ".openstaffs", "state.sqlite"), models });
    await harness.open();

    const hub = new SseHub();
    const pump = new Pump({ ws, harness, hub });
    const server = createHttpServer({
      ws,
      getConfig: () => ({ provider: "faux", apiKey: "k", modelId: "faux-model", port: 4319 }),
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
      // 先开新会话（spec §6.3：新开会话在 API 层拿到 convId 后注册订阅）。
      // 订阅必须先于提交：否则首条老板消息会在订阅建立前落盘而漏推（POST /messages 内 sendToRoom 先 submit 后注册）。
      const opened = await fetch(`${base}/api/rooms/dm:alice/new-session`, { method: "POST" });
      expect(opened.status).toBe(200);

      const post = await fetch(`${base}/api/rooms/dm:alice/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "你好" }),
      });
      expect(post.status).toBe(202);

      await waitUntil(() => events.some((e) => e.type === "room.message" && e.message.speaker.kind === "employee"));
      expect(events.some((e) => e.type === "room.message" && e.message.speaker.kind === "boss" && e.message.text === "你好")).toBe(true);
      expect(events.some((e) => e.type === "room.delta" && e.delta.length > 0)).toBe(true);
      const assistant = events.find((e) => e.type === "room.message" && e.message.speaker.kind === "employee");
      expect(assistant?.type === "room.message" ? assistant.message.text : "").toContain("流式回答内容");
      await waitUntil(() => events.some((e) => e.type === "room.unread" && e.roomKey === "dm:alice"));

      // 裁决 A2（R5）：标记已读后服务端重算并推 room.unread（红点无需等前端轮询即清零）
      const read = await fetch(`${base}/api/rooms/dm:alice/read`, { method: "POST" });
      expect(read.status).toBe(200);
      await waitUntil(() => events.some((e) => e.type === "room.unread" && e.roomKey === "dm:alice" && e.count === 0));
    } finally {
      abort.abort(); // 客户端断开（hub 依 req close 清理）；否则常驻 SSE 连接会让 server.close() 一直阻塞
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await harness.close();
    }
  }, 30_000);
});

describe("推流韧性（Task 10 裁决 A1/A3 + 修复轮 F1/F2）", () => {
  function writeEmployee(id: string): void {
    const dir = path.join(root, "agents", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "AGENTS.md"), `你是 ${id}。`);
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ provider: "faux", modelId: "faux-model" }));
  }

  function fauxHarness(suffix: string): ReturnType<typeof createPiHarness> {
    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
    faux.setResponses([fauxAssistantMessage("好的")]);
    const models = createModels();
    models.setProvider(faux.provider);
    return createPiHarness({ root, sqlitePath: path.join(root, ".openstaffs", `state-${suffix}.sqlite`), models });
  }

  it("A3（R7）：pump.register 抛错不让已 admitted 的 POST 变 500，消息照常落盘", async () => {
    writeEmployee("alice");
    const ws = createWorkspace(root);
    const harness = fauxHarness("a3");
    await harness.open();
    const server = createHttpServer({
      ws,
      getConfig: () => ({ provider: "faux", apiKey: "k", modelId: "faux-model", port: 4319 }),
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
      const post = await fetch(`http://127.0.0.1:${port}/api/rooms/dm:alice/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "你好" }),
      });
      expect(post.status).toBe(202);
      const merged = await waitFor(async () => {
        const res = await fetch(`http://127.0.0.1:${port}/api/rooms/dm:alice/messages`);
        const body = (await res.json()) as { messages: { speaker: { kind: string }; text: string }[] };
        return body.messages.some((m) => m.speaker.kind === "employee") ? body : undefined;
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
    const pump = new Pump({ ws, harness, hub });
    let convId: string | undefined;
    try {
      convId = await openDm(ws, harness, "alice", { model: { provider: "faux", modelId: "faux-model" } });
      await pump.register(convId, { roomKey: "dm:alice", memberId: "alice" });
      await harness.submit(convId, "你好");
      // 若抛错穿透到 Pi 的 listener，订阅会被静默终结 → 只会看到第一次广播就再无事件。
      await waitUntil(() => calls > 1);
      await waitUntil(() => seen.includes("room.message"));
      expect(seen.includes("room.activity")).toBe(true);
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
      watch: async (convId: string) => {
        watchCalls++;
        await gate; // 卡住 watch：两次 register 落在同一 in-flight 窗口
        return async () => {
          unsubscribed.push(convId);
        };
      },
    } as unknown as HarnessPort;
    const pump = new Pump({ ws, harness, hub: new SseHub() });
    const first = pump.register("c1", { roomKey: "dm:alice", memberId: "alice" });
    const second = pump.register("c1", { roomKey: "dm:alice", memberId: "alice" });
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
      watch: async (convId: string) => {
        watchCalls++;
        await gate;
        return async () => {
          unsubscribed.push(convId);
        };
      },
    } as unknown as HarnessPort;
    const pump = new Pump({ ws, harness, hub: new SseHub() });
    const inFlight = pump.register("c1", { roomKey: "dm:alice", memberId: "alice" });
    await pump.unregister("c1"); // watch 尚未建立：占位被清
    release();
    await inFlight;
    expect(unsubscribed).toEqual(["c1"]); // 建立后立刻退订，不写入 #refs
    // 占位与订阅都已清：再次 register 能正常建立新订阅
    await pump.register("c1", { roomKey: "dm:alice", memberId: "alice" });
    expect(watchCalls).toBe(2);
    await pump.unregister("c1");
  }, 30_000);

  it("F1c：register 失败清占位（finally 清理），之后同名 register 可重试", async () => {
    writeEmployee("alice");
    const ws = createWorkspace(root);
    let watchCalls = 0;
    let fail = true;
    const harness = {
      watch: async () => {
        watchCalls++;
        if (fail) throw new Error("会话不存在");
        return async () => {};
      },
    } as unknown as HarnessPort;
    const pump = new Pump({ ws, harness, hub: new SseHub() });
    await expect(pump.register("c1", { roomKey: "dm:alice", memberId: "alice" })).rejects.toThrow("会话不存在");
    fail = false;
    await pump.register("c1", { roomKey: "dm:alice", memberId: "alice" });
    expect(watchCalls).toBe(2); // 占位已清：第二次是真正的新订阅，而非复用失败的旧 promise
    await pump.unregister("c1");
  }, 30_000);

  it("F2a：new-session 的 pump.register 失败仍 200 + convId（会话已建，订阅由重启扫描兜底）", async () => {
    writeEmployee("alice");
    const ws = createWorkspace(root);
    const harness = fauxHarness("f2a");
    await harness.open();
    const server = createHttpServer({
      ws,
      getConfig: () => ({ provider: "faux", apiKey: "k", modelId: "faux-model", port: 4319 }),
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
      const res = await fetch(`http://127.0.0.1:${port}/api/rooms/dm:alice/new-session`, { method: "POST" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { convId?: unknown };
      expect(typeof body.convId).toBe("string");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await harness.close();
    }
  }, 30_000);

  it("F2b：registerAll 单个会话订阅失败不锁死启动（per-session 容错后继续）", async () => {
    writeEmployee("alice");
    writeEmployee("bob");
    const ws = createWorkspace(root);
    const now = new Date().toISOString();
    startNewSession(conversationIdsFile(ws, employeeDir(ws, "alice")), "bad-session", now);
    startNewSession(conversationIdsFile(ws, employeeDir(ws, "bob")), "good-session", now);
    const watched: string[] = [];
    const harness = {
      watch: async (convId: string) => {
        if (convId === "bad-session") throw new Error("会话不存在");
        watched.push(convId);
        return async () => {};
      },
    } as unknown as HarnessPort;
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "));
    });
    const pump = new Pump({ ws, harness, hub: new SseHub() });
    try {
      await expect(pump.registerAll()).resolves.toBeUndefined();
      expect(watched).toEqual(["good-session"]); // 坏链之后的会话照常订阅
      expect(errors.some((line) => line.includes("bad-session"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  }, 30_000);
});
