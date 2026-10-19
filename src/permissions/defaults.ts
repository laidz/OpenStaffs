import type { PermissionTable } from "../config/schema.ts";

/** 新建设置：write 空、read / bash 为 ./；**新工具默认空**（D14）。 */
export const DEFAULT_PERMISSIONS: Readonly<PermissionTable> = { write: [], read: ["./"], bash: ["./"] };

/** 某工具的默认路径（未登记的工具 = 空）。 */
export function defaultPathsFor(tool: string): string[] {
  return [...(DEFAULT_PERMISSIONS[tool] ?? [])];
}

/** 新建 agent / 项目时写入的 permissions 表。 */
export function defaultPermissionTable(extraTools: readonly string[] = []): PermissionTable {
  const table: PermissionTable = { write: [], read: ["./"], bash: ["./"] };
  for (const tool of extraTools) {
    if (tool.trim() !== "" && table[tool] === undefined) table[tool] = [];
  }
  return table;
}
