import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeChatMessage, parseRoomKey, roomKeyOf, roomMessagesOfTranscript, toRoomMessage, type MemberTranscript } from "../../src/app/rooms.ts";
import { createWorkspace } from "../../src/domain/paths.ts";
import type { StoredMessage } from "../../src/store/row.ts";
import type { ChatMessage } from "../../src/harness/port.ts";

function chat(id: string, role: "user" | "assistant", text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role, text, ...extra };
}

/** 库行夹具（默认 dm:alice 的老板一句）；toRoomMessage 的用例可覆盖任意字段。 */
function stored(over: Partial<StoredMessage>): StoredMessage {
  return {
    id: "m_1", seq: 1, sendTime: "2026-10-19T00:00:00.000Z", room: "dm:alice",
    projectId: null, fromId: "__boss", toIds: ["alice"], text: "你好", ...over,
  };
}

// toRoomMessage 要解析员工 alias：造一个最小工作区（alice 有 alias）。
const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-rooms-"));
fs.mkdirSync(path.join(wsRoot, "agents"), { recursive: true });
fs.writeFileSync(path.join(wsRoot, "agents", "alice.agent.config.json"), JSON.stringify({ prompt: "你是 alice。", alias: "Alice" }));
const ws = createWorkspace(wsRoot);
afterEach(() => fs.rmSync(path.join(wsRoot, "openstaffs/.data"), { recursive: true, force: true }));

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

  it("toRoomMessage：库里行还原为房间消息（键 store:<seq>、说话人、不带 roomMessageId）", () => {
    const boss = toRoomMessage(stored({ seq: 1, fromId: "__boss", toIds: ["alice"], text: "任务" }), "老板", ws);
    expect(boss).toMatchObject({
      convId: "store", entryId: "1", roomKey: "dm:alice", speaker: { kind: "boss" }, text: "任务", bossDirected: true,
    });
    // 自库来源不带 roomMessageId（那是「排队中」由 outbox/SSE 单独携带的 UI 概念）。
    expect(boss.roomMessageId).toBeUndefined();

    const reply = toRoomMessage(stored({ seq: 2, fromId: "alice", toIds: ["__boss"], text: "alice 答" }), "老板", ws);
    expect(reply).toMatchObject({ convId: "store", entryId: "2", speaker: { kind: "employee", id: "alice", alias: "Alice" } });

    // 未给工作区（取不到 alias）→ 不带 alias，也不抛。
    expect(toRoomMessage(stored({ seq: 3, fromId: "bob", toIds: ["__boss"], text: "bob 答" }), "老板").speaker).toEqual({
      kind: "employee", id: "bob",
    });
  });

  it("一次投递 = 一行：群聊一条多收件人行还原为一条消息（去重不再是读侧职责）", () => {
    const broadcast = toRoomMessage(
      stored({ seq: 5, room: "group:demo", projectId: "demo", fromId: "__boss", toIds: ["alice", "bob"], text: "广播" }),
      "老板", ws,
    );
    expect(broadcast.text).toBe("@alice @bob 广播");
    expect(broadcast.bossDirected).toBe(false); // 群里没 @ 到老板 → 非「发给老板」
    expect(broadcast.roomMessageId).toBeUndefined();
  });

  it("toRoomMessage：群聊按 toIds 重建头部 @（老板 / 成员 / 系统），私聊不加头", () => {
    const toBoss = toRoomMessage(stored({ seq: 1, room: "group:demo", projectId: "demo", fromId: "alice", toIds: ["__boss"], text: "汇报" }), "掌柜", ws);
    expect(toBoss.text).toBe("@掌柜 汇报");
    expect(toBoss.bossDirected).toBe(true);

    const toMember = toRoomMessage(stored({ seq: 2, room: "group:demo", projectId: "demo", fromId: "alice", toIds: ["bob"], text: "给你" }), "掌柜", ws);
    expect(toMember.text).toBe("@bob 给你");
    expect(toMember.bossDirected).toBe(false);

    const plainDm = toRoomMessage(stored({ seq: 3, fromId: "alice", toIds: ["__boss"], text: "私聊" }), "掌柜", ws);
    expect(plainDm.text).toBe("私聊");
    expect(plainDm.bossDirected).toBe(true); // 私聊恒 true

    // 系统消息按老板形态显示（不引入第三种 speaker，UI / 键机制零改动）。
    const system = toRoomMessage(stored({ seq: 4, fromId: "__system", toIds: ["alice"], text: "已重启" }), "老板", ws);
    expect(system.speaker).toEqual({ kind: "boss" });
  });

  it("roomMessagesOfTranscript：合成条目（pi.compaction / pi.reset）不显示为老板发言，正常 chat.message 保留", () => {
    const messages = roomMessagesOfTranscript("group:demo", {
      memberId: "alice", convId: "c1", messages: [
        chat("3", "user", "压缩摘要", { kind: "pi.compaction" }),
        chat("4", "user", "会话重置", { kind: "pi.reset" }),
        chat("5", "user", "老板问", { kind: "chat.message", data: { author: "boss" } }),
        chat("6", "assistant", "员工答"),
      ],
    });
    expect(messages.map((m) => m.entryId)).toEqual(["5", "6"]);
    expect(messages[0]!.speaker).toEqual({ kind: "boss" });
    expect(messages[1]!.speaker).toEqual({ kind: "employee", id: "alice" });
  });

  it("roomMessagesOfTranscript：员工主动发言 / 工具投递（历史形态 user + data.author = 员工 id）归属该员工，而非老板", () => {
    const alice: MemberTranscript = { memberId: "alice", convId: "c1", messages: [chat("7", "user", "我主动汇报", { kind: "chat.message", data: { author: "alice" } })] };
    const bob: MemberTranscript = { memberId: "bob", convId: "c2", messages: [chat("8", "user", "alice 对 bob 说", { kind: "chat.message", data: { author: "alice" } })] };
    expect(roomMessagesOfTranscript("group:demo", alice, ["alice", "bob"]).map((m) => m.speaker)).toEqual([
      { kind: "employee", id: "alice" },
    ]);
    expect(roomMessagesOfTranscript("group:demo", bob, ["alice", "bob"]).map((m) => m.speaker)).toEqual([
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

  it("工具投递到成员（user + data.author=他人，消息落在收件人会话）→ 显示层补 @收件人，不补 @老板", () => {
    const alice: MemberTranscript = { memberId: "alice", convId: "c1", messages: [] };
    const bob: MemberTranscript = { memberId: "bob", convId: "c2", messages: [] };
    const delivered = chat("20", "user", "权限已到位，你可以改主项目了。", { kind: "chat.message", data: { author: "alice" } });

    const group = normalizeChatMessage("group:demo", bob, delivered, ["alice", "bob"]);
    expect(group?.speaker).toEqual({ kind: "employee", id: "alice" });
    expect(group?.text).toBe("@bob 权限已到位，你可以改主项目了。");
    expect(group?.bossDirected).toBe(false);

    // 投递到老板私聊（dm）不补前缀
    const dm = normalizeChatMessage("dm:alice", alice, delivered, []);
    expect(dm?.text).toBe("权限已到位，你可以改主项目了。");
  });

  it("工具投递到成员：正文自带 @前缀块则不重复补；@ 了别人也不改写", () => {
    const bob: MemberTranscript = { memberId: "bob", convId: "c2", messages: [] };
    const explicit = chat("21", "user", "@bob 先出三件草稿", { kind: "chat.message", data: { author: "alice" } });
    expect(normalizeChatMessage("group:demo", bob, explicit, ["alice", "bob"])?.text).toBe("@bob 先出三件草稿");

    const toBoss = chat("22", "user", "@老板 已办", { kind: "chat.message", data: { author: "alice" } });
    const m = normalizeChatMessage("group:demo", bob, toBoss, ["alice", "bob"]);
    expect(m?.text).toBe("@老板 已办");
  });

  it("员工主动发言（历史 user 形态，落在自己会话）→ 与 assistant 形态同口径：群聊补 @老板", () => {
    const alice: MemberTranscript = { memberId: "alice", convId: "c1", messages: [] };
    const posted = chat("23", "user", "我主动汇报", { kind: "chat.message", data: { author: "alice" } });
    const group = normalizeChatMessage("group:demo", alice, posted, ["alice", "bob"]);
    expect(group?.text).toBe("@老板 我主动汇报");
    expect(group?.bossDirected).toBe(true);
    expect(normalizeChatMessage("dm:alice", alice, posted, [])?.text).toBe("我主动汇报");
  });

  it("空输入、空会话不产生消息", () => {
    expect(roomMessagesOfTranscript("dm:alice", { memberId: "alice", convId: "c1", messages: [] })).toEqual([]);
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

  it("bossNames 双认：@掌柜 视为给老板（不补前缀）；fallback 用当前称谓（首项）", () => {
    const bossNames = ["掌柜", "老板", "boss"];
    const direct = normalizeChatMessage("group:demo", alice, chat("9", "assistant", "@掌柜 汇报：已完成"), memberIds, bossNames);
    expect(direct?.text).toBe("@掌柜 汇报：已完成"); // 命中：不补 fallback 前缀
    expect(direct?.bossDirected).toBe(true);

    const legacy = normalizeChatMessage("group:demo", alice, chat("10", "assistant", "@老板 汇报"), memberIds, bossNames);
    expect(legacy?.bossDirected).toBe(true); // 历史写法仍有效

    const fallback = normalizeChatMessage("group:demo", alice, chat("11", "assistant", "好的，已完成"), memberIds, bossNames);
    expect(fallback?.text).toBe("@掌柜 好的，已完成");
    expect(fallback?.bossDirected).toBe(true);

    const messages = roomMessagesOfTranscript("group:demo", { memberId: "alice", convId: "c1", messages: [chat("12", "assistant", "群里说句话")] }, memberIds, bossNames);
    expect(messages[0]!.text).toBe("@掌柜 群里说句话"); // 透传当前称谓
  });
});
