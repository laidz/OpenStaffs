import { expect, test } from "vitest";
import { isSubsetOf, matchesPath } from "../../src/permissions/match.ts";

test("相等或在其下命中；不误命中兄弟目录", () => {
  expect(matchesPath(["/office/agents/alice"], "/office/agents/alice")).toBe(true);
  expect(matchesPath(["/office/agents/alice"], "/office/agents/alice/data/a.md")).toBe(true);
  expect(matchesPath(["/office/agents/alice/data"], "/office/agents/alice/data2/x.md")).toBe(false);
  expect(matchesPath(["/office/agents/alice/data"], "/office/agents/alice/dataX")).toBe(false);
});

test("空集不命中；大小写敏感；\"/\" 命中全盘", () => {
  expect(matchesPath([], "/etc/passwd")).toBe(false);
  expect(matchesPath(["/Shared"], "/shared/a")).toBe(false);
  expect(matchesPath(["/"], "/etc/passwd")).toBe(true);
  expect(matchesPath(["/"], "/")).toBe(true);
});

test("空模式 fail-closed：不匹配绝对路径 / 相对路径 / 自己", () => {
  expect(matchesPath([""], "/etc/passwd")).toBe(false);
  expect(matchesPath([""], "relative")).toBe(false);
  expect(matchesPath([""], "")).toBe(false);
  expect(isSubsetOf(["/etc/passwd"], [""])).toBe(false);
});

test("isSubsetOf：请求 ⊆ 授予（子目录可授，父目录不可授）", () => {
  expect(isSubsetOf(["/office/agents/alice/data"], ["/office/agents/alice"])).toBe(true);
  expect(isSubsetOf(["/office/agents/alice"], ["/office/agents/alice/data"])).toBe(false);
  expect(isSubsetOf(["/a", "/b"], ["/a"])).toBe(false);
  expect(isSubsetOf([], ["/a"])).toBe(true);
  expect(isSubsetOf(["/a"], [])).toBe(false);
});
