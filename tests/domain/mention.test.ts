import { describe, expect, it } from "vitest";
import { BOSS_ID, parseMentions } from "../../src/domain/mention.ts";

const employees = ["alice", "bob"];

describe("parseMentions", () => {
  it("点名一个员工：定向，正文去掉 @名", () => {
    expect(parseMentions("@alice 写个脚本", employees)).toEqual({
      targets: ["alice"], body: "写个脚本", broadcast: false,
    });
  });

  it("点名多个", () => {
    const r = parseMentions("@alice @bob 一起看下", employees);
    expect(r.targets).toEqual(["alice", "bob"]);
    expect(r.body).toBe("一起看下");
  });

  it("不点名 = 广播", () => {
    expect(parseMentions("大家看下", employees)).toEqual({
      targets: [], body: "大家看下", broadcast: true,
    });
  });

  it("@老板 映射到 BOSS_ID", () => {
    const r = parseMentions("@老板 请审批", employees);
    expect(r.targets).toEqual([BOSS_ID]);
  });

  it("未知的 @名 原样留在正文，且不误路由", () => {
    const r = parseMentions("@nobody 你好", employees);
    expect(r.targets).toEqual([]);
    expect(r.broadcast).toBe(true);
    expect(r.body).toBe("@nobody 你好");
  });
});
