import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceConfig } from "../../src/domain/config.ts";
import { createWorkspace, officeDbFile, stateDir, type Workspace } from "../../src/domain/paths.ts";
import { seedOffice } from "../helpers/office.ts";
import type { HarnessPort } from "../../src/harness/port.ts";
import { KeyedQueue } from "../../src/app/send.ts";
import { ensureMeeting } from "../../src/app/meetings.ts";
import { openMeetingStore, type MeetingStore } from "../../src/store/meetings.ts";
import { openMessageStore, type MessageStore } from "../../src/store/messages.ts";
import { openSessionStore, type SessionStore } from "../../src/store/sessions.ts";
import { createHttpServer } from "../../src/server/http.ts";

const configured: WorkspaceConfig = { providers: { faux: { apiKey: "k" } }, model: "faux/faux-model", port: 4319 };

let root: string;
let ws: Workspace;
let store: MessageStore;
let sessions: SessionStore;
let meetings: MeetingStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-wiring-"));
  ws = createWorkspace(root);
  // 接线前提（对齐 main.ts）：openMessageStore 不建父目录，注入前必须先有 stateDir。
  fs.mkdirSync(stateDir(ws), { recursive: true });
  meetings = openMeetingStore(officeDbFile(ws));
  store = openMessageStore(officeDbFile(ws));
  sessions = openSessionStore(officeDbFile(ws));
});

afterEach(() => {
  store.close();
  sessions.close();
  meetings.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function seedEmployee(id: string): void {
  seedOffice(root, { agents: [{ id, model: "faux/faux-model", prompt: `你是 ${id}。` }] });
}

/** 该主题进行中会议 id（消息行挂它）。 */
const mtg = (key: string): string =>
  key.startsWith("dm:")
    ? ensureMeeting({ ws, meetings }, { kind: "dm", employeeId: key.slice(3) }, new Date("2026-10-26T10:00:00.000Z")).meetingId
    : ensureMeeting({ ws, meetings }, { kind: "group", project: key.slice(6) }, new Date("2026-10-26T10:00:00.000Z")).meetingId;

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
    meetings,
    sessions,
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

/** 发送走主题入口（服务端解析 / 创建当前会议）。 */
function post(base: string, subjectKey: string, text: string): Promise<Response> {
  return fetch(`${base}/api/subjects/${encodeURIComponent(subjectKey)}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

describe("自有消息库接线（HTTP 发送 → 唯一注入的库实例）", () => {
  it("私聊发消息：注入的 store 恰落 1 行（fromId=__boss、正文剥头、挂在会议下）", async () => {
    seedEmployee("alice");
    const { base, close } = await start();
    try {
      const res = await post(base, "dm:alice", "@alice 你好，开工");
      expect(res.status).toBe(202);

      const rows = store.byMeeting(mtg("dm:alice"));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        meetingId: mtg("dm:alice"),
        fromId: "__boss",
        toIds: ["alice"],
        text: "你好，开工",
      });
    } finally {
      await close();
    }
  });

  it("群聊 @投递：落 1 行且归属本群会议（toIds 正确），私聊会议不受影响", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    seedOffice(root, { projects: [{ id: "yt", members: ["alice", "bob"] }] });
    const { base, close } = await start();
    try {
      const res = await post(base, "group:yt", "@bob 请收尾");
      expect(res.status).toBe(202);

      expect(store.byMeeting(mtg("dm:alice"))).toEqual([]);
      const rows = store.byMeeting(mtg("group:yt"));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ fromId: "__boss", toIds: ["bob"], text: "请收尾" });
    } finally {
      await close();
    }
  });

  it("只有 @ 没有正文：投递照旧（202），但库中不落行", async () => {
    seedEmployee("alice");
    const { base, close } = await start();
    try {
      expect((await post(base, "dm:alice", "@alice")).status).toBe(202);
      expect(store.byMeeting(mtg("dm:alice"))).toEqual([]);
    } finally {
      await close();
    }
  });
});
