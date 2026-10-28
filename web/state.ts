import type { MeetingMessage } from "../src/app/meeting-messages.ts";
import type { QueuedItemView } from "../src/app/outbox.ts";
import type { MeetingView } from "../src/app/meetings.ts";
import type { ServerEvent } from "../src/server/sse.ts";
import type { EmployeeSession, EmployeeSummary, OrgDept, PermissionRequestView, ProjectSummary, MeetingSessionInfo } from "./api.ts";

/** 正在跑的工具（栈：支持并行调用）：`hint` 是参数里的人话提示（命令 / 路径…），有就上状态行。 */
export type ToolActivity = { name: string; hint?: string };

export type Live = {
  convId: string;
  memberId: string;
  text: string;
  thinking: string;
  tools: ToolActivity[];
  /** 状态行文案（「正在思考…」/「正在准备调用 bash…」/「正在执行 bash：ls」）：run 期间**恒非空**。 */
  activity: string;
  error?: string;
};

/** 正在跑的工具有人话文案；没工具在跑 → undefined（由调用方按当前阶段给文案）。 */
export function runningText(tools: ToolActivity[]): string | undefined {
  if (tools.length === 0) return undefined;
  if (tools.length > 1) return `正在执行 ${tools.length} 个工具：${tools.map((tool) => tool.name).join("、")}`;
  const only = tools[0]!;
  return only.hint === undefined ? `正在执行 ${only.name}…` : `正在执行 ${only.name}：${only.hint}`;
}

/** 状态行文案：工具真实执行优先于一切（这是用户最想看到的事实），其次才是思考 / 输出。 */
function activityText(tools: ToolActivity[], fallback: "thinking" | "text"): string {
  const running = runningText(tools);
  if (running !== undefined) return running;
  return fallback === "text" ? "正在输出…" : "正在思考…";
}

/** 授权卡片条目：视图数据 + 本地处理态（busy 禁用按钮、error 红字提示）。 */
export type PermissionRequestItem = PermissionRequestView & { busy?: boolean; error?: string };

export type State = {
  configured: boolean;
  bossName: string;
  employees: EmployeeSummary[];
  projects: ProjectSummary[];
  permissionRequests: PermissionRequestItem[];
  /** 当前看的是哪个主题（`dm:<员工>` / `group:<项目>`）：侧栏高亮与「新建会议」的锚。 */
  subjectKey?: string;
  /** 当前会议 id（undefined = 该主题还没有会议 / 刚点「新建会议」，等第一条消息）。 */
  meetingId?: string;
  /** 当前会议元信息（标题、实时成员）。 */
  meeting?: MeetingView;
  /** 该主题的全部会议（含当前，倒序）：「历史」列表。 */
  meetings: MeetingView[];
  /** 「新建会议」已点、尚未发第一条：聊天区清空、等发送才真正建会议。 */
  freshMeeting: boolean;
  messages: MeetingMessage[];
  /** 排队中的老板消息（当前会议）：还没投递给员工，按投递顺序。 */
  queued: QueuedItemView[];
  /** 当前会议各成员活跃会话信息（模型 / 思考强度 / 上下文用量）。 */
  sessions: MeetingSessionInfo[];
  live: Record<string, Live>;
  /** 侧栏红点：该主题所有会议里被 pin 的消息数（会议没有「结束」）。 */
  pins: Record<string, number>;
  /** 当前会议被 pin 的消息键（convId:entryId），用于气泡高亮。 */
  pinned: string[];
  busy: Record<string, boolean>;
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
  meetings: [],
  freshMeeting: false,
  messages: [],
  sessions: [],
  queued: [],
  live: {},
  pins: {},
  pinned: [],
  busy: {},
  org: undefined,
  collapsedDepts: [],
};

