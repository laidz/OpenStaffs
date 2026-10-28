import { describe, expect, it } from "vitest";
import { initialState, reduce, selectView, type State } from "../../web/state.ts";
import type { MeetingView } from "../../src/app/meetings.ts";
import type { MeetingMessage } from "../../src/app/meeting-messages.ts";
import type { QueuedItemView } from "../../src/app/outbox.ts";

const meeting: MeetingView = {
  meetingId: "m1",
  kind: "dm",
  subjectId: "alice",
  subjectLabel: "爱丽丝",
  participants: ["alice"],
  title: "登录排查",
  createdAt: "2026-10-26T10:00:00.000Z",
};

function msg(entryId: string, kind: "boss" | "employee", text: string, messageId?: string): MeetingMessage {
  return kind === "boss"
    ? { convId: "store", entryId, speaker: { kind: "boss" }, text, bossDirected: false, ...(messageId === undefined ? {} : { messageId }) }
    : { convId: "store", entryId, speaker: { kind: "employee", id: "alice" }, text, bossDirected: true };
}

const queuedItem: QueuedItemView = { submissionId: "11", meetingId: "m1", memberId: "alice", messageId: "rm_1", text: "在吗" };

/** 进入某主题的当前会议（首屏 / 点侧栏的真实事件序列：subject → meeting）。 */
function inMeeting(overrides: Partial<State> = {}): State {
  const state = reduce(initialState, {
    type: "subject",
    subjectKey: "dm:alice",
    current: meeting,
    meetings: [meeting],
  });
  const entered = reduce(state, { type: "meeting", meetingId: "m1", meeting, messages: [], pinned: [] });
  return { ...entered, ...overrides };
}

/** 一场 SSE 事件（类型由 ServerEvent 约束）。 */
function sse(state: State, event: Parameters<typeof reduce>[1] & { type: "sse" }): State {
  return reduce(state, event);
}

