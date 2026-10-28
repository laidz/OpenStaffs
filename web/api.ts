import type { MeetingMessage } from "../src/app/meeting-messages.ts";
import type { MeetingView } from "../src/app/meetings.ts";
import type { QueuedItemView } from "../src/app/outbox.ts";
import type { MeetingSessionInfo } from "../src/app/conversations.ts";
import type { PermissionRequestView } from "../src/app/permission-flow.ts";

export type { PermissionRequestView } from "../src/app/permission-flow.ts";
export type { QueuedItemView } from "../src/app/outbox.ts";
export type { MeetingSessionInfo } from "../src/app/conversations.ts";
export type { MeetingView } from "../src/app/meetings.ts";

export type Status = { configured: boolean; root: string; port: number; model?: string; providers?: string[]; bossName: string };
export type EmployeeSummary = { id: string; alias?: string; model: string };
/** 组织树里的一员（与 EmployeeSummary 同形；树里也叫人）。 */
export type OrgPerson = { id: string; alias?: string; model: string };
/** 部门节点：本部门直属人 + 子部门（递归）。根部门 path === ""。 */
export type OrgDept = { path: string; name: string; people: OrgPerson[]; departments: OrgDept[] };
export type ProjectSummary = { id: string; alias: string; members: { id: string; alias?: string }[] };
/** 一个主题（员工 / 项目）的入口视图：当前会议 + 全部会议（倒序）。 */
export type SubjectView = {
  key: string;
  kind: "dm" | "group";
  subjectId: string;
  subjectLabel: string;
  participants: string[];
  current?: MeetingView;
  meetings: MeetingView[];
};
export type MeetingMessages = { meetingId: string; meeting: MeetingView; messages: MeetingMessage[]; pinned: string[]; queued: QueuedItemView[] };
export type SendResult = { meetingId: string; messageId: string; meeting: MeetingView; deliveries: { memberId: string; convId: string }[] };
export type ParticipantRow = { memberId: string; convId?: string };
export type ContextItemView = {
  role: "system" | "user" | "assistant" | "tool";
  kind?: string;
  text: string;
  thinking?: string;
  toolCalls?: { id?: string; name: string; arguments: unknown }[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  /** 这条消息产生时间（ISO）；没数据支撑就不显 */
  at?: string;
};
export type EmployeeSession = {
  convId: string;
  meetingId: string;
  kind: "dm" | "group";
  subjectKey: string;
  projectId?: string;
  projectAlias?: string;
  title?: string;
  running: boolean;
  model: string;
  thinkingLevel: string | null;
  contextUsed: number;
  contextWindow?: number;
};
export type ConfigScope = "agent" | "department" | "project";
/** 一层定义文件的原样内容（`text: null` = 该层没写配置文件）。 */
export type ConfigView = { scope: ConfigScope; file: string; text: string | null; id?: string };
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

function subjectPath(subjectKey: string): string {
  return `/api/subjects/${encodeURIComponent(subjectKey)}`;
}

function meetingPath(meetingId: string): string {
  return `/api/meetings/${encodeURIComponent(meetingId)}`;
}

export const api = {
  status: () => request<Status>("/api/status"),
  /** 组织树（部门嵌套 + 人）。 */
  org: () => request<{ root: OrgDept }>("/api/org"),
  projects: () => request<ProjectSummary[]>("/api/projects"),
  /** 主题入口：当前会议（可能没有）+ 历史会议列表。 */
  subject: (subjectKey: string) => request<SubjectView>(subjectPath(subjectKey)),
  /** 发送到某主题：`newMeeting` = 先开新会议（「新建会议」后的第一条消息）。返回实际落定的 meetingId。 */
  sendToSubject: (subjectKey: string, text: string, requestId: string, newMeeting = false) =>
    request<SendResult>(`${subjectPath(subjectKey)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, requestId, newMeeting }),
    }),
  message: (meetingId: string) => request<MeetingView>(meetingPath(meetingId)),
  messages: (meetingId: string) => request<MeetingMessages>(`${meetingPath(meetingId)}/messages`),
  /** 删除会议（老板专属）：不可恢复。 */
  deleteMeeting: (meetingId: string) =>
    request<{ ok: boolean; meetingId: string; subjectKey: string }>(meetingPath(meetingId), { method: "DELETE" }),
  /** 撤回一条排队中的消息（该条所有还没开始的投递）。 */
  cancelQueued: (meetingId: string, messageId: string) =>
    request<{ cancelled: string[] }>(`${meetingPath(meetingId)}/queue/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId }),
    }),
  participants: (meetingId: string) => request<{ participants: ParticipantRow[] }>(`${meetingPath(meetingId)}/sessions`),
  /** 当前会议各成员活跃会话的实际信息（模型 / 思考强度 / 上下文用量）。 */
  sessionInfo: (meetingId: string) => request<{ sessions: MeetingSessionInfo[] }>(`${meetingPath(meetingId)}/sessions/info`),
  /** 某条会话的完整上下文（系统提示词 + 模型条目）；只读。 */
  sessionContext: (employeeId: string, convId: string) =>
    request<SessionContextView>(`/api/employees/${encodeURIComponent(employeeId)}/sessions/${encodeURIComponent(convId)}/context`),
  /** 会议标题改名（手动）；返回落库后的实际标题。 */
  renameMeeting: (meetingId: string, title: string) =>
    request<{ meetingId: string; title: string; titleSource: string }>(`${meetingPath(meetingId)}/title`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    }),
  /** 一层定义文件的原文（左侧栏 {} 按钮）：agent / department / project。 */
  config: (scope: ConfigScope, id: string) =>
    request<ConfigView>(`/api/config?scope=${encodeURIComponent(scope)}&id=${encodeURIComponent(id)}`),
  /** 某条会话的原文（历史回看）：只读。 */
  history: (meetingId: string, convId: string) =>
    request<{ convId: string; memberId: string; messages: MeetingMessage[] }>(
      `${meetingPath(meetingId)}/sessions/${encodeURIComponent(convId)}/messages`,
    ),
  pin: (meetingId: string, convId: string, entryId: string, pinned: boolean) =>
    request<{ ok: boolean; count: number }>(`${meetingPath(meetingId)}/pin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ convId, entryId, pinned }),
    }),
  interrupt: (meetingId: string) => request<{ aborted: string[] }>(`${meetingPath(meetingId)}/interrupt`, { method: "POST" }),
  /** 侧栏红点：按主题键汇总（`dm:<员工>` / `group:<项目>`），服务端已折叠会议计数。 */
  pins: () => request<{ total: number; subjects: Record<string, number> }>("/api/pins"),
  permissionRequests: () => request<{ requests: PermissionRequestView[] }>("/api/permission-requests"),
  resolvePermission: (id: string, decision: "accept" | "reject") =>
    request<{ ok: boolean; warning?: string }>(`/api/permission-requests/${encodeURIComponent(id)}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    }),
};
