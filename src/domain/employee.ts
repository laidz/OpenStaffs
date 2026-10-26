// src/domain/employee.ts —— 人 = 单一 `agents/.../<名字>.agent.config.json`（D1/D2/D5）。
// 定位走 P2 的 org 模块（`loadPerson`），字段解析走 P3 的 `src/config/*`；
// 记忆是框架原生能力（`work/<id>/memory/`），这里只解析开关。
import { loadAgentConfig } from "../config/load.ts";
import { loadPerson } from "./org.ts";
import { workDir, type Workspace } from "./paths.ts";
import { readMemoryFlag } from "./config.ts";
import type { PermissionTable } from "../config/schema.ts";
import type { EmployeeId, ModelChoice } from "./types.ts";

export type Employee = {
  id: EmployeeId;
  /** 定义文件所在部门目录（agents/ 子树里的某一层；= person.dir）。 */
  dir: string;
  /** 工作目录 work/<id>/（D20/D27）。 */
  workDir: string;
  /** 原生记忆是否启用：员工显式值 → 空间默认 → true。 */
  memoryEnabled: boolean;
  /** 模型覆盖（config 的 model / thinkingLevel）。 */
  model: ModelChoice;
  /** 展示名（alias 缺省 = id）。 */
  alias?: string;
  /** config 的内联 prompt（未渲染；渲染见 capabilities/prompt.ts）。 */
  prompt?: string;
  /** 技能名引用（D17）。 */
  skills: string[];
  /** MCP 名引用（D16）。 */
  mcp: string[];
  /** 按工具权限（D9/D15）。 */
  permissions?: PermissionTable;
};

/** 读人：P2 定位（`loadPerson`，不存在 → 抛「员工不存在」）+ P3 解析的字段 + 工作目录记忆。 */
export function loadEmployee(ws: Workspace, id: EmployeeId): Employee {
  const person = loadPerson(ws, id); // P2：不存在会抛 `员工不存在: <id>`
  const fields = loadAgentConfig(person.dir, id)?.fields; // P3：缺失 / 坏 JSON → undefined（按空配置）
  const permissions = fields?.permissions;
  const model: ModelChoice = {
    model: fields?.model ?? "",
    ...(fields?.thinkingLevel === undefined ? {} : { thinkingLevel: fields.thinkingLevel }),
  };
  return {
    id,
    dir: person.dir,
    workDir: workDir(ws, id),
    memoryEnabled: fields?.memory ?? readMemoryFlag(ws) ?? true,
    model,
    skills: fields?.skills ?? [],
    mcp: fields?.mcp ?? [],
    ...(fields?.alias === undefined ? {} : { alias: fields.alias }),
    ...(fields?.prompt === undefined ? {} : { prompt: fields.prompt }),
    ...(permissions === undefined ? {} : { permissions }),
  };
}
