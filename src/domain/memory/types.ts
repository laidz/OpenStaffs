/** 记忆实体元数据（frontmatter）。 */
export type MemMeta = {
  id: string;
  title: string;
  description: string;
  pinned: boolean;
  created: string;
  updated: string;
};

/** 磁盘上的一条记忆：元数据 + 正文 + 文件路径。 */
export type MemEntity = MemMeta & { body: string; path: string };

/** 注入 / 列表用的索引条目（不含正文）。 */
export type MemEntry = {
  id: string;
  title: string;
  description: string;
  pinned: boolean;
  updated: string;
  lastUsed: string;
  remainingDays: number;
  evicted?: true;
};

export type MemSettings = { ttlDays: number; maxEntries: number; maxBytes: number };

/** 常驻 profile 的固定文件名。 */
export const PROFILE_FILE = "profile.md";
export const PROFILE_MAX_BYTES = 8192;
export const TITLE_MAX = 40;
export const DESC_MAX = 80;
export const TTL_DAYS = 90;
export const INDEX_MAX_ENTRIES = 40;
export const INDEX_MAX_BYTES = 16384;

export const DEFAULT_MEM_SETTINGS: MemSettings = {
  ttlDays: TTL_DAYS,
  maxEntries: INDEX_MAX_ENTRIES,
  maxBytes: INDEX_MAX_BYTES,
};
