import fs from "node:fs";
import path from "node:path";
import { membersFile, projectsDir, type Workspace } from "./paths.ts";
import { isWriteAllowedByPermission } from "./permissions.ts";
import type { EmployeeId, ProjectName } from "./types.ts";

export type AccessContext = {
  root: string;
  cwd: string;
  selfId: string;
  memberProjects: ProjectName[];
  permissionFiles: string[];
  /**
   * 运行时可写目录（D13，不落盘）：① 自己的工作目录；② 主管对自己所在部门整棵子树的写权（穿透）。
   * 由装配层（conversations.accessFor）计算，配置里不出现。
   */
  writableDirs: string[];
};

export function parseMembers(ws: Workspace, name: ProjectName): EmployeeId[] {
  const file = membersFile(ws, name);
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter((line) => line !== "");
}

export function projectsOf(ws: Workspace, id: EmployeeId): ProjectName[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(projectsDir(ws), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  return names.filter((name) => parseMembers(ws, name).includes(id));
}

function isWithin(baseDir: string, target: string): boolean {
  const rel = path.relative(baseDir, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * 受保护的配置文件（人一律不可写；老板 / 框架（授权流程）不受此限）：
 * - `department.config.json` 部门声明（写 head = 自任命）；
 * - `*.agent.config.json` 人定义（§6：人不可写任何 agent 配置，含自己的）；
 * - `permission.json` / `*.permission.json` 授权文件（防自写提权）。
 *
 * 匹配对大小写不敏感：目标卷（如 macOS 默认 APFS）可能大小写不敏感，
 * `Bob.AGENT.CONFIG.JSON` 会覆盖 `bob.agent.config.json`，故先归一为小写再比对。
 */
export function isProtectedConfigName(base: string): boolean {
  const name = base.toLowerCase();
  return (
    name === "department.config.json" ||
    name === "permission.json" ||
    name.endsWith(".agent.config.json") ||
    name.endsWith(".permission.json")
  );
}

export function isWriteAllowed(ctx: AccessContext, targetPath: string): boolean {
  if (targetPath.trim() === "") return false;
  const target = path.resolve(ctx.cwd, targetPath);
  if (isProtectedConfigName(path.basename(target))) return false;
  for (const dir of ctx.writableDirs) {
    if (isWithin(dir, target)) return true;
  }
  for (const project of ctx.memberProjects) {
    if (isWithin(path.join(ctx.root, "projects", project), target)) return true;
  }
  return isWriteAllowedByPermission(ctx.permissionFiles, target);
}
