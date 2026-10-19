import path from "node:path";
import type { PermissionTable } from "../config/schema.ts";
import type { ResolvedPermissions } from "./types.ts";

/** 相对路径按 baseDir 归一为绝对路径（与旧人级授权文件的相对语义一致）。 */
export function resolvePermissionTable(table: PermissionTable, baseDir: string): ResolvedPermissions {
  const out: ResolvedPermissions = {};
  for (const [rawTool, paths] of Object.entries(table)) {
    const tool = rawTool.trim();
    if (tool === "") continue;
    out[tool] = paths.filter((entry) => entry.trim() !== "").map((entry) => path.resolve(baseDir, entry.trim()));
  }
  return out;
}

/** 累加：同名工具按来源顺序拼接，**接受同值重复、不覆盖**（D10）。 */
export function accumulatePermissions(sources: readonly ResolvedPermissions[]): ResolvedPermissions {
  const out: ResolvedPermissions = {};
  for (const source of sources) {
    for (const [tool, paths] of Object.entries(source)) {
      (out[tool] ??= []).push(...paths);
    }
  }
  return out;
}
