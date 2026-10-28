import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { loadProjectConfig } from "../config/load.ts";
import { agentConfigFile, departmentConfigFile, projectConfigFile } from "../config/naming.ts";
import { listProjects } from "../domain/project.ts";
import { parseMembers } from "../domain/access-control.ts";
import { bossNamesFor, displayThinkingLevel, formatModelRef, readBossName, resolveEmployeeModel, type WorkspaceConfig } from "../domain/config.ts";
import type { McpSessionResolver } from "../domain/mcp.ts";
import { findPerson, loadOrg, type OrgDepartment, type OrgTree } from "../domain/org.ts";
import type { Workspace } from "../domain/paths.ts";
import { agentsDir } from "../domain/paths.ts";
import { transcriptMessages, toMeetingMessage, type MeetingMessage } from "../app/meeting-messages.ts";
import { messageKey, pinCounts, readPins, removeMeetingPins, setPin } from "../app/pins.ts";
import { Outbox, queuedItemView } from "../app/outbox.ts";
import {
  employeeActiveSessions, interruptMeeting, meetingParticipants, meetingSessionInfo, sessionDefaults, type Relation,
} from "../app/conversations.ts";
import { EmptyGroupError, KeyedQueue, NoTargetsError, sendToMeeting } from "../app/send.ts";
import type { MeetingTitleDeps } from "../app/meeting-titles.ts";
import { renameMeeting } from "../app/meeting-titles.ts";
import {
  createNewMeeting, deleteMeeting, ensureMeeting, meetingView, meetingsOf, parseSubjectKey, participantIds, subjectKeyOf, subjectLabel, subjectOf,
} from "../app/meetings.ts";
import type { PermissionRequestStore } from "../domain/permission-requests.ts";
import { permissionRequestView, resolvePermissionRequest, PermissionRequestNotFoundError } from "../app/permission-flow.ts";
import type { MeetingKind, MeetingStore } from "../store/meetings.ts";
import type { MessageStore } from "../store/messages.ts";
import type { SessionStore } from "../store/sessions.ts";
import type { HarnessPort } from "../harness/port.ts";
import type { SseHub } from "./sse.ts";

export type PumpLike = {
  register(convId: string, ref: { meetingId: string; memberId: string }): Promise<void>;
  unregister(convId: string): Promise<void>;
  /** 会话当前是否在跑（「会话上下文」面板的运行点）；缺省视为未知 / false。 */
  isRunning?(convId: string): boolean;
};

export type ServerDeps = {
  ws: Workspace;
  getConfig: () => WorkspaceConfig | undefined;
  getHarness: () => HarnessPort | undefined;
  queue: KeyedQueue;
  /** 自有消息库（P1）：全进程唯一实例，由 main.ts 创建并注入；老板发消息时落一行。 */
  store: MessageStore;
  /** 会议表（框架自持的会话身份）：subject ↔ meeting、标题、历史都读它。 */
  meetings: MeetingStore;
  /** 会话表（唯一真相：convId ↔ 会议 ↔ 成员）：会话列表 / 信息条 / 发送都读它。 */
  sessions: SessionStore;
  publicDir: string;
  /** 实际监听端口（启动参数 / config / 默认值解析后的结果）；status 展示用。 */
  port: number;
  pump?: PumpLike;
  hub?: SseHub;
  /** 待发表（排队中的老板消息）：与 Pump 共享同一实例；缺省自建（则只服务本服务器的展示与撤回）。 */
  outbox?: Outbox;
  /** 授权请求存储（装配层注入；缺省时相关端点降级）。 */
  permissionRequests?: PermissionRequestStore;
  /** MCP 扩展选择（发送 / 授权结果投递时装配新会话）。 */
  mcp?: McpSessionResolver;
  /** 会议标题依赖（新会议命名 / 改名端点写入）；缺省时新会议不命名、PATCH 端点 503。 */
  titles?: MeetingTitleDeps;
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 1024 * 1024) throw new Error("请求体过大");
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("请求体不是合法 JSON");
  }
}

type OrgPersonJson = { id: string; alias?: string; model: string };
type OrgDeptJson = { path: string; name: string; people: OrgPersonJson[]; departments: OrgDeptJson[] };

