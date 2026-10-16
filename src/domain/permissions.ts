import fs from "node:fs";
import path from "node:path";

/** 读取一个 permission.json：必须是字符串数组；任何失败返回 []。 */
export function readPermissionPaths(file: string): string[] {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    if (parsed.some((entry) => typeof entry !== "string")) return [];
    return (parsed as string[]).filter((entry) => entry.trim() !== "");
  } catch {
    return [];
  }
}

/** targetAbs 命中任一 pattern（相等或在其下）即 true。相对 pattern 相对 permissionDir 归一。 */
export function matchesPermission(patterns: string[], permissionDir: string, targetAbs: string): boolean {
  return patterns.some((pattern) => {
    const base = path.resolve(permissionDir, pattern);
    return targetAbs === base || targetAbs.startsWith(base + path.sep);
  });
}

/** 任一 permission.json 命中 targetAbs 即 true。 */
export function isWriteAllowedByPermission(files: string[], targetAbs: string): boolean {
  return files.some((file) => matchesPermission(readPermissionPaths(file), path.dirname(file), targetAbs));
}
