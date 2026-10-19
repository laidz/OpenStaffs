import fs from "node:fs";
import path from "node:path";
import { conversationIdsFile, groupConversationIdsFile, projectDir, spaceSkillsDir, workDir, type Workspace } from "../domain/paths.ts";
import { findPerson, loadOrg, loadPerson, managedDirsOf, type OrgPerson } from "../domain/org.ts";
import { parseMembers, projectsOf, type AccessContext } from "../domain/access-control.ts";
import { activeSession, readChain, startNewSession, type SessionRow } from "../domain/conversation-chain.ts";
import { displayThinkingLevel, formatModelRef, readSkillPaths, resolveEmployeeModel, type WorkspaceConfig } from "../domain/config.ts";
import type { McpSessionResolver } from "../domain/mcp.ts";
import { FRAMEWORK_SKILLS_DIR, listSkills, renderSkills } from "../domain/skills.ts";
import { renderEnvironment } from "../domain/prompt.ts";
import type { PromptVarContext } from "../domain/prompt-vars.ts";
import type { Relation } from "../domain/types.ts";
import type { HarnessPort, ConversationSpec } from "../harness/port.ts";
import type { MemberTranscript } from "./rooms.ts";

export type { Relation };

export function relationKey(relation: Relation, speakerId: string): string {
  return relation.kind === "dm" ? `dm:${relation.employeeId}` : `group:${relation.project}:${speakerId}`;
}

export function relationCwd(ws: Workspace, relation: Relation): string {
  return relation.kind === "dm" ? workDir(ws, relation.employeeId) : projectDir(ws, relation.project);
}

/** 人级额外写权限文件（过渡命名：与人同目录、同主干 + `.permission.json`；P3 收进配置的 permissions）。 */
export function agentPermissionFileOf(person: OrgPerson): string {
  return path.join(person.dir, `${person.id}.permission.json`);
}

export function permissionFilesFor(ws: Workspace, relation: Relation, speaker: OrgPerson): string[] {
  const files: string[] = [];
  if (relation.kind === "group") files.push(path.join(projectDir(ws, relation.project), "permission.json"));
  files.push(agentPermissionFileOf(speaker));
  return files;
}

function chainFileFor(ws: Workspace, relation: Relation, speakerId: string): string {
  return relation.kind === "dm"
    ? conversationIdsFile(ws, workDir(ws, relation.employeeId))
    : groupConversationIdsFile(ws, relation.project, speakerId);
}

/**
 * 技能根目录（越窄越优先，同名先出现者胜）：
 * 群聊 = 项目 + 空间 + 外部 skillPaths + 系统内置；私聊 = 空间 + 外部 + 系统内置。
 */
export function skillDirsFor(
  ws: Workspace, relation: Relation, speaker: OrgPerson, externalSkillDirs: readonly string[] = [],
): string[] {
  const dirs: string[] = [];
  if (relation.kind === "group") dirs.push(path.join(projectDir(ws, relation.project), "skills"));
  // 员工技能目录随「人 = 文件」取消（P3 用 config 的 skills 名引用恢复）
  dirs.push(spaceSkillsDir(ws));
  dirs.push(...externalSkillDirs);
  dirs.push(FRAMEWORK_SKILLS_DIR);
  return dirs;
}

