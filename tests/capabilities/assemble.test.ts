import { expect, test } from "vitest";
import { assembleCapabilities } from "../../src/capabilities/assemble.ts";
import type { LoadedConfig } from "../../src/config/schema.ts";

function cfg(scope: LoadedConfig["scope"], id: string, fields: Partial<LoadedConfig["fields"]>): LoadedConfig {
  return {
    scope,
    id,
    file: `/x/${id}`,
    baseDir: "/x",
    fields: { skills: [], mcp: [], permissions: {}, head: [], owner: [], members: [], ...fields },
    issues: [],
  };
}

test("prompt 累加（换行分割）、skills / mcp 累加且接受重复", () => {
  const caps = assembleCapabilities([
    cfg("space", "space", { prompt: "空间总纲", skills: ["report"], mcp: ["github"] }),
    cfg("department", "eng", { prompt: "部门规矩", skills: ["report"] }),
    cfg("project", "seo", { prompt: "项目规范", skills: ["seo"], mcp: ["github"] }),
    cfg("agent", "alice", { prompt: "你是运营。" }),
  ]);
  expect(caps.prompt).toBe("空间总纲\n部门规矩\n项目规范\n你是运营。");
  expect(caps.skills).toEqual(["report", "report", "seo"]);
  expect(caps.mcp).toEqual(["github", "github"]);
});

test("空 prompt 段被跳过；全空 → 空串与空数组", () => {
  expect(assembleCapabilities([cfg("space", "space", {}), cfg("agent", "alice", { prompt: "   " })])).toEqual({
    prompt: "", skills: [], mcp: [],
  });
});
