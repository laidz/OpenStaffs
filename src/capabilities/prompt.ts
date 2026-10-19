// src/capabilities/prompt.ts —— `prompt` 按作用域链累加渲染（D12/D10）。
import { renderTemplate } from "../domain/prompt.ts";
import type { PromptVarContext } from "../domain/prompt-vars.ts";
import type { LoadedConfig } from "../config/schema.ts";

/**
 * 累加 + 渲染各作用域的 `prompt`（D12/D10）：
 * 顺序 = 传入顺序（空间 → 部门（根 → 叶）→ 项目 → 员工）；空段丢弃；同值重复保留；`\n\n` 连接。
 * 变量渲染走统一的一条路径（`renderTemplate`）；未知变量渲染为空串。
 */
export function renderPromptChain(scopes: readonly LoadedConfig[], ctx: PromptVarContext): string {
  const parts: string[] = [];
  for (const scope of scopes) {
    const raw = scope.fields.prompt;
    if (raw === undefined || raw.trim() === "") continue;
    const rendered = renderTemplate(raw, ctx).trim();
    if (rendered !== "") parts.push(rendered);
  }
  return parts.join("\n\n");
}
