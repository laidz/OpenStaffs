import fs from "node:fs";
import { workDir, type Workspace } from "../domain/paths.ts";
import { displayThinkingLevel, formatModelRef, readSkillPaths, resolveEmployeeModel, type WorkspaceConfig } from "../domain/config.ts";
import { loadEmployee, type Employee } from "../domain/employee.ts";
import type { McpSessionResolver } from "../domain/mcp.ts";
import type { PromptVarContext } from "../domain/prompt-vars.ts";
import type { Relation } from "../domain/types.ts";
import { assembleCapabilities } from "../capabilities/assemble.ts";
import { renderPromptChain } from "../capabilities/prompt.ts";
import { renderMemoryPrompt, renderSystemPrompt } from "../capabilities/system-prompt.ts";
import { scopesForOrg } from "../capabilities/scopes.ts";
import { renderSkillCatalog } from "../capabilities/skills.ts";
import { loadAgentConfig, loadProjectConfig } from "../config/load.ts";
import { effectivePermissions } from "../permissions/effective.ts";
import { runtimeGrantsFor } from "../permissions/runtime.ts";
import type { HarnessPort, ConversationSpec } from "../harness/port.ts";
import type { MeetingRecord, MeetingStore } from "../store/meetings.ts";
import type { SessionStore } from "../store/sessions.ts";
import { participantIds, subjectOf, subjectsOfEmployee } from "./meetings.ts";

export type { Relation };

/** 队列 / 锁用的键：一场会议里每个成员一条队列。 */
export function queueKey(meetingId: string, memberId: string): string {
  return `${meetingId}:${memberId}`;
}

/** 会话工作目录 = **agent 自己的工作目录**（项目没有工作目录）。 */
export function relationCwd(ws: Workspace, _relation: Relation, speakerId: string): string {
  return workDir(ws, speakerId);
}

/** 能力累加的作用域链（空间 → 部门 → 项目 → 员工）；本模块内现算一次，供 instructions / MCP 复用。 */
function scopesFor(ws: Workspace, relation: Relation, speaker: Employee) {
  return scopesForOrg(ws, speaker.id, relation.kind === "group" ? relation.project : undefined);
}

/** 系统提示词变量上下文（供 prompt-vars 取值）；私聊不带 projectId。 */
export function promptContextFor(ws: Workspace, relation: Relation, speaker: Employee): PromptVarContext {
  return {
    ws,
    kind: relation.kind,
    selfId: speaker.id,
    ...(relation.kind === "group" ? { projectId: relation.project } : {}),
    cwd: relationCwd(ws, relation, speaker.id),
  };
}

/** 会话快照（仅新开会话时渲染一次）：系统段 → prompt 链（空间 → 部门 → 项目 → 员工）→ 记忆 → 技能目录。 */
export function instructionsFor(ws: Workspace, relation: Relation, speaker: Employee): string {
  const scopes = scopesFor(ws, relation, speaker);
  const ctx = promptContextFor(ws, relation, speaker);
  const parts: string[] = [];
  parts.push(renderSystemPrompt(ctx));
  const chain = renderPromptChain(scopes, ctx);
  if (chain !== "") parts.push(chain);
  parts.push(renderMemoryPrompt(ctx, speaker.memoryEnabled));
  parts.push(renderSkillCatalog(ws, scopes, readSkillPaths(ws)));
  return parts.filter((part) => part.trim() !== "").join("\n\n");
}

/** 会话访问上下文：落盘路线（项目 → 员工）+ 运行时授予；路径均为绝对路径。 */
export function accessFor(ws: Workspace, relation: Relation, speaker: Employee): {
  root: string;
  cwd: string;
  selfId: string;
  permissions: ReturnType<typeof effectivePermissions>;
} {
  const cwd = relationCwd(ws, relation, speaker.id);
  const agentConfig = loadAgentConfig(speaker.dir, speaker.id);
  const projectConfig = relation.kind === "group" ? loadProjectConfig(ws, relation.project) : undefined;
  const onDisk = [
    ...(projectConfig === undefined ? [] : [{ table: projectConfig.fields.permissions, baseDir: projectConfig.baseDir }]),
    { table: agentConfig?.fields.permissions ?? {}, baseDir: speaker.dir },
  ];
  const runtime = runtimeGrantsFor({ ws, agentId: speaker.id, workdir: cwd, extraReadRoots: readSkillPaths(ws) });
  return { root: ws.root, cwd, selfId: speaker.id, permissions: effectivePermissions({ onDisk, runtime }) };
}

