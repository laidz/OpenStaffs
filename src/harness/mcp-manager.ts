import type { Extension } from "@earendil-works/pi-durable";
import {
  DEFAULT_MCP_REQUEST_TIMEOUT_MS, MCP_DEFERRED_THRESHOLD, loadMcpSnapshot, mcpExtensionName, mcpScopeKey,
  resolveMcpServers, type McpScope, type McpSelection, type McpSessionResolver, type McpSnapshot,
} from "../domain/mcp.ts";
import type { Workspace } from "../domain/paths.ts";
import type { Relation } from "../domain/types.ts";
import { createMcpExtension } from "./mcp-extension.ts";
import { McpStdioClient, type McpCallResult, type McpToolInfo } from "./mcp-client.ts";

export type McpManagerOptions = {
  ws: Workspace;
  /** 系统级 mcp.json 路径（测试注入；缺省 src/mcp.json）。 */
  systemFile?: string;
  log?: (line: string) => void;
  connectTimeoutMs?: number;
  heartbeatMs?: number;
  pingTimeoutMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxAttempts?: number;
  deferredThreshold?: number;
};

type Runtime = {
  key: string;
  /** mcp.json 原始 key（仅日志辅助）。 */
  serverName: string;
  /** 对外映射名（工具 / 扩展 / 凭据）。 */
  alias: string;
  scope: McpScope;
  selection: McpSelection;
  client?: McpStdioClient;
  /** 连接 / 初始化中的 client（close 时也要能关掉，避免孤儿进程）。 */
  connectingClient?: McpStdioClient;
  tools: McpToolInfo[];
  extension?: Extension;
  ready: boolean;
  reconnectAttempts: number;
  reconnectTimer?: NodeJS.Timeout;
  heartbeatTimer?: NodeJS.Timeout;
  connecting?: Promise<void>;
  stopping: boolean;
  /** 正在执行的工具调用数：>0 时心跳不 ping、不判死。 */
  inflight: number;
  /** 心跳重入保护。 */
  pinging: boolean;
  /** 连续心跳失败次数（达到 2 才重连）。 */
  heartbeatFailures: number;
};

const ENV_ALLOWLIST = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ",
];

function childEnv(configured: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...configured };
}

/** 启动快照 + 进程生命周期 + 按会话选择。任何 server 故障都只影响自己。 */
export class McpManager implements McpSessionResolver {
  readonly #ws: Workspace;
  readonly #options: McpManagerOptions;
  #snapshot: McpSnapshot = { sources: [] };
  #runtimes: Runtime[] = [];
  #errors: string[] = [];
  #needsToolSearch = false;
  #closed = false;

  constructor(options: McpManagerOptions) {
    this.#ws = options.ws;
    this.#options = options;
  }

  #log(line: string): void {
    (this.#options.log ?? ((text) => console.error(text)))(line);
  }

  async start(): Promise<void> {
    this.#snapshot = loadMcpSnapshot(this.#ws, {
      ...(this.#options.systemFile === undefined ? {} : { systemFile: this.#options.systemFile }),
    });
    for (const source of this.#snapshot.sources) {
      for (const error of source.errors) {
        this.#errors.push(error);
        this.#log(`[mcp] ${error}`);
      }
    }

