// src/capabilities/scopes.ts —— 作用域链（D12）。
// B5 裁定：本文件是作用域链的**唯一实现**；后续阶段只能 import 与追加导出，不得改写其行为。
import path from "node:path";
import { ancestryOf, findPerson, loadOrg } from "../domain/org.ts";
import { loadAgentConfig, loadDepartmentConfig, loadProjectConfig, loadSpaceConfig } from "../config/load.ts";
import type { LoadedConfig } from "../config/schema.ts";
import { agentsDir, type Workspace } from "../domain/paths.ts";

/**
 * 能力累加路线（D12）：空间 → 部门（根 → 叶）→ 项目（仅群聊）→ 员工。
 * 纯函数式接缝：只吃目录，不依赖 org；缺配置的层直接跳过。
 */
export function scopeChain(input: {
  ws: Workspace;
  agentId: string;
  agentDir: string;
  departmentDirs: readonly string[];
  projectId?: string;
}): LoadedConfig[] {
  const out: LoadedConfig[] = [];
  const space = loadSpaceConfig(input.ws);
  if (space !== undefined) out.push(space);
  for (const dir of [...new Set(input.departmentDirs)]) {
    const department = loadDepartmentConfig(dir);
    if (department !== undefined) out.push(department);
  }
  if (input.projectId !== undefined) {
    const project = loadProjectConfig(input.ws, input.projectId);
    if (project !== undefined) out.push(project);
  }
  const agent = loadAgentConfig(input.agentDir, input.agentId);
  if (agent !== undefined) out.push(agent);
  return out;
}

/** 作用域链的 org 接缝（P2 的 org.ts 只在这里被读到）。 */
export function scopesForOrg(ws: Workspace, agentId: string, projectId?: string): LoadedConfig[] {
  const tree = loadOrg(ws);
  const person = findPerson(tree, agentId);
  if (person === undefined) return [];
  return scopeChain({
    ws,
    agentId,
    agentDir: person.dir,
    // P2 的 OrgDepartment 只带相对路径（无绝对 dir）；这里按 org.ts 内部同口径拼绝对目录。
    departmentDirs: ancestryOf(tree, person.departmentPath).map((department) => path.join(agentsDir(ws), department.path)),
    ...(projectId === undefined ? {} : { projectId }),
  });
}
