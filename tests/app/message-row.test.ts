import { expect, test } from "vitest";
import { parseAgentReply, stripLeadingMentions } from "../../src/app/message-row.ts";

test("只剥头部 @ 前缀块；中 / 尾部 @ 保留", () => {
  expect(stripLeadingMentions("@alice @bob 请开始")).toBe("请开始");
  expect(stripLeadingMentions("你好 @alice")).toBe("你好 @alice");
  expect(stripLeadingMentions("@alice")).toBe("");
  expect(stripLeadingMentions("  @alice   干活  ")).toBe("干活");
});

test("agent 回复：@成员 → toIds 命中；否则视为发给老板", () => {
  expect(parseAgentReply("@bob 我做完了", ["alice", "bob"], ["老板"])).toEqual({ toIds: ["bob"], text: "我做完了" });
  expect(parseAgentReply("我做完了", ["alice", "bob"], ["老板"])).toEqual({ toIds: ["__boss"], text: "我做完了" });
  expect(parseAgentReply("@老板 汇报", ["alice", "bob"], ["老板"])).toEqual({ toIds: ["__boss"], text: "汇报" });
});

test("agent 只 @ 没正文 → 空 toIds + 空 text（调用方据此不落库）", () => {
  expect(parseAgentReply("@bob", ["alice", "bob"], ["老板"])).toEqual({ toIds: [], text: "" });
});

test("空 / 全空白正文 → 空串", () => {
  expect(stripLeadingMentions("")).toBe("");
  expect(stripLeadingMentions("   ")).toBe("");
});

test("前导空白下 @ 前缀块与收件人同口径（不得静默改投老板）", () => {
  expect(parseAgentReply("  @bob 干活", ["alice", "bob"], ["老板"])).toEqual({ toIds: ["bob"], text: "干活" });
  expect(parseAgentReply("  @alice @bob 请开始", ["alice", "bob"], ["老板"])).toEqual({ toIds: ["alice", "bob"], text: "请开始" });
});
