import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createWorkspace, type Workspace } from "../../src/domain/paths.ts";
import { ensureStaff0, STAFF0_ID, staff0Config, staff0File } from "../../src/domain/staff0.ts";

let root: string;
let ws: Workspace;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "os-staff0-"));
  ws = createWorkspace(root);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test("staff0Config：spec §4 统一字段；权限 = 空间根（`..`，相对 agents/）；无 model（用全局默认）", () => {
  const config = staff0Config();
  expect(STAFF0_ID).toBe("staff0");
  expect(config.alias).not.toBe("");
  // P3 的 permissions 路径相对**配置文件所在目录**解析（staff0 = `agents/`）→ 空间根 = `..`（裁定 R-P4-1）
  expect(config.permissions).toEqual({ write: [".."], read: [".."], bash: [".."] });
  expect(config).not.toHaveProperty("model");
});

test("staff0 的权限路径解析出来就是空间根（spec §8「写空间根 ./」= 整个空间，而非 agents/）", () => {
  const [first] = staff0Config().permissions.write;
  // 基目录从实现取（`agents/`），落点变化时断言随之失效——不用手写的 `path.join(root, "agents")`。
  expect(path.resolve(path.dirname(staff0File(ws)), first!)).toBe(root);
});

test("staff0File：落点在 agents/staff0.agent.config.json（根下、无部门）", () => {
  expect(staff0File(ws)).toBe(path.join(root, "agents", "staff0.agent.config.json"));
});

test("ensureStaff0：不存在则创建（内容 = staff0Config）；已存在不覆盖", () => {
  expect(ensureStaff0(ws)).toBe("created");
  const file = staff0File(ws);
  expect(fs.existsSync(file)).toBe(true);
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(staff0Config());

  fs.writeFileSync(file, JSON.stringify({ alias: "老板改过的管家" }));
  expect(ensureStaff0(ws)).toBe("exists");
  expect(JSON.parse(fs.readFileSync(file, "utf8")).alias).toBe("老板改过的管家");
});
