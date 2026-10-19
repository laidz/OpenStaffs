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

export function workdir(ctx: PromptVarContext): string {
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

/** 当前会话类型（内置 prompt 用它区分私聊 / 群聊文案）。 */
export function sessionKind(ctx: PromptVarContext): "dm" | "group" {
  return ctx.kind;
}

/** 当前会话的一句话描述（私聊 / 群聊文案不同，避免内置 prompt 里写条件分支）。 */
export function sessionInfo(ctx: PromptVarContext): string {
  if (ctx.kind === "dm") return `与「${bossName(ctx)}」的私聊`;
  return `项目群聊「${projectName(ctx) ?? ""}」（${ctx.projectId ?? ""}）；成员（${memberCount(ctx)} 人）：${
    members(ctx).map((member) => member.name).join("、")
  }`;
}

/**
 * 群聊专属消息规则（I-1）：仅群聊成立，私聊返回空串。
 * 内置 prompt 用 `{{group_rules}}` 门控，避免私聊被要求「每条消息以 @ 开头」。
 * 文本里的负责人称谓直接取自 `bossName(ctx)`（变量渲染是单趟替换，不能再嵌 `{{...}}`）。
 */
export function groupRules(ctx: PromptVarContext): string {
  if (ctx.kind !== "group") return "";
  return [
    "群聊规则：",
    `- **每条消息都以 @ 开头**：\`@\` 只在消息最开头生效（正文中 / 结尾出现的 @ 只是文字，不会触发任何人）；要让某位成员做事，把 \`@成员 id\` 写在最前面（可多个）；发给负责人（\`@${bossName(ctx)}\`，\`@老板\` / \`@boss\` 是它的别名）写最前面。你收到的每条群消息都是指名发给你的；没写 @、或开头 @ 了但没解析出有效对象时，系统视为发给负责人。`,
    "- **非必须不要主动 @ 别人**：@ 同伴 = 派活（真的唤醒对方跑一轮，有成本）；寒暄、感谢等都不需要 @。被 @ 后直接干活、不要回「收到」；完工回告以派活约定为准（要对方完成后回告，就在同一条消息里写明）。",
    "- **派活一次说完**：背景、目标、产出要求写进同一条消息；不要「@同伴 在吗」「@同伴 再问下……」式挤牙膏——每一条都是一轮唤醒。",
    "- 成员之间没有私聊；协作一律在群里 @。找负责人也可以用 `send_message`（target=boss）。",
  ].join("\n");
}

/** 模板键 ↔ 变量函数（唯一真相源）。消费端 import 函数名直接调用；加变量 = 加函数 + 在此登记。 */
export const promptVariables: Record<string, (ctx: PromptVarContext) => unknown> = {
  agent_name: agentName,
  agent_id: agentId,
  boss_name: bossName,
  workdir,
  project_name: projectName,
  project_id: projectId,
  members,
  member_count: memberCount,
  session_kind: sessionKind,
  session_info: sessionInfo,
  group_rules: groupRules,
};
