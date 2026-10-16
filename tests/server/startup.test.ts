import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveStartOptions } from "../../src/server/startup.ts";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-startup-"));
const frameworkDir = path.join(base, "framework");
const officeDir = path.join(base, "office");
const filePath = path.join(base, "not-a-dir.txt");
fs.mkdirSync(frameworkDir, { recursive: true });
fs.mkdirSync(officeDir, { recursive: true });
fs.writeFileSync(filePath, "x");
const linkPath = path.join(base, "office-link");
fs.symlinkSync(officeDir, linkPath);

afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

function resolve(argv: string[], env: Record<string, string | undefined> = {}) {
  return resolveStartOptions({ argv, env, frameworkDir });
}

function expectOk(result: ReturnType<typeof resolve>, root: string, port: number | undefined) {
  expect(result).toEqual({ ok: true, root, port });
}

function expectError(result: ReturnType<typeof resolve>, contains: string) {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain(contains);
}

describe("启动选项解析：项目目录必填、端口可选", () => {
  it("CLI 指定目录 → ok（realpath 归一）；符号链接同样归一；未给端口 → undefined", () => {
    expectOk(resolve(["node", "main.ts", officeDir]), fs.realpathSync(officeDir), undefined);
    expectOk(resolve(["node", "main.ts", linkPath]), fs.realpathSync(officeDir), undefined);
  });

  it("环境变量指定目录 → ok；CLI 优先于环境变量（目录与端口各自独立优先）", () => {
    expectOk(resolve(["node", "main.ts"], { OPENSTAFFS_ROOT: officeDir }), fs.realpathSync(officeDir), undefined);
    expectOk(
      resolve(["node", "main.ts", officeDir, "5000"], { OPENSTAFFS_ROOT: frameworkDir, OPENSTAFFS_PORT: "5001" }),
      fs.realpathSync(officeDir),
      5000,
    );
  });

  it("端口：CLI 第三参或 OPENSTAFFS_PORT；缺省 undefined", () => {
    expectOk(resolve(["node", "main.ts", officeDir, "5000"]), fs.realpathSync(officeDir), 5000);
    expectOk(resolve(["node", "main.ts"], { OPENSTAFFS_ROOT: officeDir, OPENSTAFFS_PORT: "5001" }), fs.realpathSync(officeDir), 5001);
  });

  it("目录缺失/无效 → 报错（提示用法，含 -- 与 OPENSTAFFS_ROOT）", () => {
    const missing = resolve(["node", "main.ts"]);
    expectError(missing, "必须指定项目目录");
    if (!missing.ok) {
      expect(missing.error).toContain("npm start --");
      expect(missing.error).toContain("OPENSTAFFS_ROOT");
    }
    expectError(resolve(["node", "main.ts", "  "], { OPENSTAFFS_ROOT: "" }), "必须指定项目目录");
    expectError(resolve(["node", "main.ts", path.join(base, "nope")]), "不存在");
    expectError(resolve(["node", "main.ts", filePath]), "不存在或不是目录");
  });

  it("项目目录 = 框架目录（含符号链接形态）→ 拒绝", () => {
    expectError(resolve(["node", "main.ts", frameworkDir]), "不能是框架目录");
    const frameworkLink = path.join(base, "framework-link");
    fs.symlinkSync(frameworkDir, frameworkLink);
    expectError(resolve(["node", "main.ts", frameworkLink]), "不能是框架目录");
  });

  it("端口非法（非数字/0/65536/-1/小数/空串）→ 报错（含用法）", () => {
    for (const bad of ["abc", "0", "65536", "-1", "12.5", ""]) {
      const result = resolve(["node", "main.ts", officeDir, bad]);
      expectError(result, "端口不合法");
      if (!result.ok) expect(result.error).toContain("npm start --");
    }
    expectError(resolve(["node", "main.ts", officeDir], { OPENSTAFFS_PORT: "abc" }), "端口不合法");
  });
});
