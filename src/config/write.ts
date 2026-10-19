import fs from "node:fs";
import path from "node:path";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 把路径追加进配置文件 `permissions[tool]`（去重、保序、原子写）。
 * **保留其它字段**；坏文件一律抛错拒写（宁可不生效，也不清空别人的定义）。
 */
export function appendPermissionPaths(file: string, tool: string, paths: readonly string[]): void {
  const key = tool.trim();
  if (key === "") throw new Error("permissions 的工具名不能为空");
  const cleaned = [...new Set(paths.map((entry) => entry.trim()).filter((entry) => entry !== ""))];
  if (cleaned.length === 0) return;

  let root: Record<string, unknown> = {};
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    // 文件缺失：新建
  }
  if (raw.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`配置文件不是合法 JSON，拒绝覆盖：${file}`);
    }
    if (!isPlainObject(parsed)) throw new Error(`配置文件顶层必须是对象，拒绝覆盖：${file}`);
    root = parsed;
  }

  const current = root["permissions"];
  if (current !== undefined && !isPlainObject(current)) {
    throw new Error(`permissions 必须是对象，拒绝覆盖：${file}`);
  }
  const table = (current ?? {}) as Record<string, unknown>;
  const existingRaw = table[key];
  if (existingRaw !== undefined && !Array.isArray(existingRaw)) {
    throw new Error(`permissions.${key} 必须是字符串数组，拒绝覆盖：${file}`);
  }
  const existing: string[] = [];
  if (Array.isArray(existingRaw)) {
    for (const entry of existingRaw) {
      if (typeof entry !== "string") {
        throw new Error(
          `permissions.${key} 含非字符串项（${JSON.stringify(entry)}），拒绝覆盖：${file}`,
        );
      }
      existing.push(entry);
    }
  }
  const merged = [...existing];
  for (const entry of cleaned) {
    if (!merged.includes(entry)) merged.push(entry);
  }
  table[key] = merged;
  root["permissions"] = table;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(root, null, 2)}\n`);
  fs.renameSync(tmp, file);
}