/** 部门 → 视图：展示名 = department.config.json 的 alias，根部门兜底「办公室」。 */
function orgDeptView(config: WorkspaceConfig, dept: OrgDepartment): OrgDeptJson {
  return {
    path: dept.path,
    name: dept.path === "" ? (dept.alias ?? "办公室") : (dept.alias ?? dept.name),
    people: dept.people.map((person) => ({
      id: person.id,
      ...(person.alias === undefined ? {} : { alias: person.alias }),
      model: formatModelRef(resolveEmployeeModel(config.model, person.model)),
    })),
    departments: dept.departments.map((child) => orgDeptView(config, child)),
  };
}

function memberSummaries(ws: Workspace, tree: OrgTree, project: string): { id: string; alias?: string }[] {
  return parseMembers(ws, project).map((id) => {
    const person = findPerson(tree, id);
    return { id, ...(person?.alias === undefined ? {} : { alias: person.alias }) };
  });
}

export type ConfigScope = "agent" | "department" | "project";

const CONFIG_SCOPES: readonly ConfigScope[] = ["agent", "department", "project"];

/** id 不得带 NUL / 绝对路径 / `..`（部门 id 允许带分隔符表示嵌套部门）。 */
function safeConfigId(id: string): boolean {
  if (id.includes("\0") || path.isAbsolute(id)) return false;
  return !id.split(/[\\/]/u).includes("..");
}

/**
 * 老板在 UI 里查看定义文件：只认三类已知文件名（`*.agent.config.json` / `department.config.json` /
 * `*.project.config.json`），越界或不存在都返回 undefined（由调用方回 404）。
 */
function configFileFor(ws: Workspace, scope: string, id: string): string | undefined {
  if (!CONFIG_SCOPES.includes(scope as ConfigScope) || !safeConfigId(id)) return undefined;
  if (scope === "project") {
    return id.trim() === "" || id.includes("/") || id.includes("\\") ? undefined : projectConfigFile(ws, id);
  }
  if (scope === "agent") {
    const person = findPerson(loadOrg(ws), id);
    return person === undefined ? undefined : agentConfigFile(person.dir, id);
  }
  // 部门：id = 部门路径（"" = 根部门），目录必须落在 agents/ 内。
  const root = agentsDir(ws);
  const dir = path.resolve(root, id);
  if (dir !== root && !dir.startsWith(`${root}${path.sep}`)) return undefined;
  return departmentConfigFile(dir);
}

function resolveStatic(publicDir: string, pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined; // 畸形百分号编码（如 /%ZZ）→ 404，不是 500
  }
  const rel = decoded === "/" ? "index.html" : decoded.replace(/^\/+/u, "");
  const base = path.resolve(publicDir);
  const target = path.resolve(base, rel);
  if (target === base) return path.join(base, "index.html");
  if (!target.startsWith(base + path.sep)) return undefined;
  return target;
}

