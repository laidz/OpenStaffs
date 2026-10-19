// src/domain/employee.ts —— 人 = 单一 `agents/.../<名字>.agent.config.json`（D1/D2/D5）。
// 定位走 P2 的 org 模块（`loadPerson` / `listPeople`），字段解析走 P3 的 `src/config/*`；
// 记忆读自工作目录 `work/<id>/MEMORY.md`（D20/D27）。不再有 AGENTS.md / profile.md。
import fs from "node:fs";
import { loadAgentConfig } from "../config/load.ts";
import { listPeople, loadPerson } from "./org.ts";
import { memoryFile, workDir, type Workspace } from "./paths.ts";
import type { PermissionTable } from "../config/schema.ts";
import type { EmployeeId, ModelChoice } from "./types.ts";

export type Employee = {
  id: EmployeeId;
  /** 定义文件所在部门目录（agents/ 子树里的某一层；= person.dir）。 */
  dir: string;
  /** 工作目录 work/<id>/（D20/D27）。 */
  workDir: string;
  /** 记忆正文（读自 work/<id>/MEMORY.md；缺失 → 空串）。 */
  memory: string;
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

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

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
    memory: readText(memoryFile(ws, id)).trim(),
    model,
    skills: fields?.skills ?? [],
    mcp: fields?.mcp ?? [],
    ...(fields?.alias === undefined ? {} : { alias: fields.alias }),
    ...(fields?.prompt === undefined ? {} : { prompt: fields.prompt }),
    ...(permissions === undefined ? {} : { permissions }),
  };
}

/** 首次使用某 agent 时补建其工作目录与空 MEMORY.md（幂等，不覆盖已有内容；D27）。 */
export function ensureMemory(ws: Workspace, id: EmployeeId): void {
  fs.mkdirSync(workDir(ws, id), { recursive: true });
  const file = memoryFile(ws, id);
  if (!fs.existsSync(file)) fs.writeFileSync(file, "");
}

/** 全部人（P2 的组织发现顺序；逐个补齐能力字段）。 */
export function listEmployees(ws: Workspace): Employee[] {
  return listPeople(ws).map((person) => loadEmployee(ws, person.id));
}

/** 人级 instructions = 内联 prompt（D5 取消员工侧 AGENTS.md / profile.md）。 */
export function renderInstructions(person: Employee): string {
  return person.prompt ?? "";
}
