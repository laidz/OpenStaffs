import type { RoomMessage } from "../src/app/rooms.ts";
import type { ServerEvent } from "../src/server/sse.ts";
import type { EmployeeSummary, ProjectSummary } from "./api.ts";

export type Live = {
  convId: string;
  memberId: string;
  text: string;
  thinking: string;
  tools: string[];
  error?: string;
};

export type State = {
  configured: boolean;
  employees: EmployeeSummary[];
  projects: ProjectSummary[];
  roomKey?: string;
  messages: RoomMessage[];
  live: Record<string, Live>;
  unread: Record<string, number>;
  busy: Record<string, boolean>;
  panel?: "history";
};

export const initialState: State = {
  configured: false,
  employees: [],
  projects: [],
  messages: [],
  live: {},
  unread: {},
  busy: {},
};

export type UiEvent =
  | { type: "status"; configured: boolean }
  | { type: "employees"; list: EmployeeSummary[] }
  | { type: "projects"; list: ProjectSummary[] }
  | { type: "room"; roomKey: string; messages: RoomMessage[] }
  | { type: "close-room" }
  | { type: "panel"; panel?: "history" }
  | { type: "unread"; unread: { total: number; rooms: Record<string, number> } }
  | { type: "sse"; event: ServerEvent };

export function selectView(state: State): "setup" | "main" {
  return state.configured ? "main" : "setup";
}

function messageKey(message: RoomMessage): string {
  return `${message.convId}:${message.entryId}`;
}

/** 增量合并：复合键去重；同 roomMessageId 的广播副本已见则不重复（先到先显，历史不动）。 */
function appendMessage(messages: RoomMessage[], incoming: RoomMessage): RoomMessage[] {
  if (messages.some((m) => messageKey(m) === messageKey(incoming))) return messages;
  if (incoming.roomMessageId !== undefined && messages.some((m) => m.roomMessageId === incoming.roomMessageId)) {
    return messages;
  }
  return [...messages, incoming].sort((a, b) => Number(a.entryId) - Number(b.entryId));
}

function liveOf(state: State, convId: string, memberId: string): Live {
  return state.live[convId] ?? { convId, memberId, text: "", thinking: "", tools: [] };
}

export function reduce(state: State, event: UiEvent): State {
  switch (event.type) {
    case "status":
      return { ...state, configured: event.configured };
    case "employees":
      return { ...state, employees: event.list };
    case "projects":
      return { ...state, projects: event.list };
    case "room":
      return { ...state, roomKey: event.roomKey, messages: event.messages, live: {}, panel: undefined };
    case "close-room":
      return { ...state, roomKey: undefined, messages: [], live: {}, panel: undefined };
    case "panel":
      return { ...state, panel: event.panel };
    case "unread":
      return { ...state, unread: event.unread.rooms };
    case "sse":
      return reduceSse(state, event.event);
  }
}

function reduceSse(state: State, event: ServerEvent): State {
  if (event.type === "room.unread") {
    return { ...state, unread: { ...state.unread, [event.roomKey]: event.count } };
  }
  if (state.roomKey !== event.roomKey) {
    if (event.type === "room.activity" && event.kind === "run") {
      return { ...state, busy: { ...state.busy, [event.memberId]: event.phase === "start" } };
    }
    return state;
  }
  switch (event.type) {
    case "room.message": {
      const messages = appendMessage(state.messages, event.message);
      // 去重命中（如 R9 重拉重喂）：返回同一引用 → 上层 dispatch 短路，不触发任何重建。
      if (messages === state.messages) return state;
      // 仅当真正追加时才清 live：去重命中不得误删进行中的流式气泡
      if (event.message.speaker.kind !== "employee") {
        return { ...state, messages };
      }
      const live = { ...state.live };
      delete live[event.message.convId];
      return { ...state, messages, live };
    }
    case "room.delta": {
      const existing = liveOf(state, event.convId, event.memberId);
      const updated =
        event.channel === "text"
          ? { ...existing, text: existing.text + event.delta }
          : { ...existing, thinking: existing.thinking + event.delta };
      // 同一会话重试时，新的增量必须露出来：清掉上一轮 failed 留下的错误提示。
      delete updated.error;
      return { ...state, live: { ...state.live, [event.convId]: updated } };
    }
    case "room.activity": {
      if (event.kind === "run") {
        const busy = { ...state.busy, [event.memberId]: event.phase === "start" };
        const existing = state.live[event.convId];
        // 新一轮 run 开始：清掉上一轮 failed 的错误提示（无 live 则不凭空造气泡）。
        if (event.phase === "start" && existing?.error !== undefined) {
          const cleared = { ...existing };
          delete cleared.error;
          return { ...state, busy, live: { ...state.live, [event.convId]: cleared } };
        }
        return { ...state, busy };
      }
      const existing = liveOf(state, event.convId, event.memberId);
      const tools = event.phase === "start" ? [...existing.tools, event.name ?? ""] : existing.tools.slice(0, -1);
      return { ...state, live: { ...state.live, [event.convId]: { ...existing, tools } } };
    }
    case "room.failed": {
      const existing = liveOf(state, event.convId, event.memberId);
      return { ...state, live: { ...state.live, [event.convId]: { ...existing, error: event.message } } };
    }
    default:
      return state;
  }
}
