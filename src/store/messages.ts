import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { roomKeyOfMessage, type StoredMessage } from "./row.ts";

export type MessageStore = {
  append(input: Omit<StoredMessage, "id" | "seq" | "room">): StoredMessage;
  listByRoom(room: string): StoredMessage[];
  /**
   * 房间**当前一轮**的消息：最近一条 `sessionStart` 起点行（含）之后的行。
   * 没有起点行（旧库 / 从没点过「新开会话」）= 整本房间流水。
   */
  currentWindow(room: string): StoredMessage[];
  close(): void;
};

type Row = { id: string; seq: number; send_time: string; room: string; project_id: string | null; from_id: string; to_ids: string; text: string; session_start: number };

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
    ...(r.session_start === 1 ? { sessionStart: true } : {}),
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
      session_start INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_messages_room_seq ON messages(room, seq);
  `);
  // 旧库迁移（开发阶段：破坏性更新可接受，不为老结构留分支）：
  // session_id 是从未写入过的死列 → 删；session_start 是本轮起点标记 → 补。
  const columns = (db.prepare("PRAGMA table_info(messages)").all() as { name: string }[]).map((column) => column.name);
  if (columns.includes("session_id")) db.exec("ALTER TABLE messages DROP COLUMN session_id");
  if (!columns.includes("session_start")) {
    db.exec("ALTER TABLE messages ADD COLUMN session_start INTEGER NOT NULL DEFAULT 0");
  }
  const nextSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages");
  const insert = db.prepare(
    "INSERT INTO messages (id, seq, send_time, room, project_id, from_id, to_ids, text, session_start) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const selectRoom = db.prepare("SELECT * FROM messages WHERE room = ? ORDER BY seq ASC");
  // 当前一轮 = 最近一条起点行（含）之后；没有起点行（旧库 / 从没点过「新开会话」）→ 整本流水。
  const selectWindow = db.prepare(`
    SELECT * FROM messages
    WHERE room = ?
      AND seq >= COALESCE((SELECT MAX(seq) FROM messages WHERE room = ? AND session_start = 1), 0)
    ORDER BY seq ASC
  `);
  // 条件的标题 UPSERT 归 `store/sessions.ts`（会话表与标题同一个真相）；这里只管消息流水。
  return {
    append(input) {
      const id = `m_${randomUUID()}`;
      const seq = (nextSeq.get() as { seq: number }).seq;
      const room = roomKeyOfMessage(input);
      insert.run(id, seq, input.sendTime, room, input.projectId, input.fromId, JSON.stringify(input.toIds), input.text, input.sessionStart === true ? 1 : 0);
      return { id, seq, room, ...input };
    },
    listByRoom(room) {
      return (selectRoom.all(room) as Row[]).map(toStored);
    },
    currentWindow(room) {
      return (selectWindow.all(room, room) as Row[]).map(toStored);
    },
    close() { db.close(); },
  };
}
