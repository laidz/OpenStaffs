// src/domain/org-config.ts —— 部门 / 人配置文件的命名解析、解析与扫描（D34：独立域模块）。
// 只解析 P2 需要的窄字段：人 = { alias?, model, prompt }；部门 = { alias?, head }。
// P3 的五层统一解析器会在这两个窄接口内部扩展字段，org 模块无需改动。
import fs from "node:fs";
import path from "node:path";
import { agentsDir, type Workspace } from "./paths.ts";
import type { ModelChoice } from "./types.ts";

/** 人 = `<id>.agent.config.json`（id = 文件名主干，全局唯一）。 */
export const AGENT_CONFIG_SUFFIX = ".agent.config.json";
/** 部门声明文件名（可选：目录本身即部门，声明只为 alias / head）。 */
export const DEPARTMENT_CONFIG_NAME = "department.config.json";

export type AgentConfig = {
  id: string;
  /** 人配置文件所在的部门目录（绝对路径）。 */
  dir: string;
  /** 相对 agents/ 的部门路径（根 = ""）。 */
  departmentPath: string;
  /** 定义文件绝对路径。 */
  file: string;
  alias?: string;
  model: ModelChoice;
  /** 内联提示词（D5）；缺省 ""。 */
  prompt: string;
};

export type DepartmentConfig = {
  /** 相对 agents/ 的路径；根 = ""。 */
  path: string;
  /** 文件夹名；根 = "agents"。 */
  name: string;
  dir: string;
  /** `<dir>/department.config.json`（文件可不存在）。 */
  file: string;
  alias?: string;
  /** 配置里写的负责人名单（**未校验**；「只能从本级成员里选」在 org 模块过滤）。 */
  head: string[];
};

export type OrgScan = { departments: DepartmentConfig[]; agents: AgentConfig[]; warnings: string[] };

export function agentConfigFileName(id: string): string {
  return `${id}${AGENT_CONFIG_SUFFIX}`;
}

/** 文件名 → 人 id；不是人配置文件 / 空 id / 带路径分隔符 → undefined。 */
export function agentIdOfConfigFile(fileName: string): string | undefined {
  if (!fileName.endsWith(AGENT_CONFIG_SUFFIX)) return undefined;
  const id = fileName.slice(0, -AGENT_CONFIG_SUFFIX.length);
  if (id === "" || id.includes("/") || id.includes("\\")) return undefined;
  return id;
}

/** 读 JSON 对象；缺失 / 坏 JSON / 非对象 → undefined（一律按"没写"处理，不抛）。 */
function readJsonObject(file: string): Record<string, unknown> | undefined {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** 人配置文件 → AgentConfig（坏文件按缺省，不抛）。 */
export function parseAgentConfig(id: string, dir: string, departmentPath: string): AgentConfig {
  const file = path.join(dir, agentConfigFileName(id));
  const parsed = readJsonObject(file) ?? {};
  const alias = optionalString(parsed["alias"]);
  const thinkingLevel = optionalString(parsed["thinkingLevel"]);
  const model: ModelChoice = {
    model: optionalString(parsed["model"]) ?? "",
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
  };
  const prompt = typeof parsed["prompt"] === "string" ? parsed["prompt"] : "";
  return { id, dir, departmentPath, file, model, prompt, ...(alias === undefined ? {} : { alias }) };
}

/** 部门声明文件 → DepartmentConfig（坏文件按缺省：无 alias、无 head）。 */
export function parseDepartmentConfig(dir: string, name: string, deptPath: string): DepartmentConfig {
  const file = path.join(dir, DEPARTMENT_CONFIG_NAME);
  const parsed = readJsonObject(file);
  const alias = optionalString(parsed?.["alias"]);
  const rawHead = parsed?.["head"];
  const head = Array.isArray(rawHead)
    ? rawHead.map(optionalString).filter((value): value is string => value !== undefined)
    : [];
  return { path: deptPath, name, dir, file, head, ...(alias === undefined ? {} : { alias }) };
}

/** id 是否合法（空白 / `@` 与提及语法冲突；`__` 前缀是保留参与者 id）。 */
function idWarning(id: string): string | undefined {
  if (/\s/u.test(id)) return `人 id 含空白（无法被 @ 定向）：${JSON.stringify(id)}`;
  if (id.includes("@")) return `人 id 含 @（与提及语法冲突）：${JSON.stringify(id)}`;
  if (id.startsWith("__")) return `人 id 以 __ 开头（保留给 boss / system）：${JSON.stringify(id)}`;
  return undefined;
}

/**
 * 递归扫描 `agents/`：目录 = 部门（可嵌套），`<id>.agent.config.json` = 人。
 * - **根部门恒在**（`agents/` 不存在也给 `{ path: "" }`），调用方不必兜底；
 * - 隐藏条目（`.` 开头）跳过；非人配置文件跳过；
 * - 坏文件不抛、只按缺省解析；可疑 id 收录并记 warnings；
 * - 顺序确定：同级**先收录文件（人）**，再按名字排序进入子目录；部门先于其下内容。
 *   （与前端 `flattenOrg` 同口径：本部门的人在前，再进子部门）
 */
export function scanOrg(ws: Workspace): OrgScan {
  const departments: DepartmentConfig[] = [];
  const agents: AgentConfig[] = [];
  const warnings: string[] = [];

  collect(agentsDir(ws), "", "agents");
  return { departments, agents, warnings };

  function collect(dir: string, deptPath: string, name: string): void {
    departments.push(parseDepartmentConfig(dir, name, deptPath));
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 目录不存在：该部门只有声明，没有人
    }
    const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).filter((entry) => !entry.name.startsWith("."));
    for (const entry of sorted.filter((entry) => !entry.isDirectory())) {
      const id = agentIdOfConfigFile(entry.name);
      if (id === undefined) continue;
      const warning = idWarning(id);
      if (warning !== undefined) warnings.push(warning);
      agents.push(parseAgentConfig(id, dir, deptPath));
    }
    for (const entry of sorted.filter((entry) => entry.isDirectory())) {
      const childPath = deptPath === "" ? entry.name : `${deptPath}/${entry.name}`;
      collect(path.join(dir, entry.name), childPath, entry.name);
    }
  }
}
