import { describe, expect, it } from "vitest";
import { createMcpExtension, toToolResult } from "../../src/harness/mcp-extension.ts";

type ToolResult = { output?: unknown; isError?: boolean };

const schema = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
};

describe("MCP 扩展", () => {
  it("工具名加前缀并替换非法字符，同一 server 内重名只保留第一个", async () => {
    const calls: string[] = [];
    const extension = createMcpExtension({
      scopeKey: "system",
      serverName: "my server",
      deferred: false,
      log: () => {},
      tools: [
        { name: "echo", description: "回显", inputSchema: schema },
        { name: "search issues", inputSchema: schema },
        { name: "echo", description: "重复", inputSchema: schema },
      ],
      call: async (tool) => {
        calls.push(tool);
        return { content: [{ type: "text", text: "ok" }] };
      },
    });
    expect(extension.name).toBe("mcp:system:my server");
    const names = (extension.tools ?? []).map((tool) => tool.name);
    expect(names).toEqual(["mcp__my_server__echo", "mcp__my_server__search_issues"]);

    const echo = (extension.tools ?? [])[0]!;
    const result = (await echo.execute({ text: "hi" }, { conversationId: "c" } as never, {} as never)) as ToolResult;
    expect(calls).toEqual(["echo"]);
    expect(JSON.stringify(result.output)).toContain("ok");
  });

  it("结果映射 text / image / 空内容 / isError", async () => {
    expect(toToolResult({ content: [{ type: "text", text: "hi" }] })).toEqual({
      output: [{ type: "text", text: "hi" }],
    });
    expect(toToolResult({ content: [{ type: "image", data: "aGk=", mimeType: "image/png" }] })).toEqual({
      output: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
    });
    expect(toToolResult({ content: [] })).toEqual({ output: [{ type: "text", text: "（无输出）" }] });
    expect(toToolResult({ content: [], structuredContent: { a: 1 } })).toEqual({
      output: [{ type: "text", text: JSON.stringify({ a: 1 }) }],
    });
    expect(toToolResult({ content: [{ type: "text", text: "bad" }], isError: true })).toEqual({
      output: [{ type: "text", text: "bad" }],
      isError: true,
    });
  });

  it("调用抛错转成 isError 文本，不向外抛", async () => {
    const extension = createMcpExtension({
      scopeKey: "space",
      serverName: "fixture",
      deferred: false,
      tools: [{ name: "echo", inputSchema: schema }],
      call: async () => {
        throw new Error("连接断了");
      },
    });
    const tool = (extension.tools ?? [])[0]!;
    const result = (await tool.execute({ text: "hi" }, { conversationId: "c" } as never, {} as never)) as ToolResult;
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.output)).toContain("连接断了");
  });

  it("deferred 标记透传", () => {
    const extension = createMcpExtension({
      scopeKey: "system",
      serverName: "fixture",
      deferred: true,
      tools: [{ name: "echo", inputSchema: schema }],
      call: async () => ({ content: [] }),
    });
    const tool = (extension.tools ?? [])[0] as { deferred?: boolean };
    expect(tool.deferred).toBe(true);
  });
});