    this.#runtimes = [];
    for (const source of this.#snapshot.sources) {
      for (const config of source.servers) {
        this.#runtimes.push({
          key: mcpExtensionName(source.scope, config.alias),
          serverName: config.name,
          alias: config.alias,
          scope: source.scope,
          selection: { name: config.name, scope: source.scope, config },
          tools: [],
          ready: false,
          reconnectAttempts: 0,
          stopping: false,
          inflight: 0,
          pinging: false,
          heartbeatFailures: 0,
        });
      }
    }

    await Promise.all(
      this.#runtimes.map((runtime) =>
        this.#connect(runtime).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.#errors.push(message);
          this.#log(`[mcp] ${message}`);
        }),
      ),
    );

    const totalTools = this.#runtimes.reduce((sum, runtime) => sum + runtime.tools.length, 0);
    this.#needsToolSearch = totalTools > (this.#options.deferredThreshold ?? MCP_DEFERRED_THRESHOLD);

    for (const runtime of this.#runtimes) this.#ensureExtension(runtime);
  }

  #ensureExtension(runtime: Runtime): void {
    if (runtime.tools.length === 0 || runtime.extension !== undefined) return;
    runtime.extension = createMcpExtension({
      scopeKey: mcpScopeKey(runtime.scope),
      serverName: runtime.alias,
      tools: runtime.tools,
      deferred: this.#needsToolSearch,
      call: (tool, args) => this.#call(runtime, tool, args),
      log: (line) => this.#log(line),
    });
  }

  #connect(runtime: Runtime): Promise<void> {
    if (this.#closed || runtime.stopping) return Promise.resolve();
    if (runtime.ready) return Promise.resolve();
    if (runtime.connecting !== undefined) return runtime.connecting;
    runtime.connecting = (async () => {
      runtime.ready = false;
      this.#stopHeartbeat(runtime);
      const config = runtime.selection.config;
      const client = new McpStdioClient({
        serverName: runtime.alias,
        command: config.command,
        args: config.args,
        env: childEnv(config.env),
        cwd: config.cwd,
        requestTimeoutMs: config.timeoutMs ?? DEFAULT_MCP_REQUEST_TIMEOUT_MS,
        ...(this.#options.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: this.#options.connectTimeoutMs }),
        log: (line) => this.#log(line),
        onExit: (reason) => {
          if (runtime.stopping || this.#closed) return;
          const wasReady = runtime.ready;
          runtime.ready = false;
          runtime.client = undefined;
          this.#stopHeartbeat(runtime);
          if (!wasReady) return; // 首次连接就没成功：不具备工具清单，重连也无法注册，等重启
          this.#log(`[mcp] server "${runtime.alias}" ${reason}；准备重连`);
          this.#scheduleReconnect(runtime);
        },
      });
      const startupTimeout = this.#options.connectTimeoutMs ?? 10_000;
      runtime.connectingClient = client;
      try {
        await client.start();
        const tools = await client.listTools(startupTimeout);
        // close() 可能发生在连接窗口：关闭后不得再变成 ready。
        if (this.#closed || runtime.stopping) {
          await client.close().catch(() => undefined);
          return;
        }
        runtime.tools = tools;
        runtime.client = client;
        runtime.ready = true;
        runtime.reconnectAttempts = 0;
        runtime.heartbeatFailures = 0;
        this.#startHeartbeat(runtime);
      } catch (error) {
        await client.close().catch(() => undefined);
        runtime.ready = false;
        throw error;
      } finally {
        if (runtime.connectingClient === client) runtime.connectingClient = undefined;
        runtime.connecting = undefined;
      }
    })();
    return runtime.connecting;
  }

  #startHeartbeat(runtime: Runtime): void {
    this.#stopHeartbeat(runtime);
    const interval = this.#options.heartbeatMs ?? 30_000;
    if (interval <= 0) return;
    const timer = setInterval(() => {
      // 有工具调用在途时 server 可能正忙：不 ping、不判死，避免杀掉正在干活的进程。
      if (!runtime.ready || runtime.client === undefined || runtime.inflight > 0 || runtime.pinging) return;
      void (async () => {
        runtime.pinging = true;
        try {
          await runtime.client?.ping(this.#options.pingTimeoutMs ?? 5000);
          runtime.heartbeatFailures = 0;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          runtime.heartbeatFailures += 1;
          this.#log(`[mcp] server "${runtime.alias}" 心跳失败（${runtime.heartbeatFailures}/2）：${message}`);
          if (runtime.heartbeatFailures < 2) return;
          this.#stopHeartbeat(runtime);
          runtime.ready = false;
          const client = runtime.client;
          runtime.client = undefined;
          await client?.close().catch(() => undefined);
          this.#scheduleReconnect(runtime);
        } finally {
          runtime.pinging = false;
        }
      })();
    }, interval);
    timer.unref();
    runtime.heartbeatTimer = timer;
  }

  #stopHeartbeat(runtime: Runtime): void {
    if (runtime.heartbeatTimer !== undefined) {
      clearInterval(runtime.heartbeatTimer);
      runtime.heartbeatTimer = undefined;
    }
  }

  #scheduleReconnect(runtime: Runtime): void {
    if (this.#closed || runtime.stopping || runtime.reconnectTimer !== undefined) return;
    runtime.reconnectAttempts += 1;
    const max = this.#options.reconnectMaxAttempts ?? 5;
    if (runtime.reconnectAttempts > max) {
      const message = `MCP server "${runtime.alias}" 重连次数已用尽（${max} 次），需要重启服务`;
      this.#errors.push(message);
      this.#log(`[mcp] ${message}`);
      return;
    }
    const base = this.#options.reconnectBaseMs ?? 1000;
    const delay = Math.min(base * 2 ** (runtime.reconnectAttempts - 1), 30_000);
    const timer = setTimeout(() => {
      runtime.reconnectTimer = undefined;
      this.#connect(runtime).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.#errors.push(message);
        this.#log(`[mcp] ${message}`);
        this.#scheduleReconnect(runtime);
      });
    }, delay);
    timer.unref();
    runtime.reconnectTimer = timer;
  }

  async #call(runtime: Runtime, tool: string, args: Record<string, unknown>): Promise<McpCallResult> {
    if (!runtime.ready) {
      try {
        await this.#connect(runtime);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`MCP server "${runtime.alias}" 未连接：${message}`);
      }
    }
    if (!runtime.ready || runtime.client === undefined) {
      throw new Error(`MCP server "${runtime.alias}" 未连接`);
    }
    runtime.inflight += 1;
    try {
      return await runtime.client.callTool(tool, args);
    } finally {
      runtime.inflight -= 1;
    }
  }

  extensions(): Extension[] {
    return this.#runtimes.flatMap((runtime) => (runtime.extension === undefined ? [] : [runtime.extension]));
  }

  extensionsFor(relation: Relation, speakerId: string): string[] {
    const byKey = new Map(this.#runtimes.map((runtime) => [runtime.key, runtime]));
    const names: string[] = [];
    for (const selection of resolveMcpServers(this.#snapshot, relation, speakerId).selections) {
      const runtime = byKey.get(mcpExtensionName(selection.scope, selection.config.alias));
      if (runtime?.extension !== undefined) names.push(runtime.extension.name);
    }
    return names;
  }

  needsToolSearch(): boolean {
    return this.#needsToolSearch;
  }

  errors(): string[] {
    return [...this.#errors];
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const runtime of this.#runtimes) {
      runtime.stopping = true;
      this.#stopHeartbeat(runtime);
      if (runtime.reconnectTimer !== undefined) {
        clearTimeout(runtime.reconnectTimer);
        runtime.reconnectTimer = undefined;
      }
    }
    await Promise.all(
      this.#runtimes.map(async (runtime) => {
        // 先等在途连接收尾（它会在每个 await 后检查 closed 并自行关闭），再关残留 client。
        await runtime.connecting?.catch(() => undefined);
        const client = runtime.client;
        const connectingClient = runtime.connectingClient;
        runtime.client = undefined;
        runtime.connectingClient = undefined;
        runtime.ready = false;
        await client?.close().catch(() => undefined);
        await connectingClient?.close().catch(() => undefined);
      }),
    );
  }
}
