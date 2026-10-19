import fs from "node:fs";
import path from "node:path";
import { agentConfigFile, departmentConfigFile, projectConfigFile, spaceConfigFile } from "./naming.ts";
import { parseConfigFields, type LoadedConfig, type ScopeKind } from "./schema.ts";
import type { Workspace } from "../domain/paths.ts";

/** 读一个 `*.config.json`：缺失 / 坏 JSON / 坏顶层 → undefined（安全降级，不崩）。 */
export function readConfigFile(file: string, scope: ScopeKind, id: string): LoadedConfig | undefined {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const { fields, issues } = parseConfigFields(parsed);
  return { scope, id, file, baseDir: path.dirname(file), fields, issues };
}

export function loadSpaceConfig(ws: Workspace): LoadedConfig | undefined {
  return readConfigFile(spaceConfigFile(ws), "space", "space");
}

export function loadProjectConfig(ws: Workspace, id: string): LoadedConfig | undefined {
  return readConfigFile(projectConfigFile(ws, id), "project", id);
}

/** 部门 id = 相对办公空间的部门路径（展示 / 诊断用）。 */
export function loadDepartmentConfig(dir: string): LoadedConfig | undefined {
  return readConfigFile(departmentConfigFile(dir), "department", path.basename(dir));
}

export function loadAgentConfig(dir: string, id: string): LoadedConfig | undefined {
  return readConfigFile(agentConfigFile(dir, id), "agent", id);
}
