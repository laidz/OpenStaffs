import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { roomKeyOfMessage, type StoredMessage } from "./row.ts";

export type MessageStore = {
  append(input: Omit<StoredMessage, "id" | "seq" | "room">): StoredMessage;
  listByRoom(room: string): StoredMessage[];
  /** 会话元数据（自有库 `sessions` 表）：拿不到返回 undefined。 */
  sessionOf(convId: string): SessionMeta | undefined;
  /** 批量取（列表页避免 N 次查询）：只包含存在的会话。 */
  sessionsOf(convIds: readonly string[]): Map<string, SessionMeta>;
  /**
   * 写标题（条件 UPSERT）：`manual` 恒覆盖；`fallback` / `auto` 只在行不存在或现状为 `fallback` 时覆盖。
   * 返回**落库后的实际值**（未覆盖时是旧值）——调用方据此知道「没盖掉手动改名」。
   */
  setTitle(convId: string, title: string, source: TitleSource): SessionMeta;
  close(): void;
};

/** 标题来源：决定覆盖规则的唯一依据。 */
export type TitleSource = "fallback" | "auto" | "manual";

/** `sessions` 表的一行（会话级元数据；标题是当前唯一业务）。 */
export type SessionMeta = { convId: string; title: string; titleSource: TitleSource; updatedAt: string };

type Row = { id: string; seq: number; send_time: string; room: string; project_id: string | null; from_id: string; to_ids: string; text: string; session_id: string | null };
type SessionRow = { conv_id: string; title: string; title_source: string; updated_at: string };

function toSessionMeta(row: SessionRow): SessionMeta {
  return { convId: row.conv_id, title: row.title, titleSource: row.title_source as TitleSource, updatedAt: row.updated_at };
}

function toStored(r: Row): StoredMessage {
  return {
    id: r.id,
    seq: r.seq,
    sendTime: r.send_time,
    room: r.room,
    projectId: r.project_id,
    fromId: r.from_id,
    toIds: JSON.parse(r.to_ids) as string[],
    text: r.text,
    ...(r.session_id === null ? {} : { sessionId: r.session_id }),
  };
}

export function openMessageStore(file: string): MessageStore {
  // 自建父目录（幂等）：DatabaseSync 不建目录，父目录缺失会抛 `unable to open database file`。
  // 生产三个调用点里 registry.recordAndBroadcast 没有前置 mkdir，故把保证收敛到开库这一处。
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL,
      send_time TEXT NOT NULL,
      room TEXT NOT NULL,
      project_id TEXT,
      from_id TEXT NOT NULL,
      to_ids TEXT NOT NULL,
      text TEXT NOT NULL,
      session_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_room_seq ON messages(room, seq);
    CREATE TABLE IF NOT EXISTS sessions (
      conv_id      TEXT PRIMARY KEY,
      title        TEXT NOT NULL,
      title_source TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );
  `);
  const nextSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages");
  const insert = db.prepare(
    "INSERT INTO messages (id, seq, send_time, room, project_id, from_id, to_ids, text, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const selectRoom = db.prepare("SELECT * FROM messages WHERE room = ? ORDER BY seq ASC");
  // 条件的 DO UPDATE：manual 恒覆盖；fallback / auto 只盖 fallback（原子，不怕命名与手改并发）。
  const upsertTitle = db.prepare(`
    INSERT INTO sessions (conv_id, title, title_source, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(conv_id) DO UPDATE SET
      title = excluded.title,
      title_source = excluded.title_source,
      updated_at = excluded.updated_at
    WHERE excluded.title_source = 'manual' OR sessions.title_source = 'fallback'
  `);
  const selectTitle = db.prepare("SELECT * FROM sessions WHERE conv_id = ?");
  return {
    append(input) {
      const id = `m_${randomUUID()}`;
      const seq = (nextSeq.get() as { seq: number }).seq;
      const room = roomKeyOfMessage(input);
      insert.run(id, seq, input.sendTime, room, input.projectId, input.fromId, JSON.stringify(input.toIds), input.text, input.sessionId ?? null);
      return { id, seq, room, ...input };
    },
    listByRoom(room) {
      return (selectRoom.all(room) as Row[]).map(toStored);
    },
    sessionOf(convId) {
      const row = selectTitle.get(convId) as SessionRow | undefined;
      return row === undefined ? undefined : toSessionMeta(row);
    },
    sessionsOf(convIds) {
      const out = new Map<string, SessionMeta>();
      for (const convId of convIds) {
        const row = selectTitle.get(convId) as SessionRow | undefined;
        if (row !== undefined) out.set(convId, toSessionMeta(row));
      }
      return out;
    },
    setTitle(convId, title, source) {
      upsertTitle.run(convId, title, source, new Date().toISOString());
      // 回读落库后的实际值：未覆盖（手动改名挡住 auto）时返回旧值。
      const row = selectTitle.get(convId) as SessionRow | undefined;
      if (row === undefined) throw new Error(`标题写入失败: ${convId}`);
      return toSessionMeta(row);
    },
    close() { db.close(); },
  };
}
