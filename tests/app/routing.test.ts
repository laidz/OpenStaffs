import { describe, expect, it } from "vitest";
import { hasBodyAfterPrefix, planRouting } from "../../src/app/routing.ts";

describe("planRouting", () => {
  it("点名 → 只投给被点名者，正文保留 @", () => {
    expect(planRouting("@alice 写脚本", ["alice", "bob"])).toEqual([
      { to: "alice", body: "@alice 写脚本" },
    ]);
  });

  it("多目标按出现顺序投递", () => {
    expect(planRouting("@bob @alice 一起来", ["alice", "bob"])).toEqual([
      { to: "bob", body: "@bob @alice 一起来" },
      { to: "alice", body: "@bob @alice 一起来" },
    ]);
  });

  it("不 @ → 无投递（不再广播）", () => {
    expect(planRouting("大家看下", ["alice", "bob"])).toEqual([]);
  });

  it("只 @老板 / @非成员 → 无投递", () => {
    expect(planRouting("@老板 请审批", ["alice", "bob"])).toEqual([]);
    expect(planRouting("@ghost 你好", ["alice", "bob"])).toEqual([]);
  });

  it("只认开头的 @ 前缀块：正文中/尾的 @ 不投递", () => {
    expect(planRouting("你好 @alice", ["alice", "bob"])).toEqual([]);
    expect(planRouting("@alice 你好 @bob", ["alice", "bob"]).map((d) => d.to)).toEqual(["alice"]);
  });

  it("成员 id 恰为 boss：哨兵优先，不投递", () => {
    expect(planRouting("@boss 你好", ["boss"])).toEqual([]);
  });

  it("hasBodyAfterPrefix：前缀块之外是否还有正文", () => {
    expect(hasBodyAfterPrefix("@bob 请评审")).toBe(true);
    expect(hasBodyAfterPrefix("@bob ")).toBe(false);
    expect(hasBodyAfterPrefix("@bob")).toBe(false);
    expect(hasBodyAfterPrefix(" 。")).toBe(true);
  });
});
