import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readMcpCredentials, type McpCredentials } from "./config.ts";
import { listEmployees } from "./employee.ts";
import { employeeDir, projectDir, spaceDir, type Workspace } from "./paths.ts";
import { listProjects } from "./project.ts";
import type { Relation } from "./types.ts";

/** 系统级 mcp.json（本文件在 src/domain → src/mcp.json）。 */
export const SYSTEM_MCP_FILE = fileURLToPath(new URL("../mcp.json", import.meta.url));
export const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 60_000;
export const MCP_DEFERRED_THRESHOLD = 20;

export type McpServerConfig = {
  /** mcp.json 里的原始 key（合并 / 窄者胜按它判定）。 */
  name: string;
  /** 对外映射名：工具前缀、扩展名、凭据引用都用它；缺省 = name。 */
  alias: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  timeoutMs: number;
};

export type McpScope =
  | { kind: "system" }
  | { kind: "space" }
  | { kind: "employee"; id: string }
  | { kind: "project"; id: string };

export type McpSource = {
  scope: McpScope;
  file: string;
  servers: McpServerConfig[];
  invalid: string[];
  errors: string[];
};

export type McpSnapshot = { sources: McpSource[] };

export type McpSelection = { name: string; scope: McpScope; config: McpServerConfig };

/** 会话装配层需要的查询接口（实现见 McpManager，测试可注入假实现）。 */
export type McpSessionResolver = {
  extensionsFor(relation: Relation, speakerId: string): string[];
};

export function mcpScopeKey(scope: McpScope): string {
  switch (scope.kind) {
    case "system":
      return "system";
    case "space":
      return "space";
    case "employee":
      return `employee:${scope.id}`;
    case "project":
      return `project:${scope.id}`;
  }
}

export function mcpExtensionName(scope: McpScope, server: string): string {
  return `mcp:${mcpScopeKey(scope)}:${server}`;
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

/** alias 必须能安全用于工具名 / 扩展名 / 凭据键：不含点号、空白或其它标点。 */
const SAFE_ALIAS = /^[A-Za-z0-9_-]+$/u;

function readAlias(value: unknown, name: string): { alias?: string; error?: string } {
  if (value === undefined) return { alias: name };
  const alias = requiredString(value);
  if (alias === undefined) return { error: "alias 必须是非空字符串" };
  if (!SAFE_ALIAS.test(alias)) {
    return { error: `alias 不合法：${JSON.stringify(alias)}（只允许字母、数字、_、-，且不能含点号）` };
  }
  return { alias };
}

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
  const aliasResult = readAlias(value.alias, name);
  if (aliasResult.alias === undefined) return { error: aliasResult.error };
  const alias = aliasResult.alias;
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

  // 相对 cwd 相对该 mcp.json 所在目录；缺省也是该目录。
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

  return { config: { name, alias, command, args, env, cwd, timeoutMs } };
}

/** 读一个 mcp.json：缺失视为空；坏 JSON / 坏 server 记在 source.errors。 */
export function readMcpSource(scope: McpScope, file: string, credentials: McpCredentials): McpSource {
  const source: McpSource = { scope, file, servers: [], invalid: [], errors: [] };
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
  const aliasOwners = new Map<string, string>();
  for (const [rawName, value] of Object.entries(parsed.mcpServers)) {
    const name = rawName.trim();
    if (name === "") {
      source.invalid.push(rawName);
      source.errors.push(`MCP server 名字不能为空：${file}`);
      continue;
    }
    const parsedServer = parseServer(name, file, value, credentials);
    if (parsedServer.config === undefined) {
      source.invalid.push(name);
      source.errors.push(`MCP server "${name}" 配置错误（${file}）：${parsedServer.error ?? "未知错误"}`);
      continue;
    }
    const config = parsedServer.config;
    const owner = aliasOwners.get(config.alias);
    if (owner !== undefined) {
      source.invalid.push(name);
      source.errors.push(`MCP server "${name}" 的 alias "${config.alias}" 与 "${owner}" 重复（${file}）`);
      continue;
    }
    aliasOwners.set(config.alias, name);
    source.servers.push(config);
  }
  return source;
}

/** 启动快照：四层全部读一次（含全部员工 / 项目）；此后新增 / 修改需重启。 */
export function loadMcpSnapshot(ws: Workspace, options?: { systemFile?: string }): McpSnapshot {
  const credentials = readMcpCredentials(ws);
  const sources: McpSource[] = [];
  sources.push(readMcpSource({ kind: "system" }, options?.systemFile ?? SYSTEM_MCP_FILE, credentials));
  sources.push(readMcpSource({ kind: "space" }, path.join(spaceDir(ws), "mcp.json"), credentials));
  for (const employee of listEmployees(ws)) {
    sources.push(
      readMcpSource({ kind: "employee", id: employee.id }, path.join(employeeDir(ws, employee.id), "mcp.json"), credentials),
    );
  }
  for (const project of listProjects(ws)) {
    sources.push(
      readMcpSource({ kind: "project", id: project.id }, path.join(projectDir(ws, project.id), "mcp.json"), credentials),
    );
  }
  return { sources };
}

function sourcesFor(snapshot: McpSnapshot, relation: Relation, speakerId: string): McpSource[] {
  const out = snapshot.sources.filter((source) => source.scope.kind === "system" || source.scope.kind === "space");
  for (const source of snapshot.sources) {
    if (source.scope.kind === "employee" && source.scope.id === speakerId) out.push(source);
  }
  if (relation.kind === "group") {
    for (const source of snapshot.sources) {
      if (source.scope.kind === "project" && source.scope.id === relation.project) out.push(source);
    }
  }
  return out;
}

/** 某会话的 server 集：宽 → 窄覆盖；窄层非法定义遮蔽同名宽层定义。 */
export function resolveMcpServers(
  snapshot: McpSnapshot,
  relation: Relation,
  speakerId: string,
): { selections: McpSelection[] } {
  const merged = new Map<string, McpSelection | "invalid">();
  for (const source of sourcesFor(snapshot, relation, speakerId)) {
    for (const name of source.invalid) merged.set(name, "invalid");
    for (const config of source.servers) {
      merged.set(config.name, { name: config.name, scope: source.scope, config });
    }
  }
  // 对外可见的 server 身份是 alias：不同原名字但 alias 相同时，窄者胜。
  const byAlias = new Map<string, McpSelection>();
  for (const value of merged.values()) {
    if (value === "invalid") continue;
    byAlias.set(value.config.alias, value);
  }
  return { selections: [...byAlias.values()] };
}
