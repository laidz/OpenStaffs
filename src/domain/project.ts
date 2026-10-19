import fs from "node:fs";
import { PROJECT_CONFIG_SUFFIX, projectConfigFile } from "../config/naming.ts";
import { loadProjectConfig } from "../config/load.ts";
import type { LoadedConfig } from "../config/schema.ts";
import { defaultPermissionTable } from "../permissions/defaults.ts";
import { projectsDir, type Workspace } from "./paths.ts";
import type { EmployeeId, ProjectName } from "./types.ts";

export type Project = { id: ProjectName; alias: string; config: LoadedConfig };

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

/** 建群 = 立项：写 projects/<id>.project.config.json（扁平；无目录、无 data/，D26）。 */
export function createProject(ws: Workspace, id: ProjectName, memberIds: EmployeeId[], alias?: string): Project {
  assertValidProjectId(id);
  const file = projectConfigFile(ws, id);
  if (fs.existsSync(file)) throw new Error(`项目已存在: ${id}`);
  const displayName = alias === undefined || alias.trim() === "" ? id : alias.trim();
  const body = {
    alias: displayName,
    members: [...memberIds],
    permissions: defaultPermissionTable(),
  };
  fs.mkdirSync(projectsDir(ws), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  const config = loadProjectConfig(ws, id);
  // 刚写出的配置读不回来 = 文件写坏 / 内容非法；不得用 `!` 把 undefined 蒙混成配置。
  if (config === undefined) throw new Error(`项目配置写入后无法读取（文件损坏或内容非法）: ${id}`);
  return { id, alias: displayName, config };
}

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
