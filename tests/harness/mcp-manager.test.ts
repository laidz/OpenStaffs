import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { McpManager } from "../../src/harness/mcp-manager.ts";

const fixture = fileURLToPath(new URL("../fixtures/mcp-server.mjs", import.meta.url));
let root = "";
let managers: McpManager[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-mcp-manager-"));
});

afterEach(async () => {
  await Promise.all(managers.map((manager) => manager.close()));
  managers = [];
  fs.rmSync(root, { recursive: true, force: true });
});

function writeJson(file: string, body: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
}

function fixtureServer(extra: Record<string, string> = {}) {
  return {
    command: process.execPath,
    args: [fixture],
    env: extra,
  };
}

/** 全局定义文件（D16）：`<space>/mcps.json`。 */
function definitionsFile(): string {
  return path.join(root, "openstaffs", "mcps.json");
}

function manager(options?: {
  server?: unknown;
  connectTimeoutMs?: number;
  reconnectBaseMs?: number;
  heartbeatMs?: number;
  pingTimeoutMs?: number;
  log?: (line: string) => void;
}): { instance: McpManager; definitionsFile: string } {
  const file = definitionsFile();
  if (options?.server !== undefined) {
    writeJson(file, { mcpServers: { fixture: options.server } });
  }
  const instance = new McpManager({
    ws: createWorkspace(root),
    log: options?.log ?? (() => {}),
    connectTimeoutMs: options?.connectTimeoutMs ?? 2000,
    heartbeatMs: options?.heartbeatMs ?? 10_000,
    ...(options?.pingTimeoutMs === undefined ? {} : { pingTimeoutMs: options.pingTimeoutMs }),
    reconnectBaseMs: options?.reconnectBaseMs ?? 50,
    reconnectMaxAttempts: 3,
  });
  managers.push(instance);
  return { instance, definitionsFile: file };
}

