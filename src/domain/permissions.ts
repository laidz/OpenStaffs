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
    return (parsed as string[]).filter((entry) => entry.trim() !== "").map((entry) => entry.trim());
  } catch {
    return [];
  }
}

/** targetAbs 命中任一 pattern（相等或在其下）即 true。相对 pattern 相对 permissionDir 归一。 */
export function matchesPermission(patterns: string[], permissionDir: string, targetAbs: string): boolean {
  return patterns.some((pattern) => {
    const base = path.resolve(permissionDir, pattern);
    const root = path.parse(base).root;
    return targetAbs === base || targetAbs.startsWith(base === root ? root : base + path.sep);
  });
}

/** 任一 permission.json 命中 targetAbs 即 true。 */
export function isWriteAllowedByPermission(files: string[], targetAbs: string): boolean {
  return files.some((file) => matchesPermission(readPermissionPaths(file), path.dirname(file), targetAbs));
}

/** 文件内容是否为"健康"的字符串数组（用于决定覆盖前是否需要备份）。 */
function isHealthyArray(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string");
  } catch {
    return false;
  }
}

/**
 * 追加写权限条目：合并去重（保序）、原子写。
 * 文件存在但不可解析/非数组/含非字符串元素 → 先备份 `<file>.bak` 再以新数组覆盖
 * （坏文件本就不生效，覆盖不改变安全性；备份留痕）。
 */
export function appendPermissionPaths(file: string, paths: string[]): void {
  const cleaned = paths.map((entry) => entry.trim()).filter((entry) => entry !== "");
  if (cleaned.length === 0) return;

  let existing: string[] = [];
  try {
    const raw = fs.readFileSync(file, "utf8");
    if (!isHealthyArray(raw)) fs.copyFileSync(file, `${file}.bak`);
    existing = readPermissionPaths(file);
  } catch {
    // 文件缺失：直接新建
  }
  const merged = [...existing];
  for (const entry of cleaned) {
    if (!merged.includes(entry)) merged.push(entry);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`);
  fs.renameSync(tmp, file);
}
