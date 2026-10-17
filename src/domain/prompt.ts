import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stateDir, type Workspace } from "./paths.ts";
import { promptVariables, type PromptVarContext } from "./prompt-vars.ts";

export type PromptKind = "dm" | "group";

/** 框架内置模板目录（本文件在 src/domain → src/prompts）。 */
const FRAMEWORK_PROMPT_DIR = fileURLToPath(new URL("../prompts/", import.meta.url));

/** 模板路径：办公目录 `.openstaffs/prompts/<kind>.md` 存在则覆盖，否则用框架内置。 */
export function promptTemplatePath(ws: Workspace, kind: PromptKind): string {
  const override = path.join(stateDir(ws), "prompts", `${kind}.md`);
  return fs.existsSync(override) ? override : path.join(FRAMEWORK_PROMPT_DIR, `${kind}.md`);
}

function readFileOrEmpty(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** 表达式 = 变量名 + 多级路径（点号 / `[下标]`）；未知变量或越界 → undefined。 */
function resolveExpression(expr: string, ctx: PromptVarContext): unknown {
  const segments = expr.replace(/\[(\d+)\]/gu, ".$1").split(".").map((segment) => segment.trim());
  const head = segments[0];
  if (head === undefined || head === "") return undefined;
  let value: unknown;
  try {
    // 环境段是尽力而为的装饰：任一变量取值抛错都不该拖垮建会话。
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

/** 渲染框架环境段；模板缺失 / 为空 → 空串（不产出空段）。 */
export function renderEnvironment(ctx: PromptVarContext): string {
  const template = readFileOrEmpty(promptTemplatePath(ctx.ws, ctx.kind)).trim();
  if (template === "") return "";
  return renderTemplate(template, ctx).trim();
}
