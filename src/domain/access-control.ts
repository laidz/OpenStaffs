import type { ResolvedPermissions } from "../permissions/types.ts";
import { listProjects, loadProject } from "./project.ts";
import type { Workspace } from "./paths.ts";
import type { EmployeeId, ProjectName } from "./types.ts";

/**
 * 会话访问上下文：权限已含运行时授予，路径均为绝对路径。
 * 判定统一走 `src/tools/gate.ts` 的 `gateToolCall`（D28）；本模块只做成员 / 项目查询。
 */
export type AccessContext = {
  root: string;
  cwd: string;
  selfId: string;
  permissions: ResolvedPermissions;
};

/** 群成员（读 projects/<id>.project.config.json 的 members；D22）；项目缺失 → []。 */
export function parseMembers(ws: Workspace, name: ProjectName): EmployeeId[] {
  try {
    return [...loadProject(ws, name).config.fields.members];
  } catch {
    return [];
  }
}

export function projectsOf(ws: Workspace, id: EmployeeId): ProjectName[] {
  return listProjects(ws).filter((project) => project.config.fields.members.includes(id)).map((project) => project.id);
}
