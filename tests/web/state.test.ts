import { describe, expect, it } from "vitest";
import { initialState, reduce, selectView, type State } from "../../web/state.ts";
import type { RoomMessage } from "../../src/app/rooms.ts";

function msg(entryId: string, convId: string, kind: "boss" | "employee", text: string, roomMessageId?: string): RoomMessage {
  return kind === "boss"
    ? { convId, entryId, roomKey: "dm:alice", speaker: { kind: "boss" }, text, bossDirected: false, ...(roomMessageId === undefined ? {} : { roomMessageId }) }
    : { convId, entryId, roomKey: "dm:alice", speaker: { kind: "employee", id: "alice" }, text, bossDirected: true };
}

function inRoom(): State {
  let state = reduce(initialState, { type: "status", configured: true, bossName: "老板" });
  state = reduce(state, { type: "room", roomKey: "dm:alice", messages: [], pinned: [] });
  return state;
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

  it("room.message 增量合并：只按消息键去重（幂等）、保持排序；不再按 roomMessageId 去重", () => {
    let state = inRoom();
    state = reduce(state, { type: "sse", event: { type: "room.message", roomKey: "dm:alice", message: msg("10", "store", "boss", "任务", "rm_1") } });
    state = reduce(state, { type: "sse", event: { type: "room.message", roomKey: "dm:alice", message: msg("11", "store", "employee", "回答") } });
    // 重复投递同一条（同键 store:<seq>）：应被忽略
    state = reduce(state, { type: "sse", event: { type: "room.message", roomKey: "dm:alice", message: msg("10", "store", "boss", "任务", "rm_1") } });
    expect(state.messages.map((m) => m.entryId)).toEqual(["10", "11"]);

    // 消息真相已归自有库（一次投递 = 一行 = 唯一键），roomMessageId 只服务「排队中」占位匹配（web/render.ts），
    // 不再是读侧去重依据：键不同就是不同消息。
    state = reduce(state, { type: "sse", event: { type: "room.message", roomKey: "dm:alice", message: msg("12", "store", "boss", "另一条", "rm_1") } });
    expect(state.messages.map((m) => m.entryId)).toEqual(["10", "11", "12"]);
  });

  it("delta 聚合到 live 气泡；员工正式消息到达后清除 live", () => {
    let state = inRoom();
    state = reduce(state, { type: "sse", event: { type: "room.delta", roomKey: "dm:alice", convId: "c1", memberId: "alice", channel: "text", delta: "你" } });
    state = reduce(state, { type: "sse", event: { type: "room.delta", roomKey: "dm:alice", convId: "c1", memberId: "alice", channel: "text", delta: "好" } });
    expect(state.live["c1"]?.text).toBe("你好");
    state = reduce(state, { type: "sse", event: { type: "room.message", roomKey: "dm:alice", message: msg("20", "c1", "employee", "你好") } });
    expect(state.live["c1"]).toBeUndefined();
  });

  it("正式员工消息按**成员**清 live（库行视图的 convId 恒为 store，与 delta 的 Pi convId 不同）", () => {
    // 回归：曾经按 convId 清 live → 删的是 live["store"]，流式气泡永远清不掉，
    // 结果消息末尾留一个截断的残影气泡（看起来像「最后一段内容丢了」）。
    let state = inRoom();
    state = reduce(state, { type: "sse", event: { type: "room.delta", roomKey: "dm:alice", convId: "conv:abc", memberId: "alice", channel: "text", delta: "说一半" } });
    expect(state.live["conv:abc"]?.text).toBe("说一半");
    state = reduce(state, { type: "sse", event: { type: "room.message", roomKey: "dm:alice", message: msg("20", "store", "employee", "说一半说完") } });
    expect(Object.keys(state.live)).toEqual([]);
    expect(state.messages.map((m) => m.text)).toEqual(["说一半说完"]);
  });

  it("群聊并行流式：别人的气泡不被别人的正式消息清掉", () => {
    let state = inRoom();
    state = reduce(state, { type: "sse", event: { type: "room.delta", roomKey: "dm:alice", convId: "conv:alice", memberId: "alice", channel: "text", delta: "a" } });
    state = reduce(state, { type: "sse", event: { type: "room.delta", roomKey: "dm:alice", convId: "conv:bob", memberId: "bob", channel: "text", delta: "b" } });
    state = reduce(state, { type: "sse", event: { type: "room.message", roomKey: "dm:alice", message: msg("20", "store", "employee", "alice 说完") } });
    expect(Object.keys(state.live)).toEqual(["conv:bob"]);
  });

  it("sessions 事件只更新当前房间；切换房间清空（不展示上一个会话的信息）", () => {
    let state = inRoom();
    const info = { memberId: "alice", convId: "c1", model: "faux/faux-model", thinkingLevel: "high", contextUsed: 12800, contextWindow: 128000 };
    state = reduce(state, { type: "sessions", roomKey: "dm:alice", sessions: [info] });
    expect(state.sessions).toEqual([info]);
    // 别的房间的结果不串台
    state = reduce(state, { type: "sessions", roomKey: "dm:bob", sessions: [{ ...info, memberId: "bob" }] });
    expect(state.sessions).toEqual([info]);
    // 切房间先清空，等新房间的数据到达
    state = reduce(state, { type: "room", roomKey: "dm:bob", messages: [], pinned: [] });
    expect(state.sessions).toEqual([]);
  });

  it("R9 重喂已存在的员工消息不误删进行中的 live 气泡（仅真正追加时清 live）", () => {
    let state = inRoom();
    // 第一轮流式回复
    state = reduce(state, { type: "sse", event: { type: "room.delta", roomKey: "dm:alice", convId: "c1", memberId: "alice", channel: "text", delta: "好" } });
    // 正式消息到达（真正追加）→ 本轮结束：清 live
    state = reduce(state, { type: "sse", event: { type: "room.message", roomKey: "dm:alice", message: msg("20", "c1", "employee", "你好") } });
    expect(state.live["c1"]).toBeUndefined();
    // 第二轮流式回复开始
    state = reduce(state, { type: "sse", event: { type: "room.delta", roomKey: "dm:alice", convId: "c1", memberId: "alice", channel: "text", delta: "再" } });
    expect(state.live["c1"]?.text).toBe("再");
    // 老板再发一条触发 R9 重拉重喂：同一条历史消息（同复合键，未追加）→ live 必须保留
    state = reduce(state, { type: "sse", event: { type: "room.message", roomKey: "dm:alice", message: msg("20", "c1", "employee", "你好") } });
    expect(state.messages.map((m) => m.entryId)).toEqual(["20"]);
    expect(state.live["c1"]?.text).toBe("再");
  });

  it("忙绿与工具活动、失败事件", () => {
    let state = inRoom();
    state = reduce(state, { type: "sse", event: { type: "room.activity", roomKey: "dm:alice", convId: "c1", memberId: "alice", kind: "run", phase: "start" } });
    expect(state.busy["alice"]).toBe(true);
    state = reduce(state, { type: "sse", event: { type: "room.activity", roomKey: "dm:alice", convId: "c1", memberId: "alice", kind: "tool", phase: "start", name: "write" } });
    expect(state.live["c1"]?.tools).toEqual(["write"]);
    state = reduce(state, { type: "sse", event: { type: "room.failed", roomKey: "dm:alice", convId: "c1", memberId: "alice", message: "模型不可用" } });
    expect(state.live["c1"]?.error).toBe("模型不可用");
    state = reduce(state, { type: "sse", event: { type: "room.activity", roomKey: "dm:alice", convId: "c1", memberId: "alice", kind: "run", phase: "end" } });
    expect(state.busy["alice"]).toBe(false);
  });

  it("run end 清掉残留的流式气泡（中断后不留幽灵）；错误气泡保留", () => {
    let state = inRoom();
    state = reduce(state, { type: "sse", event: { type: "room.delta", roomKey: "dm:alice", convId: "c1", memberId: "alice", channel: "text", delta: "说到一半" } });
    expect(state.live["c1"]?.text).toBe("说到一半");
    state = reduce(state, { type: "sse", event: { type: "room.activity", roomKey: "dm:alice", convId: "c1", memberId: "alice", kind: "run", phase: "end" } });
    expect(state.live["c1"]).toBeUndefined();

    let failed = inRoom();
    failed = reduce(failed, { type: "sse", event: { type: "room.failed", roomKey: "dm:alice", convId: "c1", memberId: "alice", message: "模型不可用", kind: "model" } });
    failed = reduce(failed, { type: "sse", event: { type: "room.activity", roomKey: "dm:alice", convId: "c1", memberId: "alice", kind: "run", phase: "end" } });
    expect(failed.live["c1"]?.error).toBe("模型不可用");
  });

  it("room.failed 的错误提示在新一轮增量 / run 开始时清除（同一会话重试不被旧错误遮蔽）", () => {
    let state = inRoom();
    state = reduce(state, { type: "sse", event: { type: "room.failed", roomKey: "dm:alice", convId: "c1", memberId: "alice", message: "模型超时" } });
    expect(state.live["c1"]?.error).toBe("模型超时");

    // 重试路径一：增量到达 → 旧错误必须消失，流式文本可见
    state = reduce(state, { type: "sse", event: { type: "room.delta", roomKey: "dm:alice", convId: "c1", memberId: "alice", channel: "text", delta: "重" } });
    expect(state.live["c1"]?.error).toBeUndefined();
    expect(state.live["c1"]?.text).toBe("重");

    // 重试路径二：新一轮 run 开始（尚无增量）→ 旧错误也必须消失
    state = reduce(state, { type: "sse", event: { type: "room.failed", roomKey: "dm:alice", convId: "c1", memberId: "alice", message: "模型超时" } });
    expect(state.live["c1"]?.error).toBe("模型超时");
    state = reduce(state, { type: "sse", event: { type: "room.activity", roomKey: "dm:alice", convId: "c1", memberId: "alice", kind: "run", phase: "start" } });
    expect(state.live["c1"]?.error).toBeUndefined();

    // 没有 live 的会话：run 开始不得凭空造出空气泡
    state = reduce(state, { type: "sse", event: { type: "room.activity", roomKey: "dm:alice", convId: "c9", memberId: "alice", kind: "run", phase: "start" } });
    expect(state.live["c9"]).toBeUndefined();
  });

  it("去重命中 / 跨房间消息返回同一 state 引用（上层据此短路，避免无谓重建）", () => {
    let state = inRoom();
    state = reduce(state, { type: "sse", event: { type: "room.message", roomKey: "dm:alice", message: msg("10", "c1", "boss", "任务", "rm_1") } });
    const before = state;
    const duplicate = reduce(state, { type: "sse", event: { type: "room.message", roomKey: "dm:alice", message: msg("10", "c1", "boss", "任务", "rm_1") } });
    expect(duplicate).toBe(before);
    const crossRoom = reduce(state, { type: "sse", event: { type: "room.message", roomKey: "group:yt", message: msg("30", "cx", "employee", "别处") } });
    expect(crossRoom).toBe(before);
    const crossRoomDelta = reduce(state, { type: "sse", event: { type: "room.delta", roomKey: "group:yt", convId: "cx", memberId: "bob", channel: "text", delta: "x" } });
    expect(crossRoomDelta).toBe(before);
  });

  it("非当前房间事件：只更新忙碌/红点，不污染消息", () => {
    let state = inRoom();
    state = reduce(state, { type: "sse", event: { type: "room.message", roomKey: "group:yt", message: msg("30", "cx", "employee", "别处") } });
    expect(state.messages).toHaveLength(0);
    state = reduce(state, { type: "sse", event: { type: "room.pins", roomKey: "group:yt", count: 2 } });
    expect(state.pins["group:yt"]).toBe(2);
  });

  it("pin 标记：room 事件带入 pinned 集合；pin 事件更新当前房间高亮与红点；room.pins 更新侧栏", () => {
    let state = reduce(initialState, { type: "status", configured: true, bossName: "老板" });
    state = reduce(state, { type: "room", roomKey: "dm:alice", messages: [], pinned: ["c1:10"] });
    expect(state.pinned).toEqual(["c1:10"]);

    state = reduce(state, { type: "pin", roomKey: "dm:alice", key: "c1:11", pinned: true });
    expect(state.pinned).toEqual(["c1:10", "c1:11"]);
    expect(state.pins["dm:alice"]).toBe(2);

    state = reduce(state, { type: "pin", roomKey: "dm:alice", key: "c1:10", pinned: false });
    expect(state.pinned).toEqual(["c1:11"]);
    expect(state.pins["dm:alice"]).toBe(1);

    // 非当前房间的 pin 事件：不污染当前房间高亮
    const cross = reduce(state, { type: "pin", roomKey: "group:yt", key: "c9:1", pinned: true });
    expect(cross.pinned).toEqual(["c1:11"]);

    // 全量刷新（进入页面 / 重连补齐）
    state = reduce(state, { type: "pins", pins: { total: 1, rooms: { "dm:alice": 1 } } });
    expect(state.pins).toEqual({ "dm:alice": 1 });

    // 离开房间清空 pinned
    state = reduce(state, { type: "close-room" });
    expect(state.pinned).toEqual([]);
  });

  it("待发队列：入队追加（去重）、出队移除；非当前房间不污染；换房间重取", () => {
    const item = { submissionId: "11", roomKey: "dm:alice", memberId: "alice", roomMessageId: "rm_1", text: "在吗" };
    let state = inRoom();
    state = reduce(state, { type: "sse", event: { type: "room.queued", item } });
    expect(state.queued.map((q) => q.submissionId)).toEqual(["11"]);
    // 重复投递（重连重拉）：去重，返回同一引用
    const before = state;
    expect(reduce(state, { type: "sse", event: { type: "room.queued", item } })).toBe(before);
    // 第二条按投递顺序追加
    state = reduce(state, { type: "sse", event: { type: "room.queued", item: { ...item, submissionId: "12", text: "再问" } } });
    expect(state.queued.map((q) => q.text)).toEqual(["在吗", "再问"]);
    // 别处的排队：不污染当前房间
    const cross = reduce(state, { type: "sse", event: { type: "room.queued", item: { ...item, roomKey: "group:yt" } } });
    expect(cross).toBe(state);
    // 出队：按 submissionId 移除
    state = reduce(state, { type: "sse", event: { type: "room.dequeued", roomKey: "dm:alice", submissionId: "11", reason: "delivered" } });
    expect(state.queued.map((q) => q.submissionId)).toEqual(["12"]);
    // 出队一个不存在的：同一引用（不触发重建）
    expect(reduce(state, { type: "sse", event: { type: "room.dequeued", roomKey: "dm:alice", submissionId: "999", reason: "delivered" } })).toBe(state);
    // 房间事件带入排队态（刷新 / 换房间）；离开房间清空
    state = reduce(state, { type: "room", roomKey: "group:yt", messages: [], pinned: [], queued: [{ ...item, roomKey: "group:yt" }] });
    expect(state.queued.map((q) => q.roomKey)).toEqual(["group:yt"]);
    expect(reduce(state, { type: "close-room" }).queued).toEqual([]);
  });

  it("「新开会话」标志：切换开关；换房间 / 离开房间清掉（一次一条）", () => {
    let state = inRoom();
    expect(state.freshSession).toBe(false);
    state = reduce(state, { type: "fresh-session", on: true });
    expect(state.freshSession).toBe(true);
    expect(reduce(state, { type: "fresh-session", on: true })).toBe(state); // 幂等：同一引用
    expect(reduce(state, { type: "fresh-session", on: false }).freshSession).toBe(false);
    // 换房间 / 离开房间：标志清零（不会跨房间带过去）
    expect(reduce(reduce(state, { type: "fresh-session", on: true }), { type: "room", roomKey: "group:yt", messages: [], pinned: [] }).freshSession).toBe(false);
    expect(reduce(reduce(state, { type: "fresh-session", on: true }), { type: "close-room" }).freshSession).toBe(false);
  });

  it("room / close-room 状态迁移", () => {
    let state = inRoom();
    state = reduce(state, { type: "room", roomKey: "group:yt", messages: [msg("1", "c1", "boss", "hi")], pinned: ["c1:1"] });
    expect(state.roomKey).toBe("group:yt");
    expect(state.pinned).toEqual(["c1:1"]);
    expect(state.freshSession).toBe(false);
    state = reduce(state, { type: "close-room" });
    expect(state.roomKey).toBeUndefined();
    expect(state.messages).toHaveLength(0);
    expect(state.pinned).toEqual([]);
  });

  it("授权请求：全量替换、SSE 增量去重（新在前）、busy/error 与本地移除", () => {
    const request = { id: "pr_1", agentId: "alice", agentName: "爱丽丝", roomKey: "dm:alice", paths: ["/x"], reason: "r", createdAt: "t" };
    let state = inRoom();
    state = reduce(state, { type: "permissions", list: [request] });
    expect(state.permissionRequests).toHaveLength(1);

    state = reduce(state, { type: "sse", event: { type: "permission.request", request } });
    expect(state.permissionRequests).toHaveLength(1); // 去重

    const second = { ...request, id: "pr_2" };
    state = reduce(state, { type: "sse", event: { type: "permission.request", request: second } });
    expect(state.permissionRequests.map((r) => r.id)).toEqual(["pr_2", "pr_1"]); // 新的在前

    state = reduce(state, { type: "permission-busy", id: "pr_2", busy: true });
    expect(state.permissionRequests[0]!.busy).toBe(true);
    state = reduce(state, { type: "permission-error", id: "pr_2", error: "写盘失败" });
    expect(state.permissionRequests[0]!.error).toBe("写盘失败");

    state = reduce(state, { type: "sse", event: { type: "permission.resolved", id: "pr_1" } });
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