export type UiEvent =
  | { type: "status"; configured: boolean; bossName: string }
  | { type: "org"; root: OrgDept }
  | { type: "projects"; list: ProjectSummary[] }
  /** 主题视图（当前会议 + 历史会议）：切侧栏 / 首次进入。 */
  | { type: "subject"; subjectKey: string; current?: MeetingView; meetings: MeetingView[] }
  /** 会议视图：正在看某场会议（messages = 该会议全部消息）。 */
  | { type: "meeting"; meetingId: string; meeting: MeetingView; messages: MeetingMessage[]; pinned: string[]; queued?: QueuedItemView[] }
  | { type: "sessions"; meetingId: string; sessions: MeetingSessionInfo[] }
  /** 会议标题变了（自动命名 / 时间缺省 / 手动改名）：只改对得上的那一条。 */
  | { type: "title"; meetingId: string; title: string }
  | { type: "close-meeting" }
  | { type: "pins"; pins: { total: number; subjects: Record<string, number> } }
  | { type: "pin"; meetingId: string; key: string; pinned: boolean }
  | { type: "new-meeting"; on: boolean }
  | { type: "permissions"; list: PermissionRequestView[] }
  | { type: "permission-busy"; id: string; busy: boolean }
  | { type: "permission-error"; id: string; error: string }
  | { type: "permission-resolved"; id: string }
  | { type: "toggle-dept"; path: string }
  | { type: "sse"; event: ServerEvent };

export function selectView(state: State): "setup" | "main" {
  return state.configured ? "main" : "setup";
}

