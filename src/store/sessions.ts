import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * 一条 conv 归属：**会议 × 成员 → Pi 的 conversation id**。
 * `convId` 就是 Pi 的 conversation id，不做二次映射；`meetingId` 是框架自持的会议身份
 * （见 store/meetings.ts）。同一 (meeting, member) 只保留一条（换 conv = UPSERT 覆盖）。
 */
export type SessionRecord = {
  convId: string;
  meetingId: string;
  memberId: string;
  started: string;
};

export type SessionStore = {
  /** 落一条映射（同 (meeting, member) 已存在则覆盖 convId）。 */
  open(input: SessionRecord): SessionRecord;
  /** 该成员在该会议里的 conv。 */
  convOf(meetingId: string, memberId: string): SessionRecord | undefined;
  /** 该会议的全部 conv（成员顺序不保证，展示层按 participants 排序）。 */
  listByMeeting(meetingId: string): SessionRecord[];
  /** 全部 conv（重启订阅用：会议已无「结束」概念，所有会话都可能继续聊）。 */
  listAll(): SessionRecord[];
  /** 这条 conv 属于哪场会议的哪个成员；不在库里返回 undefined。 */
  owner(convId: string): { meetingId: string; memberId: string } | undefined;
  get(convId: string): SessionRecord | undefined;
  /** 删一条映射（conv 在 Pi 端失效后就地重建时用）。 */
  remove(convId: string): void;
  /** 删一场会议的全部映射（删除会议时用），返回删除条数。 */
  deleteByMeeting(meetingId: string): number;
  close(): void;
};

export type StoredSessionRow = {
  conv_id: string;
  meeting_id: string;
  member_id: string;
  started: string;
};

function toRecord(row: StoredSessionRow): SessionRecord {
  return { convId: row.conv_id, meetingId: row.meeting_id, memberId: row.member_id, started: row.started };
}

/**
 * 开库并建表。开发阶段的一次性迁移：旧 `sessions`（room / ended / previous / 标题…）直接 DROP 重建——
 * 会议是新的会话单元，旧行没有对应物，不做兼容（旧库由 meetings/messages 一起重建）。
 */
export function openSessionStore(file: string): SessionStore {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  const existing = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").all() as { name: string }[]).length > 0;
  if (existing) {
    const columns = (db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((column) => column.name);
    if (!columns.includes("meeting_id")) db.exec("DROP TABLE sessions");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      conv_id    TEXT PRIMARY KEY,
      meeting_id TEXT NOT NULL,
      member_id  TEXT NOT NULL,
      started    TEXT NOT NULL,
      UNIQUE(meeting_id, member_id)
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_meeting ON sessions(meeting_id);
  `);

  const upsert = db.prepare(`
    INSERT INTO sessions (conv_id, meeting_id, member_id, started) VALUES (?, ?, ?, ?)
    ON CONFLICT(meeting_id, member_id) DO UPDATE SET conv_id = excluded.conv_id, started = excluded.started
  `);
  const selectOne = db.prepare("SELECT * FROM sessions WHERE conv_id = ?");
  const selectConv = db.prepare("SELECT * FROM sessions WHERE meeting_id = ? AND member_id = ?");
  const selectMeeting = db.prepare("SELECT * FROM sessions WHERE meeting_id = ? ORDER BY started ASC");
  const selectAll = db.prepare("SELECT * FROM sessions ORDER BY started ASC");
  const deleteOne = db.prepare("DELETE FROM sessions WHERE conv_id = ?");
  const deleteMeeting = db.prepare("DELETE FROM sessions WHERE meeting_id = ?");

  return {
    open(input) {
      upsert.run(input.convId, input.meetingId, input.memberId, input.started);
      return { ...input };
    },
    convOf(meetingId, memberId) {
      const row = selectConv.get(meetingId, memberId) as StoredSessionRow | undefined;
      return row === undefined ? undefined : toRecord(row);
    },
    listByMeeting(meetingId) {
      return (selectMeeting.all(meetingId) as StoredSessionRow[]).map(toRecord);
    },
    listAll() {
      return (selectAll.all() as StoredSessionRow[]).map(toRecord);
    },
    owner(convId) {
      const row = selectOne.get(convId) as StoredSessionRow | undefined;
      return row === undefined ? undefined : { meetingId: row.meeting_id, memberId: row.member_id };
    },
    get(convId) {
      const row = selectOne.get(convId) as StoredSessionRow | undefined;
      return row === undefined ? undefined : toRecord(row);
    },
    remove(convId) {
      deleteOne.run(convId);
    },
    deleteByMeeting(meetingId) {
      return Number(deleteMeeting.run(meetingId).changes);
    },
    close() {
      db.close();
    },
  };
}
