import { ToolTask, defineExtension, hook, type Extension } from "@earendil-works/pi-durable";
import type { AccessContext } from "../domain/access-control.ts";
import { gateToolCall } from "../tools/gate.ts";
import { WriteGuard } from "./write-guard.ts";

export function createAccessExtension(
  getContext: (convId: string) => AccessContext | undefined,
  writeGuard?: WriteGuard,
): Extension {
  return defineExtension({
    name: "openstaffs-access",
    hooks: [
      hook(ToolTask, {
        beforeTool: (call, api) => {
          const convId = String(api.conversationId);
          const ctx = getContext(convId);
          if (ctx === undefined) return { block: "访问控制：未注册的会话" };
          const verdict = gateToolCall(ctx, { name: call.name, arguments: call.arguments });
          if (verdict !== undefined) return { block: verdict.block };
          return writeGuard?.beforeTool(ctx, convId, call.name, call.arguments);
        },
        afterTool: (call, result, api) => {
          const convId = String(api.conversationId);
          const ctx = getContext(convId);
          if (ctx !== undefined) {
            writeGuard?.afterTool(ctx, convId, call.name, call.arguments, result.isError === true);
          }
          return undefined;
        },
      }),
    ],
  });
}
