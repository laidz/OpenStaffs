import fs from "node:fs";
import path from "node:path";
import { createWorkspace, type Workspace } from "../../src/domain/paths.ts";
import { projectConfigFile, spaceConfigFile } from "../../src/config/naming.ts";

export type OfficeSpec = {
  space?: { alias?: string; prompt?: string; skills?: string[]; mcp?: string[] };
  /** path 是相对 agents/ 的部门路径，如 "eng" 或 "eng/platform"。 */
  departments?: { path: string; alias?: string; head?: string[]; prompt?: string; skills?: string[]; mcp?: string[] }[];
  agents?: {
    id: string; department?: string; alias?: string; model?: string; thinkingLevel?: string;
    prompt?: string; skills?: string[]; mcp?: string[]; permissions?: Record<string, string[]>; memory?: boolean;
  }[];
  projects?: { id: string; alias?: string; members?: string[]; owner?: string[]; prompt?: string; skills?: string[]; mcp?: string[] }[];
};

export function writeJsonFile(file: string, body: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
}

/** 按 spec §3 铺一个办公空间（定义树 = *.config.json；不含旧多文件载体）。 */
export function seedOffice(root: string, spec: OfficeSpec): Workspace {
  const ws = createWorkspace(root);
  for (const dir of ["agents", "projects", "work"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
  if (spec.space !== undefined) writeJsonFile(spaceConfigFile(ws), spec.space);
  for (const department of spec.departments ?? []) {
    const files = { ...department } as Record<string, unknown>;
    delete files["path"];
    writeJsonFile(path.join(root, "agents", department.path, "department.config.json"), files);
  }
  for (const agent of spec.agents ?? []) {
    const files = { ...agent } as Record<string, unknown>;
    delete files["id"];
    delete files["department"];
    const dir = agent.department === undefined ? path.join(root, "agents") : path.join(root, "agents", agent.department);
    writeJsonFile(path.join(dir, `${agent.id}.agent.config.json`), files);
  }
  for (const project of spec.projects ?? []) {
    const files = { ...project } as Record<string, unknown>;
    delete files["id"];
    writeJsonFile(projectConfigFile(ws, project.id), files);
  }
  return ws;
}
