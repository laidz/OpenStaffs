import fs from "node:fs";
import path from "node:path";
import { Type, type TSchema } from "typebox";
import { parseMembers, projectsOf } from "../domain/access-control.ts";
import { readBossName, readConfig } from "../domain/config.ts";
import type { McpSessionResolver } from "../domain/mcp.ts";
import { listPeople, personDisplayName } from "../domain/org.ts";
import { loadEmployee } from "../domain/employee.ts";
import { loadAgentConfig } from "../config/load.ts";
import { officeDbFile, stateDir, type Workspace } from "../domain/paths.ts";
import { normalizeTools, type PermissionRequest, type PermissionRequestStore } from "../domain/permission-requests.ts";
import { listProjects } from "../domain/project.ts";
import type { Relation } from "../domain/types.ts";
import type { HarnessPort } from "../harness/port.ts";
import { relationCwd, resolveSession, sessionDefaults, type SessionDefaults } from "../app/conversations.ts";
import { senderLabel } from "../app/send.ts";
import { participantIds, subjectOf } from "../app/meetings.ts";
import { stripLeadingMentions } from "../app/message-row.ts";
import { toMeetingMessage, type MeetingMessage, type Speaker } from "../app/meeting-messages.ts";
import { openMeetingStore } from "../store/meetings.ts";
import { openMessageStore } from "../store/messages.ts";
import type { MeetingStore } from "../store/meetings.ts";
import type { SessionStore } from "../store/sessions.ts";
import { memoryTools } from "./memory.ts";
import { BOSS_PARTICIPANT } from "../store/row.ts";

/** 授权请求依赖（由装配层注入；未注入时 request_permission 报"不可用"）。 */
export type ToolPermissions = {
  store: PermissionRequestStore;
  notify: (request: PermissionRequest) => void;
};

/** 工具运行上下文：会话身份 + 编排依赖。 */
export type ToolContext = {
  ws: Workspace;
  harness: HarnessPort;
  selfId: string;
  relation: Relation;
  /** MCP 扩展选择（新建会话时按关系 / 发言人解析）。 */
  mcp?: McpSessionResolver;
  permissions?: ToolPermissions;
  /** 会议消息广播（R-P1-12）：装配层注入 SSE 喇叭；缺省不广播（工具仍落库）。 */
  broadcast?: (meetingId: string, message: MeetingMessage) => void;
  /** 我在这场会议里（框架自持的会话身份）：投递 / 回显都以它为锚。 */
  meetingId: string;
  /** 会议表：send_message / request_permission 用它定位会议。 */
  meetings: MeetingStore;
  /** 会话表（唯一真相）：send_message / meeting_history 用它把 (会议, 成员) 解析成 convId。 */
  sessions: SessionStore;
};

/** 统一注册表条目。 */
export type ToolDef = {
  name: string;
  description: string;
  parameters: TSchema;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
};

function displayName(ws: Workspace, id: string): string {
  return personDisplayName(ws, id);
}

/** 新会话/新条会话的模型与思考强度兜底（全局配置）。 */
function defaultsOf(ctx: ToolContext): SessionDefaults | undefined {
  return sessionDefaults(readConfig(ctx.ws));
}

/** `resolveSession` 的依赖（工具侧：ws + harness + 会话表 + 默认值 / MCP）。 */
function sessionDepsOf(ctx: ToolContext): Parameters<typeof resolveSession>[0] {
  const defaults = defaultsOf(ctx);
  return {
    ws: ctx.ws,
    harness: ctx.harness,
    sessions: ctx.sessions,
    ...(defaults === undefined ? {} : { defaults }),
    ...(ctx.mcp === undefined ? {} : { mcp: ctx.mcp }),
  };
}