/** 「会话上下文」：该员工的活跃会话列表 + 单条会话的完整上下文（只读）。 */
async function handleEmployees(
  deps: ServerDeps,
  res: http.ServerResponse,
  method: string,
  segments: string[],
): Promise<void> {
  if (method !== "GET") {
    json(res, 405, { error: "方法不允许" });
    return;
  }
  let employeeId: string;
  try {
    employeeId = decodeURIComponent(segments[2]!);
  } catch {
    json(res, 404, { error: "员工不存在" });
    return;
  }
  const person = findPerson(loadOrg(deps.ws), employeeId);
  const harness = deps.getHarness();
  if (person === undefined) {
    json(res, 404, { error: "员工不存在" });
    return;
  }
  if (harness === undefined) {
    json(res, 503, { error: "会话服务未就绪" });
    return;
  }

  const projects = new Map(listProjects(deps.ws).map((project) => [project.id, project.alias]));
  // 会话 → 会议 + 主题（面板按会议分组 / 展示标题）。
  const meetingContext = (meetingId: string): Record<string, unknown> => {
    const meta = deps.meetings.get(meetingId);
    if (meta === undefined) return { meetingId };
    return {
      meetingId,
      kind: meta.kind,
      subjectKey: meta.kind === "dm" ? `dm:${meta.subjectId}` : `group:${meta.subjectId}`,
      ...(meta.kind === "group" ? { projectId: meta.subjectId, projectAlias: projects.get(meta.subjectId) ?? meta.subjectId } : {}),
      ...(meta.title === undefined ? {} : { title: meta.title }),
    };
  };
  const sessions = employeeActiveSessions(deps.ws, deps.meetings, deps.sessions, employeeId);

  if (segments.length === 4 && segments[3] === "sessions") {
    const out: Record<string, unknown>[] = [];
    for (const session of sessions) {
      try {
        const usage = await harness.sessionUsage(session.convId);
        out.push({
          convId: session.convId,
          ...meetingContext(session.meetingId),
          running: deps.pump?.isRunning?.(session.convId) ?? false,
          model: formatModelRef(usage.model),
          thinkingLevel: displayThinkingLevel(usage.thinkingLevel, usage.supportedThinkingLevels),
          contextUsed: usage.contextUsed,
          ...(usage.contextWindow === undefined ? {} : { contextWindow: usage.contextWindow }),
        });
      } catch {
        // 坏会话跳过：一条会话取不到信息不该让整个面板 500。
      }
    }
    out.sort((a, b) => Number(b["running"] === true) - Number(a["running"] === true));
    json(res, 200, { employee: { id: person.id, ...(person.alias === undefined ? {} : { alias: person.alias }) }, sessions: out });
    return;
  }

  if (segments.length === 6 && segments[3] === "sessions" && segments[5] === "context") {
    let convId: string;
    try {
      convId = decodeURIComponent(segments[4]!);
    } catch {
      json(res, 404, { error: "会话不存在或已结束" });
      return;
    }
    const session = sessions.find((item) => item.convId === convId);
    if (session === undefined) {
      json(res, 404, { error: "会话不存在或已结束" });
      return;
    }
    const [usage, context] = await Promise.all([harness.sessionUsage(convId), harness.context(convId)]);
    json(res, 200, {
      convId,
      ...meetingContext(session.meetingId),
      running: deps.pump?.isRunning?.(convId) ?? false,
      model: formatModelRef(usage.model),
      thinkingLevel: displayThinkingLevel(usage.thinkingLevel, usage.supportedThinkingLevels),
      contextUsed: usage.contextUsed,
      ...(usage.contextWindow === undefined ? {} : { contextWindow: usage.contextWindow }),
      instructions: context.instructions,
      ...(context.cwd === undefined ? {} : { cwd: context.cwd }),
      items: context.items,
    });
    return;
  }

  json(res, 404, { error: "接口不存在" });
}

/** 主题（员工 / 项目）是否存在：dm 看人，group 看项目配置。 */
function subjectExists(ws: Workspace, relation: Relation): boolean {
  return relation.kind === "dm"
    ? findPerson(loadOrg(ws), relation.employeeId) !== undefined
    : loadProjectConfig(ws, relation.project) !== undefined;
}

/** 主题视图：侧栏 / 历史面板用（当前会议 + 全部会议）。 */
function subjectView(deps: ServerDeps, relation: Relation): Record<string, unknown> {
  const meetings = meetingsOf({ ws: deps.ws, meetings: deps.meetings }, relation);
  const current = meetings[0]; // 最新创建的那一场 = 进入主题时的「当前会议」
  return {
    key: subjectKeyOf(relation),
    kind: relation.kind,
    subjectId: relation.kind === "dm" ? relation.employeeId : relation.project,
    subjectLabel: subjectLabel(deps.ws, relation),
    participants: participantIds(deps.ws, relation),
    ...(current === undefined ? {} : { current: meetingView(deps.ws, current) }),
    meetings: meetings.map((meeting) => meetingView(deps.ws, meeting)),
  };
}

