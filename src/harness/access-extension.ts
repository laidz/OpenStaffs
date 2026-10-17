import { ToolTask, defineExtension, hook, type Extension } from "@earendil-works/pi-durable";
import { isWriteAllowed, type AccessContext } from "../domain/access-control.ts";

/** 越界写拦截文案（引导走授权申请通道）。 */
export function writeBlockMessage(target: string): string {
  return `访问控制：不可写 "${target}"。如确需写入，可调用 request_permission 工具申请授权（异步，批准后会收到通知）。`;
}

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
          if (call.name === "write" || call.name === "edit") {
            const target = String((call.arguments as { path?: unknown } | undefined)?.path ?? "");
            if (!isWriteAllowed(ctx, target)) {
              return { block: writeBlockMessage(target) };
            }
            return undefined;
          }
          return undefined;
        },
      }),
    ],
  });
}
