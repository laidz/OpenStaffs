import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { type AddressInfo } from "node:net";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { createHttpServer, type ServerDeps } from "../../src/server/http.ts";
import { createPiHarness } from "../../src/harness/pi-durable.ts";
import { KeyedQueue } from "../../src/app/send.ts";
import type { WorkspaceConfig } from "../../src/domain/config.ts";
import { PermissionRequestStore } from "../../src/domain/permission-requests.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-http-"));
const publicDir = path.join(root, "public");
fs.mkdirSync(publicDir, { recursive: true });
fs.writeFileSync(path.join(publicDir, "index.html"), "<html>Office</html>");
fs.writeFileSync(path.join(root, "secret.txt"), "top-secret");

afterEach(() => {
  fs.rmSync(path.join(root, "agents"), { recursive: true, force: true });
  fs.rmSync(path.join(root, "projects"), { recursive: true, force: true });
  fs.rmSync(path.join(root, ".openstaffs"), { recursive: true, force: true });
});

function start(deps: ServerDeps): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createHttpServer(deps);
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
  options: { bossName?: string } = {},
): Promise<{ base: string; close: () => Promise<void>; store: PermissionRequestStore }> {
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
  const config = { ...configured, ...(options.bossName === undefined ? {} : { bossName: options.bossName }) };
  // 称谓解析（bossNamesFor/readBossName）读的是 .openstaffs/config.json 文件，内存 getConfig 只服务 defaults；
  // 故自定义称谓必须落盘才生效（与 pump-trigger 用例同一真相源约定）。
  if (options.bossName !== undefined) {
    fs.mkdirSync(path.join(root, ".openstaffs"), { recursive: true });
    fs.writeFileSync(path.join(root, ".openstaffs", "config.json"), JSON.stringify(config));
  }
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
  faux.setResponses(Array.from({ length: 20 }, (_, i) => fauxAssistantMessage(`收到${i}`)));
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = createPiHarness({ root, sqlitePath: path.join(root, `.openstaffs/state-${Date.now()}-${Math.random()}.sqlite`), models });
  await harness.open();
  const ws = createWorkspace(root);
  const store = new PermissionRequestStore(ws);
  const server = createHttpServer({ ws, getConfig: () => config, getHarness: () => harness, queue: new KeyedQueue(), publicDir, port: 4319, permissionRequests: store });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await harness.close();
    },
    store,
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
      expect(merged.messages[0]).toMatchObject({ speaker: { kind: "boss" }, text: "你好", roomMessageId: accepted.roomMessageId });
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

  it("new-session（群聊校验成员）、sessions、历史消息、read/unread", async () => {
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

      const newSessionRes = await fetch(`${base}/api/rooms/dm:alice/new-session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const { convId } = (await newSessionRes.json()) as { convId: string };
      expect(convId).not.toBe(firstConv);

      const after = (await (await fetch(`${base}/api/rooms/dm:alice/messages`)).json()) as { messages: unknown[] };
      expect(after.messages).toEqual([]); // 新会话视线清空

      const history = (await (await fetch(`${base}/api/rooms/dm:alice/sessions/${firstConv}/messages`)).json()) as { memberId: string; messages: unknown[] };
      expect(history.memberId).toBe("alice");
      expect(history.messages.length).toBeGreaterThanOrEqual(2);

      const badMember = await fetch(`${base}/api/rooms/group:yt/new-session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ memberId: "ghost" }),
      });
      expect(badMember.status).toBe(400);

      // pins：新会话为空 → 红点为 0；此处只验证 /api/pins 接口形状
      const pins = (await (await fetch(`${base}/api/pins`)).json()) as { total: number; rooms: Record<string, number> };
      expect(typeof pins.total).toBe("number");
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
