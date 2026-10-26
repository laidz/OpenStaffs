import type { RoomMessage } from "../src/app/rooms.ts";
import type { QueuedItemView } from "../src/app/outbox.ts";
import type { RoomSessionInfo } from "../src/app/conversations.ts";
import type { PermissionRequestView } from "../src/app/permission-flow.ts";

export type { PermissionRequestView } from "../src/app/permission-flow.ts";
export type { QueuedItemView } from "../src/app/outbox.ts";
export type { RoomSessionInfo } from "../src/app/conversations.ts";

export type Status = { configured: boolean; root: string; port: number; model?: string; providers?: string[]; bossName: string };
export type EmployeeSummary = { id: string; alias?: string; model: string };
/** 组织树里的一员（与 EmployeeSummary 同形；树里也叫人）。 */
export type OrgPerson = { id: string; alias?: string; model: string };
/** 部门节点：本部门直属人 + 子部门（递归）。根部门 path === ""。 */
export type OrgDept = { path: string; name: string; people: OrgPerson[]; departments: OrgDept[] };
export type ProjectSummary = { id: string; alias: string; members: { id: string; alias?: string }[] };
export type RoomMessages = { roomKey: string; messages: RoomMessage[]; pinned: string[]; queued: QueuedItemView[] };
export type SendResult = { roomMessageId: string; deliveries: { memberId: string; convId: string }[] };
export type ChainRow = { id: string; started: string; ended: string | null; previous: string | null };
export type ContextItemView = {
  role: "system" | "user" | "assistant" | "tool";
  kind?: string;
  text: string;
  thinking?: string;
  toolCalls?: { id?: string; name: string; arguments: unknown }[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
};
export type EmployeeSession = {
  convId: string;
  kind: "dm" | "group";
  relationKey: string;
  projectId?: string;
  projectAlias?: string;
  started: string;
  running: boolean;
  model: string;
  thinkingLevel: string | null;
  contextUsed: number;
  contextWindow?: number;
};
export type ConfigScope = "agent" | "department" | "project";
/** 一层定义文件的原样内容（`text: null` = 该层没写配置文件）。 */
export type ConfigView = { scope: ConfigScope; id: string; file: string; text: string | null };
export type SessionContextView = EmployeeSession & {
  instructions: string;
  cwd?: string;
  items: ContextItemView[];
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const text = await res.text();
  const body = text === "" ? undefined : (JSON.parse(text) as unknown);
  if (!res.ok) {
    const message = (body as { error?: string } | undefined)?.error ?? `HTTP ${res.status}`;
    throw new Error(message);
  }
  return body as T;
}

function roomPath(roomKey: string): string {
  return `/api/rooms/${encodeURIComponent(roomKey)}`;
}

export const api = {
  status: () => request<Status>("/api/status"),
  /** 组织树（部门嵌套 + 人）；取代旧的 /api/employees 平铺列表。 */
  org: () => request<{ root: OrgDept }>("/api/org"),
  projects: () => request<ProjectSummary[]>("/api/projects"),
  messages: (roomKey: string) => request<RoomMessages>(`${roomPath(roomKey)}/messages`),
  /** newSession=true：这条消息投递时对目标成员真正新开会话（「新开会话」按钮的落地）。 */
  send: (roomKey: string, text: string, requestId: string, newSession = false) =>
    request<SendResult>(`${roomPath(roomKey)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, requestId, newSession }),
    }),
  /** 撤回一条排队中的消息（该条所有还没开始的投递）。 */
  cancelQueued: (roomKey: string, roomMessageId: string) =>
    request<{ cancelled: string[] }>(`${roomPath(roomKey)}/queue/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomMessageId }),
    }),
  sessions: (roomKey: string) =>
    request<{ chains: { memberId: string; rows: ChainRow[] }[] }>(`${roomPath(roomKey)}/sessions`),
  /** 当前房间各成员活跃会话的实际信息（模型 / 思考强度 / 上下文用量）。 */
  sessionInfo: (roomKey: string) =>
    request<{ sessions: RoomSessionInfo[] }>(`${roomPath(roomKey)}/sessions/info`),
  /** 某条会话的完整上下文（系统提示词 + 模型条目）；只读。 */
  sessionContext: (employeeId: string, convId: string) =>
    request<SessionContextView>(`/api/employees/${encodeURIComponent(employeeId)}/sessions/${encodeURIComponent(convId)}/context`),
  /** 一层定义文件的原文（左侧栏 {} 按钮）：agent / department / project。`id` = 员工 id / 部门路径（"" = 根）/ 项目 id。 */
  config: (scope: ConfigScope, id: string) =>
    request<ConfigView>(`/api/config?scope=${encodeURIComponent(scope)}&id=${encodeURIComponent(id)}`),
  history: (roomKey: string, convId: string) =>
    request<{ convId: string; memberId: string; messages: RoomMessage[] }>(
      `${roomPath(roomKey)}/sessions/${encodeURIComponent(convId)}/messages`,
    ),
  pin: (roomKey: string, convId: string, entryId: string, pinned: boolean) =>
    request<{ ok: boolean; count: number }>(`${roomPath(roomKey)}/pin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ convId, entryId, pinned }),
    }),
  interrupt: (roomKey: string) => request<{ aborted: string[] }>(`${roomPath(roomKey)}/interrupt`, { method: "POST" }),
  pins: () => request<{ total: number; rooms: Record<string, number> }>("/api/pins"),
  permissionRequests: () => request<{ requests: PermissionRequestView[] }>("/api/permission-requests"),
  resolvePermission: (id: string, decision: "accept" | "reject") =>
    request<{ ok: boolean; warning?: string }>(`/api/permission-requests/${encodeURIComponent(id)}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    }),
};