/** 会议消息视图（GET /<meeting>/messages 与 pin 校验共用）。 */
function meetingMessages(deps: ServerDeps, outbox: Outbox, meeting: { meetingId: string; kind: MeetingKind }): MeetingMessage[] {
  const bossName = readBossName(deps.ws);
  const queuedByStoreSeq = outbox.messageIdByStoreSeq(meeting.meetingId);
  return deps.store.byMeeting(meeting.meetingId).map((stored) => {
    const view = toMeetingMessage(stored, meeting.kind, bossName, deps.ws);
    const messageId = queuedByStoreSeq.get(stored.seq);
    return messageId === undefined ? view : { ...view, messageId };
  });
}

/** 主题维度的入口：`/api/subjects/<key>`（当前会议 + 历史）与 `/<key>/messages`（发送，可要求新会议）。 */
async function handleSubjects(
  deps: ServerDeps,
  outbox: Outbox,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  rawKey: string,
  rest: string[],
): Promise<void> {
  let subjectKey: string;
  try {
    subjectKey = decodeURIComponent(rawKey);
  } catch {
    json(res, 404, { error: "会话不存在" });
    return;
  }
  const relation = parseSubjectKey(subjectKey);
  const harness = deps.getHarness();
  const config = deps.getConfig();
  if (relation === undefined || !subjectExists(deps.ws, relation)) {
    json(res, 404, { error: "会话不存在" });
    return;
  }

  if (rest.length === 0 && method === "GET") {
    json(res, 200, subjectView(deps, relation));
    return;
  }

  if (rest.length === 1 && rest[0] === "messages" && method === "POST") {
    if (harness === undefined || config === undefined) {
      json(res, 503, { error: "会话服务未就绪" });
      return;
    }
    const body = (await readJsonBody(req)) as { text?: unknown; requestId?: unknown; newMeeting?: unknown } | undefined;
    const text = typeof body?.text === "string" ? body.text : "";
    if (text.trim() === "") {
      json(res, 400, { error: "消息不能为空" });
      return;
    }
    const requestId = typeof body?.requestId === "string" && body.requestId !== "" ? body.requestId : undefined;
    // 「新建会议」：第一条消息落会议时才真正新建（空点不产生会议）。
    const meeting = body?.newMeeting === true
      ? createNewMeeting({ ws: deps.ws, meetings: deps.meetings }, relation, new Date())
      : ensureMeeting({ ws: deps.ws, meetings: deps.meetings }, relation, new Date());
    try {
      const result = await sendToMeeting(deps.ws, harness, meeting, text, {
        queue: deps.queue,
        sessions: deps.sessions,
        store: deps.store,
        defaults: sessionDefaults(config)!,
        ...(deps.mcp === undefined ? {} : { mcp: deps.mcp }),
        ...(deps.titles === undefined ? {} : { titles: deps.titles }),
        ...(requestId === undefined ? {} : { requestId }),
      });
      // 老板发言的实时气泡：广播刚落的库行（键 store:<seq>，与 GET 会议视图 / pin 校验同源）。
      // 另附一个**仅 UI 用**的 messageId 副本（不入库）：前端「排队中」占位据此贴到这条真气泡上。
      if (result.recorded !== undefined) {
        deps.hub?.broadcast({
          type: "meeting.message",
          meetingId: meeting.meetingId,
          message: { ...toMeetingMessage(result.recorded, meeting.kind, readBossName(deps.ws), deps.ws), messageId: result.messageId },
        });
      }
      for (const delivery of result.deliveries) {
        // 排队中（员工在跑）：记进待发表 + 广播，前端在消息区显示「排队中」并允许单条撤回。
        if (delivery.status === "queued") {
          const item = outbox.add({
            submissionId: delivery.submissionId,
            meetingId: meeting.meetingId,
            memberId: delivery.memberId,
            messageId: result.messageId,
            storeSeq: result.recorded?.seq ?? 0,
            text: text.trim(),
            convId: delivery.convId,
          });
          deps.hub?.broadcast({ type: "meeting.queued", item: queuedItemView(item) });
        }
        // best-effort：消息已落盘，订阅缺失由重启扫描兜底；pump 故障不得把已 admitted 的发送变成 500。
        try {
          await deps.pump?.register(delivery.convId, { meetingId: meeting.meetingId, memberId: delivery.memberId });
        } catch {
          // 忽略：见上
        }
      }
      json(res, 202, { meetingId: meeting.meetingId, ...result, meeting: meetingView(deps.ws, meeting) });
    } catch (error) {
      if (error instanceof EmptyGroupError || error instanceof NoTargetsError) {
        json(res, 400, { error: error.message });
        return;
      }
      throw error;
    }
    return;
  }

  json(res, 404, { error: "接口不存在" });
}

