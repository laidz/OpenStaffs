// src/capabilities/system-prompt.ts —— 系统级 prompt：框架自持，进程启动时读入内存。
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { renderMemoryBlock } from "../domain/memory/view.ts";
import { renderTemplate } from "../domain/prompt.ts";
import type { PromptVarContext } from "../domain/prompt-vars.ts";

export type SystemPromptName = "environment" | "dm" | "group" | "memory" | "naming";

/** 读一个内置模板；缺失 / 读失败 → 空串（不拖垮建会话），并留一条日志信号。 */
function loadTemplate(name: SystemPromptName): string {
  try {
    return fs.readFileSync(fileURLToPath(new URL(`../prompts/${name}.md`, import.meta.url)), "utf8").trim();
  } catch {
    console.warn(`[openstaffs] 系统 prompt 模板缺失或不可读：${name}.md（该段将为空）`);
    return "";
  }
}

/** 进程启动（模块加载）时一次性读入；运行期不再读盘。 */
export const SYSTEM_PROMPT_TEMPLATES: Readonly<Record<SystemPromptName, string>> = {
  environment: loadTemplate("environment"),
  dm: loadTemplate("dm"),
  group: loadTemplate("group"),
  memory: loadTemplate("memory"),
  // 会话命名 agent 的**唯一** prompt（不拼环境 / 会话前缀 / 记忆 / 技能）。
  naming: loadTemplate("naming"),
};

/** 渲染、trim、丢空段、`\n\n` 连接。 */
function join(parts: readonly string[]): string {
  return parts.map((part) => part.trim()).filter((part) => part !== "").join("\n\n");
}

/** 环境段 + 会话类型前缀（私聊 dm / 群聊 group）。 */
export function renderSystemPrompt(ctx: PromptVarContext): string {
  const session = ctx.kind === "dm" ? SYSTEM_PROMPT_TEMPLATES.dm : SYSTEM_PROMPT_TEMPLATES.group;
  return join([
    renderTemplate(SYSTEM_PROMPT_TEMPLATES.environment, ctx),
    renderTemplate(session, ctx),
  ]);
}

/** 记忆说明 + 动态记忆块；记忆关闭 → 空串。 */
export function renderMemoryPrompt(ctx: PromptVarContext, enabled: boolean): string {
  if (!enabled) return "";
  return join([
    renderTemplate(SYSTEM_PROMPT_TEMPLATES.memory, ctx),
    renderMemoryBlock(ctx.ws, ctx.selfId),
  ]);
}
