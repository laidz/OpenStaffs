// src/domain/memory/frontmatter.ts —— 记忆实体的文件格式：frontmatter 解析 / 序列化 / 校验。
// 只支持 `key: value` 子集；字段固定为 id / title / description / pinned / created / updated。
import { DESC_MAX, TITLE_MAX, type MemMeta } from "./types.ts";

export type ParseResult = { meta?: Partial<MemMeta>; body?: string; error?: string };

/** 本地时区秒级 ISO 时间戳：2026-10-25T10:00:00+08:00。 */
export function nowIso(d = new Date()): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}

/** 标题 → id：中文与字母数字保留，其余折叠为 `-`，最多 40 字符。 */
export function memSlug(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

export function parseFrontmatter(input: string): ParseResult {
  const text = input.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return { error: "缺少 frontmatter（文件需以 --- 开头）" };
  // 从第 4 个字符起找独立成行的 ---，避免正文里的 ---- 或 --- 误判。
  const close = /^---[ \t]*$/m.exec(text.slice(3));
  if (close === null) return { error: "frontmatter 未闭合" };
  const end = 3 + close.index;
  const head = text.slice(4, end);
  const body = text.slice(end + 3).replace(/^\n+/, "").replace(/\n+$/, "");
  const raw: Record<string, string> = {};
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    const i = line.indexOf(":");
    if (i <= 0) return { error: `frontmatter 行格式错误：${line}` };
    raw[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return {
    meta: {
      id: raw["id"],
      title: raw["title"],
      description: raw["description"],
      pinned: raw["pinned"] === "true",
      created: raw["created"],
      updated: raw["updated"],
    },
    body,
  };
}

export function serializeEntity(meta: MemMeta, body: string): string {
  return [
    "---",
    `id: ${meta.id}`,
    `title: ${meta.title}`,
    `description: ${meta.description}`,
    `pinned: ${meta.pinned}`,
    `created: ${meta.created}`,
    `updated: ${meta.updated}`,
    "---",
    "",
    body.trim(),
    "",
  ].join("\n");
}

export function validateMeta(meta: Partial<MemMeta>, fileId: string): string[] {
  const errs: string[] = [];
  if (!meta.id) errs.push("缺少 id");
  else if (meta.id !== fileId) errs.push(`id（${meta.id}）与文件名（${fileId}）不一致`);
  const title = (meta.title ?? "").trim();
  const description = (meta.description ?? "").trim();
  // frontmatter 是「一行一个字段」，换行 / 控制字符会让文件写出后永远读不回来。
  const singleLine = /[\u0000-\u001f\u007f]/u;
  if (!title) errs.push("缺少 title");
  else if (singleLine.test(title)) errs.push("title 不能包含换行或控制字符");
  else if ([...title].length > TITLE_MAX) errs.push(`title 超过 ${TITLE_MAX} 字`);
  if (!description) errs.push("缺少 description");
  else if (singleLine.test(description)) errs.push("description 不能包含换行或控制字符");
  else if ([...description].length > DESC_MAX) errs.push(`description 超过 ${DESC_MAX} 字`);
  return errs;
}