/** 会议维度的端点：消息 / 排队撤回 / 中断 / pin / 会话信息 / 标题 / 会话原文。 */
async function handleMeetings(
  deps: ServerDeps,
  outbox: Outbox,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  rawId: string,
  rest: string[],
): Promise<void> {
  let meetingId: string;
  try {
    meetingId = decodeURIComponent(rawId);
  } catch {
    json(res, 404, { error: "会议不存在" });
    return;
  }
  const meeting = deps.meetings.get(meetingId);
  const harness = deps.getHarness();
  const config = deps.getConfig();
  if (meeting === undefined || harness === undefined || config === undefined) {
    json(res, 404, { error: "会议不存在" });
    return;
  }
  const bossNames = bossNamesFor(deps.ws);
  const bossName = readBossName(deps.ws);
  const memberIds = participantIds(deps.ws, subjectOf(meeting));

  if (rest.length === 0 && method === "GET") {
    json(res, 200, meetingView(deps.ws, meeting));
    return;
  }

  // 删除会议（仅老板在界面操作；员工没有删除工具）：会议行 + 消息 + 会话映射 + pin 一起清。
  if (rest.length === 0 && method === "DELETE") {
    const deleted = await deleteMeeting(
      {
        ws: deps.ws,
        meetings: deps.meetings,
        messages: deps.store,
        sessions: deps.sessions,
        abort: (convId) => harness.abort(convId),
        ...(deps.pump === undefined ? {} : { unregister: (convId) => deps.pump!.unregister(convId) }),
        removePins: (id) => removeMeetingPins(deps.ws, id),
      },
      meetingId,
    );
    if (deleted === undefined) {
      json(res, 404, { error: "会议不存在" });
      return;
    }
    deps.hub?.broadcast({ type: "meeting.deleted", ...deleted });
    json(res, 200, { ok: true, ...deleted });
    return;
  }

  if (rest.length === 1 && rest[0] === "messages" && method === "GET") {
    // 会议视图 = 该会议的全部消息（会议本身即窗口：上一场会议是另一个 meetingId，进历史）。
    const messages = meetingMessages(deps, outbox, meeting);
    // pinned 只回本会议里真实存在的 pin（与红点口径一致）：前端据此高亮，条数即红点数。
    const pinnedKeys = new Set(readPins(deps.ws).pins[meetingId] ?? []);
    const pinned = messages.filter((m) => pinnedKeys.has(messageKey(m))).map(messageKey);
    json(res, 200, {
      meetingId,
      meeting: meetingView(deps.ws, meeting),
      messages,
      pinned,
      queued: outbox.list(meetingId).map(queuedItemView),
    });
    return;
  }

  if (rest.length === 1 && rest[0] === "messages" && method === "POST") {
    const body = (await readJsonBody(req)) as { text?: unknown; requestId?: unknown } | undefined;
    const text = typeof body?.text === "string" ? body.text : "";
    if (text.trim() === "") {
      json(res, 400, { error: "消息不能为空" });
      return;
    }
    const requestId = typeof body?.requestId === "string" && body.requestId !== "" ? body.requestId : undefined;
    try {
      const result = await sendToMeeting(deps.ws, harness, meeting, text, {
        queue: deps.queue,
        sessions: deps.sessions,
        store: deps.store,
        defaults: sessionDefaults(config)!,
        ...(deps.mcp === undefined ? {} : { mcp: deps.mcp }),
        ...(deps.titles === undefined ? {} : { titles: deps.titles }),
        ...(requestId === undefined ? {} : { requestId }),
      });
      if (result.recorded !== undefined) {
        deps.hub?.broadcast({
          type: "meeting.message",
          meetingId,
          message: { ...toMeetingMessage(result.recorded, meeting.kind, bossName, deps.ws), messageId: result.messageId },
        });
      }
      for (const delivery of result.deliveries) {
        if (delivery.status === "queued") {
          const item = outbox.add({
            submissionId: delivery.submissionId,
            meetingId,
            memberId: delivery.memberId,
            messageId: result.messageId,
            storeSeq: result.recorded?.seq ?? 0,
            text: text.trim(),
            convId: delivery.convId,
          });
          deps.hub?.broadcast({ type: "meeting.queued", item: queuedItemView(item) });
        }
        try {
          await deps.pump?.register(delivery.convId, { meetingId, memberId: delivery.memberId });
        } catch {
          // 忽略：见上
        }
      }
      json(res, 202, { meetingId, ...result });
    } catch (error) {
      if (error instanceof EmptyGroupError || error instanceof NoTargetsError) {
        json(res, 400, { error: error.message });
        return;
      }
      throw error;
    }
    return;
  }

  if (rest.length === 2 && rest[0] === "queue" && rest[1] === "cancel" && method === "POST") {
    const body = (await readJsonBody(req)) as { messageId?: unknown } | undefined;
    const messageId = typeof body?.messageId === "string" ? body.messageId : "";
    if (messageId === "") {
      json(res, 400, { error: "messageId 必填" });
      return;
    }
    // 单条撤回 = 撤掉这条消息里所有还没开始的投递（开始投递的拦不住 —— 那是「中断」的语义）。
    const cancelled: string[] = [];
    for (const item of outbox.byMeetingMessage(meetingId, messageId)) {
      let ok = false;
      try {
        ok = await harness.withdrawSubmission(item.convId, item.submissionId);
      } catch {
        ok = false; // 坏会话：不连坐其它投递
      }
      if (!ok) continue;
      outbox.take(item.submissionId);
      cancelled.push(item.submissionId);
      deps.hub?.broadcast({ type: "meeting.dequeued", meetingId, submissionId: item.submissionId, reason: "cancelled" });
    }
    if (cancelled.length === 0) {
      json(res, 409, { error: "这条消息已经开始投递，撤不回了（要停住请看「中断」）" });
      return;
    }
    json(res, 200, { cancelled });
    return;
  }

  if (rest.length === 1 && rest[0] === "interrupt" && method === "POST") {
    json(res, 200, await interruptMeeting(deps.ws, harness, deps.sessions, meeting));
    return;
  }

  if (rest.length === 1 && rest[0] === "pin" && method === "POST") {
    const body = (await readJsonBody(req)) as { convId?: unknown; entryId?: unknown; pinned?: unknown } | undefined;
    const convId = typeof body?.convId === "string" ? body.convId : "";
    const entryId = typeof body?.entryId === "string" ? body.entryId : "";
    if (convId === "" || entryId === "" || typeof body?.pinned !== "boolean") {
      json(res, 400, { error: "convId / entryId / pinned 必填" });
      return;
    }
    // 只允许 pin 会议视图里真实存在的消息：防止前端 bug 往 pin 存储里塞垃圾键。
    const messages = meetingMessages(deps, outbox, meeting);
    if (!messages.some((m) => m.convId === convId && m.entryId === entryId)) {
      json(res, 404, { error: "消息不存在" });
      return;
    }
    const state = setPin(deps.ws, meetingId, `${convId}:${entryId}`, body.pinned);
    const count = pinCounts([{ meetingId, messages }], state).meetings[meetingId] ?? 0;
    deps.hub?.broadcast({ type: "meeting.pins", meetingId, count });
    json(res, 200, { ok: true, count });
    return;
  }

  if (rest.length === 2 && rest[0] === "sessions" && rest[1] === "info" && method === "GET") {
    json(res, 200, { sessions: await meetingSessionInfo(deps.ws, harness, deps.sessions, meeting) });
    return;
  }

  if (rest.length === 1 && rest[0] === "sessions" && method === "GET") {
    // 会话表 = 唯一真相：这场会议里每个参与者与其 conv（顺序来自 participants 快照）。
    json(res, 200, { participants: meetingParticipants(deps.ws, deps.sessions, meeting) });
    return;
  }

  // 手动改名：走与自动命名同一条写入通道（renameMeeting：写库 + 广播）。
  if (rest.length === 1 && rest[0] === "title" && method === "PATCH") {
    const body = (await readJsonBody(req)) as { title?: unknown } | undefined;
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    if (title === "") {
      json(res, 400, { error: "标题不能为空" });
      return;
    }
    if ([...title].length > 40) {
      json(res, 400, { error: "标题最多 40 个字" });
      return;
    }
    if (deps.titles === undefined) {
      json(res, 503, { error: "会议标题未启用" });
      return;
    }
    const meta = renameMeeting(deps.titles, meetingId, title, "manual");
    json(res, 200, { meetingId, title: meta.title, titleSource: meta.titleSource });
    return;
  }

  if (rest.length === 3 && rest[0] === "sessions" && rest[2] === "messages" && method === "GET") {
    let convId: string;
    try {
      convId = decodeURIComponent(rest[1]!);
    } catch {
      json(res, 404, { error: "会话不存在" });
      return;
    }
    const owner = deps.sessions.owner(convId);
    if (owner === undefined || owner.meetingId !== meetingId) {
      json(res, 404, { error: "会话不存在" });
      return;
    }
    const alias = findPerson(loadOrg(deps.ws), owner.memberId)?.alias;
    const messages = transcriptMessages(meeting.kind, {
      memberId: owner.memberId,
      ...(alias === undefined ? {} : { alias }),
      convId,
      messages: await harness.transcript(convId),
    }, memberIds, bossNames);
    json(res, 200, { convId, memberId: owner.memberId, messages });
    return;
  }

  json(res, 404, { error: "接口不存在" });
}

