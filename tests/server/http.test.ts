import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { type AddressInfo } from "node:net";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace, messagesDbFile, stateDir } from "../../src/domain/paths.ts";
import { createHttpServer, type ServerDeps } from "../../src/server/http.ts";
import { createPiHarness } from "../../src/harness/pi-durable.ts";
import { KeyedQueue } from "../../src/app/send.ts";
import { Outbox } from "../../src/app/outbox.ts";
import { openMessageStore, type MessageStore } from "../../src/store/messages.ts";
import type { QueuedItemView } from "../../src/app/outbox.ts";
import type { RoomMessage } from "../../src/app/rooms.ts";
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

// 接线前提（对齐 main.ts）：stateDir 先建，库实例注入 HTTP；每个用例一套，afterEach 关闭并清目录。
let messageStore: MessageStore | undefined;
function getStore(): MessageStore {
  if (messageStore === undefined) {
    fs.mkdirSync(stateDir(createWorkspace(root)), { recursive: true });
    messageStore = openMessageStore(messagesDbFile(createWorkspace(root)));
  }
  return messageStore;
}

afterEach(() => {
  messageStore?.close();
  messageStore = undefined;
  fs.rmSync(path.join(root, "agents"), { recursive: true, force: true });
  fs.rmSync(path.join(root, "projects"), { recursive: true, force: true });
  fs.rmSync(path.join(root, ".openstaffs"), { recursive: true, force: true });
});

function start(deps: Omit<ServerDeps, "store">): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createHttpServer({ ...deps, store: getStore() });
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

      expect((await fetch(`${base}/api/employees`)).status).toBe(409);
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

  it("status 永不回显 apiKey；employees/projects 列表（含 alias 与模型兜底）", async () => {
    const aliceDir = path.join(root, "agents", "alice");
    fs.mkdirSync(aliceDir, { recursive: true });
    fs.writeFileSync(path.join(aliceDir, "AGENTS.md"), "你是 alice。");
    fs.writeFileSync(path.join(aliceDir, "config.json"), JSON.stringify({ alias: "爱丽丝", model: "anthropic/claude-x" }));
    const carolDir = path.join(root, "agents", "carol");
    fs.mkdirSync(carolDir, { recursive: true });
    fs.writeFileSync(path.join(carolDir, "AGENTS.md"), "你是 carol。");
    const projectDir = path.join(root, "projects", "yt");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "members.md"), "# 成员\n- alice\n- ghost\n");
    fs.writeFileSync(path.join(projectDir, "project.json"), JSON.stringify({ alias: "油管项目" }));

    const ws = createWorkspace(root);
    const { base, close } = await start({ ws, getConfig: () => configured, getHarness: () => undefined, queue: new KeyedQueue(), publicDir, port: 4319 });
    try {
      const status = (await (await fetch(`${base}/api/status`)).json()) as Record<string, unknown>;
      expect(status.apiKey).toBeUndefined();
      expect(status.configured).toBe(true);
      expect(status.model).toBe("faux/faux-model");
      expect(status.providers).toEqual(["faux"]);
      expect(status.bossName).toBe("老板");

      const employees = (await (await fetch(`${base}/api/employees`)).json()) as { id: string; alias?: string; model: string }[];
      expect(employees.map((e) => e.id)).toEqual(["alice", "carol"]);
      expect(employees[0]).toEqual({ id: "alice", alias: "爱丽丝", model: "anthropic/claude-x" }); // 员工可用别的供应商
      expect(employees[1]!.model).toBe("faux/faux-model"); // 兜底全局

      const projects = (await (await fetch(`${base}/api/projects`)).json()) as { id: string; alias: string; members: { id: string; alias?: string }[] }[];
      expect(projects).toEqual([
        { id: "yt", alias: "油管项目", members: [{ id: "alice", alias: "爱丽丝" }, { id: "ghost" }] },
      ]);
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
      // 原始 http 请求：fetch/URL 会拒绝非法百分号编码
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
  for (const id of employeeIds) {
    const dir = path.join(root, "agents", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "AGENTS.md"), `你是 ${id}。`);
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ alias: id === "alice" ? "爱丽丝" : id, model: "faux/faux-model" }));
  }
  if (groupMembers.length > 0) {
    const dir = path.join(root, "projects", "yt");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "members.md"), ["# 成员", ...groupMembers.map((m) => `- ${m}`), ""].join("\n"));
  }
  const config = {
    ...configured,
    ...(options.bossName === undefined ? {} : { bossName: options.bossName }),
    ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
  };
  // 称谓解析（bossNamesFor/readBossName）读的是 .openstaffs/config.json 文件，内存 getConfig 只服务 defaults；
  // 故自定义称谓必须落盘才生效（与 pump-trigger 用例同一真相源约定）。
  if (options.bossName !== undefined) {
    fs.mkdirSync(path.join(root, ".openstaffs"), { recursive: true });
    fs.writeFileSync(path.join(root, ".openstaffs", "config.json"), JSON.stringify(config));
  }
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "faux-model", ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }) }],
  });
  faux.setResponses(Array.from({ length: 20 }, (_, i) => fauxAssistantMessage(`收到${i}`)));
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = createPiHarness({ root, sqlitePath: path.join(root, `.openstaffs/state-${Date.now()}-${Math.random()}.sqlite`), models });
  await harness.open();
  const ws = createWorkspace(root);
  const store = new PermissionRequestStore(ws);
  // 房间视图改读自有库：agent 回复要靠 pump 落库（对齐 main.ts 的接线）。
  // hub 收事件（断言「谁写谁广播」的广播条数与库行键）。
  const events: ServerEvent[] = [];
  const hub = {
    broadcast: (event: ServerEvent) => events.push(event),
    add: () => ({ pending: 0, close: () => {} }),
    size: 0,
  } as unknown as SseHub;
  const pump = new Pump({ ws, harness, hub, store: getStore() });
  const server = createHttpServer({ ws, store: getStore(), getConfig: () => config, getHarness: () => harness, queue: new KeyedQueue(), publicDir, port: 4319, permissionRequests: store, pump, hub });
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

