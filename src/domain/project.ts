import fs from "node:fs";
import { PROJECT_CONFIG_SUFFIX } from "../config/naming.ts";
import { loadProjectConfig } from "../config/load.ts";
import type { LoadedConfig } from "../config/schema.ts";
import { projectsDir, type Workspace } from "./paths.ts";
import type { ProjectName } from "./types.ts";

export type Project = { id: ProjectName; alias: string; config: LoadedConfig };

/** 读项目；config 缺失/坏 JSON → 抛错（与现状「项目不存在」一致）。 */
export function loadProject(ws: Workspace, id: ProjectName): Project {
  const config = loadProjectConfig(ws, id);
  if (config === undefined) throw new Error(`项目不存在: ${id}`);
  return { id, alias: config.fields.alias ?? id, config };
}

/** 扫描 projects/*.project.config.json（坏文件跳过）。 */
export function listProjects(ws: Workspace): Project[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(projectsDir(ws), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Project[] = [];
  for (const entry of entries.filter((item) => item.isFile() && !item.name.startsWith(".")).map((item) => item.name).sort()) {
    if (!entry.endsWith(PROJECT_CONFIG_SUFFIX)) continue;
    const id = entry.slice(0, -PROJECT_CONFIG_SUFFIX.length);
    if (id === "") continue;
    const config = loadProjectConfig(ws, id);
    if (config === undefined) continue;
    out.push({ id, alias: config.fields.alias ?? id, config });
  }
  return out;
}
