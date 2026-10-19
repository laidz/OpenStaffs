import { ToolTask, defineExtension, hook, type Extension } from "@earendil-works/pi-durable";
import type { AccessContext } from "../domain/access-control.ts";
import { gateToolCall } from "../tools/gate.ts";

export function createAccessExtension(
  getContext: (convId: string) => AccessContext | undefined,
): Extension {
  return defineExtension({
    name: "openstaffs-access",
    hooks: [
      hook(ToolTask, {
        beforeTool: (call, api) => {
          const ctx = getContext(String(api.conversationId));
          if (ctx === undefined) return { block: "访问控制：未注册的会话" };
          const verdict = gateToolCall(ctx, { name: call.name, arguments: call.arguments });
          return verdict === undefined ? undefined : { block: verdict.block };
        },
      }),
    ],
  });
}