export function createHttpServer(deps: ServerDeps): http.Server {
  const outbox = deps.outbox ?? new Outbox();
  return http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const segments = url.pathname.split("/").filter((part) => part !== "");
        const method = req.method ?? "GET";

        if (segments[0] === "api") {
          const config = deps.getConfig();
          if (segments[1] === "status" && method === "GET") {
            json(res, 200, {
              configured: config !== undefined,
              root: deps.ws.root,
              port: deps.port,
              bossName: readBossName(deps.ws),
              ...(config === undefined ? {} : { model: config.model, providers: Object.keys(config.providers) }),
            });
            return;
          }
          if (config === undefined) {
            json(res, 409, { error: "尚未配置：请编辑 openstaffs/.data/config.json 后重启服务" });
            return;
          }
          if (segments[1] === "events" && method === "GET") {
            if (deps.hub === undefined) {
              json(res, 503, { error: "推流未启用" });
              return;
            }
            deps.hub.add(req, res);
            return;
          }
          const harness = deps.getHarness();
          if (segments[1] === "org" && method === "GET") {
            json(res, 200, { root: orgDeptView(config, loadOrg(deps.ws).root) });
            return;
          }
          if (segments[1] === "projects" && method === "GET") {
            const tree = loadOrg(deps.ws);
            json(
              res,
              200,
              listProjects(deps.ws).map((project) => ({
                id: project.id,
                alias: project.alias,
                members: memberSummaries(deps.ws, tree, project.id),
              })),
            );
            return;
          }
          if (segments[1] === "employees" && segments[2] !== undefined) {
            await handleEmployees(deps, res, method, segments);
            return;
          }
          // 老板看定义文件（左侧栏的 {} 按钮）：只读、只认三类已知配置文件。
          if (segments[1] === "config" && method === "GET") {
            const scope = url.searchParams.get("scope") ?? "";
            const id = url.searchParams.get("id") ?? "";
            const file = configFileFor(deps.ws, scope, id);
            if (file === undefined) {
              json(res, 404, { error: `没有这个配置：${scope}/${id}` });
              return;
            }
            let text: string | null = null;
            try {
              text = fs.readFileSync(file, "utf8");
            } catch {
              text = null; // 该层没有配置文件（如根部门没写 department.config.json）
            }
            json(res, 200, { scope, id, file: path.relative(deps.ws.root, file), text });
            return;
          }
          if (segments[1] === "subjects" && segments[2] !== undefined) {
            await handleSubjects(deps, outbox, req, res, method, segments[2], segments.slice(3));
            return;
          }
          if (segments[1] === "meetings" && segments[2] !== undefined && harness !== undefined) {
            await handleMeetings(deps, outbox, req, res, method, segments[2], segments.slice(3));
            return;
          }
          if (segments[1] === "permission-requests" && harness !== undefined) {
            const store = deps.permissionRequests;
            if (segments.length === 2 && method === "GET") {
              const requests = store?.list() ?? [];
              json(res, 200, { requests: requests.map((request) => permissionRequestView(deps.ws, request, deps.meetings)) });
              return;
            }
            if (segments.length === 4 && segments[2] !== undefined && segments[3] === "resolve" && method === "POST") {
              if (store === undefined) {
                json(res, 503, { error: "授权请求服务未启用" });
                return;
              }
              let id: string;
              try {
                id = decodeURIComponent(segments[2]);
              } catch {
                json(res, 404, { error: "授权请求不存在或已处理" });
                return;
              }
              const body = (await readJsonBody(req)) as { decision?: unknown } | undefined;
              const decision = body?.decision;
              if (decision !== "accept" && decision !== "reject") {
                json(res, 400, { error: "decision 必须是 accept 或 reject" });
                return;
              }
              try {
                const result = await resolvePermissionRequest(
                  {
                    ws: deps.ws,
                    harness,
                    store,
                    messages: deps.store,
                    meetings: deps.meetings,
                    sessions: deps.sessions,
                    queue: deps.queue,
                    defaults: sessionDefaults(config)!,
                    ...(deps.mcp === undefined ? {} : { mcp: deps.mcp }),
                    ...(deps.pump === undefined ? {} : { register: (convId, ref) => deps.pump!.register(convId, ref) }),
                    ...(deps.hub === undefined ? {} : { broadcast: (rid) => deps.hub!.broadcast({ type: "permission.resolved", id: rid }) }),
                    ...(deps.hub === undefined ? {} : { broadcastMessage: (meetingId, message) => deps.hub!.broadcast({ type: "meeting.message", meetingId, message }) }),
                  },
                  id,
                  decision,
                );
                json(res, 200, result);
              } catch (error) {
                if (error instanceof PermissionRequestNotFoundError) {
                  json(res, 404, { error: error.message });
                  return;
                }
                throw error;
              }
              return;
            }
          }
          if (segments[1] === "pins" && method === "GET" && harness !== undefined) {
            const bossName = readBossName(deps.ws);
            // 红点 = 该主题**所有会议**里的 pin 数（会议不再有「结束」，旧会议的 pin 仍算待看）。
            const all = deps.meetings.listAll();
            const views = all.map((meeting) => ({
              meetingId: meeting.meetingId,
              messages: deps.store.byMeeting(meeting.meetingId).map((m) => toMeetingMessage(m, meeting.kind, bossName, deps.ws)),
            }));
            const counts = pinCounts(views, readPins(deps.ws));
            // 侧栏按**主题**显示红点：把会议计数折叠到 dm:<员工> / group:<项目>。
            const subjects: Record<string, number> = {};
            let total = 0;
            for (const meeting of all) {
              const count = counts.meetings[meeting.meetingId] ?? 0;
              if (count === 0) continue;
              const key = meeting.kind === "dm" ? `dm:${meeting.subjectId}` : `group:${meeting.subjectId}`;
              subjects[key] = (subjects[key] ?? 0) + count;
              total += count;
            }
            json(res, 200, { total, subjects });
            return;
          }
          json(res, 404, { error: "接口不存在" });
          return;
        }

        // 静态文件（GET/HEAD）
        if (method !== "GET" && method !== "HEAD") {
          json(res, 405, { error: "方法不允许" });
          return;
        }
        const target = resolveStatic(deps.publicDir, url.pathname);
        if (target === undefined || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
          json(res, 404, { error: "文件不存在" });
          return;
        }
        res.writeHead(200, { "content-type": MIME[path.extname(target)] ?? "application/octet-stream" });
        const stream = fs.createReadStream(target);
        stream.on("error", () => {
          if (res.headersSent) res.destroy();
          else json(res, 500, { error: "文件读取失败" });
        });
        stream.pipe(res);
      } catch (error) {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    })();
  });
}
