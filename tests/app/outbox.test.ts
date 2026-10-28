import { describe, expect, it } from "vitest";
import { Outbox, queuedItemView } from "../../src/app/outbox.ts";

function delivery(submissionId: string, meetingId: string, messageId: string, memberId = "alice") {
  return { submissionId, meetingId, memberId, messageId, text: `给 ${memberId} 的话`, convId: `conv-${submissionId}`, storeSeq: 0 };
}

describe("待发表（Outbox）", () => {
  it("入队/出队：take 移出并返回；不在表里返回 undefined", () => {
    const outbox = new Outbox();
    outbox.add(delivery("s1", "mtg_a", "msg_1"));
    expect(outbox.size).toBe(1);
    expect(outbox.take("s1")?.submissionId).toBe("s1");
    expect(outbox.take("s1")).toBeUndefined();
    expect(outbox.size).toBe(0);
  });

  it("同 submissionId 重复入队幂等（不产生重复条目）", () => {
    const outbox = new Outbox();
    outbox.add(delivery("s1", "mtg_a", "msg_1"));
    outbox.add(delivery("s1", "mtg_a", "msg_1", "bob"));
    expect(outbox.size).toBe(1);
    expect(outbox.list("mtg_a")).toHaveLength(1);
  });

  it("list 按投递顺序（入队序）；只返回本会议的条目", () => {
    const outbox = new Outbox();
    outbox.add(delivery("s2", "mtg_a", "msg_2"));
    outbox.add(delivery("s1", "mtg_a", "msg_1"));
    outbox.add(delivery("s3", "mtg_g", "msg_3"));
    expect(outbox.list("mtg_a").map((item) => item.submissionId)).toEqual(["s2", "s1"]);
    expect(outbox.list("mtg_g").map((item) => item.submissionId)).toEqual(["s3"]);
    expect(outbox.list("mtg_none")).toEqual([]);
  });

  it("byMeetingMessage：同一次多投递（一条消息发给多人）一起取回", () => {
    const outbox = new Outbox();
    const msg = "msg_1";
    outbox.add(delivery("s1", "mtg_g", msg, "alice"));
    outbox.add(delivery("s2", "mtg_g", msg, "bob"));
    outbox.add(delivery("s9", "mtg_g", "msg_other", "alice"));
    expect(outbox.byMeetingMessage("mtg_g", msg).map((item) => item.memberId)).toEqual(["alice", "bob"]);
    expect(outbox.byMeetingMessage("mtg_g", "msg_ghost")).toEqual([]);
  });

  it("视图不外泄内部字段（convId / seq）", () => {
    const outbox = new Outbox();
    outbox.add(delivery("s1", "mtg_a", "msg_1"));
    expect(queuedItemView(outbox.list("mtg_a")[0]!)).toEqual({
      submissionId: "s1",
      meetingId: "mtg_a",
      memberId: "alice",
      messageId: "msg_1",
      text: "给 alice 的话",
    });
  });

  it("messageIdByStoreSeq：本会议仍在排队的库行 seq → messageId；别处 / 未排队不入表", () => {
    const outbox = new Outbox();
    outbox.add({ ...delivery("s1", "mtg_a", "msg_1"), storeSeq: 7 });
    outbox.add({ ...delivery("s2", "mtg_b", "msg_2"), storeSeq: 9 });
    expect([...outbox.messageIdByStoreSeq("mtg_a")]).toEqual([[7, "msg_1"]]);
    expect(outbox.messageIdByStoreSeq("mtg_other").size).toBe(0);
    // 出队后不再回填（真气泡已落库）
    outbox.take("s1");
    expect(outbox.messageIdByStoreSeq("mtg_a").size).toBe(0);
  });
});
