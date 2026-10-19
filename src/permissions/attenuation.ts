import { isSubsetOf } from "./match.ts";
import { pathsFor } from "./effective.ts";
import { resolvePermissionTable } from "./resolve.ts";
import type { PermissionTable } from "../config/schema.ts";
import type { ResolvedPermissions } from "./types.ts";

export type AttenuationViolation = { tool: string; paths: string[] };

/**
 * 写入校验（D15 / D28，全工具统一、与工具语义无关）：
 * 请求里每个工具的每条路径，都必须落在写者该工具的**有效集**之内。
 *
 * 包含判定走 Task 3 的 `isSubsetOf`（单条请求 ⊆ 写者有效集），与计划里
 * 「逐条 `matchesPath`」语义等价：子目录可授、父目录不可授、空集恒 ⊆、
 * 大小写敏感、`"/"` 特例由 `matchesPath` 负责（R-P3-9）。
 */
export function checkAttenuation(
  requested: PermissionTable,
  requestedBaseDir: string,
  writer: ResolvedPermissions,
  workdir: string,
): { ok: true } | { ok: false; violations: AttenuationViolation[] } {
  const resolved = resolvePermissionTable(requested, requestedBaseDir);
  const violations: AttenuationViolation[] = [];
  for (const [tool, paths] of Object.entries(resolved)) {
    const granted = pathsFor(writer, tool, workdir);
    const outside = paths.filter((target) => !isSubsetOf([target], granted));
    if (outside.length > 0) violations.push({ tool, paths: outside });
  }
  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}
