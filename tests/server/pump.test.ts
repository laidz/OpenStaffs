import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspace, officeDbFile, type Workspace } from "../../src/domain/paths.ts";
import { seedOffice } from "../helpers/office.ts";
import type { HarnessEvent, HarnessPort } from "../../src/harness/port.ts";
import type { ServerEvent, SseHub } from "../../src/server/sse.ts";
import { Pump } from "../../src/server/pump.ts";
import { openMessageStore, type MessageStore } from "../../src/store/messages.ts";
import { openSessionStore, type SessionStore } from "../../src/store/sessions.ts";
import { openMeetingStore, type MeetingStore } from "../../src/store/meetings.ts";
import { ensureMeeting } from "../../src/app/meetings.ts";

let root: string;
let ws: Workspace;
let store: MessageStore;
let sessions: SessionStore;
let meetings: MeetingStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-pump-"));
  ws = createWorkspace(root);
  // openMessageStore 不建父目录（接线方保证 stateDir 存在），这里对齐 main.ts 的接线前提。
  fs.mkdirSync(path.join(root, "openstaffs/.data"), { recursive: true });
  store = openMessageStore(officeDbFile(ws));
  meetings = openMeetingStore(officeDbFile(ws));
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

function seedGroup(project: string, members: string[]): void {
  seedOffice(root, { projects: [{ id: project, members }] });
}

/** 该主题的进行中会议 id（没有就建一场；pump 只认会议）。 */
type Rel = { kind: "dm"; employeeId: string } | { kind: "group"; project: string };
const mtg = (relation: Rel): string =>
  ensureMeeting({ ws, meetings }, relation, new Date("2026-10-26T10:00:00.000Z")).meetingId;
const groupMtg = (project = "seo"): string => mtg({ kind: "group", project });
const dmMtg = (employeeId = "alice"): string => mtg({ kind: "dm", employeeId });

/**
 * 桩 harness：只实现 pump 与群回复 @触发路径会用到的面（不跑真模型）；
 * 测试直接向订阅者投递事件，落库/广播是同步的，断言无需轮询。
 */
class StubHarness {
  #listeners = new Map<string, (event: HarnessEvent) => void>();
  #n = 0;
  /** 收到的输入（触发投递的可观测面：@触发是否照常发生）。 */
  readonly submits: { convId: string; text: string }[] = [];

  async open(): Promise<void> {}
  async close(): Promise<void> {}
  async startSession(): Promise<string> {
    return `conv_stub_${++this.#n}`;
  }
  async attach(): Promise<boolean> {
    return false;
  }
  /** 订阅时补登记的会话归属（房间判定不能靠 cwd 猜）。 */
  readonly bound: { convId: string; selfId: string; relation: unknown; meetingId: string; access: { selfId: string; cwd: string; permissions: { write: string[] } } }[] = [];
  bindSession(
    convId: string,
    session: { selfId: string; relation: unknown; meetingId: string; access: { selfId: string; cwd: string; permissions: { write: string[] } } },
  ): void {
    this.bound.push({ convId, ...session });
  }
  async submit(convId: string, text: string): Promise<{ id: string; status: "queued" }> {
    this.submits.push({ convId, text });
    return { id: `sub_${++this.#n}`, status: "queued" };
  }
  async watch(convId: string, listener: (event: HarnessEvent) => void): Promise<() => Promise<void>> {
    this.#listeners.set(convId, listener);
    return async () => {
      this.#listeners.delete(convId);
    };
  }
  emit(convId: string, event: HarnessEvent): void {
    const listener = this.#listeners.get(convId);
    if (listener === undefined) throw new Error(`没有订阅者: ${convId}`);
    listener(event);
  }
}

function makePump(harness: StubHarness, storeOverride?: MessageStore): { pump: Pump; events: ServerEvent[] } {
  const events: ServerEvent[] = [];
  const hub = {
    broadcast: (event: ServerEvent) => events.push(event),
    add: () => ({ pending: 0, close: () => {} }),
    size: 0,
  } as unknown as SseHub;
  const pump = new Pump({ ws, harness: harness as unknown as HarnessPort, hub, store: storeOverride ?? store, meetings, sessions });
  return { pump, events };
}

const assistant = (text: string): HarnessEvent => ({
  type: "message",
  convId: "conv_alice",
  message: { id: "e1", role: "assistant", text },
});

