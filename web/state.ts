import type { RoomMessage } from "../src/app/rooms.ts";
import type { QueuedItemView } from "../src/app/outbox.ts";
import type { ServerEvent } from "../src/server/sse.ts";
import type { EmployeeSummary, OrgDept, PermissionRequestView, ProjectSummary, RoomSessionInfo } from "./api.ts";

export type Live = {
  convId: string;
  memberId: string;
  text: string;
  thinking: string;
  tools: string[];
  error?: string;
};

/** 授权卡片条目：视图数据 + 本地处理态（busy 禁用按钮、error 红字提示）。 */
export type PermissionRequestItem = PermissionRequestView & { busy?: boolean; error?: string };

export type State = {
  configured: boolean;
  bossName: string;
  employees: EmployeeSummary[];
  projects: ProjectSummary[];
  permissionRequests: PermissionRequestItem[];
  roomKey?: string;
  messages: RoomMessage[];
  /** 排队中的老板消息（当前房间）：还没投递给员工，按投递顺序。 */
  queued: QueuedItemView[];
  /** 当前房间各成员活跃会话信息（模型 / 思考强度 / 上下文用量）；私聊最多一条。 */
  sessions: RoomSessionInfo[];
  live: Record<string, Live>;
  /** 侧栏红点：每房间被 pin 的消息数（房间当前视图口径）。 */
  pins: Record<string, number>;
  /** 当前房间被 pin 的消息键（convId:entryId），用于气泡高亮。 */
  pinned: string[];
  /** 「新开会话」已就绪：下一条消息投递时对目标成员真正新开会话（一次一条，发完清零）。 */
  freshSession: boolean;
  busy: Record<string, boolean>;
  panel?: "history";
  /** 组织树（部门嵌套）；未拿到时为 undefined（侧栏回落平铺）。 */
  org?: OrgDept;
  /** 折叠的部门路径（**不持久化**：刷新回到全展开）。 */
  collapsedDepts: string[];
};

export const initialState: State = {
  configured: false,
  bossName: "老板",
  employees: [],
  projects: [],
  permissionRequests: [],
  messages: [],
  sessions: [],
  queued: [],
  live: {},
  pins: {},
  pinned: [],
  freshSession: false,
  busy: {},
  org: undefined,
  collapsedDepts: [],
};

export type UiEvent =
  | { type: "status"; configured: boolean; bossName: string }
  | { type: "org"; root: OrgDept }
  | { type: "projects"; list: ProjectSummary[] }
  | { type: "room"; roomKey: string; messages: RoomMessage[]; pinned: string[]; queued?: QueuedItemView[] }
  | { type: "sessions"; roomKey: string; sessions: RoomSessionInfo[] }
  | { type: "close-room" }
  | { type: "panel"; panel?: "history" }
  | { type: "pins"; pins: { total: number; rooms: Record<string, number> } }
  | { type: "pin"; roomKey: string; key: string; pinned: boolean }
  | { type: "fresh-session"; on: boolean }
  | { type: "permissions"; list: PermissionRequestView[] }
  | { type: "permission-busy"; id: string; busy: boolean }
  | { type: "permission-error"; id: string; error: string }
  | { type: "permission-resolved"; id: string }
  | { type: "toggle-dept"; path: string }
  | { type: "sse"; event: ServerEvent };

export function selectView(state: State): "setup" | "main" {
  return state.configured ? "main" : "setup";
}

function messageKey(message: RoomMessage): string {
  return `${message.convId}:${message.entryId}`;
}

/** 部门树 → 平铺的人员列表（DFS：本部门的人在前，再依次进子部门）；chat / 会话信息条仍读平铺列表。 */
export function flattenOrg(root: OrgDept): EmployeeSummary[] {
  const out: EmployeeSummary[] = [];
  const walk = (dept: OrgDept): void => {
    out.push(...dept.people);
    for (const child of dept.departments) walk(child);
  };
  walk(root);
  return out;
}

/** 增量合并：按消息键（convId:entryId，房间视图里即 `store:<seq>`）去重，保持排序。
 *  消息真相已归自有库（一次投递 = 一行 = 唯一键），不再按 roomMessageId 去重——
 *  那只是「排队中」占位的匹配键（见 web/render.ts），不是读侧去重依据。 */
function appendMessage(messages: RoomMessage[], incoming: RoomMessage): RoomMessage[] {
  if (messages.some((m) => messageKey(m) === messageKey(incoming))) return messages;
  return [...messages, incoming].sort((a, b) => Number(a.entryId) - Number(b.entryId));
}

