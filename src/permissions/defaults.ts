import type { PermissionTable } from "../config/schema.ts";

/**
 * 默认权限表（D14）：write 空、read / bash 为 `./`；**未登记的工具默认空**。
 * 缺省生效点 = `permissions/effective.ts`（某层 `permissions` 缺项时按此兜底）。
 */
export const DEFAULT_PERMISSIONS: Readonly<PermissionTable> = { write: [], read: ["./"], bash: ["./"] };
