import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { Type, type TSchema } from "typebox";
import { mcpToolName } from "../domain/mcp.ts";
import type { McpCallResult, McpToolInfo } from "./mcp-client.ts";

export type McpExtensionOptions = {
  scopeKey: string;
  serverName: string;
  tools: readonly McpToolInfo[];
  deferred: boolean;
  call: (tool: string, args: Record<string, unknown>) => Promise<McpCallResult>;
  log?: (line: string) => void;
};

export type McpToolOutput =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** MCP inputSchema 是 JSON Schema；只接受对象型 schema，其它回落空对象。 */
function parametersOf(schema: unknown): TSchema {
  if (isObject(schema) && schema.type === "object") return schema as unknown as TSchema;
  return Type.Object({});
}

export function toToolResult(result: McpCallResult): {
  output: McpToolOutput[];
  isError?: boolean;
} {
  const output: McpToolOutput[] = [];
  for (const block of result.content) {
    if (!isObject(block)) {
      output.push({ type: "text", text: String(block) });
      continue;
    }
    if (block.type === "text" && typeof block.text === "string") {
      output.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
      output.push({ type: "image", data: block.data, mimeType: block.mimeType });
      continue;
    }
    output.push({ type: "text", text: JSON.stringify(block) });
  }
  if (output.length === 0) {
    output.push({
      type: "text",
      text: result.structuredContent === undefined ? "（无输出）" : JSON.stringify(result.structuredContent),
    });
  }
  return { output, ...(result.isError === true ? { isError: true } : {}) };
}

export function createMcpExtension(options: McpExtensionOptions): Extension {
  const log = options.log ?? ((line: string) => console.error(line));
  const seen = new Set<string>();
  const tools = [];
  for (const tool of options.tools) {
    const name = mcpToolName(options.serverName, tool.name);
    if (seen.has(name)) {
      log(`[mcp:${options.serverName}] 工具重名，跳过：${tool.name}`);
      continue;
    }
    seen.add(name);
    tools.push(
      defineTool({
        name,
        description: tool.description?.trim() || `MCP server "${options.serverName}" 的工具 ${tool.name}`,
        parameters: parametersOf(tool.inputSchema),
        ...(options.deferred ? { deferred: true as const } : {}),
        async execute(args) {
          try {
            const result = await options.call(tool.name, args as Record<string, unknown>);
            return toToolResult(result);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
              output: [{ type: "text" as const, text: `MCP 工具调用失败（${options.serverName}/${tool.name}）：${message}` }],
              isError: true,
            };
          }
        },
      }),
    );
  }
  return defineExtension({ name: `mcp:${options.scopeKey}:${options.serverName}`, tools });
}
