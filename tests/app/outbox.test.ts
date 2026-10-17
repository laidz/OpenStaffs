import { describe, expect, it } from "vitest";
import { Outbox, queuedItemView, newRoomMessageId } from "../../src/app/outbox.ts";

function delivery(submissionId: string, roomKey: string, roomMessageId: string, memberId = "alice") {
  return { submissionId, roomKey, memberId, roomMessageId, text: `给 ${memberId} 的话`, convId: `conv-${submissionId}` };
}

describe("待发表（Outbox）", () => {
  it("入队/出队：take 移出并返回；不在表里返回 undefined", () => {
    const outbox = new Outbox();
    outbox.add(delivery("s1", "dm:alice", "rm_1"));
    expect(outbox.size).toBe(1);
    expect(outbox.take("s1")?.submissionId).toBe("s1");
    expect(outbox.take("s1")).toBeUndefined();
    expect(outbox.size).toBe(0);
  });

  it("同 submissionId 重复入队幂等（不产生重复条目）", () => {
    const outbox = new Outbox();
    outbox.add(delivery("s1", "dm:alice", "rm_1"));
    outbox.add(delivery("s1", "dm:alice", "rm_1", "bob"));
    expect(outbox.size).toBe(1);
    expect(outbox.list("dm:alice")).toHaveLength(1);
  });

  it("list 按投递顺序（入队序）；只返回本房间的条目", () => {
    const outbox = new Outbox();
    outbox.add(delivery("s2", "dm:alice", "rm_2"));
    outbox.add(delivery("s1", "dm:alice", "rm_1"));
    outbox.add(delivery("s3", "group:yt", "rm_3"));
    expect(outbox.list("dm:alice").map((item) => item.submissionId)).toEqual(["s2", "s1"]);
    expect(outbox.list("group:yt").map((item) => item.submissionId)).toEqual(["s3"]);
    expect(outbox.list("group:none")).toEqual([]);
  });

  it("byRoomMessage：同一次多投递（一条消息发给多人）一起取回", () => {
    const outbox = new Outbox();
    const rm = newRoomMessageId();
    outbox.add(delivery("s1", "group:yt", rm, "alice"));
    outbox.add(delivery("s2", "group:yt", rm, "bob"));
    outbox.add(delivery("s9", "group:yt", "rm_other", "alice"));
    expect(outbox.byRoomMessage("group:yt", rm).map((item) => item.memberId)).toEqual(["alice", "bob"]);
    expect(outbox.byRoomMessage("group:yt", "rm_ghost")).toEqual([]);
  });

  it("视图不外泄内部字段（convId / seq）", () => {
    const outbox = new Outbox();
    outbox.add(delivery("s1", "dm:alice", "rm_1"));
    expect(queuedItemView(outbox.list("dm:alice")[0]!)).toEqual({
      submissionId: "s1",
      roomKey: "dm:alice",
      memberId: "alice",
      roomMessageId: "rm_1",
      text: "给 alice 的话",
    });
  });

  it("newRoomMessageId：rm_ 前缀且不重复", () => {
    const a = newRoomMessageId();
    const b = newRoomMessageId();
    expect(a.startsWith("rm_")).toBe(true);
    expect(a).not.toBe(b);
  });
});
