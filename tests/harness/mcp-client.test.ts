import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpStdioClient } from "../../src/harness/mcp-client.ts";

const fixture = fileURLToPath(new URL("../fixtures/mcp-server.mjs", import.meta.url));
let root = "";
const clients: McpStdioClient[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-mcp-client-"));
});

afterEach(async () => {
  await Promise.all(clients.map((client) => client.close()));
  clients.length = 0;
  fs.rmSync(root, { recursive: true, force: true });
});

function client(env: Record<string, string>, options?: { connectTimeoutMs?: number; requestTimeoutMs?: number }) {
  const instance = new McpStdioClient({
    serverName: "fixture",
    command: process.execPath,
    args: [fixture],
    env: { ...process.env, ...env },
    cwd: root,
    connectTimeoutMs: options?.connectTimeoutMs ?? 2000,
    requestTimeoutMs: options?.requestTimeoutMs ?? 2000,
    log: () => {},
  });
  clients.push(instance);
  return instance;
}

describe("MCP stdio 客户端", () => {
  it("初始化、列出工具、调用文本 / 图片 / 错误工具", async () => {
    const instance = client({});
    await instance.start();
    const tools = await instance.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["echo", "fail", "image", "slow", "busy"]);

    const echo = await instance.callTool("echo", { text: "hi" });
    expect(echo).toEqual({ content: [{ type: "text", text: "echo:hi" }] });

    const fail = await instance.callTool("fail", {});
    expect(fail.isError).toBe(true);

    const image = await instance.callTool("image", {});
    expect(image.content).toEqual([{ type: "image", data: "aGk=", mimeType: "image/png" }]);

    await expect(instance.ping()).resolves.toBeUndefined();
  });

  it("支持 tools/list 分页", async () => {
    const instance = client({ MCP_TEST_MODE: "paged" });
    await instance.start();
    const tools = await instance.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["echo", "fail", "image", "slow", "busy"]);
  });

  it("tools/list 无限分页有上限，不会无限请求", async () => {
    const instance = client({ MCP_TEST_MODE: "infinite-pages" }, { requestTimeoutMs: 2000 });
    await instance.start();
    await expect(instance.listTools()).rejects.toThrow("分页超过上限");
  });

  it("连接卡死在 initialize 时按 connectTimeoutMs 拒绝并清理进程", async () => {
    const instance = client({ MCP_TEST_MODE: "hang" }, { connectTimeoutMs: 150 });
    await expect(instance.start()).rejects.toThrow("初始化超时");
    await expect(instance.listTools()).rejects.toThrow("未启动");
  });

  it("工具调用超过 requestTimeoutMs 时拒绝", async () => {
    const instance = client({}, { requestTimeoutMs: 50 });
    await instance.start();
    await expect(instance.callTool("slow", {})).rejects.toThrow("请求超时");
  });

  it("close 幂等", async () => {
    const instance = client({});
    await instance.start();
    await instance.close();
    await instance.close();
  });
});
