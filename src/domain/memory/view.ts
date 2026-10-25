// src/domain/memory/view.ts —— 记忆的读取视图：新鲜度、注入索引、会话注入文本。
import { loadMemory, readProfile, readState } from "./store.ts";
import { DEFAULT_MEM_SETTINGS, type MemEntity, type MemEntry, type MemSettings } from "./types.ts";
import type { Workspace } from "../paths.ts";

const DAY = 86_400_000;

function epoch(iso: string | undefined): number | undefined {
  if (iso === undefined || iso === "") return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
}

function ts(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/** 计时起点 = 最近取用 → 更新时间 → 创建时间；非 pinned 超过 TTL 即淘汰。 */
export function evaluate(
  entity: MemEntity,
  lastUsedAt: string | undefined,
  ttlDays: number,
  now = new Date(),
): { evicted: boolean; remainingDays: number; lastUsedAt: string } {
  const used = lastUsedAt !== undefined && lastUsedAt !== "" ? lastUsedAt : entity.updated || entity.created;
  const t = epoch(used);
  if (t === undefined) return { evicted: false, remainingDays: ttlDays, lastUsedAt: used };
  const ageDays = (now.getTime() - t) / DAY;
  return {
    evicted: !entity.pinned && ageDays > ttlDays,
    remainingDays: Math.max(0, Math.ceil(ttlDays - ageDays)),
    lastUsedAt: used,
  };
}

export type IndexResult = { entries: MemEntry[]; truncated: number; evicted: number };

/**
 * 构建索引：pinned 置顶 → 最近使用 → 更新时间 → id。
 * cap = true 时按 maxEntries / maxBytes 截断**非 pinned** 条目（pinned 恒在）。
 */
export function buildIndex(
  entities: readonly MemEntity[],
  lastUsed: Record<string, string>,
  settings: MemSettings = DEFAULT_MEM_SETTINGS,
  options: { now?: Date; includeEvicted?: boolean; cap?: boolean } = {},
): IndexResult {
  const now = options.now ?? new Date();
  const includeEvicted = options.includeEvicted ?? false;
  const cap = options.cap ?? true;
  let evicted = 0;
  const all: MemEntry[] = entities.map((entity) => {
    const fresh = evaluate(entity, lastUsed[entity.id], settings.ttlDays, now);
    if (fresh.evicted) evicted++;
    return {
      id: entity.id,
      title: entity.title,
      description: entity.description,
      pinned: entity.pinned,
      updated: entity.updated,
      lastUsed: fresh.lastUsedAt,
      remainingDays: fresh.remainingDays,
      ...(fresh.evicted ? { evicted: true as const } : {}),
    };
  });
  const visible = includeEvicted ? all : all.filter((entry) => entry.evicted !== true);
  visible.sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      ts(b.lastUsed) - ts(a.lastUsed) ||
      ts(b.updated) - ts(a.updated) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  if (!cap) return { entries: visible, truncated: 0, evicted };

  const out: MemEntry[] = [];
  let bytes = 0;
  let count = 0;
  let truncated = 0;
  for (const entry of visible) {
    if (entry.pinned) {
      out.push(entry);
      continue;
    }
    const size = Buffer.byteLength(`${entry.id} · ${entry.title} — ${entry.description}`) + 1;
    if (count >= settings.maxEntries || bytes + size > settings.maxBytes) {
      truncated++;
      continue;
    }
    out.push(entry);
    count++;
    bytes += size;
  }
  return { entries: out, truncated, evicted };
}

/** 索引里的一行（列表 / 注入共用）。 */
export function renderEntry(entry: MemEntry): string {
  const suffix = entry.evicted === true ? "（已过期）" : entry.pinned ? "" : `（剩 ${entry.remainingDays} 天）`;
  return `- ${entry.pinned ? "[pinned] " : ""}${entry.id} · ${entry.title} — ${entry.description}${suffix}`;
}

/** 会话注入块：profile 全文 + 该人自己的索引；都为空 → 空串（不塞噪声）。 */
export function renderMemoryBlock(ws: Workspace, agentId: string): string {
  const profile = readProfile(ws, agentId);
  const { entities } = loadMemory(ws, agentId);
  const { entries, truncated } = buildIndex(entities, readState(ws, agentId));
  if (profile === "" && entries.length === 0) return "";

  const lines: string[] = ["## 你的记忆"];
  if (profile !== "") lines.push("", "### 常驻 profile（全文）", "", profile);
  if (entries.length > 0) {
    lines.push("", "### 记忆索引（需要正文时用 memory_get <id>）", "", ...entries.map(renderEntry));
    if (truncated > 0) lines.push("", `（还有 ${truncated} 条未展示，用 memory_list 查看）`);
  }
  return lines.join("\n");
}
