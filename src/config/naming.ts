import path from "node:path";
import { projectsDir, spaceDir, type Workspace } from "../domain/paths.ts";

export const SPACE_CONFIG_NAME = "space.config.json";
export const DEPARTMENT_CONFIG_NAME = "department.config.json";
export const AGENT_CONFIG_SUFFIX = ".agent.config.json";
export const PROJECT_CONFIG_SUFFIX = ".project.config.json";

export function spaceConfigFile(ws: Workspace): string {
  return path.join(spaceDir(ws), SPACE_CONFIG_NAME);
}

/** 项目 = 扁平配置文件（D26；无目录、无 data/）。 */
export function projectConfigFile(ws: Workspace, id: string): string {
  return path.join(projectsDir(ws), `${id}${PROJECT_CONFIG_SUFFIX}`);
}

export function departmentConfigFile(dir: string): string {
  return path.join(dir, DEPARTMENT_CONFIG_NAME);
}

export function agentConfigFile(dir: string, id: string): string {
  return path.join(dir, `${id}${AGENT_CONFIG_SUFFIX}`);
}

export function agentIdOfConfigFile(file: string): string | undefined {
  const base = path.basename(file);
  if (!base.endsWith(AGENT_CONFIG_SUFFIX)) return undefined;
  const id = base.slice(0, -AGENT_CONFIG_SUFFIX.length);
  return id === "" ? undefined : id;
}

export function projectIdOfConfigFile(file: string): string | undefined {
  const base = path.basename(file);
  if (!base.endsWith(PROJECT_CONFIG_SUFFIX)) return undefined;
  const id = base.slice(0, -PROJECT_CONFIG_SUFFIX.length);
  return id === "" ? undefined : id;
}

export function isConfigFileName(base: string): boolean {
  return (
    base === SPACE_CONFIG_NAME ||
    base === DEPARTMENT_CONFIG_NAME ||
    base.endsWith(AGENT_CONFIG_SUFFIX) ||
    base.endsWith(PROJECT_CONFIG_SUFFIX)
  );
}
