import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createWorkspace, type Workspace } from "../../src/domain/paths.ts";
import { ensureSpaceConfig, newSpaceConfig, spaceConfigFile } from "../../src/domain/space.ts";

let root: string;
let ws: Workspace;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "os-space-"));
  ws = createWorkspace(root);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test("newSpaceConfig 为空声明（系统 prompt 由框架自持，不再物化）", () => {
  expect(newSpaceConfig()).toEqual({});
});

test("spaceConfigFile：落点 openstaffs/space.config.json（可见、可版本化）", () => {
  expect(spaceConfigFile(ws)).toBe(path.join(root, "openstaffs", "space.config.json"));
});

test("ensureSpaceConfig：缺失则写空声明；已存在不覆盖（含空文件 / 坏 JSON）", () => {
  expect(ensureSpaceConfig(ws)).toBe("created");
  const file = spaceConfigFile(ws);
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({});

  fs.writeFileSync(file, JSON.stringify({ prompt: "老板改过的总纲" }));
  expect(ensureSpaceConfig(ws)).toBe("exists");
  expect(JSON.parse(fs.readFileSync(file, "utf8")).prompt).toBe("老板改过的总纲");

  fs.writeFileSync(file, "");
  expect(ensureSpaceConfig(ws)).toBe("exists");
  expect(fs.readFileSync(file, "utf8")).toBe("");
});
