import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { spaceConfigFile } from "../../src/domain/space.ts";
import { staff0File, staff0Config } from "../../src/domain/staff0.ts";
import { ensureSpace } from "../../src/server/bootstrap.ts";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "os-boot-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test("首次启动：新建空间写入空 space.config.json + 自动建 Staff0", () => {
  const ws = createWorkspace(root);
  const result = ensureSpace(ws);
  expect(result).toEqual({ newSpace: true, spaceConfig: "created", staff0: "created" });
  expect(JSON.parse(fs.readFileSync(spaceConfigFile(ws), "utf8"))).toEqual({});
  expect(JSON.parse(fs.readFileSync(staff0File(ws), "utf8"))).toEqual(staff0Config());
});

test("再次启动：幂等，不覆盖老板内容", () => {
  const ws = createWorkspace(root);
  ensureSpace(ws);
  fs.writeFileSync(spaceConfigFile(ws), JSON.stringify({ prompt: "老板改过" }));
  const result = ensureSpace(ws);
  expect(result).toEqual({ newSpace: false, spaceConfig: "exists", staff0: "exists" });
  expect(JSON.parse(fs.readFileSync(spaceConfigFile(ws), "utf8")).prompt).toBe("老板改过");
});

test("部分失败：space.config.json 已存在（exists）而 Staff0 落点不可写（failed）", () => {
  const ws = createWorkspace(root);
  ensureSpace(ws); // 先建好空间：space.config.json 就位
  // 让 staff0 的写入失败：把 agents/ 换成文件 → ensureStaff0 的 mkdirSync(agentsDir) 抛错。
  fs.rmSync(path.join(root, "agents"), { recursive: true, force: true });
  fs.writeFileSync(path.join(root, "agents"), "x");
  const result = ensureSpace(ws);
  expect(result).toEqual({ newSpace: false, spaceConfig: "exists", staff0: "failed" });
});

test("空间目录不可写（root 其实是文件）→ 不抛，逐项记 failed", () => {
  const rootFile = path.join(root, "not-a-dir");
  fs.writeFileSync(rootFile, "x");
  const ws = createWorkspace(rootFile);
  expect(() => ensureSpace(ws)).not.toThrow();
  const result = ensureSpace(ws);
  expect(result.spaceConfig).toBe("failed");
  expect(result.staff0).toBe("failed");
  expect(result.newSpace).toBe(false);
});
