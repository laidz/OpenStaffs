import fs from "node:fs";
import { workDir, type Workspace } from "../domain/paths.ts";
import { listProjects } from "../domain/project.ts";
import { parseMembers, type AccessContext } from "../domain/access-control.ts";
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
import type { SessionRecord, SessionStore } from "../store/sessions.ts";
import { parseRoomKey, roomKeyOf } from "./rooms.ts";

export type { Relation };

/** 会话的快照行（查询 / 列表中返回的那一行）。 */
export type SessionRow = SessionRecord;

/** 队列 / 锁用的键（群聊按「群 + 成员」；与房间键不同：房间键不含成员）。 */
export function relationKey(relation: Relation, speakerId: string): string {
  return relation.kind === "dm" ? `dm:${relation.employeeId}` : `group:${relation.project}:${speakerId}`;
}

/** 会话工作目录 = **agent 自己的工作目录**（D25/D27：项目没有工作目录）。 */
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

/** 会话访问上下文：落盘路线（项目 → 员工，D11）+ 运行时授予（D13）；路径均为绝对路径。 */
export function accessFor(ws: Workspace, relation: Relation, speaker: Employee): AccessContext {
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
  ws: Workspace, relation: Relation, speaker: Employee, defaults?: SessionDefaults, mcp?: McpSessionResolver,
): ConversationSpec {
  if (relation.kind === "dm" && speaker.id !== relation.employeeId) {
    throw new Error(`私聊关系与发言人不一致: ${relation.employeeId} ≠ ${speaker.id}`);
  }
  const cwd = ensureCwd(relationCwd(ws, relation, speaker.id));
  const model = resolveEmployeeModel(defaults?.model ?? "", speaker.model);
  // 思考强度独立于 model 解析：人 > 会话默认（全局配置）。配置端不校验档位。
  const thinkingLevel = speaker.model.thinkingLevel ?? defaults?.thinkingLevel;
  // MCP 名字来源 = 能力累加（空间 → 部门 → 项目 → 员工）；随会话快照固化。
  const mcpExtensions = mcp?.extensionsFor(assembleCapabilities(scopesFor(ws, relation, speaker)).mcp) ?? [];
  return {
    cwd,
    // 房间归属随会话快照固化：工具层（room_history / send_message / request_permission）靠它判断
    // 「我在群聊还是私聊」——群聊与私聊共用同一个 cwd，不能靠 cwd 推。
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
  /** 会话表（唯一真相：convId ↔ 房间 ↔ 主人）。 */
  sessions: SessionStore;
  defaults?: SessionDefaults;
  mcp?: McpSessionResolver;
};

/**
 * **唯一的会话解析入口**：`(room, memberId)` → convId。
 * - 会话表里该 owner 有活跃行、且 Pi 那边能 attach → 复用（`created: false`）；
 * - 否则新建一条 Pi 会话并登记进会话表（`created: true`）；同 owner 的旧活跃行在同事务里 ended。
 * - `newSession: true` = 显式重开（跳过复用）。
 *
 * 房间 + 主人是会话身份的两根锚：老板发消息、授权结果投递、群回复触发、员工工具（send_message / new_session）
 * 全部走这里，**没有任何一层再自己拼「我在哪个会话」**。
 */
export async function resolveSession(
  deps: SessionDeps,
  room: string,
  memberId: string,
  options: { newSession?: boolean } = {},
): Promise<OpenResult> {
  const relation = parseRoomKey(room);
  if (relation === undefined) throw new Error(`房间键不合法：${room}`);
  const speaker = loadEmployee(deps.ws, memberId);
  if (options.newSession !== true) {
    const active = deps.sessions.active(room, memberId);
    if (active !== undefined && (await deps.harness.attach(active.convId, accessFor(deps.ws, relation, speaker), relation))) {
      return { convId: active.convId, created: false };
    }
  }
  const convId = await deps.harness.startSession(specFor(deps.ws, relation, speaker, deps.defaults, deps.mcp));
  deps.sessions.open({ convId, room, memberId, kind: relation.kind, now: new Date().toISOString() });
  return { convId, created: true };
}

/** 关系下的成员 id（私聊 = 那一个人；群聊 = 项目 config 的 members 顺序）。 */
function memberIdsOf(ws: Workspace, relation: Relation): string[] {
  return relation.kind === "dm" ? [relation.employeeId] : parseMembers(ws, relation.project);
}

/** 一个员工的活跃会话（私聊 + 他所在的每个群）：供「会话上下文」面板按人聚合。 */
export function employeeActiveSessions(
  ws: Workspace,
  sessions: SessionStore,
  employeeId: string,
): { relation: Relation; convId: string; started: string }[] {
  const relations: Relation[] = [{ kind: "dm", employeeId }];
  for (const project of listProjects(ws)) {
    if (parseMembers(ws, project.id).includes(employeeId)) relations.push({ kind: "group", project: project.id });
  }
  const out: { relation: Relation; convId: string; started: string }[] = [];
  for (const relation of relations) {
    const active = sessions.active(roomKeyOf(relation), employeeId);
    if (active !== undefined) out.push({ relation, convId: active.convId, started: active.started });
  }
  return out;
}

/** 关系下各成员的会话列表（成员按项目 config 顺序；已不在成员表里的历史会话排在后面）。 */
export function sessionList(
  ws: Workspace,
  sessions: SessionStore,
  relation: Relation,
): { memberId: string; rows: SessionRow[] }[] {
  const room = roomKeyOf(relation);
  const rows = sessions.list(room);
  const members = memberIdsOf(ws, relation);
  const out = members.map((memberId) => ({ memberId, rows: rows.filter((row) => row.memberId === memberId) }));
  const seen = new Set(members);
  for (const row of rows) {
    if (seen.has(row.memberId)) continue;
    seen.add(row.memberId);
    out.push({ memberId: row.memberId, rows: rows.filter((item) => item.memberId === row.memberId) });
  }
  return out;
}

/** 关系下各成员的活跃会话。 */
export function activeMemberSessions(
  ws: Workspace,
  sessions: SessionStore,
  relation: Relation,
): { memberId: string; convId: string }[] {
  const out: { memberId: string; convId: string }[] = [];
  const room = roomKeyOf(relation);
  for (const memberId of memberIdsOf(ws, relation)) {
    const active = sessions.active(room, memberId);
    if (active !== undefined) out.push({ memberId, convId: active.convId });
  }
  return out;
}

/** 会话信息条（展示层）：模型全值 + 思考强度 + 上下文用量 / 模型窗口 + 标题。 */
export type RoomSessionInfo = {
  memberId: string;
  convId: string;
  /** 会话标题（会话表同一行）；没有则缺省。 */
  title?: string;
  /** "provider/modelId"（会话快照）。 */
  model: string;
  /** 展示层判定后的档位；模型明确不支持 → null。 */
  thinkingLevel: string | null;
  contextUsed: number;
  contextWindow?: number;
};

/** 关系下各成员活跃会话的实际信息；坏会话（Pi 那边已不存在等）跳过，不连坐整个房间。 */
export async function roomSessionInfo(
  ws: Workspace, harness: HarnessPort, relation: Relation, sessions: SessionStore,
): Promise<RoomSessionInfo[]> {
  const out: RoomSessionInfo[] = [];
  const active = activeMemberSessions(ws, sessions, relation);
  const metas = sessions.getMany(active.map((session) => session.convId));
  for (const session of active) {
    try {
      const usage = await harness.sessionUsage(session.convId);
      const meta = metas.get(session.convId);
      out.push({
        memberId: session.memberId,
        convId: session.convId,
        ...(meta?.title === undefined ? {} : { title: meta.title }),
        model: formatModelRef(usage.model),
        thinkingLevel: displayThinkingLevel(usage.thinkingLevel, usage.supportedThinkingLevels),
        contextUsed: usage.contextUsed,
        ...(usage.contextWindow === undefined ? {} : { contextWindow: usage.contextWindow }),
      });
    } catch {
      // 坏会话跳过：一个坏会话不该让整房间的信息条 500。
    }
  }
  return out;
}

/** 房间级中断：中止该关系下各成员的活跃会话；best-effort（坏会话失败不连坐其它）。 */
export async function interruptRoom(
  ws: Workspace, harness: HarnessPort, sessions: SessionStore, relation: Relation,
): Promise<{ aborted: string[] }> {
  const aborted: string[] = [];
  for (const session of activeMemberSessions(ws, sessions, relation)) {
    try {
      await harness.abort(session.convId);
      aborted.push(session.convId);
    } catch {
      // 坏会话（会话表指向不存在的 convId 等）跳过：一个失败不该让整房间中断失败。
    }
  }
  return { aborted };
}

/** 这条 convId 属于关系下哪个成员（含已结束的会话）；不属于该房间返回 undefined。 */
export function findSessionOwner(sessions: SessionStore, relation: Relation, convId: string): string | undefined {
  const owner = sessions.owner(convId);
  return owner !== undefined && owner.room === roomKeyOf(relation) ? owner.memberId : undefined;
}
