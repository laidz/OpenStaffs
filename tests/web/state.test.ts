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
  state = reduce(state, { type: "room", roomKey: "dm:alice", messages: [] });
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

  it("room.message 增量合并：幂等（复合键/roomMessageId 双去重）、保持排序", () => {
    let state = inRoom();
    state = reduce(state, { type: "sse", event: { type: "room.message", roomKey: "dm:alice", message: msg("10", "c1", "boss", "任务", "rm_1") } });
    state = reduce(state, { type: "sse", event: { type: "room.message", roomKey: "dm:alice", message: msg("11", "c1", "employee", "回答") } });
    // 重复投递：应被忽略
    state = reduce(state, { type: "sse", event: { type: "room.message", roomKey: "dm:alice", message: msg("10", "c1", "boss", "任务", "rm_1") } });
    // 其他成员会话的同一次多投递副本：也应被忽略（roomMessageId 已见）
    state = reduce(state, { type: "sse", event: { type: "room.message", roomKey: "dm:alice", message: msg("12", "c2", "boss", "任务", "rm_1") } });
    expect(state.messages.map((m) => m.entryId)).toEqual(["10", "11"]);
  });

  it("delta 聚合到 live 气泡；员工正式消息到达后清除 live", () => {
    let state = inRoom();
    state = reduce(state, { type: "sse", event: { type: "room.delta", roomKey: "dm:alice", convId: "c1", memberId: "alice", channel: "text", delta: "你" } });
    state = reduce(state, { type: "sse", event: { type: "room.delta", roomKey: "dm:alice", convId: "c1", memberId: "alice", channel: "text", delta: "好" } });
    expect(state.live["c1"]?.text).toBe("你好");
    state = reduce(state, { type: "sse", event: { type: "room.message", roomKey: "dm:alice", message: msg("20", "c1", "employee", "你好") } });
    expect(state.live["c1"]).toBeUndefined();
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

  it("非当前房间事件：只更新忙碌/未读，不污染消息", () => {
    let state = inRoom();
    state = reduce(state, { type: "sse", event: { type: "room.message", roomKey: "group:yt", message: msg("30", "cx", "employee", "别处") } });
    expect(state.messages).toHaveLength(0);
    state = reduce(state, { type: "sse", event: { type: "room.unread", roomKey: "group:yt", count: 2 } });
    expect(state.unread["group:yt"]).toBe(2);
  });

  it("room / close-room / unread / panel 状态迁移", () => {
    let state = inRoom();
    state = reduce(state, { type: "panel", panel: "history" });
    expect(state.panel).toBe("history");
    state = reduce(state, { type: "room", roomKey: "group:yt", messages: [msg("1", "c1", "boss", "hi")] });
    expect(state.roomKey).toBe("group:yt");
    expect(state.panel).toBeUndefined();
    state = reduce(state, { type: "close-room" });
    expect(state.roomKey).toBeUndefined();
    expect(state.messages).toHaveLength(0);
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
});