function readTextOrEmpty(file: string): string {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

/** 系统提示词变量上下文（供 prompt-vars 取值）；私聊不带 projectId。 */
export function promptContextFor(ws: Workspace, relation: Relation, speaker: OrgPerson): PromptVarContext {
  return {
    ws,
    kind: relation.kind,
    selfId: speaker.id,
    ...(relation.kind === "group" ? { projectId: relation.project } : {}),
    cwd: relationCwd(ws, relation),
  };
}

/** 会话快照（仅 startSession/新开会话时渲染一次）：系统环境段 → 空间总纲 → 项目规范（群聊）→ 人级 prompt → 技能。 */
export function instructionsFor(
  ws: Workspace, relation: Relation, speaker: OrgPerson, externalSkillDirs: readonly string[] = [],
): string {
  const parts: string[] = [];
  const environment = renderEnvironment(promptContextFor(ws, relation, speaker));
  if (environment !== "") parts.push(environment);
  const rootAgents = readTextOrEmpty(path.join(ws.root, "AGENTS.md"));
  if (rootAgents !== "") parts.push(rootAgents);
  if (relation.kind === "group") {
    const projectAgents = readTextOrEmpty(path.join(projectDir(ws, relation.project), "AGENTS.md"));
    if (projectAgents !== "") parts.push(projectAgents);
  }
  parts.push(speaker.prompt);
  parts.push(renderSkills(listSkills(skillDirsFor(ws, relation, speaker, externalSkillDirs))));
  return parts.filter((part) => part.trim() !== "").join("\n\n");
}

/** 只计算 access 上下文（实时读 members.md；不读 profile/记忆）。 */
export function accessFor(ws: Workspace, relation: Relation, speaker: OrgPerson): AccessContext {
  const cwd = relationCwd(ws, relation);
  const tree = loadOrg(ws);
  return {
    root: ws.root,
    cwd,
    selfId: speaker.id,
    memberProjects: projectsOf(ws, speaker.id),
    permissionFiles: permissionFilesFor(ws, relation, speaker),
    // 运行时写权（D13）：自己的工作目录 + 主管管理的部门目录（整棵子树由前缀判定覆盖）
    writableDirs: [workDir(ws, speaker.id), ...managedDirsOf(tree, ws, speaker.id)],
  };
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
  ws: Workspace, relation: Relation, speaker: OrgPerson, defaults?: SessionDefaults, mcp?: McpSessionResolver,
): ConversationSpec {
  if (relation.kind === "dm" && speaker.id !== relation.employeeId) {
    throw new Error(`私聊关系与发言人不一致: ${relation.employeeId} ≠ ${speaker.id}`);
  }
  const cwd = ensureCwd(relationCwd(ws, relation));
  const model = resolveEmployeeModel(defaults?.model ?? "", speaker.model);
  // 思考强度独立于 model 解析：人 > 会话默认（全局配置）。配置端不校验档位。
  const thinkingLevel = speaker.model.thinkingLevel ?? defaults?.thinkingLevel;
  const mcpExtensions = mcp?.extensionsFor(relation, speaker.id) ?? [];
  return {
    cwd,
    // 技能清单与 MCP 选择随会话快照固化：这里读一次（新开会话才重读）
    instructions: instructionsFor(ws, relation, speaker, readSkillPaths(ws)),
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
  const speaker = loadPerson(ws, speakerId);
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
  const speaker = loadPerson(ws, speakerId);
  const convId = await harness.startSession(specFor(ws, relation, speaker, defaults, mcp));
  startNewSession(chainFileFor(ws, relation, speakerId), convId, new Date().toISOString());
  return convId;
}

/** 关系下各成员的会话链（群聊按 members.md 顺序；未创建过会话的成员为空链）。 */
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

/** 当前房间各成员活跃会话的 transcript（合并视图输入；只读不创建）。 */
export async function roomTranscripts(ws: Workspace, harness: HarnessPort, relation: Relation): Promise<MemberTranscript[]> {
  const out: MemberTranscript[] = [];
  for (const session of activeMemberSessions(ws, relation)) {
    const person = findPerson(loadOrg(ws), session.memberId);
    const alias = person?.alias;
    try {
      const messages = await harness.transcript(session.convId);
      out.push({ memberId: session.memberId, ...(alias === undefined ? {} : { alias }), convId: session.convId, messages });
    } catch {
      // 坏会话（如链指向不存在的 convId）跳过：一个坏会话不该让整房间的合并视图 / 红点 500。
    }
  }
  return out;
}
