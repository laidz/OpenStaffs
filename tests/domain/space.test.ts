import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createWorkspace, type Workspace } from "../../src/domain/paths.ts";
import { builtinSpacePrompt, ensureSpaceConfig, newSpaceConfig, spaceConfigFile } from "../../src/domain/space.ts";
// 说明（跨计划裁定 N2）：`spaceConfigFile` 由 `src/domain/space.ts` re-export 自 P3 的 `src/config/naming.ts`，
// 本测试引用的是**同一实现**（re-export），不存在第二份定义。

let root: string;
let ws: Workspace;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "os-space-"));
  ws = createWorkspace(root);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test("内置空间 prompt 非空（框架自带的系统级 prompt）", () => {
  expect(builtinSpacePrompt().trim().length).toBeGreaterThan(0);
  expect(newSpaceConfig().prompt).toBe(builtinSpacePrompt());
});

test("spaceConfigFile：落点 openstaffs/space.config.json（可见、可版本化）", () => {
  expect(spaceConfigFile(ws)).toBe(path.join(root, "openstaffs", "space.config.json"));
});

test("ensureSpaceConfig：缺失则物化内置 prompt；已存在不覆盖（含空文件 / 坏 JSON）", () => {
  expect(ensureSpaceConfig(ws)).toBe("created");
  const file = spaceConfigFile(ws);
  expect(JSON.parse(fs.readFileSync(file, "utf8")).prompt).toBe(builtinSpacePrompt());

  fs.writeFileSync(file, JSON.stringify({ prompt: "老板改过的总纲" }));
  expect(ensureSpaceConfig(ws)).toBe("exists");
  expect(JSON.parse(fs.readFileSync(file, "utf8")).prompt).toBe("老板改过的总纲");

  fs.writeFileSync(file, "");
  expect(ensureSpaceConfig(ws)).toBe("exists");
  expect(fs.readFileSync(file, "utf8")).toBe("");
});