/** 新会话默认模型 "provider/modelId"（员工未配模型时兜底）与默认思考强度。 */
export type SessionDefaults = { model: string; thinkingLevel?: string };

/** 解析 / 新建会话的结果：`created` = 这次真的新建了一条会话（否则是 attach 复用）。 */
export type OpenResult = { convId: string; created: boolean };

/** 全局配置 → 新会话默认值（model / thinkingLevel 都只是兜底，员工配置优先）。 */
export function sessionDefaults(config: WorkspaceConfig | undefined): SessionDefaults | undefined {
  if (config === undefined) return undefined;
  return {
    model: config.model,
    ...(config.thinkingLevel === undefined ? {} : { thinkingLevel: config.thinkingLevel }),
  };
}

/** 会话 cwd 必须是真实目录（工具落点与 Pi 会话都要求）。 */
function ensureCwd(cwd: string): string {
  fs.mkdirSync(cwd, { recursive: true });
  return cwd;
}

function specFor(
  ws: Workspace, meeting: MeetingRecord, speaker: Employee, defaults?: SessionDefaults, mcp?: McpSessionResolver,
): ConversationSpec {
  const relation = subjectOf(meeting);
  if (relation.kind === "dm" && speaker.id !== relation.employeeId) {
    throw new Error(`私聊会议与发言人不一致: ${relation.employeeId} ≠ ${speaker.id}`);
  }
  const cwd = ensureCwd(relationCwd(ws, relation, speaker.id));
  const model = resolveEmployeeModel(defaults?.model ?? "", speaker.model);
  // 思考强度独立于 model 解析：人 > 会话默认（全局配置）。配置端不校验档位。
  const thinkingLevel = speaker.model.thinkingLevel ?? defaults?.thinkingLevel;
  // MCP 名字来源 = 能力累加（空间 → 部门 → 项目 → 员工）；随会话快照固化。
  const mcpExtensions = mcp?.extensionsFor(assembleCapabilities(scopesFor(ws, relation, speaker)).mcp) ?? [];
  return {
    cwd,
    meetingId: meeting.meetingId,
    // 会议归属随会话快照固化：工具层（meeting_history / send_message / request_permission）靠它判断
    // 「我在哪场会议」——relation 只是 prompt / 权限的装配依据，不承担投递路由。
    relation,
    // 技能清单与 MCP 选择随会话快照固化：这里读一次（新开会话才重读）
    instructions: instructionsFor(ws, relation, speaker),
    model: { provider: model.provider, modelId: model.modelId },
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    access: accessFor(ws, relation, speaker),
    ...(mcpExtensions.length === 0 ? {} : { mcpExtensions }),
  };
}

/** `resolveSession` 的依赖（ws + harness + 会话表；defaults / mcp 只影响新会话的装配）。 */
export type SessionDeps = {
  ws: Workspace;
  harness: HarnessPort;
  /** 会话表（唯一真相：convId ↔ 会议 ↔ 成员）。 */
  sessions: SessionStore;
  defaults?: SessionDefaults;
  mcp?: McpSessionResolver;
};

/**
 * **唯一的会话解析入口**：`(会议, 成员)` → convId。
 * - 该成员在这场会议里已有 conv、且 Pi 那边能 attach → 复用（`created: false`）；
 * - 否则新建一条 Pi 会话并登记进会话表（`created: true`）；同 (会议, 成员) 的旧映射被 UPSERT 覆盖。
 *
 * 会议 + 成员是会话身份的两根锚：老板发消息、授权结果投递、群回复触发、员工工具全部走这里，
 * **没有任何一层再自己拼「我在哪场会议」**。
 */
