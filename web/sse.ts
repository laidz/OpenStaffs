import type { ServerEvent } from "../src/server/sse.ts";

/**
 * 服务端广播的全部事件名。
 *
 * `Record<ServerEvent["type"], true>` 是刻意的：**漏一个 / 多一个都会编译报错**。
 * 曾经这里还留着 `room.message` / `room.delta` / `session.title` 等已退役的名字，而服务端
 * 早已改成 `meeting.*` → EventSource 订阅全部落空，员工回复、流式增量、排队态都进不了聊天框
 * （只有发消息触发重拉才看得到历史）。用 Record 把「订阅名单 = 服务端事件类型」钉死在类型上。
 */
const EVENT_TYPES: Record<ServerEvent["type"], true> = {
  "meeting.message": true,
  "meeting.delta": true,
  "meeting.activity": true,
  "meeting.failed": true,
  "meeting.pins": true,
  "meeting.queued": true,
  "meeting.dequeued": true,
  "permission.request": true,
  "permission.resolved": true,
  "meeting.title": true,
  "meeting.deleted": true,
};

const EVENT_NAMES = Object.keys(EVENT_TYPES) as ServerEvent["type"][];

/** 连接 SSE；返回断开函数。断线由 EventSource 自动重连，重连成功后回调 onReconnect（用于重拉补齐）。 */
export function connectEvents(handlers: {
  onEvent: (event: ServerEvent) => void;
  onReconnect: () => void;
}): () => void {
  const source = new EventSource("/api/events");
  for (const type of EVENT_NAMES) {
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
