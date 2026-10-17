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
  it("订阅名单含授权与排队事件：permission / room.queued / room.dequeued 能送达 onEvent", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const events: unknown[] = [];
    const close = connectEvents({ onEvent: (event) => events.push(event), onReconnect: () => {} });

    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe("/api/events");
    expect([...source.listeners.keys()]).toEqual([
      "room.message",
      "room.delta",
      "room.activity",
      "room.failed",
      "room.pins",
      "room.queued",
      "room.dequeued",
      "permission.request",
      "permission.resolved",
      "open",
    ]);

    const request = { id: "pr_1", agentId: "alice", agentName: "爱丽丝", roomKey: "dm:alice", paths: ["/x"], reason: "r", createdAt: "t" };
    source.emit("permission.request", { type: "permission.request", request });
    source.emit("permission.resolved", { type: "permission.resolved", id: "pr_1" });
    const item = { submissionId: "11", roomKey: "dm:alice", memberId: "alice", roomMessageId: "rm_1", text: "在吗" };
    source.emit("room.queued", { type: "room.queued", item });
    source.emit("room.dequeued", { type: "room.dequeued", roomKey: "dm:alice", submissionId: "11", reason: "delivered" });
    expect(events).toEqual([
      { type: "permission.request", request },
      { type: "permission.resolved", id: "pr_1" },
      { type: "room.queued", item },
      { type: "room.dequeued", roomKey: "dm:alice", submissionId: "11", reason: "delivered" },
    ]);
    close();
  });

  it("坏帧忽略、open 触发重连回调、close 关闭连接", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const onEvent = vi.fn();
    const onReconnect = vi.fn();
    const close = connectEvents({ onEvent, onReconnect });
    const source = FakeEventSource.instances[0]!;

    source.emitRaw("room.delta", "{ 坏帧");
    expect(onEvent).not.toHaveBeenCalled();

    source.emitRaw("open", "");
    expect(onReconnect).toHaveBeenCalledTimes(1);

    close();
    expect(source.closed).toBe(true);
  });
});