describe("前端状态归约", () => {
  it("selectView：configured 决定引导页/主界面", () => {
    expect(selectView(initialState)).toBe("setup");
    expect(selectView(reduce(initialState, { type: "status", configured: true, bossName: "老板" }))).toBe("main");
  });

  it("bossName 随 status 事件更新", () => {
    const state = reduce(initialState, { type: "status", configured: true, bossName: "掌柜" });
    expect(state.bossName).toBe("掌柜");
  });

  it("subject 事件：存 subjectKey/current/meetings；没有 current 时 meetingId 为 undefined；切主题清空上一场", () => {
    const loaded = reduce(inMeeting({ messages: [msg("1", "boss", "旧")], pinned: ["store:1"], live: { c1: { convId: "c1", memberId: "alice", text: "", thinking: "", tools: [], activity: "" } } }), {
      type: "subject",
      subjectKey: "group:yt",
      current: { ...meeting, meetingId: "m2", kind: "group", subjectId: "yt", subjectLabel: "油管" },
      meetings: [{ ...meeting, meetingId: "m2", kind: "group", subjectId: "yt", subjectLabel: "油管" }],
    });
    expect(loaded.subjectKey).toBe("group:yt");
    expect(loaded.meetingId).toBe("m2");
    expect(loaded.meeting?.subjectLabel).toBe("油管");
    expect(loaded.meetings).toHaveLength(1);
    expect(loaded.freshMeeting).toBe(false);
    // 上一场的消息 / pin / live 不能带过来
    expect(loaded.messages).toEqual([]);
    expect(loaded.pinned).toEqual([]);
    expect(loaded.live).toEqual({});

    const pending = reduce(initialState, { type: "subject", subjectKey: "dm:bob", meetings: [] });
    expect(pending.subjectKey).toBe("dm:bob");
    expect(pending.meetingId).toBeUndefined();
    expect(pending.meeting).toBeUndefined();
    expect(pending.meetings).toEqual([]);
  });

  it("meeting 事件：换会议就重置 messages/pinned/queued/live 并接受本场数据", () => {
    const state = reduce(inMeeting({ messages: [msg("1", "boss", "旧")], live: { c1: { convId: "c1", memberId: "alice", text: "x", thinking: "", tools: [], activity: "" } } }), {
      type: "meeting",
      meetingId: "m2",
      meeting: { ...meeting, meetingId: "m2", title: "下一场" },
      messages: [msg("5", "employee", "新")],
      pinned: ["store:5"],
      queued: [queuedItem],
    });
    expect(state.meetingId).toBe("m2");
    expect(state.meeting?.title).toBe("下一场");
    expect(state.messages.map((m) => m.text)).toEqual(["新"]);
    expect(state.pinned).toEqual(["store:5"]);
    expect(state.queued.map((q) => q.submissionId)).toEqual(["11"]);
    expect(state.live).toEqual({});
    expect(state.freshMeeting).toBe(false);
  });

  it("new-meeting：置 freshMeeting 并清空聊天区（上一场不显示）；取消只复原标志", () => {
    const base = inMeeting({ messages: [msg("1", "boss", "上一轮的话")], pinned: ["store:1"], queued: [queuedItem] });
    const armed = reduce(base, { type: "new-meeting", on: true });
    expect(armed.freshMeeting).toBe(true);
    expect(armed.messages).toEqual([]);
    expect(armed.pinned).toEqual([]);
    expect(armed.queued).toEqual([]);
    // 幂等：同一引用
    expect(reduce(armed, { type: "new-meeting", on: true })).toBe(armed);
    expect(reduce(armed, { type: "new-meeting", on: false }).freshMeeting).toBe(false);
  });

  it("迟到 / 别处的会议消息被丢弃：只更新忙碌点，不污染消息", () => {
    const state = inMeeting();
    const other = sse(state, {
      type: "sse",
      event: { type: "meeting.message", meetingId: "m9", message: msg("30", "employee", "别处") },
    });
    expect(other).toBe(state);
    const delta = sse(state, {
      type: "sse",
      event: { type: "meeting.delta", meetingId: "m9", convId: "cx", memberId: "bob", channel: "text", delta: "x" },
    });
    expect(delta).toBe(state);
    const activity = sse(state, {
      type: "sse",
      event: { type: "meeting.activity", meetingId: "m9", convId: "cx", memberId: "bob", kind: "run", phase: "start" },
    });
    expect(activity.messages).toEqual([]);
    expect(activity.busy["bob"]).toBe(true); // 忙碌点是全局的（侧栏要显示谁在干活）
  });

  it("消息增量合并：按消息键去重（幂等）、保持排序；messageId 不再参与读侧去重", () => {
    let state = inMeeting();
    state = sse(state, { type: "sse", event: { type: "meeting.message", meetingId: "m1", message: msg("10", "boss", "任务", "rm_1") } });
    state = sse(state, { type: "sse", event: { type: "meeting.message", meetingId: "m1", message: msg("11", "employee", "回答") } });
    state = sse(state, { type: "sse", event: { type: "meeting.message", meetingId: "m1", message: msg("10", "boss", "任务", "rm_1") } });
    expect(state.messages.map((m) => m.entryId)).toEqual(["10", "11"]);

    // 键不同就是不同消息（一次投递 = 库中一行 = 唯一 seq）
    state = sse(state, { type: "sse", event: { type: "meeting.message", meetingId: "m1", message: msg("12", "boss", "另一条", "rm_1") } });
    expect(state.messages.map((m) => m.entryId)).toEqual(["10", "11", "12"]);
  });

  it("delta 聚合到 live 气泡；员工正式消息到达后按**成员**清 live", () => {
    let state = inMeeting();
    state = sse(state, { type: "sse", event: { type: "meeting.delta", meetingId: "m1", convId: "c1", memberId: "alice", channel: "text", delta: "你" } });
    state = sse(state, { type: "sse", event: { type: "meeting.delta", meetingId: "m1", convId: "c1", memberId: "alice", channel: "text", delta: "好" } });
    expect(state.live["c1"]?.text).toBe("你好");
    state = sse(state, { type: "sse", event: { type: "meeting.message", meetingId: "m1", message: msg("20", "employee", "你好") } });
    expect(state.live["c1"]).toBeUndefined();
  });

  it("正式员工消息按成员清 live（库行视图 convId 恒为 store，与 delta 的 Pi convId 不同）", () => {
    // 回归：曾经按 convId 清 live → 删的是 live["store"]，流式气泡永远清不掉，
    // 结果消息末尾留一个截断的残影气泡（看起来像「最后一段内容丢了」）。
    let state = inMeeting();
    state = sse(state, { type: "sse", event: { type: "meeting.delta", meetingId: "m1", convId: "conv:abc", memberId: "alice", channel: "text", delta: "说一半" } });
    expect(state.live["conv:abc"]?.text).toBe("说一半");
    state = sse(state, { type: "sse", event: { type: "meeting.message", meetingId: "m1", message: msg("20", "employee", "说一半说完") } });
    expect(Object.keys(state.live)).toEqual([]);
    expect(state.messages.map((m) => m.text)).toEqual(["说一半说完"]);
  });

  it("群聊并行流式：别人的气泡不被别人的正式消息清掉", () => {
    let state = inMeeting();
    state = sse(state, { type: "sse", event: { type: "meeting.delta", meetingId: "m1", convId: "conv:alice", memberId: "alice", channel: "text", delta: "a" } });
    state = sse(state, { type: "sse", event: { type: "meeting.delta", meetingId: "m1", convId: "conv:bob", memberId: "bob", channel: "text", delta: "b" } });
    const finished: MeetingMessage = { convId: "store", entryId: "20", speaker: { kind: "employee", id: "alice" }, text: "alice 说完", bossDirected: true };
    state = sse(state, { type: "sse", event: { type: "meeting.message", meetingId: "m1", message: finished } });
    expect(Object.keys(state.live)).toEqual(["conv:bob"]);
  });

  it("R9 重喂已存在的员工消息不误删进行中的 live 气泡（仅真正追加时清 live）", () => {
    const existing = msg("20", "employee", "说一半说完");
    let state = inMeeting({ messages: [existing] });
    state = sse(state, { type: "sse", event: { type: "meeting.delta", meetingId: "m1", convId: "c1", memberId: "alice", channel: "text", delta: "继续" } });
    state = sse(state, { type: "sse", event: { type: "meeting.message", meetingId: "m1", message: existing } });
    expect(state.live["c1"]?.text).toBe("继续");
  });

  it("忙碌与工具活动、失败事件", () => {
    let state = inMeeting();
    state = sse(state, { type: "sse", event: { type: "meeting.activity", meetingId: "m1", convId: "c1", memberId: "alice", kind: "run", phase: "start" } });
    expect(state.busy["alice"]).toBe(true);
    expect(state.live["c1"]?.activity).toBe("正在思考…");
    state = sse(state, { type: "sse", event: { type: "meeting.activity", meetingId: "m1", convId: "c1", memberId: "alice", kind: "tool", phase: "start", name: "write" } });
    expect(state.live["c1"]?.tools.map((tool) => tool.name)).toEqual(["write"]);
    expect(state.live["c1"]?.activity).toBe("正在执行 write…");
    // 工具结束：栈里移除，但状态行**不消失**（退化成「已完成 write」）
    state = sse(state, { type: "sse", event: { type: "meeting.activity", meetingId: "m1", convId: "c1", memberId: "alice", kind: "tool", phase: "end", name: "write" } });
    expect(state.live["c1"]?.tools).toEqual([]);
    expect(state.live["c1"]?.activity).toBe("已完成 write");
    state = sse(state, { type: "sse", event: { type: "meeting.delta", meetingId: "m1", convId: "c1", memberId: "alice", channel: "thinking", delta: "嗯" } });
    expect(state.live["c1"]?.activity).toBe("正在思考…");
    state = sse(state, { type: "sse", event: { type: "meeting.failed", meetingId: "m1", convId: "c1", memberId: "alice", message: "模型不可用" } });
    expect(state.live["c1"]?.error).toBe("模型不可用");
    state = sse(state, { type: "sse", event: { type: "meeting.activity", meetingId: "m1", convId: "c1", memberId: "alice", kind: "run", phase: "end" } });
    expect(state.busy["alice"]).toBe(false);
  });

  it("状态行文案跟随事件：思考 / 输出 / 工具，且恒非空", () => {
    let state = inMeeting();
    state = sse(state, { type: "sse", event: { type: "meeting.delta", meetingId: "m1", convId: "c1", memberId: "alice", channel: "thinking", delta: "嗯" } });
    expect(state.live["c1"]?.activity).toBe("正在思考…");
    state = sse(state, { type: "sse", event: { type: "meeting.delta", meetingId: "m1", convId: "c1", memberId: "alice", channel: "text", delta: "好" } });
    expect(state.live["c1"]?.activity).toBe("正在输出…");
    state = sse(state, { type: "sse", event: { type: "meeting.activity", meetingId: "m1", convId: "c1", memberId: "alice", kind: "tool", phase: "start", name: "shell" } });
    expect(state.live["c1"]?.activity).toBe("正在执行 shell…");
    // 工具仍在跑：思考增量不改状态行（工具优先）
    state = sse(state, { type: "sse", event: { type: "meeting.delta", meetingId: "m1", convId: "c1", memberId: "alice", channel: "thinking", delta: "再" } });
    expect(state.live["c1"]?.activity).toBe("正在执行 shell…");
  });

  it("状态行真实体现工具阶段：准备调用（参数流）→ 执行（带参数提示）→ 并行 → 结束回思考", () => {
    let state = inMeeting();
    state = sse(state, { type: "sse", event: { type: "meeting.activity", meetingId: "m1", convId: "c1", memberId: "alice", kind: "toolCall", phase: "start", name: "bash" } });
    expect(state.live["c1"]?.activity).toBe("正在准备调用 bash…");
    expect(state.live["c1"]?.tools).toEqual([]);

    state = sse(state, { type: "sse", event: { type: "meeting.activity", meetingId: "m1", convId: "c1", memberId: "alice", kind: "tool", phase: "start", name: "bash", hint: "sleep 1.5; echo done" } });
    expect(state.live["c1"]?.activity).toBe("正在执行 bash：sleep 1.5; echo done");

    state = sse(state, { type: "sse", event: { type: "meeting.activity", meetingId: "m1", convId: "c1", memberId: "alice", kind: "tool", phase: "start", name: "read", hint: "a.md" } });
    expect(state.live["c1"]?.activity).toBe("正在执行 2 个工具：bash、read");

    // 后开始的先结束：按名字移除，不误删另一个
    state = sse(state, { type: "sse", event: { type: "meeting.activity", meetingId: "m1", convId: "c1", memberId: "alice", kind: "tool", phase: "end", name: "read" } });
    expect(state.live["c1"]?.tools.map((tool) => tool.name)).toEqual(["bash"]);
    expect(state.live["c1"]?.activity).toBe("正在执行 bash：sleep 1.5; echo done");

    state = sse(state, { type: "sse", event: { type: "meeting.activity", meetingId: "m1", convId: "c1", memberId: "alice", kind: "tool", phase: "end", name: "bash" } });
    expect(state.live["c1"]?.activity).toBe("已完成 bash");
    state = sse(state, { type: "sse", event: { type: "meeting.delta", meetingId: "m1", convId: "c1", memberId: "alice", channel: "thinking", delta: "下" } });
    expect(state.live["c1"]?.activity).toBe("正在思考…");
  });

  it("工具真在跑时，「准备调用」不抢状态行（以执行真相为准）", () => {
    let state = inMeeting();
    state = sse(state, { type: "sse", event: { type: "meeting.activity", meetingId: "m1", convId: "c1", memberId: "alice", kind: "tool", phase: "start", name: "bash", hint: "ls" } });
    state = sse(state, { type: "sse", event: { type: "meeting.activity", meetingId: "m1", convId: "c1", memberId: "alice", kind: "toolCall", phase: "start", name: "read" } });
    expect(state.live["c1"]?.activity).toBe("正在执行 bash：ls");
  });

  it("run end 清掉残留的流式气泡（中断后不留幽灵）；错误气泡保留", () => {
    let state = inMeeting();
    state = sse(state, { type: "sse", event: { type: "meeting.delta", meetingId: "m1", convId: "c1", memberId: "alice", channel: "text", delta: "说到一半" } });
    expect(state.live["c1"]?.text).toBe("说到一半");
    state = sse(state, { type: "sse", event: { type: "meeting.activity", meetingId: "m1", convId: "c1", memberId: "alice", kind: "run", phase: "end" } });
    expect(state.live["c1"]).toBeUndefined();

    let failed = inMeeting();
    failed = sse(failed, { type: "sse", event: { type: "meeting.failed", meetingId: "m1", convId: "c1", memberId: "alice", message: "模型不可用", kind: "model" } });
    failed = sse(failed, { type: "sse", event: { type: "meeting.activity", meetingId: "m1", convId: "c1", memberId: "alice", kind: "run", phase: "end" } });
    expect(failed.live["c1"]?.error).toBe("模型不可用");
  });

  it("meeting.failed 的错误提示在新一轮增量 / run 开始时清除（重试不被旧错误遮蔽）", () => {
    let state = inMeeting();
    state = sse(state, { type: "sse", event: { type: "meeting.failed", meetingId: "m1", convId: "c1", memberId: "alice", message: "模型超时" } });
    expect(state.live["c1"]?.error).toBe("模型超时");

    state = sse(state, { type: "sse", event: { type: "meeting.delta", meetingId: "m1", convId: "c1", memberId: "alice", channel: "text", delta: "重" } });
    expect(state.live["c1"]?.error).toBeUndefined();
    expect(state.live["c1"]?.text).toBe("重");

    state = sse(state, { type: "sse", event: { type: "meeting.failed", meetingId: "m1", convId: "c1", memberId: "alice", message: "模型超时" } });
    expect(state.live["c1"]?.error).toBe("模型超时");
    state = sse(state, { type: "sse", event: { type: "meeting.activity", meetingId: "m1", convId: "c1", memberId: "alice", kind: "run", phase: "start" } });
    expect(state.live["c1"]?.error).toBeUndefined();

    // 没有 live 的会话：run 开始要**建出**进行中气泡（转圈 + 状态行）
    state = sse(state, { type: "sse", event: { type: "meeting.activity", meetingId: "m1", convId: "c9", memberId: "alice", kind: "run", phase: "start" } });
    expect(state.live["c9"]?.activity).toBe("正在思考…");
    state = sse(state, { type: "sse", event: { type: "meeting.activity", meetingId: "m1", convId: "c9", memberId: "alice", kind: "run", phase: "end" } });
    expect(state.live["c9"]).toBeUndefined();
  });

  it("去重命中 / 跨会议消息返回同一 state 引用（上层据此短路，避免无谓重建）", () => {
    let state = inMeeting();
    state = sse(state, { type: "sse", event: { type: "meeting.message", meetingId: "m1", message: msg("10", "boss", "任务", "rm_1") } });
    const before = state;
    const duplicate = sse(state, { type: "sse", event: { type: "meeting.message", meetingId: "m1", message: msg("10", "boss", "任务", "rm_1") } });
    expect(duplicate).toBe(before);
    const crossMeeting = sse(state, { type: "sse", event: { type: "meeting.message", meetingId: "m9", message: msg("30", "employee", "别处") } });
    expect(crossMeeting).toBe(before);
  });

  it("pin 标记：meeting 事件带入 pinned 集合；pin 事件按主题更新高亮与红点", () => {
    let state = reduce(inMeeting(), { type: "meeting", meetingId: "m1", meeting, messages: [], pinned: ["store:10"] });
    expect(state.pinned).toEqual(["store:10"]);

    state = reduce(state, { type: "pin", meetingId: "m1", key: "store:11", pinned: true });
    expect(state.pinned).toEqual(["store:10", "store:11"]);
    expect(state.pins["dm:alice"]).toBe(2);

    state = reduce(state, { type: "pin", meetingId: "m1", key: "store:10", pinned: false });
    expect(state.pinned).toEqual(["store:11"]);
    expect(state.pins["dm:alice"]).toBe(1);

    // 非当前会议的 pin：只更新消息区高亮之外的红点（本页高亮不动）→ 完全忽略
    const cross = reduce(state, { type: "pin", meetingId: "m9", key: "store:1", pinned: true });
    expect(cross).toBe(state);

    // 全量刷新（进入页面 / 重连补齐）：键是主题
    state = reduce(state, { type: "pins", pins: { total: 1, subjects: { "dm:alice": 1 } } });
    expect(state.pins).toEqual({ "dm:alice": 1 });

    // 离开会议清空 pinned
    state = reduce(state, { type: "close-meeting" });
    expect(state.pinned).toEqual([]);
  });

  it("待发队列：入队追加（去重）、出队移除；非当前会议不污染；换会议重取", () => {
    let state = inMeeting();
    state = sse(state, { type: "sse", event: { type: "meeting.queued", item: queuedItem } });
    expect(state.queued.map((q) => q.submissionId)).toEqual(["11"]);
    const before = state;
    expect(sse(state, { type: "sse", event: { type: "meeting.queued", item: queuedItem } })).toBe(before);
    state = sse(state, { type: "sse", event: { type: "meeting.queued", item: { ...queuedItem, submissionId: "12", text: "再问" } } });
    expect(state.queued.map((q) => q.text)).toEqual(["在吗", "再问"]);
    // 别处的排队：不污染当前会议
    const cross = sse(state, { type: "sse", event: { type: "meeting.queued", item: { ...queuedItem, meetingId: "m9" } } });
    expect(cross).toBe(state);
    // 出队：按 submissionId 移除
    state = sse(state, { type: "sse", event: { type: "meeting.dequeued", meetingId: "m1", submissionId: "11", reason: "delivered" } });
    expect(state.queued.map((q) => q.submissionId)).toEqual(["12"]);
    // 出队一个不存在的：同一引用（不触发重建）
    expect(sse(state, { type: "sse", event: { type: "meeting.dequeued", meetingId: "m1", submissionId: "999", reason: "delivered" } })).toBe(state);
    // 换会议带入排队态；离开会议清空
    state = reduce(state, {
      type: "meeting",
      meetingId: "m2",
      meeting: { ...meeting, meetingId: "m2" },
      messages: [],
      pinned: [],
      queued: [{ ...queuedItem, meetingId: "m2" }],
    });
    expect(state.queued.map((q) => q.meetingId)).toEqual(["m2"]);
    expect(reduce(state, { type: "close-meeting" }).queued).toEqual([]);
  });

  it("sessions 事件只更新当前会议；别的会议的结果丢弃", () => {
    const session = { memberId: "alice", convId: "c1", model: "faux/x", thinkingLevel: "off", contextUsed: 10 };
    const state = reduce(inMeeting(), { type: "sessions", meetingId: "m1", sessions: [session] });
    expect(state.sessions).toEqual([session]);
    expect(reduce(state, { type: "sessions", meetingId: "m9", sessions: [] })).toBe(state);
  });

  it("title：只改对得上的会议；别的会议 / 未命中时返回同一引用", () => {
    const base = inMeeting();
    const updated = reduce(base, { type: "title", meetingId: "m1", title: "登录排查（改）" });
    expect(updated.meeting?.title).toBe("登录排查（改）");
    expect(updated.meetings[0]!.title).toBe("登录排查（改）");

    expect(reduce(base, { type: "title", meetingId: "m9", title: "X" })).toBe(base);

    // SSE 同口径
    const viaSse = sse(base, { type: "sse", event: { type: "meeting.title", meetingId: "m1", title: "周报整理" } });
    expect(viaSse.meeting?.title).toBe("周报整理");
  });

  it("close-meeting：清空主题 / 会议 / 消息 / 标志", () => {
    const state = reduce(inMeeting({ messages: [msg("1", "boss", "hi")], pinned: ["store:1"] }), { type: "close-meeting" });
    expect(state.subjectKey).toBeUndefined();
    expect(state.meetingId).toBeUndefined();
    expect(state.meeting).toBeUndefined();
    expect(state.meetings).toEqual([]);
    expect(state.messages).toEqual([]);
    expect(state.pinned).toEqual([]);
    expect(state.freshMeeting).toBe(false);
  });

  it("授权请求：全量替换、SSE 同 id 原地更新（合并后的权限要出现在同一张卡上）、busy/error 与本地移除", () => {
    const request = { id: "pr_1", agentId: "alice", meetingId: "m1", tools: ["write"], paths: ["/x"], reason: "r", createdAt: "t", agentName: "爱丽丝", where: "私聊 · 爱丽丝" };
    let state = inMeeting();
    state = reduce(state, { type: "permissions", list: [request] });
    expect(state.permissionRequests).toHaveLength(1);

    // 同 id = 服务端把同目录的新权限并进了已有请求：原地更新，不能忽略
    state = sse(state, { type: "sse", event: { type: "permission.request", request: { ...request, tools: ["write", "read"] } } });
    expect(state.permissionRequests).toHaveLength(1);
    expect(state.permissionRequests[0]!.tools).toEqual(["write", "read"]);

    const second = { ...request, id: "pr_2" };
    state = sse(state, { type: "sse", event: { type: "permission.request", request: second } });
    expect(state.permissionRequests.map((r) => r.id)).toEqual(["pr_2", "pr_1"]); // 新的在前

    state = reduce(state, { type: "permission-busy", id: "pr_2", busy: true });
    expect(state.permissionRequests[0]!.busy).toBe(true);
    state = reduce(state, { type: "permission-error", id: "pr_2", error: "写盘失败" });
    expect(state.permissionRequests[0]!.error).toBe("写盘失败");

    state = sse(state, { type: "sse", event: { type: "permission.resolved", id: "pr_1" } });
    expect(state.permissionRequests.map((r) => r.id)).toEqual(["pr_2"]);
    state = reduce(state, { type: "permission-resolved", id: "pr_2" });
    expect(state.permissionRequests).toEqual([]);
  });

  const ORG = {
    path: "",
    name: "办公室",
    people: [{ id: "staff0", model: "faux/faux-model" }],
    departments: [
      {
        path: "eng",
        name: "研发",
        people: [{ id: "alice", alias: "爱丽丝", model: "faux/x" }],
        departments: [{ path: "eng/platform", name: "平台", people: [{ id: "bob", model: "faux/y" }], departments: [] }],
      },
    ],
  };

  it("org 事件：喂树 + 拍平 employees（DFS 顺序）", () => {
    const state = reduce(initialState, { type: "org", root: ORG });
    expect(state.org).toEqual(ORG);
    expect(state.employees.map((e) => e.id)).toEqual(["staff0", "alice", "bob"]);
  });

  it("toggle-dept：可折叠可展开（幂等）", () => {
    let state = reduce(initialState, { type: "toggle-dept", path: "eng" });
    expect(state.collapsedDepts).toEqual(["eng"]);
    state = reduce(state, { type: "toggle-dept", path: "eng/platform" });
    expect(state.collapsedDepts).toEqual(["eng", "eng/platform"]);
    state = reduce(state, { type: "toggle-dept", path: "eng" });
    expect(state.collapsedDepts).toEqual(["eng/platform"]);
  });
});