describe("房间 API", () => {
  it("私聊：发消息 202 → 合并视图出现 boss 与员工回复（含 speaker 形状）", async () => {
    const { base, close } = await startWithFaux(["alice"], []);
    try {
      const post = await fetch(`${base}/api/rooms/dm:alice/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "你好", requestId: "t-1" }),
      });
      expect(post.status).toBe(202);
      const accepted = (await post.json()) as { roomMessageId: string; deliveries: { memberId: string; convId: string }[] };
      expect(accepted.deliveries[0]!.memberId).toBe("alice");

      const merged = await waitFor(async () => {
        const res = await fetch(`${base}/api/rooms/dm:alice/messages`);
        const body = (await res.json()) as { messages: { speaker: unknown; text: string; roomMessageId?: string }[] };
        return body.messages.some((m) => (m.speaker as { kind?: string }).kind === "employee") ? body : undefined;
      });
      expect(merged.messages[0]).toMatchObject({ speaker: { kind: "boss" }, text: "你好" });
      expect(merged.messages[1]).toMatchObject({ speaker: { kind: "employee", id: "alice", alias: "爱丽丝" }, text: "收到0" });
    } finally {
      await close();
    }
  });

  it("群聊：@alice 定向（正文保留 @）、不 @ / 只 @老板 400、空成员群 400", async () => {
    const { base, close } = await startWithFaux(["alice", "bob"], ["alice", "bob"]);
    try {
      const mentioned = await fetch(`${base}/api/rooms/group:yt/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "@alice 做视频" }),
      });
      expect(mentioned.status).toBe(202);
      const accepted = (await mentioned.json()) as { deliveries: { memberId: string }[] };
      expect(accepted.deliveries.map((d) => d.memberId)).toEqual(["alice"]);

      // 合并视图里老板消息保留 @（成员读历史时能辨认消息原本发给谁）
      const merged = await waitFor(async () => {
        const res = await fetch(`${base}/api/rooms/group:yt/messages`);
        const body = (await res.json()) as { messages: { speaker: unknown; text: string }[] };
        return body.messages.some((m) => (m.speaker as { kind?: string }).kind === "employee") ? body : undefined;
      });
      expect(merged.messages[0]).toMatchObject({ speaker: { kind: "boss" }, text: "@alice 做视频" });

      const noTargets = await fetch(`${base}/api/rooms/group:yt/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "全体汇报" }),
      });
      expect(noTargets.status).toBe(400);
      expect(((await noTargets.json()) as { error: string }).error).toBe("消息需要 @ 至少一位群成员");

      const bossOnly = await fetch(`${base}/api/rooms/group:yt/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "@老板 收到" }),
      });
      expect(bossOnly.status).toBe(400);

      fs.rmSync(path.join(root, "projects", "yt", "members.md"));
      const empty = await fetch(`${base}/api/rooms/group:yt/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "在吗" }),
      });
      expect(empty.status).toBe(400);
    } finally {
      await close();
    }
  });

  it("群聊 @alice @bob：写路径恰广播 1 条库行（store:<seq>），不再按成员会话 N 份回显", async () => {
    const { base, close, events } = await startWithFaux(["alice", "bob"], ["alice", "bob"]);
    try {
      const post = await fetch(`${base}/api/rooms/group:yt/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "@alice @bob 全体汇报" }),
      });
      expect(post.status).toBe(202);

      await waitFor(async () => (events.some((e) => e.type === "room.message" && e.message.speaker.kind === "boss") ? true : undefined));
      // 「谁写谁广播」：老板一句 @ 多人 = 1 行 = 1 条广播（旧行为是每个成员会话各回显一条 room.message）。
      const bossEvents = events.filter((e) => e.type === "room.message" && e.message.speaker.kind === "boss");
      expect(bossEvents).toHaveLength(1);
      const seq = getStore().listByRoom("group:yt")[0]!.seq;
      const broadcast = bossEvents[0];
      if (broadcast?.type !== "room.message") throw new Error("缺少老板广播");
      // 键与 GET 房间视图 / pin 校验同源（store:<seq>），不是 conv:entry（否则 pin 404）。
      expect(broadcast.message.convId).toBe("store");
      expect(broadcast.message.entryId).toBe(String(seq));
      expect(broadcast.message.text).toBe("@alice @bob 全体汇报");
    } finally {
      await close();
    }
  }, 30_000);

  it("老板库行广播附 UI 用 roomMessageId（排队占位据此贴真气泡）；GET 房间视图不带", async () => {
    const { base, close, events } = await startWithFaux(["alice"], []);
    try {
      const post = await fetch(`${base}/api/rooms/dm:alice/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "第一句" }),
      });
      expect(post.status).toBe(202);
      const accepted = (await post.json()) as { roomMessageId: string };

      // 广播先于响应：此刻已有老板库行广播。
      const broadcast = events.find((event) => event.type === "room.message" && event.message.speaker.kind === "boss");
      if (broadcast?.type !== "room.message") throw new Error("缺少老板广播");
      // R-P1-11：roomMessageId 不入库；广播时附一个仅 UI 用的副本，
      // 让 web 的「排队中」占位（web/render.ts 按 roomMessageId 匹配）能贴到这条真气泡上。
      expect(broadcast.message.roomMessageId).toBe(accepted.roomMessageId);
      expect(broadcast.message.entryId).toBe("1");

      // GET 返回的是库行：刷新后排队条已消失，无需匹配 → 不带 roomMessageId。
      const view = (await (await fetch(`${base}/api/rooms/dm:alice/messages`)).json()) as { messages: { text: string; roomMessageId?: string }[] };
      expect(view.messages[0]).toMatchObject({ text: "第一句" });
      expect(view.messages[0]!.roomMessageId).toBeUndefined();
    } finally {
      await close();
    }
  }, 30_000);

  it("新开会话（发送时 newSession）：投递那一刻才建会话、视线随之清空；sessions / 历史 / pins 形状", async () => {
    const { base, close } = await startWithFaux(["alice"], ["alice"]);
    try {
      // 先发一条消息建立链
      await fetch(`${base}/api/rooms/dm:alice/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "第一轮" }),
      });
      await waitFor(async () => {
        const res = await fetch(`${base}/api/rooms/dm:alice/messages`);
        const body = (await res.json()) as { messages: unknown[] };
        return body.messages.length >= 2 ? body : undefined;
      });

      const chains = (await (await fetch(`${base}/api/rooms/dm:alice/sessions`)).json()) as { chains: { memberId: string; rows: { id: string }[] }[] };
      expect(chains.chains[0]!.memberId).toBe("alice");
      const firstConv = chains.chains[0]!.rows[0]!.id;

      // 普通发送：复用同一条会话（链不增长）
      await fetch(`${base}/api/rooms/dm:alice/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "同一条会话里再说一句" }),
      });
      const same = (await (await fetch(`${base}/api/rooms/dm:alice/sessions`)).json()) as { chains: { rows: { id: string }[] }[] };
      expect(same.chains[0]!.rows).toHaveLength(1);

      // newSession=true：这条消息投递给 alice 时新开会话（旧会话结束、视线清空）
      const fresh = await fetch(`${base}/api/rooms/dm:alice/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "重新开始", newSession: true }),
      });
      expect(fresh.status).toBe(202);

      // 房间视图改读自有库 → 它是「房间历史」：新开会话不再清空它（会话视线改由 sessions/<convId>/messages 承载）。
      const roomView = (await (await fetch(`${base}/api/rooms/dm:alice/messages`)).json()) as { messages: { text: string }[] };
      expect(roomView.messages.map((m) => m.text)).toContain("第一轮"); // 历史保留（自有库）
      expect(roomView.messages.map((m) => m.text)).toContain("重新开始");

      // 会话视线：链增长到 2 条，新会话里没有旧内容、只有新一轮
      const chainsAfter = (await (await fetch(`${base}/api/rooms/dm:alice/sessions`)).json()) as { chains: { rows: { id: string }[] }[] };
      const rows = chainsAfter.chains[0]!.rows;
      expect(rows).toHaveLength(2);
      const freshConv = rows.at(-1)!.id;
      expect(freshConv).not.toBe(firstConv);
      const freshView = (await (await fetch(`${base}/api/rooms/dm:alice/sessions/${freshConv}/messages`)).json()) as { messages: { text: string }[] };
      expect(freshView.messages.map((m) => m.text)).toContain("重新开始");
      expect(freshView.messages.some((m) => m.text === "第一轮")).toBe(false); // 新会话视线里没有旧内容

      const history = (await (await fetch(`${base}/api/rooms/dm:alice/sessions/${firstConv}/messages`)).json()) as { memberId: string; messages: unknown[] };
      expect(history.memberId).toBe("alice");
      expect(history.messages.length).toBeGreaterThanOrEqual(2); // 旧会话仍可回看

      // pins：新会话为空 → 红点为 0；此处只验证 /api/pins 接口形状
      const pins = (await (await fetch(`${base}/api/pins`)).json()) as { total: number; rooms: Record<string, number> };
      expect(typeof pins.total).toBe("number");
    } finally {
      await close();
    }
  });

  it("会话信息：模型全值 / 思考强度 / 上下文用量与窗口；未建会话为空", async () => {
    const { base, close } = await startWithFaux(["alice"], []);
    try {
      const empty = (await (await fetch(`${base}/api/rooms/dm:alice/sessions/info`)).json()) as { sessions: unknown[] };
      expect(empty.sessions).toEqual([]);

      await fetch(`${base}/api/rooms/dm:alice/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "你好", requestId: "info-1" }),
      });
      const info = await waitFor(async () => {
        const res = await fetch(`${base}/api/rooms/dm:alice/sessions/info`);
        const body = (await res.json()) as { sessions: { memberId: string; model: string; thinkingLevel: string | null; contextUsed: number; contextWindow?: number }[] };
        return body.sessions.length > 0 && body.sessions[0]!.contextUsed > 0 ? body : undefined;
      });
      expect(info.sessions[0]).toMatchObject({
        memberId: "alice",
        model: "faux/faux-model",
        thinkingLevel: "off", // Pi 默认档（会话实际在用）
        contextWindow: 128000,
      });
      expect((await fetch(`${base}/api/rooms/dm:nobody/sessions/info`)).status).toBe(404);
    } finally {
      await close();
    }
  });

  it("全局 thinkingLevel 进入新会话；模型不支持该档 → 信息条返回 null", async () => {
    const { base, close } = await startWithFaux(["alice"], [], { thinkingLevel: "high", reasoning: false });
    try {
      await fetch(`${base}/api/rooms/dm:alice/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "你好", requestId: "info-2" }),
      });
      const info = await waitFor(async () => {
        const res = await fetch(`${base}/api/rooms/dm:alice/sessions/info`);
        const body = (await res.json()) as { sessions: { thinkingLevel: string | null; contextUsed: number }[] };
        return body.sessions.length > 0 && body.sessions[0]!.contextUsed > 0 ? body : undefined;
      });
      expect(info.sessions[0]!.thinkingLevel).toBeNull(); // 非推理模型只支持 off；不回落、不显示 high
    } finally {
      await close();
    }
  });

  it("interrupt：房间级中断返回 aborted（无在跑也 200）；不存在的房间 404", async () => {
    const { base, close } = await startWithFaux(["alice"], []);
    try {
      const res = await fetch(`${base}/api/rooms/dm:alice/interrupt`, { method: "POST" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { aborted: string[] };
      expect(Array.isArray(body.aborted)).toBe(true);
      expect(body.aborted).toEqual([]); // 尚未建会话
      expect((await fetch(`${base}/api/rooms/dm:nobody/interrupt`, { method: "POST" })).status).toBe(404);
    } finally {
      await close();
    }
  });

  it("不存在的房间 404", async () => {
    const { base, close } = await startWithFaux([], []);
    try {
      expect((await fetch(`${base}/api/rooms/dm:nobody/messages`)).status).toBe(404);
      expect((await fetch(`${base}/api/rooms/group:none/messages`)).status).toBe(404);
    } finally {
      await close();
    }
  });

  it("房间键路径穿越（编码分隔符/点开头/畸形编码）一律 404", async () => {
    const { base, close } = await startWithFaux(["alice"], ["alice"]);
    try {
      // %2F 编码的 ../ 穿越：不得泄露父目录存在性，也不得回读任意目录的会话链
      expect((await fetch(`${base}/api/rooms/dm:..%2F..%2F..%2F..%2Fetc/messages`)).status).toBe(404);
      expect((await fetch(`${base}/api/rooms/dm:..%2F..%2F..%2F..%2Fetc/sessions`)).status).toBe(404);
      expect((await fetch(`${base}/api/rooms/group:..%2F..%2F..%2Fyt/messages`)).status).toBe(404);
      expect((await fetch(`${base}/api/rooms/dm:%2E%2E/messages`)).status).toBe(404);
      expect((await fetch(`${base}/api/rooms/dm:.hidden/messages`)).status).toBe(404);
      // 深度穿越：20 层 .. 归一化到 /etc（真实存在）——修复前是存在性预言机（200），修复后恒 404
      const deepEscape = `dm:${"..%2F".repeat(20)}etc`;
      expect((await fetch(`${base}/api/rooms/${deepEscape}/messages`)).status).toBe(404);
      expect((await fetch(`${base}/api/rooms/${deepEscape}/sessions`)).status).toBe(404);
      // 畸形百分号编码：404 而非 500
      const malformed = await new Promise<number>((resolve) => {
        const req = http.request({ host: "127.0.0.1", port: new URL(base).port, path: "/api/rooms/dm:%ZZ/messages" }, (res) => {
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

  it("pin 闭环：新消息红点 0 → pin 一条 → 1 → 取消 → 0；不存在的消息 404", async () => {
    const { base, close } = await startWithFaux(["alice"], []);
    try {
      const post = await fetch(`${base}/api/rooms/dm:alice/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "请回答" }),
      });
      expect(post.status).toBe(202);

      const merged = await waitFor(async () => {
        const res = await fetch(`${base}/api/rooms/dm:alice/messages`);
        const body = (await res.json()) as {
          messages: { convId: string; entryId: string; speaker: { kind: string } }[];
          pinned: string[];
        };
        return body.messages.some((m) => m.speaker.kind === "employee") ? body : undefined;
      });
      // 新消息默认未 pin：红点为 0
      expect(merged.pinned).toEqual([]);
      const before = (await (await fetch(`${base}/api/pins`)).json()) as { total: number; rooms: Record<string, number> };
      expect(before.rooms["dm:alice"] ?? 0).toBe(0);

      const employee = merged.messages.find((m) => m.speaker.kind === "employee")!;
      const pin = await fetch(`${base}/api/rooms/dm:alice/pin`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ convId: employee.convId, entryId: employee.entryId, pinned: true }),
      });
      expect(pin.status).toBe(200);
      expect((await pin.json()) as { ok: boolean; count: number }).toMatchObject({ ok: true, count: 1 });

      const after = (await (await fetch(`${base}/api/pins`)).json()) as { total: number; rooms: Record<string, number> };
      expect(after.rooms["dm:alice"]).toBe(1);

      // messages GET 透出当前房间的 pin 集合（前端据此高亮）
      const merged2 = (await (await fetch(`${base}/api/rooms/dm:alice/messages`)).json()) as { pinned: string[] };
      expect(merged2.pinned).toEqual([`${employee.convId}:${employee.entryId}`]);

      const unpin = await fetch(`${base}/api/rooms/dm:alice/pin`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ convId: employee.convId, entryId: employee.entryId, pinned: false }),
      });
      expect((await unpin.json()) as { count: number }).toMatchObject({ count: 0 });
      const cleared = (await (await fetch(`${base}/api/pins`)).json()) as { total: number; rooms: Record<string, number> };
      expect(cleared.rooms["dm:alice"] ?? 0).toBe(0);

      // 视图里不存在的消息 → 404（不往 pin 存储里塞垃圾）
      const ghost = await fetch(`${base}/api/rooms/dm:alice/pin`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ convId: "nope", entryId: "999", pinned: true }),
      });
      expect(ghost.status).toBe(404);
    } finally {
      await close();
    }
  });

  it("称谓自定义：群回复 fallback 用真称谓（@掌柜）", async () => {
    const { base, close } = await startWithFaux(["alice"], ["alice"], { bossName: "掌柜" });
    try {
      // status 是 UI 发言人名的真相源：自定义称谓必须透出（读盘，不是硬编码默认值）
      const status = (await (await fetch(`${base}/api/status`)).json()) as { bossName: string };
      expect(status.bossName).toBe("掌柜");
      await fetch(`${base}/api/rooms/group:yt/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "@alice 你好" }),
      });
      const merged = await waitFor(async () => {
        const body = (await (await fetch(`${base}/api/rooms/group:yt/messages`)).json()) as { messages: { speaker: { kind: string }; text: string }[] };
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
    const dir = path.join(root, "agents", "alice");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "你是 alice。");
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ model: "faux/faux-model" }));

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
    const harness = createPiHarness({ root, sqlitePath: path.join(root, `.openstaffs/state-queue-${Date.now()}.sqlite`), models });
    await harness.open();
    const ws = createWorkspace(root);
    const events: ServerEvent[] = [];
    const hub = {
      broadcast: (event: ServerEvent) => events.push(event),
      add: () => ({ pending: 0, close: () => {} }),
      size: 0,
    } as unknown as SseHub;
    // 房间视图改读自有库：agent 回复要靠 pump 落库（对齐 main.ts 的接线）。
    const pump = new Pump({ ws, harness, hub, store: getStore() });
    const server = createHttpServer({
      ws,
      store: getStore(),
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
    return fetch(`${base}/api/rooms/dm:alice/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function room(base: string): Promise<{ messages: { text: string }[]; queued: { text: string; roomMessageId: string; memberId: string }[] }> {
    return (await (await fetch(`${base}/api/rooms/dm:alice/messages`)).json()) as never;
  }

  it("员工在跑：第二条以 queued 返回 + 进待发表 + 广播；撤回后不再投递", async () => {
    const { base, close, release, events } = await startQueued();
    try {
      const first = await post(base, { text: "第一轮" });
      expect(first.status).toBe(202);
      expect(((await first.json()) as { deliveries: { status: string }[] }).deliveries[0]!.status).toBe("placed");

      const second = await post(base, { text: "第二条" });
      expect(second.status).toBe(202);
      const accepted = (await second.json()) as { roomMessageId: string; deliveries: { status: string; submissionId: string }[] };
      expect(accepted.deliveries[0]!.status).toBe("queued"); // 员工在跑 → 进了 Pi 的 inbox

      await waitFor(async () => (events.some((e) => e.type === "room.queued") ? true : undefined));
      const queuedEvent = events.find((e) => e.type === "room.queued");
      expect(queuedEvent?.type === "room.queued" ? queuedEvent.item : undefined).toMatchObject({
        submissionId: accepted.deliveries[0]!.submissionId,
        memberId: "alice",
        roomMessageId: accepted.roomMessageId,
        text: "第二条",
      });

      // 消息区拿得到排队态（刷新 / 换标签页一致）；老板消息发送即落自有库 → 房间视图里也在
      const withQueued = await room(base);
      expect(withQueued.queued.map((item) => item.text)).toEqual(["第二条"]);
      expect(withQueued.messages.map((m) => m.text)).toEqual(["第一轮", "第二条"]);

      // 单条撤回：撤掉这条消息里还没开始的投递，广播出队
      const cancel = await fetch(`${base}/api/rooms/dm:alice/queue/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomMessageId: accepted.roomMessageId }),
      });
      expect(cancel.status).toBe(200);
      expect(((await cancel.json()) as { cancelled: string[] }).cancelled).toEqual([accepted.deliveries[0]!.submissionId]);
      expect(events.some((e) => e.type === "room.dequeued" && e.reason === "cancelled")).toBe(true);

      const cleared = await room(base);
      expect(cleared.queued).toEqual([]);

      // 撤回的输入绝不投递：放开第一轮后，**会话 transcript** 里只有第一轮与其回复
      // （自有库里那条老板行只是「发送记录」，不代表已投递）。
      release();
      await waitFor(async () => ((await room(base)).messages.some((m) => m.text === "第一轮回复") ? true : undefined));
      const chains = (await (await fetch(`${base}/api/rooms/dm:alice/sessions`)).json()) as { chains: { rows: { id: string }[] }[] };
      const convId = chains.chains[0]!.rows.at(-1)!.id;
      const history = (await (await fetch(`${base}/api/rooms/dm:alice/sessions/${convId}/messages`)).json()) as { messages: { text: string }[] };
      expect(history.messages.map((m) => m.text)).toEqual(["第一轮", "第一轮回复"]);
      const after = await room(base);
      expect(after.queued).toEqual([]);
    } finally {
      await close();
    }
  }, 30_000);

  it("GET 房间：仍在排队的库行回填 roomMessageId（与 SSE 同口径），渲染不出重复气泡", async () => {
    const { base, close, release } = await startQueued();
    try {
      await post(base, { text: "第一轮" });
      const second = await post(base, { text: "第二条" });
      const accepted = (await second.json()) as { roomMessageId: string; deliveries: { status: string }[] };
      expect(accepted.deliveries[0]!.status).toBe("queued"); // 员工在跑 → 该条投递仍在排队

      const view = (await (await fetch(`${base}/api/rooms/dm:alice/messages`)).json()) as {
        messages: RoomMessage[];
        pinned: string[];
        queued: QueuedItemView[];
      };
      // F1：刷新 / 换标签页 / 首次进房走 GET，仍在排队的库行要回填 roomMessageId（此前不带 →
      // 真气泡 + `msg boss queued` 灰占位两条）；没有排队的库行（第一轮已投递）不带。
      expect(view.messages.find((m) => m.text === "第二条")!.roomMessageId).toBe(accepted.roomMessageId);
      expect(view.messages.find((m) => m.text === "第一轮")!.roomMessageId).toBeUndefined();

      // 等价断言：拿 GET 载荷交给 UI 渲染，老板气泡恰两个（第一轮 + 第二条），无独立灰占位。
      const html = messagesHtml(view.messages, "老板", view.pinned, view.queued);
      expect(html.match(/class="msg boss/g)).toHaveLength(2);
      expect(html).not.toContain('class="msg boss queued"');
    } finally {
      release(); // 放行卡住的第一轮，否则 harness.close() 挂着
      await close();
    }
  }, 30_000);

  it("撤不回已开始投递的：409 + 明确文案；roomMessageId 必填 400", async () => {
    const { base, close, release } = await startQueued();
    try {
      const first = await post(base, { text: "第一轮" });
      const accepted = (await first.json()) as { roomMessageId: string };
      // 这条已经 placed（员工空闲 → 直接进 transcript）→ 撤不回
      const conflict = await fetch(`${base}/api/rooms/dm:alice/queue/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomMessageId: accepted.roomMessageId }),
      });
      expect(conflict.status).toBe(409);
      expect(((await conflict.json()) as { error: string }).error).toContain("撤不回");

      const missing = await fetch(`${base}/api/rooms/dm:alice/queue/cancel`, {
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
  it("GET 列表（新在前、带 agentName）；accept 写权限并投递「已完成授权」；处理后列表清空", async () => {
    const { base, close, store } = await startWithFaux(["alice"], []);
    try {
      const target = path.join(root, "outside", "shared");
      const added = store.add({ agentId: "alice", roomKey: "dm:alice", paths: [target], reason: "要写共享目录" });

      const list = (await (await fetch(`${base}/api/permission-requests`)).json()) as {
        requests: { id: string; agentName: string; paths: string[]; reason: string }[];
      };
      expect(list.requests).toHaveLength(1);
      expect(list.requests[0]).toMatchObject({ id: added.id, agentName: "爱丽丝", paths: [target], reason: "要写共享目录" });

      const resolve = await fetch(`${base}/api/permission-requests/${added.id}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "accept" }),
      });
      expect(resolve.status).toBe(200);
      expect(await resolve.json()).toEqual({ ok: true });

      expect(JSON.parse(fs.readFileSync(path.join(root, "agents", "alice", "permission.json"), "utf8"))).toEqual([target]);
      await waitFor(async () => {
        const body = (await (await fetch(`${base}/api/rooms/dm:alice/messages`)).json()) as { messages: { speaker: { kind: string }; text: string }[] };
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
      const added = store.add({ agentId: "alice", roomKey: "group:yt", paths: [path.join(root, "outside")], reason: "r" });
      const resolve = await fetch(`${base}/api/permission-requests/${added.id}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "accept" }),
      });
      expect(resolve.status).toBe(200);
      const merged = await waitFor(async () => {
        const body = (await (await fetch(`${base}/api/rooms/group:yt/messages`)).json()) as { messages: { text: string }[] };
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
      const added = store.add({ agentId: "alice", roomKey: "dm:alice", paths: [path.join(root, "outside")], reason: "r" });
      const reject = await fetch(`${base}/api/permission-requests/${added.id}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "reject" }),
      });
      expect(reject.status).toBe(200);
      expect(fs.existsSync(path.join(root, "agents", "alice", "permission.json"))).toBe(false);

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
