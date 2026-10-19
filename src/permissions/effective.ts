import { accumulatePermissions, resolvePermissionTable } from "./resolve.ts";
import { DEFAULT_PERMISSIONS } from "./defaults.ts";
import type { OnDiskPermissions, ResolvedPermissions, RuntimeGrants } from "./types.ts";

/**
 * 有效权限 = 落盘路线（项目 → 员工，D11）累加后，再叠加**运行时授予**（D13）：
 * ① 自己的工作目录 → 所有工具；② 主管对管理子树的写权；③ 技能库根 → read。
 */
export function effectivePermissions(input: {
  onDisk: readonly OnDiskPermissions[];
  runtime: RuntimeGrants;
}): ResolvedPermissions {
  const resolved = accumulatePermissions(input.onDisk.map((source) => resolvePermissionTable(source.table, source.baseDir)));
  const tools = new Set<string>([...Object.keys(DEFAULT_PERMISSIONS), ...Object.keys(resolved)]);
  for (const tool of tools) {
    const paths = resolved[tool] ?? [];
    paths.push(input.runtime.workdir);
    if (tool === "write") paths.push(...input.runtime.managedWriteDirs);
    if (tool === "read") paths.push(...input.runtime.readRoots);
    resolved[tool] = paths;
  }
  return resolved;
}

/** 某工具的有效路径：未登记的工具 = 只有运行时工作目录。 */
export function pathsFor(effective: ResolvedPermissions, tool: string, workdir: string): string[] {
  return [...(effective[tool] ?? [workdir])];
}
