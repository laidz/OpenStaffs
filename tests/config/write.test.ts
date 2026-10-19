import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { appendPermissionPaths } from "../../src/config/write.ts";

let root = "";
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-cfgwrite-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function write(file: string, body: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`);
}

function read(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

test("缺失文件 → 新建 { permissions: { tool: paths } }（2 空格缩进 + 尾换行 + 无 .tmp）", () => {
  const file = path.join(root, "agents", "eng", "alice.agent.config.json");
  appendPermissionPaths(file, "write", ["/abs/new"]);
  expect(read(file)).toEqual({ permissions: { write: ["/abs/new"] } });
  const raw = fs.readFileSync(file, "utf8");
  expect(raw.endsWith("\n")).toBe(true);
  expect(raw).toContain("  ");
  expect(fs.existsSync(`${file}.tmp`)).toBe(false);
});

test("已有文件：保留全部原有字段，只合并该工具路径（去重保序）", () => {
  const file = path.join(root, "alice.agent.config.json");
  write(file, {
    alias: "爱丽丝",
    model: "opencode-go/x",
    prompt: "你是运营。",
    mcp: ["github"],
    permissions: { write: ["../shared/"], read: ["./"] },
  });
  appendPermissionPaths(file, "write", ["/abs/new", "../shared/", " "]);
  expect(read(file)).toEqual({
    alias: "爱丽丝",
    model: "opencode-go/x",
    prompt: "你是运营。",
    mcp: ["github"],
    permissions: { write: ["../shared/", "/abs/new"], read: ["./"] },
  });
});

test("坏 JSON / 顶层非对象 / permissions 非对象 / 该工具值非数组 → 抛错且不改文件", () => {
  const bad = path.join(root, "bad.agent.config.json");
  write(bad, "{ 坏");
  expect(() => appendPermissionPaths(bad, "write", ["/a"])).toThrow();
  expect(fs.readFileSync(bad, "utf8")).toBe("{ 坏");

  const array = path.join(root, "array.agent.config.json");
  write(array, [1, 2]);
  expect(() => appendPermissionPaths(array, "write", ["/a"])).toThrow();

  const perm = path.join(root, "perm.agent.config.json");
  write(perm, { permissions: { write: "nope" } });
  expect(() => appendPermissionPaths(perm, "write", ["/a"])).toThrow();
  expect(read(perm)).toEqual({ permissions: { write: "nope" } });

  const weird = path.join(root, "weird.agent.config.json");
  write(weird, { permissions: [] });
  expect(() => appendPermissionPaths(weird, "write", ["/a"])).toThrow();
});

test("该工具值为数组但含非字符串项 → 抛错且不改文件（不静默丢项）", () => {
  const file = path.join(root, "mixed.agent.config.json");
  write(file, { alias: "爱丽丝", permissions: { write: ["a", 123] } });
  const before = fs.readFileSync(file, "utf8");
  expect(() => appendPermissionPaths(file, "write", ["/a"])).toThrow();
  expect(fs.readFileSync(file, "utf8")).toBe(before);
  expect(read(file)).toEqual({ alias: "爱丽丝", permissions: { write: ["a", 123] } });
});

test("空 tool 抛错；空 paths 空操作（不建文件）", () => {
  const file = path.join(root, "none.agent.config.json");
  expect(() => appendPermissionPaths(file, "  ", ["/a"])).toThrow();
  appendPermissionPaths(file, "write", ["", "   "]);
  expect(fs.existsSync(file)).toBe(false);
});
