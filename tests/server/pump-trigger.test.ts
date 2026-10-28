import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace, officeDbFile, stateDir } from "../../src/domain/paths.ts";
import { seedOffice } from "../helpers/office.ts";
import { createPiHarness } from "../../src/harness/pi-durable.ts";
import { SseHub, type ServerEvent } from "../../src/server/sse.ts";
import { Pump } from "../../src/server/pump.ts";
import { resolveSession } from "../../src/app/conversations.ts";
import { toMeetingMessage } from "../../src/app/meeting-messages.ts";
import { openMessageStore, type MessageStore } from "../../src/store/messages.ts";
import { openSessionStore, type SessionStore } from "../../src/store/sessions.ts";
import { openMeetingStore, type MeetingStore } from "../../src/store/meetings.ts";
import { ensureMeeting } from "../../src/app/meetings.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-trigger-"));

// 接线前提（对齐 main.ts）：stateDir 先建；每个用例一套库，afterEach 关闭后再删目录。
let store: MessageStore | undefined;
function getStore(): MessageStore {
  if (store === undefined) {
    fs.mkdirSync(stateDir(createWorkspace(root)), { recursive: true });
    store = openMessageStore(officeDbFile(createWorkspace(root)));
  }
  return store;
}

// 会话表（唯一真相）：与消息同库文件。
let sessionStore: SessionStore | undefined;
function getSessions(): SessionStore {
  if (sessionStore === undefined) {
    fs.mkdirSync(stateDir(createWorkspace(root)), { recursive: true });
    sessionStore = openSessionStore(officeDbFile(createWorkspace(root)));
  }
  return sessionStore;
}

// 会议表（与消息/会话同库）：pump 只认 meetingId。
let meetingStore: MeetingStore | undefined;
function getMeetings(): MeetingStore {
  if (meetingStore === undefined) {
    fs.mkdirSync(stateDir(createWorkspace(root)), { recursive: true });
    meetingStore = openMeetingStore(officeDbFile(createWorkspace(root)));
  }
  return meetingStore;
}
/** 该主题的进行中会议 id。 */
const mtgOf = (relation: { kind: "dm"; employeeId: string } | { kind: "group"; project: string }): string =>
  ensureMeeting({ ws: createWorkspace(root), meetings: getMeetings() }, relation, new Date("2026-10-26T10:00:00.000Z")).meetingId;

