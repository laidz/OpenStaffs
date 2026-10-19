import type { PermissionTable } from "../config/schema.ts";

export type { PermissionTable };

/** 解析为**绝对路径**后的权限表。 */
export type ResolvedPermissions = Record<string, string[]>;

/** 运行时授予（D13，不落盘）。 */
export type RuntimeGrants = {
  /** agent 自己的工作目录 → 所有工具。 */
  workdir: string;
  /** 技能库根 → read（否则 agent 读不到技能正文）。 */
  readRoots: string[];
  /** 主管对管理子树的写权。 */
  managedWriteDirs: string[];
};

/** 落盘路线的一层（D11）：项目 / 员工配置的 permissions + 其所在目录。 */
export type OnDiskPermissions = { table: PermissionTable; baseDir: string };
