import type { ServerEvent } from "../src/server/sse.ts";

const EVENT_TYPES = ["room.message", "room.delta", "room.activity", "room.failed", "room.unread"] as const;

/** 连接 SSE；返回断开函数。断线由 EventSource 自动重连，重连成功后回调 onReconnect（用于重拉补齐）。 */
export function connectEvents(handlers: {
  onEvent: (event: ServerEvent) => void;
  onReconnect: () => void;
}): () => void {
  const source = new EventSource("/api/events");
  for (const type of EVENT_TYPES) {
    source.addEventListener(type, (event) => {
      try {
        handlers.onEvent(JSON.parse((event as MessageEvent).data) as ServerEvent);
      } catch {
        // 忽略坏帧
      }
    });
  }
  source.addEventListener("open", () => handlers.onReconnect());
  return () => source.close();
}
