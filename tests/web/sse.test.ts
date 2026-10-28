import { afterEach, describe, expect, it, vi } from "vitest";
import { connectEvents } from "../../web/sse.ts";

type Handler = (event: { data: string }) => void;

/** 最小 EventSource 替身：记录订阅名单并可按事件名派发（供 connectEvents 行为测试）。 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Handler[]>();
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: Handler): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: unknown): void {
    this.emitRaw(type, JSON.stringify(data));
  }

  emitRaw(type: string, data: string): void {
    for (const handler of this.listeners.get(type) ?? []) handler({ data });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

describe("SSE 订阅", () => {
  it("订阅名单 = 服务端广播的全部事件名（meeting.* / permission.*），不含已退役的 room.*", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const events: unknown[] = [];
    const close = connectEvents({ onEvent: (event) => events.push(event), onReconnect: () => {} });

    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe("/api/events");
    // 回归：曾经订阅的还是 room.* / session.title → 服务端发 meeting.* 全部落空，
    // 员工回复、流式增量、排队态、标题更新都进不了聊天框（只有手动发消息触发重拉才看得到历史）。
    expect([...source.listeners.keys()]).toEqual([
      "meeting.message",
      "meeting.delta",
      "meeting.activity",
      "meeting.failed",
      "meeting.pins",
      "meeting.queued",
      "meeting.dequeued",
      "permission.request",
      "permission.resolved",
      "meeting.title",
      "meeting.deleted",
      "open",
    ]);
    expect([...source.listeners.keys()].some((type) => type.startsWith("room."))).toBe(false);

    const request = { id: "pr_1", agentId: "alice", meetingId: "m1", paths: ["/x"], reason: "r", createdAt: "t", agentName: "爱丽丝", where: "私聊 · 爱丽丝" };
    source.emit("permission.request", { type: "permission.request", request });
    source.emit("permission.resolved", { type: "permission.resolved", id: "pr_1" });
    const item = { submissionId: "11", meetingId: "m1", memberId: "alice", messageId: "rm_1", text: "在吗" };
    source.emit("meeting.queued", { type: "meeting.queued", item });
    source.emit("meeting.dequeued", { type: "meeting.dequeued", meetingId: "m1", submissionId: "11", reason: "delivered" });
    source.emit("meeting.message", {
      type: "meeting.message",
      meetingId: "m1",
      message: { convId: "store", entryId: "1", speaker: { kind: "employee", id: "alice" }, text: "在", bossDirected: true },
    });
    source.emit("meeting.title", { type: "meeting.title", meetingId: "m1", title: "登录排查" });
    source.emit("meeting.deleted", { type: "meeting.deleted", meetingId: "m1", subjectKey: "dm:alice" });
    expect(events).toHaveLength(7);
    expect(events.map((event) => (event as { type: string }).type)).toEqual([
      "permission.request",
      "permission.resolved",
      "meeting.queued",
      "meeting.dequeued",
      "meeting.message",
      "meeting.title",
      "meeting.deleted",
    ]);
    close();
  });

  it("坏帧忽略、open 触发重连回调、close 关闭连接", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const onEvent = vi.fn();
    const onReconnect = vi.fn();
    const close = connectEvents({ onEvent, onReconnect });
    const source = FakeEventSource.instances[0]!;

    source.emitRaw("meeting.delta", "{ 坏帧");
    expect(onEvent).not.toHaveBeenCalled();

    source.emitRaw("open", "");
    expect(onReconnect).toHaveBeenCalledTimes(1);

    close();
    expect(source.closed).toBe(true);
  });
});
