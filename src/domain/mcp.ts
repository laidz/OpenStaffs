import fs from "node:fs";
import path from "node:path";
import { readMcpCredentials, type McpCredentials } from "./config.ts";
import { spaceDir, type Workspace } from "./paths.ts";

/** 全局 MCP 定义文件名（落在空间附属目录 `openstaffs/mcps.json`，D16）。 */
export const MCP_DEFINITIONS_FILE_NAME = "mcps.json";
export const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 60_000;
export const MCP_DEFERRED_THRESHOLD = 20;

export type McpServerConfig = {
  /** mcps.json 里的 key；也是工具前缀、扩展名、凭据引用使用的名字。 */
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  timeoutMs: number;
};

export type McpSource = { file: string; servers: McpServerConfig[]; invalid: string[]; errors: string[] };

export type McpSnapshot = { source: McpSource };

export type McpSelection = { name: string; config: McpServerConfig };

/** 会话装配层需要的查询接口（实现见 McpManager，测试可注入假实现）。 */
export type McpSessionResolver = {
  extensionsFor(names: readonly string[]): string[];
};

/** 全局定义文件路径（D16：全空间唯一，按名引用）。 */
export function mcpDefinitionsFile(ws: Workspace): string {
  return path.join(spaceDir(ws), MCP_DEFINITIONS_FILE_NAME);
}

export function mcpExtensionName(server: string): string {
  return `mcp:global:${server}`;
}

function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/gu, "_");
  return cleaned === "" ? "unnamed" : cleaned;
}

export function mcpToolName(server: string, tool: string): string {
  return `mcp__${safeSegment(server)}__${safeSegment(tool)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** server 名必须能安全用于工具名 / 扩展名 / 凭据引用：不含点号、空白或其它标点。 */
const SAFE_SERVER_NAME = /^[A-Za-z0-9_-]+$/u;

const CREDENTIAL_REF = /\$\{config\.mcp\.([A-Za-z0-9_-]+)\.([^}]+)\}/gu;

/** 只替换 `${config.mcp.<server>.<key>}`；其它 `${...}` 原样保留。缺凭据 → undefined + 错误文案。 */
function interpolate(
  value: string,
  credentials: McpCredentials,
  errors: string[],
): string | undefined {
  let missing: string | undefined;
  const out = value.replace(CREDENTIAL_REF, (_whole, server: string, key: string) => {
    const resolved = credentials[server]?.[key];
    if (resolved === undefined || resolved === "") {
      missing ??= `${server}.${key}`;
      return "";
    }
    return resolved;
  });
  if (missing !== undefined) {
    errors.push(`缺少凭据：\${config.mcp.${missing}}（请在 .openstaffs/config.json 的 mcp.${missing} 配置）`);
    return undefined;
  }
  return out;
}

function parseServer(
  name: string,
  file: string,
  value: unknown,
  credentials: McpCredentials,
): { config?: McpServerConfig; error?: string } {
  if (!isObject(value)) return { error: "配置必须是对象" };
  const interpolateErrors: string[] = [];
  const commandRaw = requiredString(value.command);
  if (commandRaw === undefined) return { error: "缺少 command" };
  const command = interpolate(commandRaw, credentials, interpolateErrors);
  if (command === undefined) return { error: interpolateErrors.join("；") };

  const args: string[] = [];
  if (value.args !== undefined) {
    if (!Array.isArray(value.args)) return { error: "args 必须是字符串数组" };
    for (const arg of value.args) {
      if (typeof arg !== "string") return { error: "args 必须是字符串数组" };
      const resolved = interpolate(arg, credentials, interpolateErrors);
      if (resolved === undefined) return { error: interpolateErrors.join("；") };
      args.push(resolved);
    }
  }

  const env: Record<string, string> = {};
  if (value.env !== undefined) {
    if (!isObject(value.env)) return { error: "env 必须是对象" };
    for (const [rawKey, rawValue] of Object.entries(value.env)) {
      if (typeof rawValue !== "string") return { error: `env.${rawKey} 必须是字符串` };
      const resolved = interpolate(rawValue, credentials, interpolateErrors);
      if (resolved === undefined) return { error: interpolateErrors.join("；") };
      env[rawKey] = resolved;
    }
  }

  // 相对 cwd 相对该 mcps.json 所在目录；缺省也是该目录。
  let cwd = path.dirname(file);
  if (value.cwd !== undefined) {
    if (typeof value.cwd !== "string" || value.cwd.trim() === "") return { error: "cwd 必须是非空字符串" };
    const resolved = interpolate(value.cwd.trim(), credentials, interpolateErrors);
    if (resolved === undefined) return { error: interpolateErrors.join("；") };
    cwd = path.resolve(path.dirname(file), resolved);
  }

  let timeoutMs = DEFAULT_MCP_REQUEST_TIMEOUT_MS;
  if (value.timeoutMs !== undefined) {
    if (typeof value.timeoutMs !== "number" || !Number.isInteger(value.timeoutMs) || value.timeoutMs <= 0) {
      return { error: "timeoutMs 必须是正整数" };
    }
    timeoutMs = value.timeoutMs;
  }

  return { config: { name, command, args, env, cwd, timeoutMs } };
}

/** 读全局定义文件：缺失视为空；坏 JSON / 坏 server 记在 source.errors。 */
export function readMcpSource(file: string, credentials: McpCredentials): McpSource {
  const source: McpSource = { file, servers: [], invalid: [], errors: [] };
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return source;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    source.errors.push(`MCP 配置不是合法 JSON：${file}`);
    return source;
  }
  if (!isObject(parsed) || parsed.mcpServers === undefined) return source;
  if (!isObject(parsed.mcpServers)) {
    source.errors.push(`MCP 配置的 mcpServers 必须是对象：${file}`);
    return source;
  }
  for (const [rawName, value] of Object.entries(parsed.mcpServers)) {
    const name = rawName.trim();
    if (name === "") {
      source.invalid.push(rawName);
      source.errors.push(`MCP server 名字不能为空：${file}`);
      continue;
    }
    if (!SAFE_SERVER_NAME.test(name)) {
      source.invalid.push(name);
      source.errors.push(
        `MCP server 名字不合法：${JSON.stringify(name)}（${file}；只允许字母、数字、_、-，不能含点号或空白）`,
      );
      continue;
    }
    const parsedServer = parseServer(name, file, value, credentials);
    if (parsedServer.config === undefined) {
      source.invalid.push(name);
      source.errors.push(`MCP server "${name}" 配置错误（${file}）：${parsedServer.error ?? "未知错误"}`);
      continue;
    }
    source.servers.push(parsedServer.config);
  }
  return source;
}

/** 启动快照：只读 `openstaffs/mcps.json`（D16）；此后新增 / 修改需重启。 */
export function loadMcpSnapshot(ws: Workspace): McpSnapshot {
  const credentials = readMcpCredentials(ws);
  return { source: readMcpSource(mcpDefinitionsFile(ws), credentials) };
}

/** 按名解析（引用顺序即装配顺序）；未定义 → missing，非法定义 → 跳过（errors 已记录）。 */
export function resolveMcpServers(
  snapshot: McpSnapshot,
  names: readonly string[],
): { selections: McpSelection[]; missing: string[] } {
  const byName = new Map(snapshot.source.servers.map((config) => [config.name, config]));
  const selections: McpSelection[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const rawName of names) {
    const name = rawName.trim();
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    if (snapshot.source.invalid.includes(name)) continue;
    const config = byName.get(name);
    if (config === undefined) {
      missing.push(name);
      continue;
    }
    selections.push({ name, config });
  }
  return { selections, missing };
}
