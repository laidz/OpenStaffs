import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type McpToolInfo = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

export type McpCallResult = {
  content: readonly unknown[];
  structuredContent?: unknown;
  isError?: boolean;
};

export type McpClientOptions = {
  serverName: string;
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
  onExit?: (reason: string) => void;
  log?: (line: string) => void;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** POSIX 下杀整个进程组（npx 等会派生子进程）；失败回落单进程。 */
function signalProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // 进程组不存在时回落到单进程
    }
  }
  try {
    child.kill(signal);
  } catch {
    // 已退出
  }
}

/**
 * 最小 MCP stdio 客户端：initialize → notifications/initialized → tools/list / tools/call / ping。
 * 只处理换行分隔的 JSON-RPC 2.0；server 的 stderr 转日志；stdout 非 JSON 行忽略。
 */
export class McpStdioClient {
  readonly #options: McpClientOptions;
  #child: ChildProcessWithoutNullStreams | undefined;
  #buffer = "";
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #ready = false;
  #closed = false;
  #exitNotified = false;

  constructor(options: McpClientOptions) {
    this.#options = options;
  }

  #log(line: string): void {
    (this.#options.log ?? ((text) => console.error(text)))(line);
  }

  async start(): Promise<void> {
    if (this.#child !== undefined) throw new Error(`MCP server "${this.#options.serverName}" 已经启动`);
    const child = spawn(this.#options.command, [...this.#options.args], {
      cwd: this.#options.cwd,
      env: this.#options.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    this.#child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/u)) {
        if (line.trim() !== "") this.#log(`[mcp:${this.#options.serverName}] ${line.slice(0, 2000)}`);
      }
    });
    child.on("error", (error) => {
      // 不回显 error.message：Node 的 spawn 错误会带解析后的 command（可能含凭据）。
      const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
      this.#failAll(new Error(`MCP server "${this.#options.serverName}" 启动失败（${code}）`));
    });
    child.on("exit", (code, signal) => {
      const reason = `进程退出（code=${code ?? "null"}, signal=${signal ?? "null"}）`;
      this.#ready = false;
      this.#child = undefined;
      this.#failAll(new Error(`MCP server "${this.#options.serverName}" ${reason}`));
      if (!this.#closed && !this.#exitNotified) {
        this.#exitNotified = true;
        this.#options.onExit?.(reason);
      }
    });

    try {
      await this.#request(
        "initialize",
        {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "openstaffs", version: "0.0.0" },
        },
        this.#options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
        "初始化超时",
      );
      this.#notify("notifications/initialized", {});
      this.#ready = true;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  #assertReady(): void {
    if (!this.#ready || this.#child === undefined) {
      throw new Error(`MCP server "${this.#options.serverName}" 未启动或未就绪`);
    }
  }

  #write(message: unknown): void {
    const child = this.#child;
    if (child === undefined || this.#closed) {
      throw new Error(`MCP server "${this.#options.serverName}" 未启动`);
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #notify(method: string, params: Record<string, unknown>): void {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  #request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    timeoutLabel = "请求超时",
  ): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pending.has(id)) return;
        this.#pending.delete(id);
        reject(new Error(`MCP server "${this.#options.serverName}" ${timeoutLabel}：${method}（${timeoutMs}ms）`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #onStdout(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const index = this.#buffer.indexOf("\n");
      if (index < 0) break;
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (line === "") continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.#log(`[mcp:${this.#options.serverName}] 忽略非 JSON 输出：${line.slice(0, 200)}`);
        continue;
      }
      this.#onMessage(message);
    }
  }

  #onMessage(message: unknown): void {
    if (!isObject(message)) return;
    if (typeof message.method === "string") {
      if (message.id !== undefined) {
        try {
          this.#write({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: `不支持 server 发起的请求：${message.method}` },
          });
        } catch {
          // 连接已断
        }
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (isObject(message.error)) {
      const text = typeof message.error.message === "string" ? message.error.message : "未知错误";
      pending.reject(new Error(`MCP server "${this.#options.serverName}" 返回错误：${text}`));
      return;
    }
    pending.resolve(message.result);
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  async listTools(timeoutMs = this.#options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS): Promise<McpToolInfo[]> {
    this.#assertReady();
    const tools: McpToolInfo[] = [];
    const seenCursors = new Set<string>();
    const deadline = Date.now() + timeoutMs;
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      pages += 1;
      if (pages > 50) {
        throw new Error(`MCP server "${this.#options.serverName}" tools/list 分页超过上限（50 页）`);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`MCP server "${this.#options.serverName}" tools/list 超时（${timeoutMs}ms）`);
      }
      const result = await this.#request(
        "tools/list",
        cursor === undefined ? {} : { cursor },
        remaining,
      );
      if (!isObject(result) || !Array.isArray(result.tools)) {
        throw new Error(`MCP server "${this.#options.serverName}" tools/list 返回格式不合法`);
      }
      for (const item of result.tools) {
        if (!isObject(item) || typeof item.name !== "string" || item.name.trim() === "") continue;
        tools.push({
          name: item.name,
          ...(typeof item.description === "string" ? { description: item.description } : {}),
          ...(item.inputSchema === undefined ? {} : { inputSchema: item.inputSchema }),
        });
      }
      const next = typeof result.nextCursor === "string" && result.nextCursor !== "" ? result.nextCursor : undefined;
      if (next === undefined || seenCursors.has(next)) break;
      seenCursors.add(next);
      cursor = next;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    this.#assertReady();
    const result = await this.#request(
      "tools/call",
      { name, arguments: args },
      this.#options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
    if (!isObject(result) || !Array.isArray(result.content)) {
      throw new Error(`MCP server "${this.#options.serverName}" tools/call 返回格式不合法`);
    }
    return {
      content: result.content,
      ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
      ...(result.isError === true ? { isError: true } : {}),
    };
  }

  async ping(timeoutMs = 5000): Promise<void> {
    this.#assertReady();
    await this.#request("ping", {}, timeoutMs);
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#ready = false;
    const child = this.#child;
    this.#child = undefined;
    this.#failAll(new Error(`MCP server "${this.#options.serverName}" 已关闭`));
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      child.once("exit", finish);
      signalProcessGroup(child, "SIGTERM");
      const timer = setTimeout(() => {
        signalProcessGroup(child, "SIGKILL");
        finish();
      }, 2000);
      timer.unref();
    });
  }
}
