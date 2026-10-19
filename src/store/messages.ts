import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { roomKeyOfMessage, type StoredMessage } from "./row.ts";

export type MessageStore = {
  append(input: Omit<StoredMessage, "id" | "seq" | "room">): StoredMessage;
  listByRoom(room: string): StoredMessage[];
  close(): void;
};

type Row = { id: string; seq: number; send_time: string; room: string; project_id: string | null; from_id: string; to_ids: string; text: string; session_id: string | null };

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
  `);
  const nextSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages");
  const insert = db.prepare(
    "INSERT INTO messages (id, seq, send_time, room, project_id, from_id, to_ids, text, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const selectRoom = db.prepare("SELECT * FROM messages WHERE room = ? ORDER BY seq ASC");
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
    close() { db.close(); },
  };
}
