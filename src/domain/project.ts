import fs from "node:fs";
import path from "node:path";
import { membersFile, projectDir, type Workspace } from "./paths.ts";
import type { EmployeeId, ProjectName } from "./types.ts";

export type Project = { id: ProjectName; alias: string };

function assertValidProjectId(id: string): void {
  const invalid =
    id.trim() === "" ||
    /\s/u.test(id) ||
    id.includes("/") ||
    id.includes("\\") ||
    id.includes("\0") ||
    id === "." ||
    id === ".." ||
    id.startsWith(".");
  if (invalid) {
    throw new Error(`项目 id 不合法: ${JSON.stringify(id)}（不得为空/含空白或路径分隔符/以点开头）`);
  }
}

/**
 * 建群 = 立项：在 projects/ 下创建 <id>/（AGENTS.md + data/ + members.md + project.json）。
 * id 是唯一标识（目录名，不可变）；alias 是可变展示名。不预建任何会话（按需创建）。
 */
export function createProject(ws: Workspace, id: ProjectName, memberIds: EmployeeId[], alias?: string): Project {
  assertValidProjectId(id);
  const dir = projectDir(ws, id);
  if (fs.existsSync(dir)) throw new Error(`项目已存在: ${id}`);
  const displayName = alias === undefined || alias.trim() === "" ? id : alias.trim();
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.writeFileSync(path.join(dir, "AGENTS.md"), `# ${displayName}\n\n（任务规范：目标 / 范围 / 交付标准）\n`);
  fs.writeFileSync(membersFile(ws, id), ["# 成员", ...memberIds.map((m) => `- ${m}`), ""].join("\n"));
  fs.writeFileSync(path.join(dir, "project.json"), `${JSON.stringify({ alias: displayName }, null, 2)}\n`);
  return { id, alias: displayName };
}
