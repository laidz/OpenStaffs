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
  it("sendToSubject：POST 主题入口、键编码、返回解析；newMeeting 透传", async () => {
    const calls = stubFetch({ meetingId: "m1", messageId: "rm_1", meeting: {}, deliveries: [] });
    const result = await api.sendToSubject("dm:alice", "你好", "req-1");
    expect(result.meetingId).toBe("m1");
    expect(calls[0]!.url).toBe("/api/subjects/dm%3Aalice/messages");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ text: "你好", requestId: "req-1", newMeeting: false });

    await api.sendToSubject("group:yt", "重开", "req-2", true);
    expect(calls[1]!.url).toBe("/api/subjects/group%3Ayt/messages");
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ text: "重开", requestId: "req-2", newMeeting: true });
  });

  it("cancelQueued：POST 撤回排队中的消息（会议 + messageId）", async () => {
    const calls = stubFetch({ cancelled: ["sub-1"] });
    const result = await api.cancelQueued("mtg_1", "rm_1");
    expect(result.cancelled).toEqual(["sub-1"]);
    expect(calls[0]!.url).toBe("/api/meetings/mtg_1/queue/cancel");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ messageId: "rm_1" });
  });

  it("错误响应抛 Error（带服务端 message）", async () => {
    stubFetch({ error: "群还没有成员" }, 400);
    await expect(api.sendToSubject("group:yt", "hi", "r")).rejects.toThrow("群还没有成员");
  });

  it("status/subject/messages/pin/pins 的 URL 形状与请求体", async () => {
    const calls = stubFetch({});
    await api.status();
    await api.subject("dm:alice");
    await api.messages("mtg_1");
    await api.pin("mtg_1", "store", "10", true);
    await api.pins();
    expect(calls.map((c) => c.url)).toEqual([
      "/api/status",
      "/api/subjects/dm%3Aalice",
      "/api/meetings/mtg_1/messages",
      "/api/meetings/mtg_1/pin",
      "/api/pins",
    ]);
    expect(calls[3]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[3]!.init?.body))).toEqual({ convId: "store", entryId: "10", pinned: true });
  });

  it("org：GET /api/org", async () => {
    const calls = stubFetch({ root: { path: "", name: "办公室", people: [], departments: [] } });
    await api.org();
    expect(calls[0]!.url).toBe("/api/org");
  });
});
