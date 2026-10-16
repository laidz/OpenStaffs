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

export function isWriteAllowed(ctx: AccessContext, targetPath: string): boolean {
  if (targetPath.trim() === "") return false;
  const target = path.resolve(ctx.cwd, targetPath);
  if (path.basename(target) === "permission.json") return false;
  if (isWithin(path.join(ctx.root, "agents", ctx.selfId), target)) return true;
  for (const project of ctx.memberProjects) {
    if (isWithin(path.join(ctx.root, "projects", project), target)) return true;
  }
  return isWriteAllowedByPermission(ctx.permissionFiles, target);
}