function messageKey(message: MeetingMessage): string {
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

/** 增量合并：按消息键（convId:entryId，会议视图里即 `store:<seq>`）去重，保持排序。 */
function appendMessage(messages: MeetingMessage[], incoming: MeetingMessage): MeetingMessage[] {
  if (messages.some((m) => messageKey(m) === messageKey(incoming))) return messages;
  return [...messages, incoming].sort((a, b) => Number(a.entryId) - Number(b.entryId));
}

function liveOf(state: State, convId: string, memberId: string): Live {
  return state.live[convId] ?? { convId, memberId, text: "", thinking: "", tools: [], activity: "" };
}

/** 工具结束：按名字移除最后一条同名项（并行调用时不是简单弹栈）；找不到就原样返回。 */
function dropTool(tools: ToolActivity[], name: string | undefined): ToolActivity[] {
  const index = name === undefined ? tools.length - 1 : tools.map((tool) => tool.name).lastIndexOf(name);
  if (index < 0) return tools;
  return [...tools.slice(0, index), ...tools.slice(index + 1)];
}

/** 换会议 / 换主题时的公共清理：消息区与运行态一起清（不能把上一场的流式气泡带过去）。 */
function cleared(state: State): State {
  return { ...state, messages: [], pinned: [], queued: [], sessions: [], live: {} };
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
    case "subject": {
      const next = cleared({ ...state, subjectKey: event.subjectKey, meetings: event.meetings, freshMeeting: false });
      return { ...next, meetingId: event.current?.meetingId, meeting: event.current };
    }
    case "meeting":
      return {
        ...cleared(state),
        meetingId: event.meetingId,
        meeting: event.meeting,
        messages: event.messages,
        pinned: event.pinned,
        queued: event.queued ?? [],
        freshMeeting: false,
      };
    case "sessions":
      // 迟到的结果不串台：只接受当前会议。
      return state.meetingId === event.meetingId ? { ...state, sessions: event.sessions } : state;
    case "title": {
      if (state.meetingId !== event.meetingId) return state;
      const next = state.meeting === undefined ? state : { ...state, meeting: { ...state.meeting, title: event.title } };
      return {
        ...next,
        meetings: state.meetings.map((meeting) => (meeting.meetingId === event.meetingId ? { ...meeting, title: event.title } : meeting)),
      };
    }
    case "close-meeting":
      return { ...cleared(state), subjectKey: undefined, meetingId: undefined, meeting: undefined, meetings: [], freshMeeting: false };
    case "new-meeting": {
      if (state.freshMeeting === event.on) return state;
      // 点「新建会议」= 聊天区立刻清空（会议还没落，等第一条消息）；取消由上层重拉当前会议恢复。
      return event.on ? { ...cleared(state), freshMeeting: true } : { ...state, freshMeeting: false };
    }
    case "pins":
      // 服务端按**主题**（`dm:<员工>` / `group:<项目>`）折叠，与侧栏行的键一致。
      return { ...state, pins: event.pins.subjects };
    case "pin": {
      if (state.meetingId !== event.meetingId) return state; // 非当前会议的本地 pin 事件不生效
      const next = event.pinned
        ? state.pinned.includes(event.key)
          ? state.pinned
          : [...state.pinned, event.key]
        : state.pinned.filter((key) => key !== event.key);
      if (next === state.pinned) return state;
      // 侧栏红点按主题算（该主题所有会议的 pin 一起计）。
      return state.subjectKey === undefined
        ? { ...state, pinned: next }
        : { ...state, pinned: next, pins: { ...state.pins, [state.subjectKey]: next.length } };
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
  if (event.type === "meeting.title") {
    return reduce(state, { type: "title", meetingId: event.meetingId, title: event.title });
  }
  if (event.type === "meeting.deleted") {
    const meetings = state.meetings.filter((meeting) => meeting.meetingId !== event.meetingId);
    if (state.meetingId !== event.meetingId) {
      return meetings.length === state.meetings.length ? state : { ...state, meetings };
    }
    // 当前会议被删（别处标签页 / 本人操作）：清掉消息区，停在「暂无记录」；侧栏仍在该主题。
    return { ...cleared(state), meetingId: undefined, meeting: undefined, meetings };
  }
  if (event.type === "meeting.pins") {
    // 只更新当前会议所属主题：别的会议（别处标签页）不该改本页侧栏红点。
    if (state.meetingId !== event.meetingId || state.subjectKey === undefined) return state;
    return { ...state, pins: { ...state.pins, [state.subjectKey]: event.count } };
  }
  // 待发队列（入队 / 出队）：只影响当前会议的消息区展示。
  if (event.type === "meeting.queued") {
    if (state.meetingId !== event.item.meetingId) return state;
    if (state.queued.some((item) => item.submissionId === event.item.submissionId)) return state; // 重连重拉去重
    return { ...state, queued: [...state.queued, event.item] }; // 追加即投递顺序（服务端按入队序发）
  }
  if (event.type === "meeting.dequeued") {
    if (state.meetingId !== event.meetingId) return state;
    const next = state.queued.filter((item) => item.submissionId !== event.submissionId);
    return next.length === state.queued.length ? state : { ...state, queued: next };
  }
  // 授权事件是全局的（不属于任何会议视图）：先于 meetingId 过滤处理。
  if (event.type === "permission.request") {
    // 同 id = 服务端把新权限并进了已有请求（或重连重拉）：原地更新那一张卡，
    // 不能像以前那样直接忽略（否则合并后的权限在弹框上永远不出现）。本地处理态保留。
    const existing = state.permissionRequests.find((r) => r.id === event.request.id);
    if (existing !== undefined) {
      const next = {
        ...event.request,
        ...(existing.busy === undefined ? {} : { busy: existing.busy }),
        ...(existing.error === undefined ? {} : { error: existing.error }),
      };
      return { ...state, permissionRequests: state.permissionRequests.map((r) => (r.id === event.request.id ? next : r)) };
    }
    return { ...state, permissionRequests: [event.request, ...state.permissionRequests] }; // 新请求在前
  }
  if (event.type === "permission.resolved") {
    const next = state.permissionRequests.filter((r) => r.id !== event.id);
    return next.length === state.permissionRequests.length ? state : { ...state, permissionRequests: next };
  }
  if (state.meetingId !== event.meetingId) {
    if (event.type === "meeting.activity" && event.kind === "run") {
      return { ...state, busy: { ...state.busy, [event.memberId]: event.phase === "start" } };
    }
    return state;
  }
  switch (event.type) {
    case "meeting.message": {
      const messages = appendMessage(state.messages, event.message);
      // 去重命中（如重拉重喂）：返回同一引用 → 上层 dispatch 短路，不触发任何重建。
      if (messages === state.messages) return state;
      // 仅当真正追加时才清 live：去重命中不得误删进行中的流式气泡
      if (event.message.speaker.kind !== "employee") {
        return { ...state, messages };
      }
      // 按**成员**清（不能按 convId）：正式消息来自库行视图，convId 恒为 "store"。
      const speakerId = event.message.speaker.id;
      const keeping = Object.entries(state.live).filter(([, entry]) => entry.memberId !== speakerId);
      if (keeping.length === Object.keys(state.live).length) return { ...state, messages };
      return { ...state, messages, live: Object.fromEntries(keeping) };
    }
    case "meeting.delta": {
      const existing = liveOf(state, event.convId, event.memberId);
      const updated =
        event.channel === "text"
          ? { ...existing, text: existing.text + event.delta, activity: activityText(existing.tools, "text") }
          : { ...existing, thinking: existing.thinking + event.delta, activity: activityText(existing.tools, "thinking") };
      // 同一会话重试时，新的增量必须露出来：清掉上一轮 failed 留下的错误提示。
      delete updated.error;
      return { ...state, live: { ...state.live, [event.convId]: updated } };
    }
    case "meeting.activity": {
      if (event.kind === "run") {
        const busy = { ...state.busy, [event.memberId]: event.phase === "start" };
        const existing = state.live[event.convId];
        if (event.phase === "start") {
          // run 开始就出「进行中」气泡（转圈 + 状态行）：不必等第一段增量。
          if (existing === undefined) {
            const fresh: Live = { convId: event.convId, memberId: event.memberId, text: "", thinking: "", tools: [], activity: "正在思考…" };
            return { ...state, busy, live: { ...state.live, [event.convId]: fresh } };
          }
          if (existing.error === undefined) return { ...state, busy };
          const clearedLive = { ...existing };
          delete clearedLive.error;
          return { ...state, busy, live: { ...state.live, [event.convId]: clearedLive } };
        }
        // run 结束仍留有 live：多为被中断（正常结束会先落 assistant message 并清掉）。清掉残影。
        if (existing !== undefined && existing.error === undefined) {
          const live = { ...state.live };
          delete live[event.convId];
          return { ...state, busy, live };
        }
        return { ...state, busy };
      }
      // 工具起止 / 调用参数开流：只改**工具栈**与状态行文案。
      if (event.kind === "toolCall") {
        const composing = liveOf(state, event.convId, event.memberId);
        if (runningText(composing.tools) !== undefined) return state; // 已有工具真在跑：以执行真相为准
        return {
          ...state,
          live: { ...state.live, [event.convId]: { ...composing, activity: `正在准备调用 ${event.name === "" || event.name === undefined ? "工具" : event.name}…` } },
        };
      }
      const existing = liveOf(state, event.convId, event.memberId);
      const tools =
        event.phase === "start"
          ? [...existing.tools, { name: event.name ?? "", ...(event.hint === undefined ? {} : { hint: event.hint }) }]
          : dropTool(existing.tools, event.name);
      const activity =
        event.phase === "start"
          ? activityText(tools, "thinking")
          : (runningText(tools) ?? (event.name === undefined || event.name === "" ? "正在思考…" : `已完成 ${event.name}`));
      return { ...state, live: { ...state.live, [event.convId]: { ...existing, tools, activity } } };
    }
    case "meeting.failed": {
      const existing = liveOf(state, event.convId, event.memberId);
      return { ...state, live: { ...state.live, [event.convId]: { ...existing, error: event.message } } };
    }
    default:
      return state;
  }
}
