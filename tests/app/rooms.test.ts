import { describe, expect, it } from "vitest";
import { countUnread, mergeRoomMessages, normalizeChatMessage, parseRoomKey, roomKeyOf, type MemberTranscript } from "../../src/app/rooms.ts";
import type { ChatMessage } from "../../src/harness/port.ts";

function chat(id: string, role: "user" | "assistant", text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role, text, ...extra };
}

describe("房间合并视图", () => {
  it("roomKeyOf / parseRoomKey 往返与非法键", () => {
    expect(roomKeyOf({ kind: "dm", employeeId: "alice" })).toBe("dm:alice");
    expect(roomKeyOf({ kind: "group", project: "demo" })).toBe("group:demo");
    expect(parseRoomKey("dm:alice")).toEqual({ kind: "dm", employeeId: "alice" });
    expect(parseRoomKey("group:demo")).toEqual({ kind: "group", project: "demo" });
    expect(parseRoomKey("dm:")).toBeUndefined();
    expect(parseRoomKey("bogus")).toBeUndefined();
  });

  it("parseRoomKey 安全校验：拒绝路径穿越与非法 id，正常 id 不受影响", () => {
    for (const key of [
      "dm:../etc",
      "dm:a/b",
      "dm:.",
      "dm:..",
      "dm:.hidden",
      "group:a\\b",
      "group:../../..",
      "dm:a b",
      "dm:a\0b",
      "dm:",
      "group:",
    ]) {
      expect(parseRoomKey(key)).toBeUndefined();
    }
    expect(parseRoomKey("dm:alice")).toEqual({ kind: "dm", employeeId: "alice" });
    expect(parseRoomKey("group:demo")).toEqual({ kind: "group", project: "demo" });
  });

  it("按 entryId 数值升序合并各成员会话", () => {
    const members: MemberTranscript[] = [
      {
        memberId: "bob", convId: "c2",
        messages: [chat("20", "assistant", "bob 答")],
      },
      {
        memberId: "alice", alias: "Alice", convId: "c1",
        messages: [
          chat("10", "user", "任务", { kind: "chat.message", data: { author: "boss", roomMessageId: "rm_1" } }),
          chat("30", "assistant", "alice 答"),
        ],
      },
    ];
    const merged = mergeRoomMessages("group:demo", members);
    expect(merged.map((m) => m.entryId)).toEqual(["10", "20", "30"]);
    expect(merged[0]!.speaker).toEqual({ kind: "boss" });
    expect(merged[1]!.speaker).toEqual({ kind: "employee", id: "bob" });
    expect(merged[2]!.speaker).toEqual({ kind: "employee", id: "alice", alias: "Alice" });
  });

  it("老板广播消息按 roomMessageId 去重取最小 entryId；无 roomMessageId 的不去重", () => {
    const members: MemberTranscript[] = [
      { memberId: "alice", convId: "c1", messages: [chat("15", "user", "广播", { kind: "chat.message", data: { author: "boss", roomMessageId: "rm_x" } })] },
      { memberId: "bob", convId: "c2", messages: [chat("16", "user", "广播", { kind: "chat.message", data: { author: "boss", roomMessageId: "rm_x" } })] },
    ];
    const merged = mergeRoomMessages("group:demo", members);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.entryId).toBe("15");

    const plain = mergeRoomMessages("dm:alice", [
      { memberId: "alice", convId: "c1", messages: [chat("1", "user", "甲", { kind: "pi.user" }), chat("2", "user", "乙", { kind: "pi.user" })] },
    ]);
    expect(plain).toHaveLength(2);
  });

  it("合成条目（pi.compaction / pi.reset）不显示为老板发言，正常 chat.message 保留", () => {
    const merged = mergeRoomMessages("group:demo", [
      { memberId: "alice", convId: "c1", messages: [
        chat("3", "user", "压缩摘要", { kind: "pi.compaction" }),
        chat("4", "user", "会话重置", { kind: "pi.reset" }),
        chat("5", "user", "老板问", { kind: "chat.message", data: { author: "boss" } }),
        chat("6", "assistant", "员工答"),
      ] },
    ]);
    expect(merged.map((m) => m.entryId)).toEqual(["5", "6"]);
    expect(merged[0]!.speaker).toEqual({ kind: "boss" });
    expect(merged[1]!.speaker).toEqual({ kind: "employee", id: "alice" });
  });

  it("countUnread：watermark 之后的员工消息计数，老板消息不计", () => {
    const members: MemberTranscript[] = [
      { memberId: "alice", convId: "c1", messages: [
        chat("5", "assistant", "旧回答"),
        chat("10", "user", "老板问", { kind: "chat.message", data: { author: "boss", roomMessageId: "rm_1" } }),
        chat("11", "assistant", "新回答"),
        chat("12", "assistant", "再答"),
      ] },
    ];
    const merged = mergeRoomMessages("dm:alice", members);
    expect(countUnread(merged, undefined)).toBe(3);
    expect(countUnread(merged, 10)).toBe(2);
    expect(countUnread(merged, 12)).toBe(0);
  });

  it("空输入、空会话不产生消息", () => {
    expect(mergeRoomMessages("dm:alice", [])).toEqual([]);
    expect(normalizeChatMessage("dm:alice", { memberId: "alice", convId: "c1", messages: [] }, chat("1", "assistant", ""))).toEqual({
      convId: "c1", entryId: "1", roomKey: "dm:alice", speaker: { kind: "employee", id: "alice" }, text: "",
    });
  });
});
