import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { seedOffice } from "../helpers/office.ts";
import { EmptyGroupError, KeyedQueue, NoTargetsError, sendToMeeting, triggerFromMeetingReply } from "../../src/app/send.ts";
import type { ChatMessage, ConversationSpec, HarnessPort, InputMeta } from "../../src/harness/port.ts";
import { openMessageStore } from "../../src/store/messages.ts";
import { openSessionStore, type SessionStore } from "../../src/store/sessions.ts";
import { openMeetingStore, type MeetingStore, type MeetingRecord } from "../../src/store/meetings.ts";
import { createNewMeeting, ensureMeeting } from "../../src/app/meetings.ts";

/** 每个用例一个独立的自有消息库文件（与临时空间夹具同源）。 */
const storeDirs: string[] = [];
function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "os-store-"));
  storeDirs.push(dir);
  return openMessageStore(path.join(dir, "m.db"));
}
afterEach(() => {
  for (const dir of storeDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-send-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** 会议表 / 会话表（同一库文件，唯一真相）：每个用例一份。 */
let sessions: SessionStore;
let meetings: MeetingStore;
const sessionDirs: string[] = [];
beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "os-sessions-"));
  sessionDirs.push(dir);
  meetings = openMeetingStore(path.join(dir, "s.db"));
  sessions = openSessionStore(path.join(dir, "s.db"));
});
afterEach(() => {
  sessions.close();
  meetings.close();
  for (const dir of sessionDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-10-26T10:00:00.000Z");
/** 该主题的进行中会议（没有就建一场）。 */
const meetingOf = (ws: ReturnType<typeof createWorkspace>, relation: { kind: "dm"; employeeId: string } | { kind: "group"; project: string }) =>
  ensureMeeting({ ws, meetings }, relation, NOW);
/** 该主题再开一场新会议（上一场 closed）。 */
const newMeetingOf = (ws: ReturnType<typeof createWorkspace>, relation: { kind: "dm"; employeeId: string } | { kind: "group"; project: string }) =>
  createNewMeeting({ ws, meetings }, relation, NOW);

/** 包一层：把会话表补进每个调用点（生产代码里由装配层注入），并把 relation 解析成会议。 */
type Relation = { kind: "dm"; employeeId: string } | { kind: "group"; project: string };
type SendOptions = Omit<Parameters<typeof sendToMeeting>[4], "sessions">;
const send = (ws: Parameters<typeof sendToMeeting>[0], harness: Parameters<typeof sendToMeeting>[1], relation: Relation, text: string, options: SendOptions) =>
  sendToMeeting(ws, harness, meetingOf(ws, relation), text, { sessions, ...options });
/** 在新会议里发送（等价于「新建会议」后的第一条）。 */
const sendNew = (ws: Parameters<typeof sendToMeeting>[0], harness: Parameters<typeof sendToMeeting>[1], relation: Relation, text: string, options: SendOptions) =>
  sendToMeeting(ws, harness, newMeetingOf(ws, relation), text, { sessions, ...options });
type TriggerOptions = Omit<Parameters<typeof triggerFromMeetingReply>[2], "sessions" | "meeting">;
const trigger = (
  ws: Parameters<typeof triggerFromMeetingReply>[0],
  harness: Parameters<typeof triggerFromMeetingReply>[1],
  relation: Relation,
  options: TriggerOptions,
) => triggerFromMeetingReply(ws, harness, { sessions, meeting: meetingOf(ws, relation), ...options });

/** 该会议落库的消息行。 */
const rowsOf = (store: ReturnType<typeof tempStore>, ws: Parameters<typeof meetingOf>[0], relation: Relation) =>
  store.byMeeting(meetingOf(ws, relation).meetingId);

/** 人 = 一份 `<id>.agent.config.json`（新形态夹具，经 seedOffice）。 */
function seedEmployee(id: string, alias?: string) {
  seedOffice(root, { agents: [{ id, alias, model: "faux/faux-model", prompt: `你是 ${id}。` }] });
}

/** 群 = 一份 `<项目>.project.config.json`（成员写进 config 的 members）。 */
function seedGroup(project: string, members: string[]) {
  seedOffice(root, { projects: [{ id: project, members }] });
}

class FakePort implements HarnessPort {
  readonly starts: ConversationSpec[] = [];
  readonly submits: { convId: string; text: string; meta?: InputMeta }[] = [];
  /** 受理回执状态（缺省 placed）：置 queued 可模拟「员工在跑 → 输入排队」。 */
  status: "queued" | "placed" | "done" | "unanswered" = "placed";
  withdrawn: string[] = [];
  gate?: Promise<void>;

  async open(): Promise<void> {}
  async close(): Promise<void> {}
  /** 会话 id 单调递增（不随 `starts` 清空而回退）：会话表里 conv_id 是主键，不能重号。 */
  #seq = 0;
  async startSession(spec: ConversationSpec): Promise<string> {
    this.starts.push(spec);
    return `conv-${++this.#seq}`;
  }
  async attach(convId: string): Promise<boolean> {
    return convId.startsWith("conv-");
  }
  bindSession(): void {}
  async append(): Promise<void> {}
  async abort(): Promise<void> {}
  sessionInfo(): undefined {
    return undefined;
  }
  async sessionUsage(): Promise<never> {
    throw new Error("FakePort 不提供会话信息");
  }
  async submit(convId: string, text: string, meta?: InputMeta) {
    this.submits.push({ convId, text, meta }); // 先记录"进入 submit"，再被 gate 阻塞（模拟 admission 在途）
    if (this.gate !== undefined) await this.gate;
    return { id: `sub-${this.submits.length}`, status: this.status };
  }
  async withdrawSubmission(_convId: string, submissionId: string): Promise<boolean> {
    this.withdrawn.push(submissionId);
    return true;
  }
  async watch(): Promise<() => Promise<void>> {
    return async () => {};
  }
  async send(convId: string, text: string): Promise<ChatMessage> {
    return { id: "x", role: "assistant", text };
  }
  async context(): Promise<{ instructions: string; items: never[] }> {
    return { instructions: "", items: [] };
  }

  async transcript(): Promise<ChatMessage[]> {
    return [];
  }
}

const defaults = { model: "faux/faux-model" };

describe("发送编排", () => {
  it("私聊直接投递（原文不剥 @），meta 带 author 与同一 messageId", async () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const port = new FakePort();
    const result = await send(ws, port, { kind: "dm", employeeId: "alice" }, "@老板 你好", {
      queue: new KeyedQueue(),
      defaults,
      requestId: "r1",
    });
    expect(result.deliveries).toHaveLength(1);
    expect(port.submits).toHaveLength(1);
    expect(port.submits[0]!.text).toBe("@老板 你好");
    expect(port.submits[0]!.meta?.kind).toBe("chat.message");
    expect(port.submits[0]!.meta?.requestId).toBe("r1");
    const data = port.submits[0]!.meta?.data as { author?: string; messageId?: string };
    expect(data.author).toBe("boss");
    expect(data.messageId).toBe(result.messageId);
  });

  it("受理回执透出：placed 表示已进 transcript；queued 表示在 Pi 的 inbox 里排队", async () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const port = new FakePort();
    const placed = await send(ws, port, { kind: "dm", employeeId: "alice" }, "在吗", { queue: new KeyedQueue(), defaults });
    expect(placed.deliveries[0]).toMatchObject({ memberId: "alice", status: "placed" });
    expect(placed.deliveries[0]!.submissionId).toBeTruthy();

    port.status = "queued";
    const queued = await send(ws, port, { kind: "dm", employeeId: "alice" }, "再问", { queue: new KeyedQueue(), defaults });
    expect(queued.deliveries[0]).toMatchObject({ memberId: "alice", status: "queued" });
  });

  it("新会议：对目标成员各开一条 conv；同一会议内后续发送复用", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    seedGroup("yt", ["alice", "bob"]);
    const ws = createWorkspace(root);
    const port = new FakePort();
    const relation = { kind: "group", project: "yt" } as const;
    const queue = new KeyedQueue();

    // 先各建一条会话（链上已有活跃会话）
    await send(ws, port, relation, "@alice @bob 先热身", { queue, defaults });
    expect(port.starts).toHaveLength(2);
    port.starts.length = 0;

    // 在新会议里发：每人各开一条新会话（而不是复用）
    const fresh = await sendNew(ws, port, relation, "@alice @bob 重新开始", { queue, defaults });
    expect(port.starts).toHaveLength(2);
    expect(fresh.deliveries.map((d) => d.memberId)).toEqual(["alice", "bob"]);
    expect(new Set(fresh.deliveries.map((d) => d.convId)).size).toBe(2);

    // 不开新会话时复用旧会话：两次普通发送落在同一条 convId 上
    await send(ws, port, relation, "@alice 接着聊", { queue, defaults });
    const reused = port.submits.at(-1)!.convId;
    await send(ws, port, relation, "@alice 继续聊", { queue, defaults });
    expect(port.submits.at(-1)!.convId).toBe(reused);
    expect(port.starts).toHaveLength(2); // 没开新会话：没有新增会话
  });

  it("群聊 @alice：只投递 alice，正文保留 @；多 @：各一份同 messageId", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    seedGroup("yt", ["alice", "bob"]);
    const ws = createWorkspace(root);
    const port = new FakePort();
    const queue = new KeyedQueue();

    const mentioned = await send(ws, port, { kind: "group", project: "yt" }, "@alice 做视频", { queue, defaults });
    expect(mentioned.deliveries.map((d) => d.memberId)).toEqual(["alice"]);
    expect(port.submits[0]!.text).toBe("@alice 做视频");

    port.submits.length = 0;
    const both = await send(ws, port, { kind: "group", project: "yt" }, "@alice @bob 全体汇报", { queue, defaults });
    expect(both.deliveries.map((d) => d.memberId).sort()).toEqual(["alice", "bob"]);
    const rids = new Set(port.submits.map((s) => (s.meta?.data as { messageId?: string } | undefined)?.messageId));
    expect(rids).toEqual(new Set([both.messageId]));
  });

  it("群聊一次 @ 两人：落一行、toIds 两人、text 已剥离 @", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    seedGroup("seo", ["alice", "bob"]);
    const ws = createWorkspace(root);
    const store = tempStore();
    try {
      await send(ws, new FakePort(), { kind: "group", project: "seo" }, "@alice @bob 开工", { queue: new KeyedQueue(), store });
      const rows = rowsOf(store, ws, { kind: "group", project: "seo" });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.fromId).toBe("__boss");
      expect(rows[0]!.toIds).toEqual(["alice", "bob"]);
      expect(rows[0]!.text).toBe("开工");
    } finally {
      store.close();
    }
  });

  it("私聊：落一行、projectId 为 null、toIds 只该员工、text 已剥离 @", async () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const store = tempStore();
    try {
      await send(ws, new FakePort(), { kind: "dm", employeeId: "alice" }, "@老板 在吗", { queue: new KeyedQueue(), store });
      const rows = rowsOf(store, ws, { kind: "dm", employeeId: "alice" });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.fromId).toBe("__boss");
      expect(rows[0]!.toIds).toEqual(["alice"]);
      expect(rows[0]!.text).toBe("在吗");
    } finally {
      store.close();
    }
  });

  it("群聊 @ 到成员 + 老板：落一行、toIds 保留 __boss（头部 @ 据此重建）、text 已剥离", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    seedGroup("seo", ["alice", "bob"]);
    const ws = createWorkspace(root);
    const store = tempStore();
    try {
      await send(ws, new FakePort(), { kind: "group", project: "seo" }, "@alice @老板 开工", { queue: new KeyedQueue(), store });
      const rows = rowsOf(store, ws, { kind: "group", project: "seo" });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.fromId).toBe("__boss");
      expect(rows[0]!.toIds).toEqual(["alice", "__boss"]);
      expect(rows[0]!.text).toBe("开工");
    } finally {
      store.close();
    }
  });

  it("空正文不落库（私聊只剩 @ 前缀，剥完为空）：不落行", async () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const store = tempStore();
    try {
      const result = await send(ws, new FakePort(), { kind: "dm", employeeId: "alice" }, "@alice", { queue: new KeyedQueue(), store });
      expect(result.deliveries.map((d) => d.memberId)).toEqual(["alice"]);
      expect(rowsOf(store, ws, { kind: "dm", employeeId: "alice" })).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("不传 store：不落库（行为与既有完全一致）、recorded 为 undefined", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    seedGroup("seo", ["alice", "bob"]);
    const ws = createWorkspace(root);
    const store = tempStore();
    try {
      const result = await send(ws, new FakePort(), { kind: "group", project: "seo" }, "@alice @bob 开工", { queue: new KeyedQueue() });
      expect(result.deliveries.map((d) => d.memberId).sort()).toEqual(["alice", "bob"]);
      expect(result.recorded).toBeUndefined();
      expect(rowsOf(store, ws, { kind: "group", project: "seo" })).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("传 store：返回值带回刚落的行（recorded），供调用方广播库行；只落 1 行（N 份投递不落 N 行）", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    seedGroup("seo", ["alice", "bob"]);
    const ws = createWorkspace(root);
    const store = tempStore();
    try {
      const result = await send(ws, new FakePort(), { kind: "group", project: "seo" }, "@alice @bob 开工", { queue: new KeyedQueue(), store });
      const rows = rowsOf(store, ws, { kind: "group", project: "seo" });
      expect(rows).toHaveLength(1);
      expect(result.recorded).toBeDefined();
      expect(result.recorded).toEqual(rows[0]);
      expect(result.recorded!.seq).toBe(rows[0]!.seq);
      expect(result.recorded!.meetingId).toBe(meetingOf(ws, { kind: "group", project: "seo" }).meetingId);
    } finally {
      store.close();
    }
  });

  it("空正文（剥头后为空）：不落行，recorded 为 undefined", async () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const store = tempStore();
    try {
      const result = await send(ws, new FakePort(), { kind: "dm", employeeId: "alice" }, "@alice", { queue: new KeyedQueue(), store });
      expect(result.recorded).toBeUndefined();
      expect(rowsOf(store, ws, { kind: "dm", employeeId: "alice" })).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("群聊不 @ 到任何成员（含只 @老板）：抛 NoTargetsError，不 submit", async () => {
    seedEmployee("alice");
    seedGroup("yt", ["alice"]);
    const ws = createWorkspace(root);
    const port = new FakePort();
    const queue = new KeyedQueue();
    await expect(
      send(ws, port, { kind: "group", project: "yt" }, "全体汇报", { queue, defaults }),
    ).rejects.toThrow(NoTargetsError);
    await expect(
      send(ws, port, { kind: "group", project: "yt" }, "@老板 收到", { queue, defaults }),
    ).rejects.toThrow(NoTargetsError);
    expect(port.submits).toEqual([]);
  });

  it("空成员群：抛 EmptyGroupError", async () => {
    seedOffice(root, { projects: [{ id: "empty" }] });
    const ws = createWorkspace(root);
    await expect(
      send(ws, new FakePort(), { kind: "group", project: "empty" }, "在吗", { queue: new KeyedQueue(), defaults }),
    ).rejects.toThrow(EmptyGroupError);
  });

  it("per-key 串行：同 key 后一个等前一个进入 submit 后才开始", async () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const port = new FakePort();
    const queue = new KeyedQueue();
    let release!: () => void;
    port.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = send(ws, port, { kind: "dm", employeeId: "alice" }, "一", { queue, defaults });
    const second = send(ws, port, { kind: "dm", employeeId: "alice" }, "二", { queue, defaults });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(port.submits).toHaveLength(1); // 第二个还没进入
    release();
    await Promise.all([first, second]);
    expect(port.submits.map((s) => s.text)).toEqual(["一", "二"]);
  });

  it("异 key 并行：两个成员同时进入 submit（互不阻塞）", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    seedGroup("yt", ["alice", "bob"]);
    const ws = createWorkspace(root);
    const port = new FakePort();
    let release!: () => void;
    port.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const p = send(ws, port, { kind: "group", project: "yt" }, "@alice @bob 全体动起来", { queue: new KeyedQueue(), defaults });
    const started = Date.now();
    while (port.submits.length < 2 && Date.now() - started < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(port.submits).toHaveLength(2); // 两个成员都在 submit 中等待
    release();
    await p;
  });
});

describe("群回复的 @触发（agent ↔ agent / 发给老板的口径）", () => {
  it("投递给被 @ 到的成员：发送者标注 + chat.mention + 去重键；不含发送者自己与老板", async () => {
    seedEmployee("alice", "爱丽丝");
    seedEmployee("bob");
    seedGroup("yt", ["alice", "bob"]);
    const ws = createWorkspace(root);
    const port = new FakePort();
    const reports = await trigger(ws, port, { kind: "group", project: "yt" }, {
      queue: new KeyedQueue(),
      defaults,
      senderId: "alice",
      convId: "conv-a",
      entryId: "42",
      text: "@bob @alice @老板 请评审：方案 A",
    });
    expect(reports.map((r) => r.memberId)).toEqual(["bob"]);
    expect(port.submits).toHaveLength(1);
    expect(port.submits[0]!.text).toBe("爱丽丝（alice）：@bob @alice @老板 请评审：方案 A");
    expect(port.submits[0]!.meta?.kind).toBe("chat.mention");
    const data = port.submits[0]!.meta?.data as { author?: string; source?: string };
    expect(data.author).toBe("alice");
    expect(data.source).toBe("conv-a:42");
    expect(port.submits[0]!.meta?.requestId).toBe("mention:conv-a:42");
  });

  it("不落库：触发副本不再是「一次投递」的记录（同一句话由 pump 的 message 分支落一行）", async () => {
    seedEmployee("alice", "爱丽丝");
    seedEmployee("bob");
    seedGroup("yt", ["alice", "bob"]);
    const ws = createWorkspace(root);
    const port = new FakePort();
    const store = tempStore();
    try {
      const reports = await trigger(ws, port, { kind: "group", project: "yt" }, {
        queue: new KeyedQueue(),
        defaults,
        senderId: "alice",
        convId: "conv-a",
        entryId: "42",
        text: "@bob 请评审框架",
      });
      expect(reports.map((r) => r.memberId)).toEqual(["bob"]);
      expect(port.submits).toHaveLength(1);
      expect(store.byMeeting(meetingOf(ws, { kind: "group", project: "yt" }).meetingId)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("无 alias 用 id 标注；无 @ 开头 / 只 @老板 / @非成员 / 只 @自己 → 不投递", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    seedGroup("yt", ["alice", "bob"]);
    const ws = createWorkspace(root);
    const port = new FakePort();
    const queue = new KeyedQueue();
    const run = (text: string) =>
      trigger(ws, port, { kind: "group", project: "yt" }, { queue, defaults, senderId: "alice", convId: "c", entryId: "1", text });

    const reports = await run("@bob 你好");
    expect(reports.map((r) => r.memberId)).toEqual(["bob"]);
    expect(port.submits[0]!.text).toBe("alice：@bob 你好");
    port.submits.length = 0;

    expect(await run("好的，已完成")).toEqual([]);
    expect(await run("@老板 已汇报")).toEqual([]);
    expect(await run("@ghost 你好")).toEqual([]);
    expect(await run("@alice 我自己")).toEqual([]);
    expect(port.submits).toEqual([]);
  });

  it("新会话的第一条消息命名：落时间标题 + 调一次命名；复用旧会话不再命名", async () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const store = tempStore();
    const named: string[] = [];
    const titles = {
      store: meetings,
      notify: () => {},
      namer: async (text: string) => {
        named.push(text);
        return "登录排查";
      },
    };
    const port = new FakePort();
    const queue = new KeyedQueue();

    await send(ws, port, { kind: "dm", employeeId: "alice" }, "帮我看看登录", { queue, defaults, titles });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(named).toEqual(["帮我看看登录"]);
    expect(meetings.get(meetingOf(ws, { kind: "dm", employeeId: "alice" }).meetingId)?.title).toBe("登录排查");

    // 第二条消息复用同一会话 → 不再命名
    await send(ws, port, { kind: "dm", employeeId: "alice" }, "继续", { queue, defaults, titles });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(named).toHaveLength(1);
  });

  it("群聊一条消息 @ 两人 → 两条新会话各自命名", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    seedGroup("yt", ["alice", "bob"]);
    const ws = createWorkspace(root);
    const store = tempStore();
    const named: string[] = [];
    const titles = {
      store: meetings,
      notify: () => {},
      namer: async (text: string) => {
        named.push(text);
        return "协作安排";
      },
    };
    const port = new FakePort();
    await send(ws, port, { kind: "group", project: "yt" }, "@alice @bob 看下这个", {
      queue: new KeyedQueue(),
      defaults,
      titles,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 一场会议一个标题：一条消息 @ 两人 → 第一次建 conv 时命名一次，同一会议的后续 delivery 不再命名
    expect(named).toHaveLength(1);
    expect(meetings.get(meetingOf(ws, { kind: "group", project: "yt" }).meetingId)?.title).toBe("协作安排");
  });

  it("没有 titles 依赖时行为不变（不落标题、不报错）", async () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const port = new FakePort();
    const result = await send(ws, port, { kind: "dm", employeeId: "alice" }, "你好", {
      queue: new KeyedQueue(),
      defaults,
    });
    expect(result.deliveries).toHaveLength(1);
  });
});
