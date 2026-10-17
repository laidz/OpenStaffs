import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import type { Workspace } from "../domain/paths.ts";
import type { HarnessPort } from "../harness/port.ts";
import { openStaffsToolDefs, type ToolContext } from "./registry.ts";

/**
 * 把 OpenStaffs 统一注册表适配成 Pi Extension（装进 harness registry）。
 * 每次工具调用：用会话 id 经 `harness.sessionInfo` 解析出「我是谁 / 我在哪个关系」，再跑工具。
 */
export function createOpenStaffsToolsExtension(options: {
  ws: Workspace;
  getHarness: () => HarnessPort;
}): Extension {
  return defineExtension({
    name: "openstaffs-tools",
    tools: openStaffsToolDefs.map((def) =>
      defineTool({
        name: def.name,
        description: def.description,
        parameters: def.parameters,
        async execute(args, api) {
          const harness = options.getHarness();
          const info = harness.sessionInfo(String(api.conversationId));
          if (info === undefined) {
            return { output: [{ type: "text", text: "工具不可用：未注册的会话" }], isError: true };
          }
          const ctx: ToolContext = { ws: options.ws, harness, selfId: info.selfId, relation: info.relation };
          try {
            return { output: [{ type: "text", text: await def.run(args as Record<string, unknown>, ctx) }] };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { output: [{ type: "text", text: `失败：${message}` }], isError: true };
          }
        },
      }),
    ),
  });
}
