import type { IncomingMessage, ServerResponse } from "node:http";
import type { RoomMessage } from "../app/rooms.ts";
import type { QueuedItemView } from "../app/outbox.ts";
import type { PermissionRequestView } from "../app/permission-flow.ts";

export type ServerEvent =
  | { type: "room.message"; roomKey: string; message: RoomMessage }
  | { type: "room.delta"; roomKey: string; convId: string; memberId: string; channel: "text" | "thinking"; delta: string }
  | { type: "room.activity"; roomKey: string; convId: string; memberId: string; kind: "run" | "tool" | "toolCall"; phase: "start" | "end"; name?: string; hint?: string }
  | { type: "room.failed"; roomKey: string; convId: string; memberId: string; message: string; kind?: string }
  | { type: "room.pins"; roomKey: string; count: number }
  /** 老板的消息进了待发队列（员工在跑）：前端显示「排队中」。 */
  | { type: "room.queued"; item: QueuedItemView }
  /** 出队：投递开始（delivered）/ 被撤回（cancelled）/ 随中断撤下（aborted）。 */
  | { type: "room.dequeued"; roomKey: string; submissionId: string; reason: "delivered" | "cancelled" | "aborted" }
  | { type: "permission.request"; request: PermissionRequestView }
  | { type: "permission.resolved"; id: string }
  /** 会话标题变了（fallback / 自动命名 / 手动改名同一条写入通道）：前端的标题原地刷新。 */
  | { type: "session.title"; roomKey: string; convId: string; title: string };

export interface SseClientHandle {
  readonly pending: number;
  close(): void;
}

/** 每客户端积压上限；溢出丢增量（delta/activity），权威事件保留。 */
const MAX_PENDING = 200;

type Client = { queue: ServerEvent[]; flushing: boolean };

/** SSE 客户端管理与广播；泵只调用 broadcast，绝不 await 慢客户端。 */
export class SseHub {
  #clients = new Map<ServerResponse, Client>();

  add(req: IncomingMessage, res: ServerResponse): SseClientHandle {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    const client: Client = { queue: [], flushing: false };
    this.#clients.set(res, client);
    req.on("close", () => this.#remove(res));
    return {
      get pending() {
        return client.queue.length;
      },
      close: () => this.#remove(res),
    };
  }

  get size(): number {
    return this.#clients.size;
  }

  broadcast(event: ServerEvent): void {
    for (const [res, client] of this.#clients) {
      if (client.queue.length >= MAX_PENDING) {
        if (event.type === "room.delta" || event.type === "room.activity") continue;
        client.queue = client.queue.filter((e) => e.type !== "room.delta" && e.type !== "room.activity");
        if (client.queue.length >= MAX_PENDING) client.queue.shift();
      }
      client.queue.push(event);
      this.#flush(res, client);
    }
  }

  #flush(res: ServerResponse, client: Client): void {
    if (client.flushing) return;
    while (client.queue.length > 0) {
      const event = client.queue[0]!;
      const ok = res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      client.queue.shift();
      if (!ok) {
        client.flushing = true;
        res.once("drain", () => {
          client.flushing = false;
          this.#flush(res, client);
        });
        return;
      }
    }
  }

  #remove(res: ServerResponse): void {
    if (!this.#clients.has(res)) return;
    this.#clients.delete(res);
    res.end();
  }
}
