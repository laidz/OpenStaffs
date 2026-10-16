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

const configured: WorkspaceConfig = { provider: "faux", apiKey: "k", modelId: "faux-model", port: 4319 };

describe("HTTP 骨架", () => {
  it("未配置：status 可用、其余 API 409、静态可用", async () => {
    const ws = createWorkspace(root);
    const { base, close } = await start({ ws, getConfig: () => undefined, getHarness: () => undefined, queue: new KeyedQueue(), publicDir, port: 4319 });
    try {
      const status = await fetch(`${base}/api/status`);
      expect(status.status).toBe(200);
      expect(await status.json()).toEqual({ configured: false, root: ws.root, port: 4319 });

      expect((await fetch(`${base}/api/employees`)).status).toBe(409);
      expect((await fetch(`${base}/api/unread`)).status).toBe(409);

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
    fs.writeFileSync(path.join(aliceDir, "config.json"), JSON.stringify({ alias: "爱丽丝", provider: "faux", modelId: "faux-model" }));
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
      expect(status.provider).toBe("faux");

      const employees = (await (await fetch(`${base}/api/employees`)).json()) as { id: string; alias?: string; model: { provider: string; modelId: string } }[];
      expect(employees.map((e) => e.id)).toEqual(["alice", "carol"]);
      expect(employees[0]).toEqual({ id: "alice", alias: "爱丽丝", model: { provider: "faux", modelId: "faux-model" } });
      expect(employees[1]!.model).toEqual({ provider: "faux", modelId: "faux-model" }); // 兜底全局

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

async function startWithFaux(employeeIds: string[], groupMembers: string[]): Promise<{ base: string; close: () => Promise<void> }> {
  for (const id of employeeIds) {
    const dir = path.join(root, "agents", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "AGENTS.md"), `你是 ${id}。`);
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ alias: id === "alice" ? "爱丽丝" : id, provider: "faux", modelId: "faux-model" }));
  }
  if (groupMembers.length > 0) {
    const dir = path.join(root, "projects", "yt");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "members.md"), ["# 成员", ...groupMembers.map((m) => `- ${m}`), ""].join("\n"));
  }
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
  faux.setResponses(Array.from({ length: 20 }, (_, i) => fauxAssistantMessage(`收到${i}`)));
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = createPiHarness({ root, sqlitePath: path.join(root, `.openstaffs/state-${Date.now()}-${Math.random()}.sqlite`), models });
  await harness.open();
  const ws = createWorkspace(root);
  const server = createHttpServer({ ws, getConfig: () => configured, getHarness: () => harness, queue: new KeyedQueue(), publicDir, port: 4319 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await harness.close();
    },
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

  it("群聊：@alice 定向、@老板 空投递、空成员群 400", async () => {
    const { base, close } = await startWithFaux(["alice", "bob"], ["alice", "bob"]);
    try {
      const mentioned = await fetch(`${base}/api/rooms/group:yt/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "@alice 做视频" }),
      });
      const accepted = (await mentioned.json()) as { deliveries: { memberId: string }[] };
      expect(accepted.deliveries.map((d) => d.memberId)).toEqual(["alice"]);

      const bossOnly = await fetch(`${base}/api/rooms/group:yt/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "@老板 收到" }),
      });
      expect(bossOnly.status).toBe(202);
      expect(((await bossOnly.json()) as { deliveries: unknown[] }).deliveries).toEqual([]);

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

      // unread：新会话为空 → 无法直接产生未读；此处只验证 read/unread 接口形状
      const read = await fetch(`${base}/api/rooms/dm:alice/read`, { method: "POST" });
      expect(read.status).toBe(200);
      const unread = (await (await fetch(`${base}/api/unread`)).json()) as { total: number; rooms: Record<string, number> };
      expect(typeof unread.total).toBe("number");
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

  it("未读闭环：员工回复产生未读 → read 推进水位后清零", async () => {
    const { base, close } = await startWithFaux(["alice"], []);
    try {
      const post = await fetch(`${base}/api/rooms/dm:alice/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "请回答" }),
      });
      expect(post.status).toBe(202);

      const before = await waitFor(async () => {
        const body = (await (await fetch(`${base}/api/unread`)).json()) as { total: number; rooms: Record<string, number> };
        return (body.rooms["dm:alice"] ?? 0) >= 1 ? body : undefined;
      });
      expect(before.total).toBeGreaterThanOrEqual(1);

      const read = await fetch(`${base}/api/rooms/dm:alice/read`, { method: "POST" });
      expect(read.status).toBe(200);

      const after = (await (await fetch(`${base}/api/unread`)).json()) as { total: number; rooms: Record<string, number> };
      expect(after.rooms["dm:alice"] ?? 0).toBe(0);
    } finally {
      await close();
    }
  });
});