function liveOf(state: State, convId: string, memberId: string): Live {
  return state.live[convId] ?? { convId, memberId, text: "", thinking: "", tools: [] };
}

export function reduce(state: State, event: UiEvent): State {
  switch (event.type) {
    case "status":
      return { ...state, configured: event.configured, bossName: event.bossName };
    case "org":
      return { ...state, org: event.root, employees: flattenOrg(event.root) };
    case "toggle-dept": {
      const collapsed = state.collapsedDepts.includes(event.path)
        ? state.collapsedDepts.filter((path) => path !== event.path)
        : [...state.collapsedDepts, event.path];
      return { ...state, collapsedDepts: collapsed };
    }
    case "projects":
      return { ...state, projects: event.list };
    case "room":
      return {
        ...state,
        roomKey: event.roomKey,
        messages: event.messages,
        pinned: event.pinned,
        queued: event.queued ?? [],
        sessions: [],
        freshSession: false,
        live: {},
        panel: undefined,
      };
    case "sessions":
      // 迟到的结果不串台：只接受当前房间。
      return state.roomKey === event.roomKey ? { ...state, sessions: event.sessions } : state;
    case "close-room":
      return { ...state, roomKey: undefined, messages: [], pinned: [], queued: [], sessions: [], freshSession: false, live: {}, panel: undefined };
    case "panel":
      return { ...state, panel: event.panel };
    case "fresh-session":
      return state.freshSession === event.on ? state : { ...state, freshSession: event.on };
    case "pins":
      return { ...state, pins: event.pins.rooms };
    case "pin": {
      if (state.roomKey !== event.roomKey) return state; // 非当前房间的本地 pin 事件不生效
      const next = event.pinned
        ? state.pinned.includes(event.key)
          ? state.pinned
          : [...state.pinned, event.key]
        : state.pinned.filter((key) => key !== event.key);
      if (next === state.pinned) return state;
      return { ...state, pinned: next, pins: { ...state.pins, [event.roomKey]: next.length } };
    }
    case "permissions":
      return { ...state, permissionRequests: event.list };
    case "permission-busy":
      return { ...state, permissionRequests: state.permissionRequests.map((r) => (r.id === event.id ? { ...r, busy: event.busy } : r)) };
    case "permission-error":
      return { ...state, permissionRequests: state.permissionRequests.map((r) => (r.id === event.id ? { ...r, error: event.error } : r)) };
    case "permission-resolved":
      return { ...state, permissionRequests: state.permissionRequests.filter((r) => r.id !== event.id) };
    case "sse":
      return reduceSse(state, event.event);
  }
}

function reduceSse(state: State, event: ServerEvent): State {
  if (event.type === "room.pins") {
    return { ...state, pins: { ...state.pins, [event.roomKey]: event.count } };
  }
  // 待发队列（入队 / 出队）：只影响当前房间的消息区展示。
  if (event.type === "room.queued") {
    if (state.roomKey !== event.item.roomKey) return state;
    if (state.queued.some((item) => item.submissionId === event.item.submissionId)) return state; // 重连重拉去重
    return { ...state, queued: [...state.queued, event.item] }; // 追加即投递顺序（服务端按入队序发）
  }
  if (event.type === "room.dequeued") {
    if (state.roomKey !== event.roomKey) return state;
    const next = state.queued.filter((item) => item.submissionId !== event.submissionId);
    return next.length === state.queued.length ? state : { ...state, queued: next };
  }
  // 授权事件是全局的（不属于任何房间视图，也不受当前房间过滤）：先于 roomKey 过滤处理。
  if (event.type === "permission.request") {
    if (state.permissionRequests.some((r) => r.id === event.request.id)) return state; // 重连重拉去重
    return { ...state, permissionRequests: [event.request, ...state.permissionRequests] }; // 新请求在前
  }
  if (event.type === "permission.resolved") {
    const next = state.permissionRequests.filter((r) => r.id !== event.id);
    // 未命中（本地已移除）返回同一引用 → 上层短路，避免无谓重建。
    return next.length === state.permissionRequests.length ? state : { ...state, permissionRequests: next };
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
        // run 结束仍留有 live：多为被中断（正常结束会先落 assistant message 并清掉）。清掉残影，避免幽灵气泡。
        if (event.phase === "end" && existing !== undefined && existing.error === undefined) {
          const live = { ...state.live };
          delete live[event.convId];
          return { ...state, busy, live };
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
