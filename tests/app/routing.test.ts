import { describe, expect, it } from "vitest";
import { planRouting } from "../../src/app/routing.ts";
import { unreadForBoss } from "../../src/app/unread.ts";

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

describe("unreadForBoss", () => {
  it("老板没看过的、非老板发的消息 = 小红点", () => {
    const unread = unreadForBoss(
      [
        { relation: "dm:alice", messages: [
          { id: "1", role: "user", text: "在吗" },
          { id: "2", role: "assistant", text: "在的" },
        ] },
      ],
      { "dm:alice": 1 },
    );
    expect(unread).toEqual([{ relation: "dm:alice", message: { id: "2", role: "assistant", text: "在的" } }]);
  });
});