/** 列出办公室：成员（id、展示名、所在部门） + 项目。 */
const officeList: ToolDef = {
  name: "office_list",
  description:
    "列出办公室：全部成员（id、展示名、所在部门）与全部项目（id、展示名、成员 id、你是否在其中）。想了解有哪些同事 / 哪些群聊时用它。",
  parameters: Type.Object({}),
  async run(_args, ctx) {
    const employees = listPeople(ctx.ws).map((p) => ({
      id: p.id,
      name: p.alias ?? p.id,
      department: p.departmentPath === "" ? "（办公室直属）" : p.departmentPath,
    }));
    const mine = new Set(projectsOf(ctx.ws, ctx.selfId));
    const projects = listProjects(ctx.ws).map((p) => ({
      id: p.id,
      name: p.alias,
      members: parseMembers(ctx.ws, p.id),
      youAreMember: mine.has(p.id),
    }));
    return JSON.stringify({ you: ctx.selfId, employees, projects }, null, 2);
  },
};

/** 读某成员资料。 */
const memberProfile: ToolDef = {
  name: "member_profile",
  description: "读某位成员的资料：id、展示名与其定义 config 的 prompt 正文。参数 member 是成员 id。",
  parameters: Type.Object({ member: Type.String({ description: "成员 id（<名字>.agent.config.json 的名字）" }) }),
  async run(args, ctx) {
    const member = String(args["member"]);
    const employee = loadEmployee(ctx.ws, member);
    const config = loadAgentConfig(employee.dir, employee.id);
    const prompt = config?.fields.prompt ?? "";
    return [`成员：${employee.alias ?? employee.id}（${employee.id}）`, prompt === "" ? "（未配置 prompt）" : prompt].join("\n\n");
  },
};

function speakerName(ws: Workspace, speaker: Speaker): string {
  if (speaker.kind === "boss") return readBossName(ws);
  return speaker.alias ?? displayName(ws, speaker.id);
}

/** 读某场会议的聊天记录（一场会议 = 一次会话；上一场会是另一个 meetingId）。 */
const meetingHistory: ToolDef = {
  name: "meeting_history",
  description:
    "读某场会议的聊天记录（含发言人）。缺省 = 我当前所在会议；也可传 meetingId（历史会议可回看，只读）。limit 取最近若干条（缺省 50）。",
  parameters: Type.Object({
    meeting: Type.Optional(Type.String({ description: "meetingId；缺省当前会议" })),
    limit: Type.Optional(Type.Number({ description: "最近 N 条，缺省 50" })),
  }),
  async run(args, ctx) {
    const meeting = args["meeting"] === undefined ? undefined : String(args["meeting"]);
    const meetingId = meeting === undefined ? ctx.meetingId : meeting;
    const meta = ctx.meetings.get(meetingId);
    if (meta === undefined) throw new Error(`会议不存在：${meetingId}`);
    const limitRaw = args["limit"];
    const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw) ? Math.max(1, Math.floor(limitRaw)) : 50;

    // 读自有消息库：会议历史不再读各成员 transcript。
    // 工具只有 ctx.ws，为它改 ToolCtx 装配会波及 harness（超出 P1 范围）→ 自开一个实例、用完即关；
    // SQLite 同进程多连接安全（HTTP / pump 用的是 main.ts 的唯一实例）。
    // `openstaffs/.data` 从未创建时也要能读：openMessageStore 现在自建父目录（此处 mkdir 幂等保留）、
    // 建库即空表 → 应返回「（暂无消息）」而不是报错。
    fs.mkdirSync(stateDir(ctx.ws), { recursive: true });
    const store = openMessageStore(officeDbFile(ctx.ws));
    try {
      const messages = store.byMeeting(meta.meetingId).map((m) => toMeetingMessage(m, meta.kind, readBossName(ctx.ws), ctx.ws));
      const recent = messages.slice(-limit);
      if (recent.length === 0) return "（暂无消息）";
      return recent.map((m) => `${speakerName(ctx.ws, m.speaker)}：${m.text}`).join("\n");
    } finally {
      store.close();
    }
  },
};

