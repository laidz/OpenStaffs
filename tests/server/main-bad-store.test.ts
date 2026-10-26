import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const mainTs = path.resolve(here, "..", "..", "src", "server", "main.ts");

const base = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-baddb-"));
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

describe("启动失败路径：坏消息库不再裸崩", () => {
  it("openstaffs.sqlite 是非 SQLite 文件 → 打印「启动失败」后退出 1（含清晰原因）", () => {
    const office = path.join(base, "office");
    const stateDir = path.join(office, "openstaffs/.data");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "openstaffs.sqlite"), "这不是一个 SQLite 数据库");

    // 直接跑 strip-only TS 入口（与 npm start 同口径）；坏库应使它即刻退出，不会进入监听。
    const result = spawnSync(process.execPath, [mainTs, office], { encoding: "utf8", timeout: 20_000 });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[openstaffs] 启动失败：");
    expect(result.stderr).toMatch(/not a database/u);
  }, 30_000);
});