/** 老板消息 / pi.user 等 user 条目（对别处已落库发言的回显）。 */
const userEcho = (text: string): HarnessEvent => ({
  type: "message",
  convId: "conv_alice",
  message: { id: "e2", role: "user", kind: "chat.message", text, data: { author: "boss" } },
});

/** 工具代写的「己方发言」（send_message boss/project：assistant 形态 + kind=chat.message）。 */
const toolAppend = (text: string): HarnessEvent => ({
  type: "message",
  convId: "conv_alice",
  message: { id: "e3", role: "assistant", kind: "chat.message", text, data: { author: "alice" } },
});

describe("订阅时补登记会话归属与访问上下文（重启后工具才能用）", () => {
  it("register 把「我是谁 / 在哪个房间 / 能用什么权限」一起登记给 harness", async () => {
    seedEmployee("alice");
    seedGroup("seo", ["alice"]);
    const harness = new StubHarness();
    const { pump } = makePump(harness);
    try {
      await pump.register("conv_alice", { meetingId: groupMtg(), memberId: "alice" });
      // 回归：曾只补登记身份不补 access → 重启后员工每个工具调用都被「访问控制：未注册的会话」拦下。
      expect(harness.bound).toHaveLength(1);
      expect(harness.bound[0]).toMatchObject({
        convId: "conv_alice",
        selfId: "alice",
        relation: { kind: "group", project: "seo" },
        meetingId: groupMtg(),
        access: { selfId: "alice" },
      });
      expect(harness.bound[0]!.access.permissions.write.length).toBeGreaterThan(0);
      expect(harness.bound[0]!.access.cwd).toContain("work");
      await pump.unregister("conv_alice");
      await pump.register("conv_dm", { meetingId: dmMtg(), memberId: "alice" });
      expect(harness.bound.at(-1)).toMatchObject({ convId: "conv_dm", selfId: "alice", relation: { kind: "dm", employeeId: "alice" }, meetingId: dmMtg() });
    } finally {
      await pump.unregister("conv_alice");
      await pump.unregister("conv_dm");
    }
  });
});

describe("user 条目不再回显（R-P1-12）", () => {
  it("user 角色 message 事件（含 pi.user）→ 不广播 room.message", async () => {
    seedEmployee("alice");
    const harness = new StubHarness();
    const { pump, events } = makePump(harness);
    await pump.register("conv_alice", { meetingId: dmMtg(), memberId: "alice" });

    harness.emit("conv_alice", userEcho("你好"));

    expect(events.filter((event) => event.type === "meeting.message")).toEqual([]);
  });

  it("工具代写的己方发言（chat.message，assistant 形态）→ 不落库、不广播（其写路径自持广播）", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    seedGroup("seo", ["alice", "bob"]);
    const harness = new StubHarness();
    const { pump, events } = makePump(harness);
    await pump.register("conv_alice", { meetingId: groupMtg(), memberId: "alice" });

    harness.emit("conv_alice", toolAppend("@bob 汇报一下"));

    expect(store.byMeeting(groupMtg())).toEqual([]);
    expect(events.filter((event) => event.type === "meeting.message")).toEqual([]);
  });
});

describe("agent 回复落库（pump → 自有消息库）", () => {
  it("群聊：agent 回复落一行（fromId/toIds/text），同事件仍广播 room.message", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    seedGroup("seo", ["alice", "bob"]);
    const harness = new StubHarness();
    const { pump, events } = makePump(harness);
    await pump.register("conv_alice", { meetingId: groupMtg(), memberId: "alice" });

    harness.emit("conv_alice", assistant("@bob 完成"));

    const rows = store.byMeeting(groupMtg());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ meetingId: groupMtg(), fromId: "alice", toIds: ["bob"], text: "完成" });
    expect(events.filter((event) => event.type === "meeting.message")).toHaveLength(1);
  });

  it("群聊一次 @ 多人：仍是 1 行（toIds 数组）", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    seedEmployee("carol");
    seedGroup("seo", ["alice", "bob", "carol"]);
    const harness = new StubHarness();
    const { pump } = makePump(harness);
    await pump.register("conv_alice", { meetingId: groupMtg(), memberId: "alice" });

    harness.emit("conv_alice", assistant("@bob @carol 都来收尾"));

    const rows = store.byMeeting(groupMtg());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.toIds).toEqual(["bob", "carol"]);
    expect(rows[0]?.text).toBe("都来收尾");
  });

  it("只有 @ 没有正文 → 不落行，也就没有库行可广播（气泡不出现）", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    seedGroup("seo", ["alice", "bob"]);
    const harness = new StubHarness();
    const { pump, events } = makePump(harness);
    await pump.register("conv_alice", { meetingId: groupMtg(), memberId: "alice" });

    harness.emit("conv_alice", assistant("@bob"));

    expect(store.byMeeting(groupMtg())).toEqual([]);
    // R-P1-12：pump 只广播库行；不落行 → 不广播（旧行为是回显 transcript 条目，键与 GET/pin 不同源）。
    expect(events.some((event) => event.type === "meeting.message")).toBe(false);
  });

  it("私聊会议：没写 @ 的回复默认发给老板（__boss）", async () => {
    seedEmployee("alice");
    const harness = new StubHarness();
    const { pump } = makePump(harness);
    await pump.register("conv_alice", { meetingId: dmMtg(), memberId: "alice" });

    harness.emit("conv_alice", assistant("收到"));

    const rows = store.byMeeting(dmMtg());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ meetingId: dmMtg(), fromId: "alice", toIds: ["__boss"], text: "收到" });
  });
});

