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

  it("老板多投递消息按 roomMessageId 去重取最小 entryId；无 roomMessageId 的不去重", () => {
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

  it("员工主动发言 / 工具投递（历史形态 user + data.author = 员工 id）归属该员工，而非老板（向后兼容）", () => {
    const merged = mergeRoomMessages("group:demo", [
      { memberId: "alice", convId: "c1", messages: [
        chat("7", "user", "我主动汇报", { kind: "chat.message", data: { author: "alice" } }),
      ] },
      { memberId: "bob", convId: "c2", messages: [
        chat("8", "user", "alice 对 bob 说", { kind: "chat.message", data: { author: "alice" } }),
      ] },
    ]);
    expect(merged.map((m) => m.speaker)).toEqual([
      { kind: "employee", id: "alice" },
      { kind: "employee", id: "alice" },
    ]);
  });

  it("员工主动发言（新形态 assistant + chat.message）归属该员工；私聊原样、群聊没写 @ 视为发给老板", () => {
    const alice: MemberTranscript = { memberId: "alice", convId: "c1", messages: [] };
    const posted = chat("9", "assistant", "我主动汇报", { kind: "chat.message", data: { author: "alice" } });

    const dm = normalizeChatMessage("dm:alice", alice, posted, []);
    expect(dm?.speaker).toEqual({ kind: "employee", id: "alice" });
    expect(dm?.text).toBe("我主动汇报");
    expect(dm?.bossDirected).toBe(true);

    const group = normalizeChatMessage("group:demo", alice, posted, ["alice", "bob"]);
    expect(group?.speaker).toEqual({ kind: "employee", id: "alice" });
    expect(group?.text).toBe("@老板 我主动汇报");
    expect(group?.bossDirected).toBe(true);

    const directed = normalizeChatMessage("group:demo", alice, chat("10", "assistant", "@bob 帮我看", { kind: "chat.message", data: { author: "alice" } }), ["alice", "bob"]);
    expect(directed?.text).toBe("@bob 帮我看");
    expect(directed?.bossDirected).toBe(false);
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
      convId: "c1", entryId: "1", roomKey: "dm:alice", speaker: { kind: "employee", id: "alice" }, text: "", bossDirected: true,
    });
  });
});

describe("群聊 @前缀约定（历史整洁 + 待办口径）", () => {
  const memberIds = ["alice", "bob"];
  const alice: MemberTranscript = { memberId: "alice", convId: "c1", messages: [] };

  it("群回复没以 @ 开头 → 显示层补 @老板，且计为给老板", () => {
    const m = normalizeChatMessage("group:demo", alice, chat("9", "assistant", "好的，已完成"), memberIds);
    expect(m?.text).toBe("@老板 好的，已完成");
    expect(m?.bossDirected).toBe(true);
  });

  it("以 @成员 开头 → 原样保留，不算给老板", () => {
    const m = normalizeChatMessage("group:demo", alice, chat("9", "assistant", "@bob 请评审"), memberIds);
    expect(m?.text).toBe("@bob 请评审");
    expect(m?.bossDirected).toBe(false);
  });

  it("显式 @老板（含与成员并列）→ 计入给老板", () => {
    expect(normalizeChatMessage("group:demo", alice, chat("9", "assistant", "@老板 汇报：已完成"), memberIds)?.bossDirected).toBe(true);
    expect(normalizeChatMessage("group:demo", alice, chat("9", "assistant", "@bob @老板 请同步"), memberIds)?.bossDirected).toBe(true);
  });

  it("开头 @ 了但解析不出有效对象（写错 id / 标点粘连 / 只 @ 自己 / 只有 @ 没正文）→ 同样视为发给老板", () => {
    for (const text of ["@alice，你好", "@ghost 你好", "@所有人 注意", "@alice 备忘", "@bob"]) {
      const m = normalizeChatMessage("group:demo", alice, chat("9", "assistant", text), memberIds);
      expect(m?.text).toBe(`@老板 ${text}`);
      expect(m?.bossDirected).toBe(true);
    }
  });

  it("正文中/尾的 @老板 不算（只认前缀块）", () => {
    expect(normalizeChatMessage("group:demo", alice, chat("9", "assistant", "@bob 请转告 @老板"), memberIds)?.bossDirected).toBe(false);
    expect(normalizeChatMessage("group:demo", alice, chat("9", "assistant", "已汇报 @老板"), memberIds)?.text).toBe("@老板 已汇报 @老板");
  });

  it("私聊：不补 @老板，但一律计为给老板", () => {
    const m = normalizeChatMessage("dm:alice", alice, chat("9", "assistant", "好的"));
    expect(m?.text).toBe("好的");
    expect(m?.bossDirected).toBe(true);
  });

  it("群聊红点口径：只统计给老板的消息（成员互聊不点）", () => {
    const merged = mergeRoomMessages(
      "group:demo",
      [
        { memberId: "alice", convId: "c1", messages: [
          chat("10", "assistant", "@bob 请评审"),
          chat("11", "assistant", "好的，已完成"),
          chat("12", "assistant", "@老板 汇报：已提交"),
        ] },
      ],
      memberIds,
    );
    expect(countUnread(merged, undefined)).toBe(2);
    expect(countUnread(merged, 11)).toBe(1);
  });
});