/**
 * 写路径自持广播（R-P1-12「谁写谁广播」）：落一行 + 广播该库行（键 `store:<seq>`）。
 * - 自有库实例按 `meeting_history` 同款处理：工具只有 `ctx.ws`，为它改 ToolCtx 装配会波及 harness（超出 P1 范围）
 *   → 自开一个实例、用完即关；SQLite 同进程多连接安全（HTTP / pump 用的是 main.ts 的唯一实例）。
 * - `text` 一律剥头部 @（与发送侧 `stripLeadingMentions` 同口径）；**空正文不落行**（也就不广播）。
 * - 归属由**本会议**决定（`ctx.meetingId`）：目标只决定投给谁，绝不决定消息落在哪场会议。
 */
function recordAndBroadcast(ctx: ToolContext, meeting: { meetingId: string; kind: "dm" | "group" }, row: { toIds: string[]; text: string }): void {
  const text = stripLeadingMentions(row.text);
  if (text === "") return;
  const store = openMessageStore(officeDbFile(ctx.ws));
  try {
    const stored = store.append({
      sendTime: new Date().toISOString(),
      meetingId: meeting.meetingId,
      fromId: ctx.selfId,
      toIds: row.toIds,
      text,
    });
    ctx.broadcast?.(meeting.meetingId, toMeetingMessage(stored, meeting.kind, readBossName(ctx.ws), ctx.ws));
  } finally {
    store.close();
  }
}

/** 通用发消息：**永远投在本会议内**（目标只决定投给谁，不决定消息落在哪场会议）。 */
const sendMessage: ToolDef = {
  name: "send_message",
  description:
    "在当前会议里发言。target 二选一：boss（发给负责人，会进其待办）；member:<成员id>（触发本会议里的该成员，即 @他，仅群聊会议）。text 为消息内容。",
  parameters: Type.Object({
    target: Type.String({ description: "boss | member:<成员id>" }),
    text: Type.String({ description: "消息内容" }),
  }),
  async run(args, ctx) {
    const target = String(args["target"]);
    const text = String(args["text"]);
    const meeting = ctx.meetings.get(ctx.meetingId);
    if (meeting === undefined) throw new Error(`会议不存在：${ctx.meetingId}`);
    if (target === "boss") {
      const { convId } = await resolveSession(sessionDepsOf(ctx), meeting, ctx.selfId);
      await ctx.harness.append(convId, { kind: "chat.message", text, data: { author: ctx.selfId } });
      // 会议内可见发言：落库 + 广播（会议 = 我当前所在的会议，收件人 = 老板）。
      recordAndBroadcast(ctx, meeting, { toIds: [BOSS_PARTICIPANT], text });
      return `已发给「${readBossName(ctx.ws)}」（会显示在其待办里）。`;
    }
    const memberMatch = /^member:(.+)$/u.exec(target);
    if (memberMatch !== null) {
      const memberId = memberMatch[1]!;
      if (meeting.kind !== "group") throw new Error("member: 目标只能在群聊会议里用（当前是私聊会议）");
      if (!participantIds(ctx.ws, subjectOf(meeting)).includes(memberId)) throw new Error(`不是本会议成员：${memberId}`);
      const { convId } = await resolveSession(sessionDepsOf(ctx), meeting, memberId);
      // 接收者的模型上下文只看到正文：派活必须自报身份，否则他找不到该回告谁。
      await ctx.harness.submit(convId, `${senderLabel(ctx.ws, ctx.selfId)}：${text}`, { kind: "chat.message", data: { author: ctx.selfId } });
      // 会议内可见发言：落库 + 广播（会议不变，收件人 = 被触发的成员）。
      recordAndBroadcast(ctx, meeting, { toIds: [memberId], text });
      return `已触发 ${memberId}。`;
    }
    throw new Error(`无法识别的 target：${target}（应为 boss | member:<id>）`);
  },
};