afterEach(() => {
  store?.close();
  store = undefined;
  sessionStore?.close();
  sessionStore = undefined;
  meetingStore?.close();
  meetingStore = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

function seedEmployee(id: string): void {
  seedOffice(root, { agents: [{ id, model: "faux/faux-model", prompt: `你是 ${id}。` }] });
}

function seedGroup(project: string, members: string[]): void {
  seedOffice(root, { projects: [{ id: project, members }] });
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 15000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("群回复 @触发（pump 集成）", () => {
  it("alice 回复 @bob @carol → 两人都被触发并开工；新会话被订阅（有广播）；副本不重复显示；无 @ 的回复补 @老板", async () => {
    for (const id of ["alice", "bob", "carol"]) seedEmployee(id);
    seedGroup("yt", ["alice", "bob", "carol"]);

    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
    // 三个响应：alice 的回复（触发两人）、bob/carol 的回复（内容相同，避免并发消费顺序影响断言）
    faux.setResponses([fauxAssistantMessage("@bob @carol 都来收尾"), fauxAssistantMessage("收到！"), fauxAssistantMessage("收到！")]);
    const models = createModels();
    models.setProvider(faux.provider);
    const ws = createWorkspace(root);
    const harness = createPiHarness({ root, sqlitePath: path.join(root, "openstaffs/.data", "state.sqlite"), models });
    await harness.open();

    const events: ServerEvent[] = [];
    const hub = {
      broadcast: (event: ServerEvent) => events.push(event),
      add: () => ({ pending: 0, close: () => {} }),
      size: 0,
    } as unknown as SseHub;
    const pump = new Pump({ ws, harness, hub, store: getStore(), meetings: getMeetings(), sessions: getSessions() });
    try {
      const { convId: aliceConv } = await resolveSession({ ws, harness, sessions: getSessions() }, { meetingId: mtgOf({ kind: "group", project: "yt" }), kind: "group", subjectId: "yt", subjectLabel: "yt", createdAt: "" }, "alice");
      await pump.register(aliceConv, { meetingId: mtgOf({ kind: "group", project: "yt" }), memberId: "alice" });
      await harness.submit(aliceConv, "请安排一下收尾");

      // bob 与 carol 都被触发：新会话收到带发送者标注的 chat.mention，并各自产出回复
      const readTarget = async (id: string) => {
        const active = getSessions().convOf(mtgOf({ kind: "group", project: "yt" }), id);
        if (active === undefined) return undefined;
        const messages = await harness.transcript(active.convId);
        return messages.some((m) => m.role === "assistant") ? { convId: active.convId, messages } : undefined;
      };
      const bobActive = await waitFor(() => readTarget("bob"));
      const carolActive = await waitFor(() => readTarget("carol"));
      for (const active of [bobActive, carolActive]) {
        const trigger = active.messages.find((m) => m.kind === "chat.mention");
        expect(trigger?.role).toBe("user");
        expect(trigger?.text).toBe("alice：@bob @carol 都来收尾");
      }

      // 新触发的会话被订阅：bob/carol 的回复走 SSE 广播（register-after-trigger 可观测）
      await waitFor(async () =>
        events.some((e) => e.type === "meeting.message" && e.meetingId === mtgOf({ kind: "group", project: "yt" }) && e.message.speaker.kind === "employee" && e.message.speaker.id === "carol")
          ? true
          : undefined,
      );
      for (const id of ["bob", "carol"]) {
        expect(
          events.some((e) => e.type === "meeting.message" && e.message.speaker.kind === "employee" && e.message.speaker.id === id),
        ).toBe(true);
      }

      // 房间合并视图（自有库）：原回复只出现一份（触发副本不落库）；没写 @ 的回复补 @老板
      const merged = getStore().byMeeting(mtgOf({ kind: "group", project: "yt" })).map((m) => toMeetingMessage(m, "group", "老板"));
      expect(merged.map((m) => m.text)).toEqual([
        "@bob @carol 都来收尾",
        "@老板 收到！",
        "@老板 收到！",
      ]);
      expect(merged.filter((m) => m.text === "@bob @carol 都来收尾")).toHaveLength(1);
    } finally {
      await harness.close();
    }
  }, 30_000);

  it("称谓自定义：pump 广播的 fallback 文本用真称谓（读 config）", async () => {
    seedEmployee("alice");
    seedGroup("yt", ["alice"]);
    fs.mkdirSync(path.join(root, "openstaffs/.data"), { recursive: true });
    fs.writeFileSync(path.join(root, "openstaffs/.data", "config.json"), JSON.stringify({ bossName: "掌柜" }));

    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
    faux.setResponses([fauxAssistantMessage("收到！")]);
    const models = createModels();
    models.setProvider(faux.provider);
    const ws = createWorkspace(root);
    const harness = createPiHarness({ root, sqlitePath: path.join(root, "openstaffs/.data", "state.sqlite"), models });
    await harness.open();

    const events: ServerEvent[] = [];
    const hub = {
      broadcast: (event: ServerEvent) => events.push(event),
      add: () => ({ pending: 0, close: () => {} }),
      size: 0,
    } as unknown as SseHub;
    const pump = new Pump({ ws, harness, hub, store: getStore(), meetings: getMeetings(), sessions: getSessions() });
    try {
      const { convId: aliceConv } = await resolveSession({ ws, harness, sessions: getSessions() }, { meetingId: mtgOf({ kind: "group", project: "yt" }), kind: "group", subjectId: "yt", subjectLabel: "yt", createdAt: "" }, "alice");
      await pump.register(aliceConv, { meetingId: mtgOf({ kind: "group", project: "yt" }), memberId: "alice" });
      await harness.submit(aliceConv, "请回答");
      await waitFor(async () =>
        events.some((e) => e.type === "meeting.message" && e.message.speaker.kind === "employee") ? true : undefined,
      );
      const message = events.find((e) => e.type === "meeting.message" && e.message.speaker.kind === "employee");
      expect(message?.type === "meeting.message" ? message.message.text : "").toBe("@掌柜 收到！");
    } finally {
      await harness.close();
    }
  }, 30_000);
});
