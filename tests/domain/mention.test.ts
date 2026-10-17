import { describe, expect, it } from "vitest";
import { BOSS_ID, parseMentions } from "../../src/domain/mention.ts";

const employees = ["alice", "bob"];

describe("parseMentions", () => {
  it("点名一个员工：命中原名，正文保留 @（供聊天记录辨认对象）", () => {
    expect(parseMentions("@alice 写个脚本", employees)).toEqual({
      targets: ["alice"], body: "@alice 写个脚本",
    });
  });

  it("点名多个：去重保序，正文原样", () => {
    const r = parseMentions("@alice @bob @alice 一起看下", employees);
    expect(r.targets).toEqual(["alice", "bob"]);
    expect(r.body).toBe("@alice @bob @alice 一起看下");
  });

  it("不点名：targets 空，正文原样", () => {
    expect(parseMentions("大家看下", employees)).toEqual({
      targets: [], body: "大家看下",
    });
  });

  it("@老板 映射到 BOSS_ID，正文保留", () => {
    const r = parseMentions("@老板 请审批", employees);
    expect(r.targets).toEqual([BOSS_ID]);
    expect(r.body).toBe("@老板 请审批");
  });

  it("未知的 @名 原样留在正文，且不误路由", () => {
    const r = parseMentions("@nobody 你好", employees);
    expect(r.targets).toEqual([]);
    expect(r.body).toBe("@nobody 你好");
  });

  it("只认开头的 @ 前缀块：正文中/尾的 @ 不触发", () => {
    expect(parseMentions("你好 @alice", employees)).toEqual({ targets: [], body: "你好 @alice" });
    expect(parseMentions("@alice 你好 @bob", employees)).toEqual({ targets: ["alice"], body: "@alice 你好 @bob" });
  });

  it("前缀块内：未知 @ 名不中断后续 token；整块无尾随空白也算前缀", () => {
    expect(parseMentions("@nobody @alice 你好", employees).targets).toEqual(["alice"]);
    expect(parseMentions("@alice", employees).targets).toEqual(["alice"]);
  });
});
