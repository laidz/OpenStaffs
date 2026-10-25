import { expect, test } from "vitest";
import { parseConfigFields } from "../../src/config/schema.ts";

test("全字段解析：trim、数组保序", () => {
  const { fields, issues } = parseConfigFields({
    alias: " 爱丽丝 ",
    avatar: "avatars/a.png",
    prompt: "你是运营。",
    skills: ["report", "seo"],
    mcp: ["github"],
    permissions: { write: ["../shared"], read: ["./"], bash: [] },
    model: "opencode-go/x",
    thinkingLevel: "high",
    head: ["alice"],
    owner: ["bob"],
    members: ["alice", "bob"],
  });
  expect(issues).toEqual([]);
  expect(fields).toEqual({
    alias: "爱丽丝", avatar: "avatars/a.png", prompt: "你是运营。",
    skills: ["report", "seo"], mcp: ["github"],
    permissions: { write: ["../shared"], read: ["./"], bash: [] },
    model: "opencode-go/x", thinkingLevel: "high",
    head: ["alice"], owner: ["bob"], members: ["alice", "bob"],
  });
});

test("字段缺省：数组为空、permissions 为空对象、可选字段不出现", () => {
  const { fields, issues } = parseConfigFields({});
  expect(issues).toEqual([]);
  expect(fields).toEqual({ skills: [], mcp: [], permissions: {}, head: [], owner: [], members: [] });
});

test("坏条目被跳过并记 issue（不崩、不放大权限）", () => {
  const { fields, issues } = parseConfigFields({
    skills: ["ok", 5, ""],
    permissions: { write: ["./a", "", "  "], bad: "nope", "  ": ["./x"] },
  });
  expect(fields.skills).toEqual(["ok"]);
  expect(fields.permissions).toEqual({ write: ["./a"] });
  expect(issues.length).toBeGreaterThanOrEqual(3);
});

test("非对象 / prompt 非字符串 → 空字段 + issue / 字段缺省", () => {
  const array = parseConfigFields([]);
  expect(array.fields.skills).toEqual([]);
  expect(array.issues.length).toBe(1);
  expect(parseConfigFields({ prompt: 42 }).fields.prompt).toBeUndefined();
});

test("memory：布尔值解析，非布尔值忽略并记 issue", () => {
  expect(parseConfigFields({ memory: true }).fields.memory).toBe(true);
  expect(parseConfigFields({ memory: false }).fields.memory).toBe(false);
  expect(parseConfigFields({}).fields.memory).toBeUndefined();
  const bad = parseConfigFields({ memory: "yes" });
  expect(bad.fields.memory).toBeUndefined();
  expect(bad.issues).toContain("memory 必须是布尔值（已忽略）");
});