describe("MCP 管理器", () => {
  it("正常启动生成扩展；按名引用只为被点名的 server 装配", async () => {
    writeJson(definitionsFile(), {
      mcpServers: { fixture: fixtureServer(), projectOnly: fixtureServer() },
    });
    const { instance } = manager();
    await instance.start();

    const only = instance.extensionsFor(["fixture"]);
    expect(only).toContain("mcp:global:fixture");
    expect(only).not.toContain("mcp:global:projectOnly");

    const both = instance.extensionsFor(["projectOnly", "fixture"]);
    expect(both).toContain("mcp:global:projectOnly");
    expect(both).toContain("mcp:global:fixture");
    expect(instance.errors()).toEqual([]);
  });

  it("引用未定义的 mcp 名：跳过、不崩，已定义的照常装配（Focus #5）", async () => {
    const { instance } = manager({ server: fixtureServer() });
    await instance.start();
    expect(instance.extensionsFor(["fixture", "nope"])).toEqual(["mcp:global:fixture"]);
    expect(instance.errors()).toEqual([]);
  });

  it("server 名含点号时明确报错、不注册", async () => {
    const { instance } = manager();
    writeJson(definitionsFile(), {
      mcpServers: { "my.server": fixtureServer() },
    });
    await instance.start();
    expect(instance.errors().join("\n")).toContain("名字不合法");
    expect(instance.extensions()).toEqual([]);
    expect(instance.extensionsFor(["my.server"])).toEqual([]);
  });

  it("凭据缺失：明确错误、server 不注册、start 不抛", async () => {
    const { instance } = manager({
      server: { command: "npx", env: { TOKEN: "${config.mcp.fixture.token}" } },
    });
    await expect(instance.start()).resolves.toBeUndefined();
    expect(instance.errors().join("\n")).toContain("fixture.token");
    expect(instance.extensionsFor(["fixture"])).toEqual([]);
  });

  it("命令不存在：start 在超时内返回，不拖死会话", async () => {
    const { instance } = manager({ server: { command: "/nonexistent/openstaffs-mcp" }, connectTimeoutMs: 500 });
    const start = Date.now();
    await instance.start();
    expect(Date.now() - start).toBeLessThan(2000);
    expect(instance.extensions()).toEqual([]);
  });

  it("初始化卡死：按连接超时返回", async () => {
    const { instance } = manager({
      server: fixtureServer({ MCP_TEST_MODE: "hang" }),
      connectTimeoutMs: 150,
    });
    const start = Date.now();
    await instance.start();
    expect(Date.now() - start).toBeLessThan(2000);
    expect(instance.extensions()).toEqual([]);
  });

  it("崩溃后自动重连并恢复调用", async () => {
    const marker = path.join(root, "crashed.marker");
    const output = path.join(root, "echo.txt");
    const { instance } = manager({
      server: fixtureServer({
        MCP_TEST_MODE: "crash-once",
        MCP_TEST_MARKER: marker,
        MCP_TEST_OUTPUT: output,
      }),
      reconnectBaseMs: 50,
    });
    await instance.start();
    expect(instance.extensions()).toHaveLength(1);
    expect(fs.existsSync(marker)).toBe(true);
    // 等 fixture 自己退出，再调用：管理器应已重连，或由这次调用触发一次重连。
    await new Promise((resolve) => setTimeout(resolve, 700));

    const extension = instance.extensions()[0]!;
    const tool = extension.tools!.find((item) => item.name === "mcp__fixture__echo")!;
    await tool.execute({ text: "after-reconnect" }, { conversationId: "c" } as never, {} as never);
    expect(fs.readFileSync(output, "utf8")).toBe("echo:after-reconnect\n");
  });

  it("工具超过阈值时全部 deferred 且需要 tool_search", async () => {
    const { instance } = manager({ server: fixtureServer({ MCP_TEST_MODE: "many" }) });
    await instance.start();
    expect(instance.needsToolSearch()).toBe(true);
    const tools = instance.extensions()[0]!.tools ?? [];
    expect(tools.length).toBeGreaterThan(20);
    for (const tool of tools) expect((tool as { deferred?: boolean }).deferred).toBe(true);
  });

  it("同一 server 的工具重名只保留一个", async () => {
    const { instance } = manager({ server: fixtureServer({ MCP_TEST_MODE: "duplicate" }) });
    await instance.start();
    const names = (instance.extensions()[0]!.tools ?? []).map((tool) => tool.name);
    expect(names.filter((name) => name === "mcp__fixture__dup")).toHaveLength(1);
  });

  it("长工具调用跨心跳 tick 不会被心跳杀掉", async () => {
    const { instance } = manager({ server: fixtureServer(), heartbeatMs: 20, pingTimeoutMs: 20 });
    await instance.start();
    const extension = instance.extensions()[0]!;
    const tool = extension.tools!.find((item) => item.name === "mcp__fixture__busy")!;
    const result = (await tool.execute({}, { conversationId: "c" } as never, {} as never)) as { output?: unknown; isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.output)).toContain("busy-done");
  }, 10_000);

  it("关闭发生在连接中：不留下 ready 状态或孤儿进程", async () => {
    const pidFile = path.join(root, "server.pid");
    const { instance } = manager({
      server: fixtureServer({ MCP_TEST_MODE: "slow-list", MCP_TEST_PID_FILE: pidFile }),
    });
    const started = instance.start();
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(fs.existsSync(pidFile)).toBe(true);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    await instance.close();
    await started;
    expect(instance.extensions()).toEqual([]);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("initialize 正常但 tools/list 卡死：启动按连接超时返回", async () => {
    const { instance } = manager({
      server: fixtureServer({ MCP_TEST_MODE: "hang-list" }),
      connectTimeoutMs: 150,
    });
    const start = Date.now();
    await instance.start();
    expect(Date.now() - start).toBeLessThan(2000);
    expect(instance.extensions()).toEqual([]);
  });

  it("凭据进入 command 导致 spawn 失败时，不把凭据写进日志或 errors", async () => {
    writeJson(path.join(root, ".openstaffs", "config.json"), {
      mcp: { leaky: { cmd: "SUPER_SECRET_COMMAND_VALUE" } },
    });
    const logs: string[] = [];
    const { instance } = manager({
      server: { command: "${config.mcp.leaky.cmd}" },
      log: (line) => logs.push(line),
    });
    await instance.start();
    expect(instance.errors().join("\n")).not.toContain("SUPER_SECRET_COMMAND_VALUE");
    expect(logs.join("\n")).not.toContain("SUPER_SECRET_COMMAND_VALUE");
    expect(instance.errors().join("\n")).toContain("启动失败");
  });

  it("按名引用：只装配被点名的 server（不串到别的名字）", async () => {
    writeJson(definitionsFile(), {
      mcpServers: { p1Only: fixtureServer(), p2Only: fixtureServer() },
    });
    const { instance } = manager();
    await instance.start();
    expect(instance.extensionsFor(["p1Only"])).toContain("mcp:global:p1Only");
    expect(instance.extensionsFor(["p2Only"])).toContain("mcp:global:p2Only");
    expect(instance.extensionsFor(["p2Only"])).not.toContain("mcp:global:p1Only");
    expect(instance.extensionsFor(["p1Only"])).not.toContain("mcp:global:p2Only");
  });
});
