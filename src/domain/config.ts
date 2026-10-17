import fs from "node:fs";
import path from "node:path";
import { stateDir, type Workspace } from "./paths.ts";
import type { ModelChoice } from "./types.ts";

export type WorkspaceConfig = {
  provider: string;
  apiKey: string;
  modelId: string;
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

/** 读取全局配置；缺失/坏 JSON/必需字段缺失 → undefined（未配置模式）。 */
export function readConfig(ws: Workspace): WorkspaceConfig | undefined {
  let raw = "";
  try {
    raw = fs.readFileSync(configFile(ws), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const provider = requiredString(parsed.provider);
    const apiKey = requiredString(parsed.apiKey);
    const modelId = requiredString(parsed.modelId);
    if (provider === undefined || apiKey === undefined || modelId === undefined) return undefined;
    const port =
      typeof parsed.port === "number" && Number.isInteger(parsed.port) && parsed.port > 0 && parsed.port < 65536
        ? parsed.port
        : DEFAULT_PORT;
    return { provider, apiKey, modelId, port };
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

export type ModelRefLike = { provider: string; modelId: string };

/** 员工模型兜底：员工 provider+modelId 成对非空则用员工的，否则整体用全局；thinkingLevel 独立保留。 */
export function resolveEmployeeModel(global: ModelRefLike, employee: ModelChoice): ModelChoice & ModelRefLike {
  const thinking = employee.thinkingLevel === undefined ? {} : { thinkingLevel: employee.thinkingLevel };
  const provider = employee.provider.trim();
  const modelId = employee.modelId.trim();
  if (provider !== "" && modelId !== "") return { provider, modelId, ...thinking };
  return { provider: global.provider, modelId: global.modelId, ...thinking };
}
