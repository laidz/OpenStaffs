import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Relation } from "../domain/types.ts";
import { parseRoomKey } from "../app/rooms.ts";

/** 标题来源：决定覆盖规则的唯一依据（`manual` 恒覆盖；`auto` / `fallback` 只盖 `fallback`）。 */
export type TitleSource = "fallback" | "auto" | "manual";

/**
 * 一条会话（**会话的唯一真相**）。
 * `convId` 就是 Pi 的 conversation id —— 会话 ID 与 Pi 的 conv_id 是同一样东西，不做二次映射。
 */
export type SessionRecord = {
  convId: string;
  /** 房间键：`dm:<员工id>` / `group:<项目id>`。 */
  room: string;
  /** 会话主人（agent id）。 */
  memberId: string;
  kind: "dm" | "group";
  started: string;
  /** null = 活跃（同一 owner 同时只允许一条活跃会话）。 */
  ended: string | null;
  /** 上一条会话的 convId（历史链）。 */
  previous: string | null;
  title?: string;
  titleSource?: TitleSource;
  updatedAt: string;
};

export type SessionStore = {
  /** 开一条新会话：同 owner 未结束的那条先 ended=now，再插入本行（同事务）。 */
  open(input: { convId: string; room: string; memberId: string; kind: "dm" | "group"; now: string }): SessionRecord;
  /** 把指定会话标为已结束（一次性迁入历史行时用；已结束则不变）。 */
  closeAt(convId: string, ended: string): void;
  /** 该 owner 当前活跃会话；没有返回 undefined。 */
  active(room: string, memberId: string): SessionRecord | undefined;
  /** 房间内全部会话（按 started 升序 = 链序）。 */
  list(room: string): SessionRecord[];
  /** 全部活跃会话（重启扫描 / 订阅用：一条 SQL 拿全）。 */
  listActive(): SessionRecord[];
  /** 这条 convId 属于谁 / 哪个房间；不在库里返回 undefined。 */
  owner(convId: string): { room: string; memberId: string } | undefined;
  get(convId: string): SessionRecord | undefined;
  getMany(convIds: readonly string[]): Map<string, SessionRecord>;
  /** 写标题（条件 UPDATE）：`manual` 恒覆盖；`fallback` / `auto` 只在现状为空或 `fallback` 时覆盖。 */
  setTitle(convId: string, title: string, source: TitleSource): SessionRecord;
  close(): void;
};

export type StoredSessionRow = {
  conv_id: string;
  room: string;
  member_id: string;
  kind: string;
  started: string;
  ended: string | null;
  previous: string | null;
  title: string | null;
  title_source: string | null;
  updated_at: string;
};

function toRecord(row: StoredSessionRow): SessionRecord {
  return {
    convId: row.conv_id,
    room: row.room,
    memberId: row.member_id,
    kind: row.kind === "group" ? "group" : "dm",
    started: row.started,
    ended: row.ended,
    previous: row.previous,
    ...(row.title === null ? {} : { title: row.title }),
    ...(row.title_source === null ? {} : { titleSource: row.title_source as TitleSource }),
    updatedAt: row.updated_at,
  };
}

/** 房间键 → 关系（会话行的 `room` 列是唯一真相，其余层不再自己拼）。 */
export function relationOfRoom(room: string): Relation | undefined {
  return parseRoomKey(room);
}

/**
 * 开库并建表。开发阶段的一次性迁移：旧 `sessions`（只有标题：conv_id/title/title_source/updated_at）
 * 直接 DROP 重建——旧标题会由新会话重建（`fallback` 时间标题），不做兼容。
 */
export function openSessionStore(file: string): SessionStore {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  const existing = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").all() as { name: string }[]).length > 0;
  if (existing) {
    const columns = (db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((column) => column.name);
    if (!columns.includes("room")) db.exec("DROP TABLE sessions"); // 旧结构（只有标题）：不兼容，直接重建
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      conv_id      TEXT PRIMARY KEY,
      room         TEXT NOT NULL,
      member_id    TEXT NOT NULL,
      kind         TEXT NOT NULL,
      started      TEXT NOT NULL,
      ended        TEXT,
      previous     TEXT,
      title        TEXT,
      title_source TEXT,
      updated_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(room, member_id, ended);
    CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(ended);
  `);

  const insert = db.prepare(
    "INSERT INTO sessions (conv_id, room, member_id, kind, started, ended, previous, title, title_source, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?)",
  );
  const endActive = db.prepare("UPDATE sessions SET ended = ? WHERE room = ? AND member_id = ? AND ended IS NULL");
  const endOne = db.prepare("UPDATE sessions SET ended = ? WHERE conv_id = ? AND ended IS NULL");
  const lastOf = db.prepare("SELECT conv_id FROM sessions WHERE room = ? AND member_id = ? ORDER BY started DESC, rowid DESC LIMIT 1");
  const selectByConv = db.prepare("SELECT * FROM sessions WHERE conv_id = ?");
  const selectActive = db.prepare("SELECT * FROM sessions WHERE room = ? AND member_id = ? AND ended IS NULL ORDER BY started DESC, rowid DESC LIMIT 1");
  const selectRoom = db.prepare("SELECT * FROM sessions WHERE room = ? ORDER BY started ASC, rowid ASC");
  const selectAllActive = db.prepare("SELECT * FROM sessions WHERE ended IS NULL ORDER BY started ASC");
  // 标题覆盖规则（与原 UPSERT 同口径）：manual 恒覆盖；其余只盖「没有标题」或「现状是 fallback」。
  const updateTitle = db.prepare(`
    UPDATE sessions SET title = ?, title_source = ?, updated_at = ?
    WHERE conv_id = ? AND (? = 'manual' OR title IS NULL OR title_source IS NULL OR title_source = 'fallback')
  `);

  const record = (convId: string): SessionRecord => {
    const row = selectByConv.get(convId) as StoredSessionRow | undefined;
    if (row === undefined) throw new Error(`会话不存在：${convId}`);
    return toRecord(row);
  };

  return {
    open(input) {
      const now = input.now;
      db.exec("BEGIN");
      try {
        endActive.run(now, input.room, input.memberId);
        const previous = (lastOf.get(input.room, input.memberId) as { conv_id: string } | undefined)?.conv_id ?? null;
        insert.run(input.convId, input.room, input.memberId, input.kind, now, previous, now);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return record(input.convId);
    },
    closeAt(convId, ended) {
      endOne.run(ended, convId);
    },
    active(room, memberId) {      const row = selectActive.get(room, memberId) as StoredSessionRow | undefined;
      return row === undefined ? undefined : toRecord(row);
    },
    list(room) {
      return (selectRoom.all(room) as StoredSessionRow[]).map(toRecord);
    },
    listActive() {
      return (selectAllActive.all() as StoredSessionRow[]).map(toRecord);
    },
    owner(convId) {
      const row = selectByConv.get(convId) as StoredSessionRow | undefined;
      return row === undefined ? undefined : { room: row.room, memberId: row.member_id };
    },
    get(convId) {
      const row = selectByConv.get(convId) as StoredSessionRow | undefined;
      return row === undefined ? undefined : toRecord(row);
    },
    getMany(convIds) {
      const out = new Map<string, SessionRecord>();
      for (const convId of convIds) {
        const row = selectByConv.get(convId) as StoredSessionRow | undefined;
        if (row !== undefined) out.set(convId, toRecord(row));
      }
      return out;
    },
    setTitle(convId, title, source) {
      updateTitle.run(title, source, new Date().toISOString(), convId, source);
      return record(convId);
    },
    close() {
      db.close();
    },
  };
}
