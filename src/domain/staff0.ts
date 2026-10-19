import fs from "node:fs";
import path from "node:path";
import { agentsDir, type Workspace } from "./paths.ts";

/** 0 号员工 id（空间管家；根下、无部门；spec §8）。 */
export const STAFF0_ID = "staff0";

/** Staff0 定义：spec §4 统一字段（员工层）。权限 = 空间根（§8）——「空间级附属 = 老板地盘」的有意例外。 */
export type Staff0Config = {
  alias: string;
  prompt: string;
  permissions: { write: string[]; read: string[]; bash: string[] };
};

/** 内置的管家 prompt（可被老板改写；不在框架更新时自动覆盖）。 */
const STAFF0_PROMPT =
  "你是本办公空间的 0 号员工（首席管家）。你对空间根（整个办公空间）有写权限，负责空间级事务；协作、产物与记忆的通用约定见空间总纲。";

export function staff0File(ws: Workspace): string {
  return path.join(agentsDir(ws), `${STAFF0_ID}.agent.config.json`);
}

/**
 * Staff0 的初始定义（无 `model` → 运行时用全局默认模型兜底）。
 * 权限路径相对**配置文件所在目录**（`agents/`）解析 → 空间根 = `..`（裁定 R-P4-1；不用绝对路径，保持配置可整包迁移）。
 */
export function staff0Config(): Staff0Config {
  return {
    alias: "首席管家",
    prompt: STAFF0_PROMPT,
    permissions: { write: [".."], read: [".."], bash: [".."] },
  };
}

/**
 * 首次启动探测（spec §8）：`agents/staff0.agent.config.json` 不存在则自动创建。
 * 幂等——已存在一律不覆盖（老板可能改过）。
 */
export function ensureStaff0(ws: Workspace): "created" | "exists" {
  const file = staff0File(ws);
  if (fs.existsSync(file)) return "exists";
  fs.mkdirSync(agentsDir(ws), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(staff0Config(), null, 2)}\n`);
  return "created";
}