/**
 * 申请权限（异步：负责人稍后在界面弹框中处理）。
 * 权限类型**必填**；同一组目录要多种权限时一次列全（服务端也会按「人 × 会议 × 目录组」合并，
 * 但一次请求能让弹框第一眼就完整，不用老板看两张卡）。
 */
const requestPermission: ToolDef = {
  name: "request_permission",
  description:
    "向负责人申请权限（异步）。tools 必填：要申请的权限类型数组（write / read / bash …，至少一个）；**同一组目录需要多种权限时一次列全**（如 [\"read\",\"write\"]），不要分多次申请。paths 为要申请的路径（目录或文件，可多条；相对路径按当前工作目录解析）；reason 为简短理由（必填，会展示给负责人）。权限按工具授予，写 / 读 / bash 各是一张路径表。",
  parameters: Type.Object({
    tools: Type.Array(Type.String(), {
      description: "要申请的权限类型（至少一个）：write / read / bash。同一组目录的多种权限请一次列全，不要分开发起。",
    }),
    paths: Type.Array(Type.String(), { description: "要申请的路径（目录 / 文件，可多个）" }),
    reason: Type.String({ description: "简短理由：为什么需要这些路径（会展示给负责人）" }),
  }),
  async run(args, ctx) {
    const permissions = ctx.permissions;
    if (permissions === undefined) throw new Error("授权申请不可用：当前会话未装配该能力。");
    const cwd = relationCwd(ctx.ws, ctx.relation, ctx.selfId);
    const rawPaths = Array.isArray(args["paths"]) ? args["paths"] : [];
    const paths = [
      ...new Set(
        rawPaths
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter((value) => value !== "")
          .map((value) => path.resolve(cwd, value)),
      ),
    ];
    const bossName = readBossName(ctx.ws);
    if (paths.length === 0) throw new Error("paths 不能为空：至少给出一个要申请的路径。");
    const reason = String(args["reason"] ?? "").trim();
    if (reason === "") throw new Error(`reason 不能为空：用一两句话说明为什么要这些路径（会展示给「${bossName}」）。`);
    // 权限类型必填、不得回落 write：让弹框上的每种权限都是发起者明确要的。
    const tools = normalizeTools(args["tools"]);
    if (tools.length === 0) throw new Error("tools 不能为空：必须明确要哪种权限（write / read / bash）。");
    // 工具名会被写进 config 的 permissions 键与日志，只放行字母 / 数字 / _ / -（防路径穿越或怪异键）。
    for (const tool of tools) {
      if (!/^[A-Za-z0-9_-]+$/u.test(tool)) throw new Error(`tools 不合法：${tool}（只允许字母、数字、下划线、连字符）`);
    }

    const { request, merged, addedTools } = permissions.store.add({
      agentId: ctx.selfId,
      meetingId: ctx.meetingId,
      tools,
      paths,
      reason,
    });
    permissions.notify(request);
    const toolList = request.tools.join("+");
    const waiting = "等待处理：请勿重复发起，也不要尝试访问这些路径或用其他方式绕过拦截；处理后你会收到新消息。";
    if (merged) {
      if (addedTools.length === 0) {
        return `已有完全相同的授权请求在等待「${bossName}」处理（权限：[${toolList}]；${paths.length} 个目录），请勿重复发起。`;
      }
      return [
        `已把「${addedTools.join("、")}」并入同一组目录的等待请求（当前权限：[${toolList}]）：`,
        ...paths.map((value) => `- ${value}`),
        waiting,
      ].join("\n");
    }
    return [
      `已向「${bossName}」发起授权请求（权限：[${toolList}]；${paths.length} 个目录）：`,
      ...paths.map((value) => `- ${value}`),
      waiting,
    ].join("\n");
  },
};

/** OpenStaffs 自有工具（统一注册表，唯一真相源）。加工具 = 加一条并在此登记。 */
export const openStaffsToolDefs: readonly ToolDef[] = [
  officeList,
  memberProfile,
  meetingHistory,
  sendMessage,
  requestPermission,
  ...memoryTools,
];
