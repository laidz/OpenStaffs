import { describe, expect, it } from "vitest";
import { planRouting } from "../../src/app/routing.ts";

describe("planRouting", () => {
  it("点名 → 只投给被点名者", () => {
    expect(planRouting("@alice 写脚本", ["alice", "bob"])).toEqual({
      deliveries: [{ to: "alice", body: "写脚本" }],
      broadcast: false,
    });
  });

  it("不点名 → 广播给全体", () => {
    expect(planRouting("大家看下", ["alice", "bob"])).toEqual({
      deliveries: [
        { to: "alice", body: "大家看下" },
        { to: "bob", body: "大家看下" },
      ],
      broadcast: true,
    });
  });
});
