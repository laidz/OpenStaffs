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
  it("send：POST JSON、roomKey 编码、返回解析", async () => {
    const calls = stubFetch({ roomMessageId: "rm_1", deliveries: [] });
    const result = await api.send("dm:alice", "你好", "req-1");
    expect(result.roomMessageId).toBe("rm_1");
    expect(calls[0]!.url).toBe("/api/rooms/dm%3Aalice/messages");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ text: "你好", requestId: "req-1" });
  });

  it("错误响应抛 Error（带服务端 message）", async () => {
    stubFetch({ error: "群还没有成员" }, 400);
    await expect(api.send("group:yt", "hi", "r")).rejects.toThrow("群还没有成员");
  });

  it("status/messages/read/unread 的 URL 形状", async () => {
    const calls = stubFetch({});
    await api.status();
    await api.messages("group:yt");
    await api.read("dm:alice");
    await api.unread();
    expect(calls.map((c) => c.url)).toEqual([
      "/api/status",
      "/api/rooms/group%3Ayt/messages",
      "/api/rooms/dm%3Aalice/read",
      "/api/unread",
    ]);
  });
});