/** 轮询到条件成立（@触发是异步的：pump 用 void 发起）。 */
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("waitFor 超时");
}

describe("落库异常不连坐（Task 6 收口）", () => {
  it("store.append 抛错：记日志、无库行广播，但群内 @触发照常投递", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    seedGroup("seo", ["alice", "bob"]);
    const harness = new StubHarness();
    const { pump, events } = makePump(harness, {
      // 写库失败（如库被锁）：只记日志，不吞掉广播与 @触发（旧行为：整块裸 catch 一起吞掉且无日志）。
      append() {
        throw new Error("database is locked");
      },
      byMeeting() {
        return [];
      },
      deleteByMeeting() {
        return 0;
      },
      close() {},
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await pump.register("conv_alice", { meetingId: groupMtg(), memberId: "alice" });

      harness.emit("conv_alice", assistant("@bob 完成"));

      expect(events.some((event) => event.type === "meeting.message")).toBe(false); // 无库行可播
      await waitFor(() => harness.submits.length > 0); // @触发仍投递给了 bob
      expect(harness.submits.some((submit) => submit.text.includes("完成"))).toBe(true);
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });
});

describe("工具活动广播（前端状态行的真相源）", () => {
  it("tool start 带 name + hint、end 不带；toolCall（生成参数）广播 kind=toolCall / phase=start", async () => {
    seedEmployee("alice");
    const harness = new StubHarness();
    const { pump, events } = makePump(harness);
    await pump.register("conv_alice", { meetingId: dmMtg(), memberId: "alice" });

    harness.emit("conv_alice", { type: "toolCall", convId: "conv_alice", name: "bash" });
    harness.emit("conv_alice", { type: "tool", convId: "conv_alice", name: "bash", phase: "start", hint: "echo hi" });
    harness.emit("conv_alice", { type: "tool", convId: "conv_alice", name: "bash", phase: "end" });

    expect(events).toEqual([
      { type: "meeting.activity", meetingId: dmMtg(), convId: "conv_alice", memberId: "alice", kind: "toolCall", phase: "start", name: "bash" },
      { type: "meeting.activity", meetingId: dmMtg(), convId: "conv_alice", memberId: "alice", kind: "tool", phase: "start", name: "bash", hint: "echo hi" },
      { type: "meeting.activity", meetingId: dmMtg(), convId: "conv_alice", memberId: "alice", kind: "tool", phase: "end", name: "bash" },
    ]);
    await pump.unregister("conv_alice");
  });
});

describe("运行状态", () => {
  it("isRunning：run start/end 维护，unregister 清掉", async () => {
    seedEmployee("alice");
    const harness = new StubHarness();
    const { pump } = makePump(harness);
    await pump.register("conv_run", { meetingId: dmMtg(), memberId: "alice" });
    expect(pump.isRunning("conv_run")).toBe(false);
    harness.emit("conv_run", { type: "run", convId: "conv_run", phase: "start" });
    expect(pump.isRunning("conv_run")).toBe(true);
    harness.emit("conv_run", { type: "run", convId: "conv_run", phase: "end" });
    expect(pump.isRunning("conv_run")).toBe(false);

    harness.emit("conv_run", { type: "run", convId: "conv_run", phase: "start" });
    await pump.unregister("conv_run");
    expect(pump.isRunning("conv_run")).toBe(false);
  });
});
