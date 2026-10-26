import fs from "node:fs";
import { conversationIdsFile, groupConversationIdsFile, workDir, type Workspace } from "../domain/paths.ts";
import { findPerson, loadOrg } from "../domain/org.ts";
import { listProjects } from "../domain/project.ts";
import { parseMembers, type AccessContext } from "../domain/access-control.ts";
import { activeSession, readChain, startNewSession, type SessionRow } from "../domain/conversation-chain.ts";
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

export type { Relation };

export function relationKey(relation: Relation, speakerId: string): string {
  return relation.kind === "dm" ? `dm:${relation.employeeId}` : `group:${relation.project}:${speakerId}`;
}

/** 会话工作目录 = **agent 自己的工作目录**（D25/D27：项目没有工作目录）。 */
export function relationCwd(ws: Workspace, _relation: Relation, speakerId: string): string {
  return workDir(ws, speakerId); // workDir 由 P2 提供（src/domain/paths.ts），本计划只 import
}

function chainFileFor(ws: Workspace, relation: Relation, speakerId: string): string {
  return relation.kind === "dm"
    ? conversationIdsFile(ws, workDir(ws, relation.employeeId))
    : groupConversationIdsFile(ws, relation.project, speakerId);
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
    // 技能清单与 MCP 选择随会话快照固化：这里读一次（新开会话才重读）
    instructions: instructionsFor(ws, relation, speaker),
    model: { provider: model.provider, modelId: model.modelId },
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    access: accessFor(ws, relation, speaker),
    ...(mcpExtensions.length === 0 ? {} : { mcpExtensions }),
  };
}

async function ensure(
  ws: Workspace, harness: HarnessPort, relation: Relation, speakerId: string,
  defaults?: SessionDefaults, mcp?: McpSessionResolver,
): Promise<string> {
  const speaker = loadEmployee(ws, speakerId);
  const file = chainFileFor(ws, relation, speakerId);
  const active = activeSession(file);
  if (active !== undefined && (await harness.attach(active.id, accessFor(ws, relation, speaker)))) {
    return active.id;
  }
  const convId = await harness.startSession(specFor(ws, relation, speaker, defaults, mcp));
  startNewSession(file, convId, new Date().toISOString());
  return convId;
}

export function openDm(
  ws: Workspace, harness: HarnessPort, employeeId: string, defaults?: SessionDefaults, mcp?: McpSessionResolver,
): Promise<string> {
  return ensure(ws, harness, { kind: "dm", employeeId }, employeeId, defaults, mcp);
}

export function openGroup(
  ws: Workspace, harness: HarnessPort, project: string, speakerId: string,
  defaults?: SessionDefaults, mcp?: McpSessionResolver,
): Promise<string> {
  return ensure(ws, harness, { kind: "group", project }, speakerId, defaults, mcp);
}

export async function newSession(
  ws: Workspace, harness: HarnessPort, relation: Relation, speakerId: string,
  defaults?: SessionDefaults, mcp?: McpSessionResolver,
): Promise<string> {
  const speaker = loadEmployee(ws, speakerId);
  const convId = await harness.startSession(specFor(ws, relation, speaker, defaults, mcp));
  startNewSession(chainFileFor(ws, relation, speakerId), convId, new Date().toISOString());
  return convId;
}

/** 一个员工的活跃会话（私聊 + 他所在的每个群的链尾）：供「会话上下文」面板按人聚合。 */
export function employeeActiveSessions(
  ws: Workspace,
  employeeId: string,
): { relation: Relation; convId: string; started: string }[] {
  const relations: Relation[] = [{ kind: "dm", employeeId }];
  for (const project of listProjects(ws)) {
    if (parseMembers(ws, project.id).includes(employeeId)) relations.push({ kind: "group", project: project.id });
  }
  const out: { relation: Relation; convId: string; started: string }[] = [];
  for (const relation of relations) {
    for (const chain of sessionChains(ws, relation)) {
      if (chain.memberId !== employeeId) continue;
      const active = chain.rows.filter((row) => row.ended === null).at(-1);
      if (active !== undefined) out.push({ relation, convId: active.id, started: active.started });
    }
  }
  return out;
}

/** 关系下各成员的会话链（群聊按项目 config 的 members 顺序；未创建过会话的成员为空链）。 */
export function sessionChains(ws: Workspace, relation: Relation): { memberId: string; rows: SessionRow[] }[] {
  if (relation.kind === "dm") {
    return [{ memberId: relation.employeeId, rows: readChain(conversationIdsFile(ws, workDir(ws, relation.employeeId))) }];
  }
  return parseMembers(ws, relation.project).map((memberId) => ({
    memberId,
    rows: readChain(groupConversationIdsFile(ws, relation.project, memberId)),
  }));
}

/** 关系下各成员的活跃会话（链尾未结束行）。 */
export function activeMemberSessions(ws: Workspace, relation: Relation): { memberId: string; convId: string }[] {
  const out: { memberId: string; convId: string }[] = [];
  for (const chain of sessionChains(ws, relation)) {
    const active = chain.rows.filter((row) => row.ended === null).at(-1);
    if (active !== undefined) out.push({ memberId: chain.memberId, convId: active.id });
  }
  return out;
}

/** 会话信息条（展示层）：模型全值 + 思考强度 + 上下文用量 / 模型窗口。 */
export type RoomSessionInfo = {
  memberId: string;
  convId: string;
  /** "provider/modelId"（会话快照）。 */
  model: string;
  /** 展示层判定后的档位；模型明确不支持 → null。 */
  thinkingLevel: string | null;
  contextUsed: number;
  contextWindow?: number;
};

/** 关系下各成员活跃会话的实际信息；坏会话（链指向不存在等）跳过，不连坐整个房间。 */
export async function roomSessionInfo(
  ws: Workspace, harness: HarnessPort, relation: Relation,
): Promise<RoomSessionInfo[]> {
  const out: RoomSessionInfo[] = [];
  for (const session of activeMemberSessions(ws, relation)) {
    try {
      const usage = await harness.sessionUsage(session.convId);
      out.push({
        memberId: session.memberId,
        convId: session.convId,
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
  ws: Workspace, harness: HarnessPort, relation: Relation,
): Promise<{ aborted: string[] }> {
  const aborted: string[] = [];
  for (const session of activeMemberSessions(ws, relation)) {
    try {
      await harness.abort(session.convId);
      aborted.push(session.convId);
    } catch {
      // 坏会话（链指向不存在的 convId 等）跳过：一个失败不该让整房间中断失败。
    }
  }
  return { aborted };
}

/** convId 属于关系下哪个成员（含已结束的会话行）；不属于返回 undefined。 */
export function findSessionOwner(ws: Workspace, relation: Relation, convId: string): string | undefined {
  for (const chain of sessionChains(ws, relation)) {
    if (chain.rows.some((row) => row.id === convId)) return chain.memberId;
  }
  return undefined;
}
