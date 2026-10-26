import { parseMembers } from "./access-control.ts";
import { readBossName } from "./config.ts";
import { personDisplayName } from "./org.ts";
import type { Workspace } from "./paths.ts";
import { loadProject } from "./project.ts";

/** 变量取值上下文：会话创建时由应用层组装（中性视图，不泄漏 Relation 等上层类型）。 */
export type PromptVarContext = {
  ws: Workspace;
  kind: "dm" | "group";
  selfId: string;
  /** 群聊时的项目 id；私聊缺省。 */
  projectId?: string;
  /** 会话工作目录（绝对路径）。 */
  cwd: string;
};

/** 员工展示名（alias 缺省 = id）；未知人回退 id。 */
function displayNameOf(ws: Workspace, id: string): string {
  return personDisplayName(ws, id);
}

/** 员工展示名（alias 缺省 = id）。 */
export function agentName(ctx: PromptVarContext): string {
  return displayNameOf(ctx.ws, ctx.selfId);
}

export function agentId(ctx: PromptVarContext): string {
  return ctx.selfId;
}

export function bossName(ctx: PromptVarContext): string {
  return readBossName(ctx.ws);
}

/** 私人目录（= 会话 cwd）：系统分配的固定目录，不随项目增加。 */
export function privateDir(ctx: PromptVarContext): string {
  return ctx.cwd;
}

/** 项目展示名；私聊 undefined；项目目录缺失 → 回退 id（prompt 链尽力而为，不拖垮建会话）。 */
export function projectName(ctx: PromptVarContext): string | undefined {
  if (ctx.projectId === undefined) return undefined;
  try {
    return loadProject(ctx.ws, ctx.projectId).alias;
  } catch {
    return ctx.projectId;
  }
}

export function projectId(ctx: PromptVarContext): string | undefined {
  return ctx.projectId;
}

/** 群成员（带展示名，缺目录回退 id）；私聊为空数组。 */
export function members(ctx: PromptVarContext): { id: string; name: string }[] {
  if (ctx.projectId === undefined) return [];
  return parseMembers(ctx.ws, ctx.projectId).map((id) => ({ id, name: displayNameOf(ctx.ws, id) }));
}

export function memberCount(ctx: PromptVarContext): number {
  return members(ctx).length;
}

/** 当前会话类型（私聊 dm / 群聊 group）。 */
export function sessionKind(ctx: PromptVarContext): "dm" | "group" {
  return ctx.kind;
}

/**
 * 当前会话的一句话描述（私聊 / 群聊文案不同）。
 */
export function sessionInfo(ctx: PromptVarContext): string {
  if (ctx.kind === "dm") return `与「${bossName(ctx)}」的私聊`;
  return `项目群聊「${projectName(ctx) ?? ""}」（${ctx.projectId ?? ""}）；成员（${memberCount(ctx)} 人）：${
    members(ctx).map((member) => member.name).join("、")
  }`;
}

/** 模板键 ↔ 变量函数（唯一真相源）。消费端 import 函数名直接调用；加变量 = 加函数 + 在此登记。 */
export const promptVariables: Record<string, (ctx: PromptVarContext) => unknown> = {
  agent_name: agentName,
  agent_id: agentId,
  boss_name: bossName,
  private_dir: privateDir,
  project_name: projectName,
  project_id: projectId,
  members,
  member_count: memberCount,
  session_kind: sessionKind,
  session_info: sessionInfo,
};
