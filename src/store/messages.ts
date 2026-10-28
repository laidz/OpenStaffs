import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StoredMessage } from "./row.ts";

export type MessageStore = {
  append(input: Omit<StoredMessage, "id" | "seq">): StoredMessage;
  /** 一场会议的全部消息（按 seq 升序）。 */
  byMeeting(meetingId: string): StoredMessage[];
  /** 删一场会议的全部消息（删除会议时用），返回删除条数。 */
  deleteByMeeting(meetingId: string): number;
  close(): void;
};

type Row = { id: string; seq: number; send_time: string; meeting_id: string; from_id: string; to_ids: string; text: string };

function toStored(r: Row): StoredMessage {
  return {
    id: r.id,
    seq: r.seq,
    sendTime: r.send_time,
    meetingId: r.meeting_id,
    fromId: r.from_id,
    toIds: JSON.parse(r.to_ids) as string[],
    text: r.text,
  };
}

export function openMessageStore(file: string): MessageStore {
  // 自建父目录（幂等）：DatabaseSync 不建目录，父目录缺失会抛 `unable to open database file`。
  // 生产三个调用点里 registry.recordAndBroadcast 没有前置 mkdir，故把保证收敛到开库这一处。
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // 开发阶段的一次性迁移：旧 `messages`（room / project_id / session_start）直接重建——
  // 房间已被会议取代，旧行无对应物，不做兼容（跟 meetings / sessions 一起重建）。
  const existing = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'").all() as { name: string }[]).length > 0;
  if (existing) {
    const columns = (db.prepare("PRAGMA table_info(messages)").all() as { name: string }[]).map((column) => column.name);
    if (!columns.includes("meeting_id")) db.exec("DROP TABLE messages");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id         TEXT PRIMARY KEY,
      seq        INTEGER NOT NULL,
      send_time  TEXT NOT NULL,
      meeting_id TEXT NOT NULL,
      from_id    TEXT NOT NULL,
      to_ids     TEXT NOT NULL,
      text       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_meeting_seq ON messages(meeting_id, seq);
  `);
  const nextSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages");
  const insert = db.prepare(
    "INSERT INTO messages (id, seq, send_time, meeting_id, from_id, to_ids, text) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const selectMeeting = db.prepare("SELECT * FROM messages WHERE meeting_id = ? ORDER BY seq ASC");
  const deleteMeeting = db.prepare("DELETE FROM messages WHERE meeting_id = ?");
  // 标题归 `store/meetings.ts`（会议与标题同一个真相）；这里只管消息流水。
  return {
    append(input) {
      const id = `m_${randomUUID()}`;
      const seq = (nextSeq.get() as { seq: number }).seq;
      insert.run(id, seq, input.sendTime, input.meetingId, input.fromId, JSON.stringify(input.toIds), input.text);
      return { id, seq, ...input };
    },
    byMeeting(meetingId) {
      return (selectMeeting.all(meetingId) as Row[]).map(toStored);
    },
    deleteByMeeting(meetingId) {
      return Number(deleteMeeting.run(meetingId).changes);
    },
    close() {
      db.close();
    },
  };
}
