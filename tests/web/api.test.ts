import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../web/api.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(body: unknown, status = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  return calls;
}

describe("前端 API 封装", () => {
  it("send：POST JSON、roomKey 编码、返回解析；newSession 透传", async () => {
    const calls = stubFetch({ roomMessageId: "rm_1", deliveries: [] });
    const result = await api.send("dm:alice", "你好", "req-1");
    expect(result.roomMessageId).toBe("rm_1");
    expect(calls[0]!.url).toBe("/api/rooms/dm%3Aalice/messages");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ text: "你好", requestId: "req-1", newSession: false });

    await api.send("dm:alice", "重开", "req-2", true);
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ text: "重开", requestId: "req-2", newSession: true });
  });

  it("cancelQueued：POST 撤回排队中的消息（按 roomMessageId）", async () => {
    const calls = stubFetch({ cancelled: ["sub-1"] });
    const result = await api.cancelQueued("group:yt", "rm_1");
    expect(result.cancelled).toEqual(["sub-1"]);
    expect(calls[0]!.url).toBe("/api/rooms/group%3Ayt/queue/cancel");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ roomMessageId: "rm_1" });
  });

  it("错误响应抛 Error（带服务端 message）", async () => {
    stubFetch({ error: "群还没有成员" }, 400);
    await expect(api.send("group:yt", "hi", "r")).rejects.toThrow("群还没有成员");
  });

  it("status/messages/pin/pins 的 URL 形状与请求体", async () => {
    const calls = stubFetch({});
    await api.status();
    await api.messages("group:yt");
    await api.pin("dm:alice", "c1", "10", true);
    await api.pins();
    expect(calls.map((c) => c.url)).toEqual([
      "/api/status",
      "/api/rooms/group%3Ayt/messages",
      "/api/rooms/dm%3Aalice/pin",
      "/api/pins",
    ]);
    expect(calls[2]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[2]!.init?.body))).toEqual({ convId: "c1", entryId: "10", pinned: true });
  });

  it("org：GET /api/org", async () => {
    const calls = stubFetch({ root: { path: "", name: "办公室", people: [], departments: [] } });
    await api.org();
    expect(calls[0]!.url).toBe("/api/org");
  });
});