export async function resolveSession(
  deps: SessionDeps,
  meeting: MeetingRecord,
  memberId: string,
): Promise<OpenResult> {
  const relation = subjectOf(meeting);
  const speaker = loadEmployee(deps.ws, memberId);
  const existing = deps.sessions.convOf(meeting.meetingId, memberId);
  if (existing !== undefined) {
    if (await deps.harness.attach(existing.convId, accessFor(deps.ws, relation, speaker), relation, meeting.meetingId)) {
      return { convId: existing.convId, created: false };
    }
    // Pi 那边已不存在（坏 conv）：只重建这一条，其余成员与该会议不受影响。
    deps.sessions.remove(existing.convId);
  }
  const convId = await deps.harness.startSession(specFor(deps.ws, meeting, speaker, deps.defaults, deps.mcp));
  deps.sessions.open({ convId, meetingId: meeting.meetingId, memberId, started: new Date().toISOString() });
  return { convId, created: true };
}

/** 会议内各成员与其 conv（按 participants 顺序；还没建 conv 的成员 convId 为 undefined）。 */
export function meetingParticipants(
  ws: Workspace,
  sessions: SessionStore,
  meeting: MeetingRecord,
): { memberId: string; convId?: string }[] {
  const rows = new Map(sessions.listByMeeting(meeting.meetingId).map((row) => [row.memberId, row.convId]));
  return participantIds(ws, subjectOf(meeting)).map((memberId) => {
    const convId = rows.get(memberId);
    return convId === undefined ? { memberId } : { memberId, convId };
  });
}

/** 会议信息条（展示层）：模型全值 + 思考强度 + 上下文用量 / 模型窗口。 */
export type MeetingSessionInfo = {
  memberId: string;
  convId: string;
  /** "provider/modelId"（会话快照）。 */
  model: string;
  /** 展示层判定后的档位；模型明确不支持 → null。 */
  thinkingLevel: string | null;
  contextUsed: number;
  contextWindow?: number;
};

/** 会议内各成员会话的实际信息；坏会话（Pi 那边已不存在等）跳过，不连坐整场会议。 */
export async function meetingSessionInfo(
  ws: Workspace, harness: HarnessPort, sessions: SessionStore, meeting: MeetingRecord,
): Promise<MeetingSessionInfo[]> {
  const out: MeetingSessionInfo[] = [];
  for (const participant of meetingParticipants(ws, sessions, meeting)) {
    if (participant.convId === undefined) continue;
    try {
      const usage = await harness.sessionUsage(participant.convId);
      out.push({
        memberId: participant.memberId,
        convId: participant.convId,
        model: formatModelRef(usage.model),
        thinkingLevel: displayThinkingLevel(usage.thinkingLevel, usage.supportedThinkingLevels),
        contextUsed: usage.contextUsed,
        ...(usage.contextWindow === undefined ? {} : { contextWindow: usage.contextWindow }),
      });
    } catch {
      // 坏会话跳过：一个坏会话不该让整场会议的信息条 500。
    }
  }
  return out;
}

/** 会议级中断：中止该会议内各成员的会话；best-effort（坏会话失败不连坐其它）。 */
export async function interruptMeeting(
  ws: Workspace, harness: HarnessPort, sessions: SessionStore, meeting: MeetingRecord,
): Promise<{ aborted: string[] }> {
  const aborted: string[] = [];
  for (const participant of meetingParticipants(ws, sessions, meeting)) {
    if (participant.convId === undefined) continue;
    try {
      await harness.abort(participant.convId);
      aborted.push(participant.convId);
    } catch {
      // 坏会话（会话表指向不存在的 convId 等）跳过：一个失败不该让整场会议中断失败。
    }
  }
  return { aborted };
}

/** 一个员工在各主题（私聊 + 他参与的每个项目）**最新一场会议**里的 conv：供「会话上下文」面板按人聚合。 */
export function employeeActiveSessions(
  ws: Workspace,
  meetings: MeetingStore,
  sessions: SessionStore,
  employeeId: string,
): { meetingId: string; kind: "dm" | "group"; convId: string }[] {
  const out: { meetingId: string; kind: "dm" | "group"; convId: string }[] = [];
  for (const relation of subjectsOfEmployee(ws, employeeId)) {
    const subjectId = relation.kind === "dm" ? relation.employeeId : relation.project;
    const current = meetings.latest(relation.kind, subjectId);
    if (current === undefined) continue;
    const row = sessions.convOf(current.meetingId, employeeId);
    if (row !== undefined) out.push({ meetingId: current.meetingId, kind: relation.kind, convId: row.convId });
  }
  return out;
}
