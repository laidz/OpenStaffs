import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceConfig } from "../../src/domain/config.ts";
import { createWorkspace, messagesDbFile, stateDir, type Workspace } from "../../src/domain/paths.ts";
import { seedOffice } from "../helpers/office.ts";
import type { HarnessPort } from "../../src/harness/port.ts";
import { KeyedQueue } from "../../src/app/send.ts";
import { openMessageStore, type MessageStore } from "../../src/store/messages.ts";
import { createHttpServer } from "../../src/server/http.ts";

const configured: WorkspaceConfig = { providers: { faux: { apiKey: "k" } }, model: "faux/faux-model", port: 4319 };

let root: string;
let ws: Workspace;
let store: MessageStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-wiring-"));
  ws = createWorkspace(root);
  // 接线前提（对齐 main.ts）：openMessageStore 不建父目录，注入前必须先有 stateDir。
  fs.mkdirSync(stateDir(ws), { recursive: true });
  store = openMessageStore(messagesDbFile(ws));
});

afterEach(() => {
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function seedEmployee(id: string): void {
  seedOffice(root, { agents: [{ id, model: "faux/faux-model", prompt: `你是 ${id}。` }] });
}

/** 桩 harness：只实现 HTTP 发送路径会用到的面（开会话 + 提交，不跑真模型）。 */
function stubHarness(): HarnessPort {
  let n = 0;
  return {
    open: async () => {},
    close: async () => {},
    startSession: async () => `conv_stub_${++n}`,
    attach: async () => false,
    submit: async () => ({ id: `sub_${++n}`, status: "queued" }),
    withdrawSubmission: async () => false,
    append: async () => {},
    abort: async () => {},
    watch: async () => async () => {},
    transcript: async () => [],
  } as unknown as HarnessPort;
}

/** 起 HTTP 服务器：库实例由调用方注入（生产由 main.ts 建唯一实例）。 */
async function start(): Promise<{ base: string; close: () => Promise<void> }> {
  const publicDir = path.join(root, "public");
  fs.mkdirSync(publicDir, { recursive: true });
  const server = createHttpServer({
    ws,
    store,
    getConfig: () => configured,
    getHarness: () => stubHarness(),
    queue: new KeyedQueue(),
    publicDir,
    port: 4319,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

function post(base: string, roomKey: string, text: string): Promise<Response> {
  return fetch(`${base}/api/rooms/${roomKey}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

describe("自有消息库接线（HTTP 发送 → 唯一注入的库实例）", () => {
  it("私聊发消息：注入的 store 恰落 1 行（fromId=__boss、正文剥头）", async () => {
    seedEmployee("alice");
    const { base, close } = await start();
    try {
      const res = await post(base, "dm:alice", "@alice 你好，开工");
      expect(res.status).toBe(202);

      const rows = store.listByRoom("dm:alice");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        room: "dm:alice",
        projectId: null,
        fromId: "__boss",
        toIds: ["alice"],
        text: "你好，开工",
      });
    } finally {
      await close();
    }
  });

  it("群聊 @投递：落 1 行且归属该房间（projectId/toIds 正确）", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    seedOffice(root, { projects: [{ id: "yt", members: ["alice", "bob"] }] });
    const { base, close } = await start();
    try {
      const res = await post(base, "group:yt", "@bob 请收尾");
      expect(res.status).toBe(202);

      expect(store.listByRoom("dm:alice")).toEqual([]);
      const rows = store.listByRoom("group:yt");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ projectId: "yt", fromId: "__boss", toIds: ["bob"], text: "请收尾" });
    } finally {
      await close();
    }
  });

  it("只有 @ 没有正文：投递照旧（202），但库中不落行", async () => {
    seedEmployee("alice");
    const { base, close } = await start();
    try {
      expect((await post(base, "dm:alice", "@alice")).status).toBe(202);
      expect(store.listByRoom("dm:alice")).toEqual([]);
    } finally {
      await close();
    }
  });
});
