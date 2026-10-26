import fs from "node:fs";
import { spaceDir, type Workspace } from "./paths.ts";
// 空间声明文件的路径口径由 P3 的 src/config/naming.ts 唯一定义；
// 本模块只 re-export，绝不重复实现。
import { spaceConfigFile } from "../config/naming.ts";

export { spaceConfigFile };

/** 新建空间的初始声明：系统 prompt 由框架自持，空间 prompt 只是可选自定义层（默认空）。 */
export function newSpaceConfig(): Record<string, never> {
  return {};
}

/**
 * 首次启动探测：`space.config.json` 不存在 → 写入空声明。
 * 幂等——已存在一律不覆盖（含老板手改内容、空文件、坏 JSON）。
 */
export function ensureSpaceConfig(ws: Workspace): "created" | "exists" {
  const file = spaceConfigFile(ws);
  if (fs.existsSync(file)) return "exists";
  fs.mkdirSync(spaceDir(ws), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(newSpaceConfig(), null, 2)}\n`);
  return "created";
}
