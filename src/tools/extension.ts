import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import type { McpSessionResolver } from "../domain/mcp.ts";
import type { Workspace } from "../domain/paths.ts";
import type { PermissionRequest, PermissionRequestStore } from "../domain/permission-requests.ts";
import type { HarnessPort } from "../harness/port.ts";
import { openStaffsToolDefs, type ToolContext } from "./registry.ts";
import type { MeetingMessage } from "../app/meeting-messages.ts";
import type { MeetingStore } from "../store/meetings.ts";
import type { SessionStore } from "../store/sessions.ts";

/**
 * 把 OpenStaffs 统一注册表适配成 Pi Extension（装进 harness registry）。
 * 每次工具调用：用会话 id 经 `harness.sessionInfo` 解析出「我是谁 / 我在哪个关系」，再跑工具。
 */
export function createOpenStaffsToolsExtension(options: {
  ws: Workspace;
  getHarness: () => HarnessPort;
  /** MCP 扩展选择（员工工具新建会话时透传）。 */
  mcp?: McpSessionResolver;
  /** 授权请求依赖（装配层注入；缺省时 request_permission 不可用）。 */
  permissions?: { store: PermissionRequestStore; notify: (request: PermissionRequest) => void };
  /** 会议消息广播（R-P1-12）：员工发言（send_message）落库后广播库行；缺省不广播。 */
  broadcast?: (meetingId: string, message: MeetingMessage) => void;
  /** 会议表：工具里 send_message 靠它定位会议。 */
  meetings: MeetingStore;
  /** 会话表（唯一真相）：工具里 send_message / meeting_history 靠它解析会话。 */
  sessions: SessionStore;
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
          const ctx: ToolContext = {
            ws: options.ws,
            harness,
            selfId: info.selfId,
            relation: info.relation,
            meetingId: info.meetingId,
            meetings: options.meetings,
            sessions: options.sessions,
            ...(options.mcp === undefined ? {} : { mcp: options.mcp }),
            ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
            ...(options.broadcast === undefined ? {} : { broadcast: options.broadcast }),
          };
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
