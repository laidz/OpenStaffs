import { describe, expect, it } from "vitest";
import { bodyWithoutPrefix, draftAfterSend, groupSendable, targetsOf, toggleTarget } from "../../web/composer.ts";

const members = ["alice", "bob"];

describe("群聊输入框定向辅助", () => {
  describe("targetsOf（与后端路由一致）", () => {
    it("命中成员 id；@老板 / @未知名 / 中文标点粘连不算命中", () => {
      expect(targetsOf("@alice 写脚本", members)).toEqual(["alice"]);
      expect(targetsOf("@alice @bob 一起", members)).toEqual(["alice", "bob"]);
      expect(targetsOf("@alice @alice 重复", members)).toEqual(["alice"]);
      expect(targetsOf("@老板 收到", members)).toEqual([]);
      expect(targetsOf("@nobody 你好", members)).toEqual([]);
      expect(targetsOf("@alice，你好", members)).toEqual([]);
      expect(targetsOf("大家看下", members)).toEqual([]);
    });

    it("只认开头的 @ 前缀块：正文中/尾的 @ 不触发", () => {
      expect(targetsOf("你好 @alice", members)).toEqual([]);
      expect(targetsOf("@alice 你好 @bob", members)).toEqual(["alice"]);
      expect(targetsOf("请找 @alice 处理", members)).toEqual([]);
    });

    it("与发送口径一致：前导空白不影响命中", () => {
      expect(targetsOf(" @alice 你好", members)).toEqual(["alice"]);
      expect(targetsOf("\n@alice 你好", members)).toEqual(["alice"]);
    });

    it("成员 id 恰为 boss：哨兵优先，不命中", () => {
      expect(targetsOf("@boss 你好", ["boss"])).toEqual([]);
    });
  });

  describe("toggleTarget（勾选 ↔ 正文 @）", () => {
    it("勾选：@id 插到前缀块末尾；已存在不重复插入", () => {
      expect(toggleTarget("你好", "alice", true)).toBe("@alice 你好");
      expect(toggleTarget("@bob 你好", "alice", true)).toBe("@bob @alice 你好");
      expect(toggleTarget("", "alice", true)).toBe("@alice ");
      expect(toggleTarget("@alice 你好", "alice", true)).toBe("@alice 你好");
    });

    it("勾选：前缀以无空格 @token 结尾（发送后退格）也不粘连", () => {
      expect(toggleTarget("@alice", "bob", true)).toBe("@alice @bob ");
      expect(toggleTarget("@alice\n@bob", "carol", true)).toBe("@alice @bob @carol ");
    });

    it("取消勾选：只动前缀块，不误伤正文中的同形 @、不误伤前缀相似的 id", () => {
      expect(toggleTarget("@alice 你好", "alice", false)).toBe("你好");
      expect(toggleTarget("@bob @alice 你好", "alice", false)).toBe("@bob 你好");
      expect(toggleTarget("@alice", "alice", false)).toBe("");
      expect(toggleTarget("@alice 你好 @alice", "alice", false)).toBe("你好 @alice");
      expect(toggleTarget("你好 @alice", "alice", false)).toBe("你好 @alice");
      expect(toggleTarget("@alice 你好", "al", false)).toBe("@alice 你好");
    });

    it("取消勾选：多余空白/重复 token 一并归一（勾选不会弹回）", () => {
      expect(toggleTarget("@alice \n@bob 你好", "alice", false)).toBe("@bob 你好");
      expect(toggleTarget("@alice  @alice 你好", "alice", false)).toBe("你好");
    });

    it("正文中已有同形 @ 时，勾选仍在前缀块补一个（正文中的是文字）", () => {
      expect(toggleTarget("你好 @alice", "alice", true)).toBe("@alice 你好 @alice");
    });

    it("前导空白：插入落在前缀块、空白保留", () => {
      expect(toggleTarget(" @alice 你好", "bob", true)).toBe(" @alice @bob 你好");
    });
  });

  describe("bodyWithoutPrefix（前缀之外是否有正文）", () => {
    it("按前缀块切分（与发送口径一致）", () => {
      expect(bodyWithoutPrefix("@alice @bob 你好")).toBe("你好");
      expect(bodyWithoutPrefix("@alice ")).toBe("");
      expect(bodyWithoutPrefix("你好")).toBe("你好");
      expect(bodyWithoutPrefix(" @alice 你好")).toBe("你好");
    });
  });

  describe("groupSendable（群聊发送门禁）", () => {
    it("需同时满足：有有效对象 + 前缀外有正文（避免只 @ 人的空消息误触员工）", () => {
      expect(groupSendable("@alice 你好", members)).toBe(true);
      expect(groupSendable("@alice @bob 你好", members)).toBe(true);
      expect(groupSendable("@alice ", members)).toBe(false);
      expect(groupSendable("你好", members)).toBe(false);
      expect(groupSendable("@nobody 你好", members)).toBe(false);
      expect(groupSendable(" @alice 你好", members)).toBe(true);
      expect(groupSendable("@boss 你好", ["boss"])).toBe(false);
    });
  });

  describe("draftAfterSend（发送后保留 @ 前缀）", () => {
    it("保留勾选对象的 @ 前缀；无对象则清空", () => {
      expect(draftAfterSend(["alice", "bob"])).toBe("@alice @bob ");
      expect(draftAfterSend([])).toBe("");
    });
  });
});
