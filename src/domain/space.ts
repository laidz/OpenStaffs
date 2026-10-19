import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spaceDir, type Workspace } from "./paths.ts";
// 空间声明文件的路径口径由 P3 的 src/config/naming.ts 唯一定义（P3 Task 1，按序在前）；
// 本模块只 re-export，绝不重复实现（跨计划裁定 N2）。
// 注：`export { x } from "..."` 不会在本模块建立本地绑定，故先 import 再 re-export 同一实现。
import { spaceConfigFile } from "../config/naming.ts";

export { spaceConfigFile };

/** 框架内置的空间 prompt（系统作用域；本文件在 src/domain → src/prompts/space.md）。 */
export const SPACE_PROMPT_TEMPLATE = fileURLToPath(new URL("../prompts/space.md", import.meta.url));

/** 读内置空间 prompt；缺失 → 空串（不崩）。 */
export function builtinSpacePrompt(): string {
  try {
    return fs.readFileSync(SPACE_PROMPT_TEMPLATE, "utf8").trim();
  } catch {
    return "";
  }
}

/** 新建空间的初始声明：把内置 prompt 物化进来（D32）。 */
export function newSpaceConfig(): { prompt: string } {
  return { prompt: builtinSpacePrompt() };
}

/**
 * 首次启动探测（D32）：`space.config.json` 不存在 → 物化内置 prompt（此后运行时无关）。
 * 幂等——已存在一律不覆盖（含老板手改内容、空文件、坏 JSON）。
 */
export function ensureSpaceConfig(ws: Workspace): "created" | "exists" {
  const file = spaceConfigFile(ws);
  if (fs.existsSync(file)) return "exists";
  fs.mkdirSync(spaceDir(ws), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(newSpaceConfig(), null, 2)}\n`);
  return "created";
}
