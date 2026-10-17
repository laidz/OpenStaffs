import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stateDir, type Workspace } from "./paths.ts";
import type { ModelChoice } from "./types.ts";

export type ProviderEntry = { apiKey: string };

export type WorkspaceConfig = {
  /** 多供应商：id → 凭据；key 即模型引用 "provider/modelId" 里的供应商。 */
  providers: Record<string, ProviderEntry>;
  /** 全局默认模型 "provider/modelId"（员工未配模型时的兜底）。 */
  model: string;
  /** 全局默认思考强度（员工未配时兜底；配置端不校验档位，展示层按模型能力判定）。 */
  thinkingLevel?: string;
  port: number;
};

/** 默认端口（config.json 未给 port 时）。 */
export const DEFAULT_PORT = 4319;

export function configFile(ws: Workspace): string {
  return path.join(stateDir(ws), "config.json");
}

function requiredString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** 解析模型引用 "provider/modelId"：第一个 / 前为供应商，其余为模型 id（可再含 /）；两侧非空才合法。 */
export function parseModelRef(raw: string): { provider: string; modelId: string } | undefined {
  const slash = raw.indexOf("/");
  if (slash < 0) return undefined;
  const provider = raw.slice(0, slash).trim();
  const modelId = raw.slice(slash + 1).trim();
  if (provider === "" || modelId === "") return undefined;
  return { provider, modelId };
}

/** 解析 providers map：坏条目（非对象 / 缺 apiKey / 空 id）跳过；无有效条目 → undefined。 */
function parseProviders(value: unknown): Record<string, ProviderEntry> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, ProviderEntry> = {};
  for (const [rawId, entry] of Object.entries(value)) {
    const id = rawId.trim();
    const apiKey =
      typeof entry === "object" && entry !== null
        ? requiredString((entry as Record<string, unknown>).apiKey)
        : undefined;
    if (id === "" || apiKey === undefined) continue;
    out[id] = { apiKey };
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** 读取全局配置；缺失/坏 JSON/无有效供应商/缺合法默认模型 → undefined（未配置模式）。 */
export function readConfig(ws: Workspace): WorkspaceConfig | undefined {
  let raw = "";
  try {
    raw = fs.readFileSync(configFile(ws), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const providers = parseProviders(parsed.providers);
    const model = requiredString(parsed.model);
    if (providers === undefined || model === undefined || parseModelRef(model) === undefined) return undefined;
    // 思考档位不校验（每个模型支持的档不同；不支持的档由展示层呈现为 null）。
    const thinkingLevel = requiredString(parsed.thinkingLevel);
    const port =
      typeof parsed.port === "number" && Number.isInteger(parsed.port) && parsed.port > 0 && parsed.port < 65536
        ? parsed.port
        : DEFAULT_PORT;
    return { providers, model, ...(thinkingLevel === undefined ? {} : { thinkingLevel }), port };
  } catch {
    return undefined;
  }
}

/** 老板显示名默认值。 */
export const DEFAULT_BOSS_NAME = "老板";

/** 读老板显示名（config.json 的 bossName）；缺失/坏 JSON/空串 → 默认。 */
export function readBossName(ws: Workspace): string {
  let raw = "";
  try {
    raw = fs.readFileSync(configFile(ws), "utf8");
  } catch {
    return DEFAULT_BOSS_NAME;
  }
  try {
    const parsed = JSON.parse(raw) as { bossName?: unknown };
    return typeof parsed.bossName === "string" && parsed.bossName.trim() !== ""
      ? parsed.bossName.trim()
      : DEFAULT_BOSS_NAME;
  } catch {
    return DEFAULT_BOSS_NAME;
  }
}

/**
 * 外部技能目录（config.json 的 skillPaths）：老板的全局技能库，多个 agent 工具共用。
 * 写法：`~` 开头 → 家目录；绝对路径 → 原样；其余 → 相对办公空间根目录。
 * 去重（先出现者胜）；文件缺失 / 坏 JSON / 非数组 / 坏条目 → 跳过（不崩）。
 */
export function readSkillPaths(ws: Workspace): string[] {
  let raw = "";
  try {
    raw = fs.readFileSync(configFile(ws), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { skillPaths?: unknown };
    if (!Array.isArray(parsed.skillPaths)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const entry of parsed.skillPaths) {
      const text = requiredString(entry);
      if (text === undefined) continue;
      const abs = text === "~" || text.startsWith("~/")
        ? path.join(os.homedir(), text.slice(1))
        : path.resolve(ws.root, text);
      if (seen.has(abs)) continue;
      seen.add(abs);
      out.push(abs);
    }
    return out;
  } catch {
    return [];
  }
}

/** MCP 凭据：config.json 的 mcp.<server>.<key>（机器私有；独立读取，未配置模式也可用）。 */
export type McpCredentials = Record<string, Record<string, string>>;

export function readMcpCredentials(ws: Workspace): McpCredentials {
  let raw = "";
  try {
    raw = fs.readFileSync(configFile(ws), "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as { mcp?: unknown };
    if (typeof parsed.mcp !== "object" || parsed.mcp === null || Array.isArray(parsed.mcp)) return {};
    const out: McpCredentials = {};
    for (const [rawServer, entry] of Object.entries(parsed.mcp)) {
      const server = rawServer.trim();
      if (server === "" || typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const values: Record<string, string> = {};
      for (const [rawKey, value] of Object.entries(entry)) {
        const key = rawKey.trim();
        const text = requiredString(value);
        if (key !== "" && text !== undefined) values[key] = text;
      }
      if (Object.keys(values).length > 0) out[server] = values;
    }
    return out;
  } catch {
    return {};
  }
}

export type ModelRefLike = { provider: string; modelId: string };

/** 员工模型兜底：员工 model 合法则用员工的，否则整体用全局；thinkingLevel 独立保留。 */
export function resolveEmployeeModel(globalModel: string, employee: ModelChoice): ModelRefLike & { thinkingLevel?: string } {
  const thinking = employee.thinkingLevel === undefined ? {} : { thinkingLevel: employee.thinkingLevel };
  const own = parseModelRef(employee.model);
  if (own !== undefined) return { ...own, ...thinking };
  const fallback = parseModelRef(globalModel) ?? { provider: "", modelId: "" };
  return { ...fallback, ...thinking };
}

/** 解析结果 → "provider/modelId"（展示/API 输出用）。 */
export function formatModelRef(ref: ModelRefLike): string {
  return `${ref.provider}/${ref.modelId}`;
}

/** 思考档位全集（pi-ai ModelThinkingLevel）；配置端不校验，展示层用它识别非法档。 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * 展示层思考强度判定：
 * - 非法档（不在 THINKING_LEVELS 里）→ null；
 * - 模型目录给出支持列表、但该档不在列表 → null（不回落成别的档，也不原样显示无效值）；
 * - 支持 / 模型目录缺失（无法判定）→ 原值。
 */
export function displayThinkingLevel(level: string, supportedThinkingLevels: readonly string[] | undefined): string | null {
  if (typeof level !== "string" || !(THINKING_LEVELS as readonly string[]).includes(level)) return null;
  if (supportedThinkingLevels !== undefined && !supportedThinkingLevels.includes(level)) return null;
  return level;
}

/** @提及解析用的负责人写法：当前称谓 + 历史写法（双认；首项 = 当前称谓）。 */
export function bossNamesFor(ws: Workspace): string[] {
  return [...new Set([readBossName(ws), DEFAULT_BOSS_NAME, "boss"])];
}
