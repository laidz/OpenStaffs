import { promptVariables, type PromptVarContext } from "./prompt-vars.ts";

/** 表达式 = 变量名 + 多级路径（点号 / `[下标]`）；未知变量或越界 → undefined。 */
function resolveExpression(expr: string, ctx: PromptVarContext): unknown {
  const segments = expr.replace(/\[(\d+)\]/gu, ".$1").split(".").map((segment) => segment.trim());
  const head = segments[0];
  if (head === undefined || head === "") return undefined;
  let value: unknown;
  try {
    // prompt 渲染是尽力而为的装饰：任一变量取值抛错都不该拖垮建会话。
    value = promptVariables[head]?.(ctx);
  } catch {
    return undefined;
  }
  for (const segment of segments.slice(1)) {
    if (value === null || value === undefined) return undefined;
    if (Array.isArray(value)) {
      const index = Number(segment);
      value = Number.isInteger(index) ? value[index] : undefined;
    } else if (typeof value === "object") {
      value = (value as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return value;
}

/** 值 → 文本：标量直出；数组用「、」连接；对象取 name（缺省 id）。 */
function formatValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(formatValue).join("、");
  const object = value as Record<string, unknown>;
  if (typeof object.name === "string") return object.name;
  if (typeof object.id === "string") return object.id;
  return JSON.stringify(value);
}

/** 渲染模板：把 `{{ 变量.路径 }}` 替换为文本（未知 → 空串）。 */
export function renderTemplate(text: string, ctx: PromptVarContext): string {
  return text.replace(/\{\{([^{}]*)\}\}/gu, (_match, expr: string) => formatValue(resolveExpression(expr.trim(), ctx)));
}
