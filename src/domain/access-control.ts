import fs from "node:fs";
import path from "node:path";
import { membersFile, projectsDir, type Workspace } from "./paths.ts";
import type { EmployeeId, ProjectName } from "./types.ts";

export type AccessContext = {
  root: string;
  cwd: string;
  selfId: string;
  memberProjects: ProjectName[];
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

export function isWriteAllowed(ctx: AccessContext, targetPath: string): boolean {
  if (targetPath.trim() === "") return false;
  // 顶层保留命名空间（agents/、projects/）在相对路径中出现时按工作区根解析，
  // 否则按 cwd 解析。理由见 ledger Task 4 Ruling：避免群聊 cwd 下
  // "agents/bob/x.md" 被误判为落在项目内而放行。
  let absolute: string;
  if (path.isAbsolute(targetPath)) {
    absolute = targetPath;
  } else if (/^(?:agents|projects)(?:[/\\]|$)/u.test(targetPath)) {
    absolute = path.resolve(ctx.root, targetPath);
  } else {
    absolute = path.resolve(ctx.cwd, targetPath);
  }
  const relative = path.relative(ctx.root, absolute);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  const parts = relative.split(path.sep);
  if (parts[0] === "agents" && parts[1] === ctx.selfId) return true;
  if (parts[0] === "projects" && parts[1] !== undefined && ctx.memberProjects.includes(parts[1])) return true;
  return false;
}
