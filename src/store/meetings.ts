import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** 会议类型：私聊（1 对 1） / 群聊（1 对多）。 */
export type MeetingKind = "dm" | "group";

/** 标题来源：决定覆盖规则的唯一依据（`manual` 恒覆盖；`auto` / `fallback` 只盖 `fallback`）。 */
export type TitleSource = "fallback" | "auto" | "manual";

/**
 * 一场会议（**会话的框架级身份**）。`meeting_id` 由框架自持、不透明，
 * 名字变化（项目/员工改名）不影响它；`conv_id`（Pi 的 conversation id）挂在它下面（见 store/sessions.ts）。
 *
 * **没有「结束」**：会议一旦创建就永远可以继续聊；成员不在这里快照（始终按当前项目 members 实时算，
 * 见 app/meetings.ts 的 `meetingView`）。老板唯一销毁会议的手段是删除（连同消息 / 会话映射 / pin）。
 */
export type MeetingRecord = {
  meetingId: string;
  kind: MeetingKind;
  /** dm = 员工 id；group = 项目 id。 */
  subjectId: string;
  /** 开会时的显示名（员工 / 项目 alias；取不到用 id）。 */
  subjectLabel: string;
  title?: string;
  titleSource?: TitleSource;
  createdAt: string;
};

export type MeetingStore = {
  /** 新建会议：只 insert，不结束任何旧会议（旧会议仍可继续聊）。 */
  create(input: { kind: MeetingKind; subjectId: string; subjectLabel: string; now: string }): MeetingRecord;
  /** 该 subject **最新创建**的会议（侧栏 / 首屏进入的那一场）。 */
  latest(kind: MeetingKind, subjectId: string): MeetingRecord | undefined;
  get(meetingId: string): MeetingRecord | undefined;
  getMany(meetingIds: readonly string[]): Map<string, MeetingRecord>;
  /** 该 subject 的全部会议，created_at 倒序（历史列表）。 */
  list(kind: MeetingKind, subjectId: string): MeetingRecord[];
  /** 全部会议（红点 / 删除后回退等），created_at 正序。 */
  listAll(): MeetingRecord[];
  /** 写标题（条件 UPDATE）：`manual` 恒覆盖；`fallback` / `auto` 只在现状为空或 `fallback` 时覆盖。 */
  setTitle(meetingId: string, title: string, source: TitleSource): MeetingRecord;
  /** 删除会议行（消息 / 会话 / pin 由 app 层一并清理）。 */
  delete(meetingId: string): void;
  close(): void;
};

type StoredMeetingRow = {
  meeting_id: string;
  kind: string;
  subject_id: string;
  subject_label: string;
  title: string | null;
  title_source: string | null;
  created_at: string;
};

function toRecord(row: StoredMeetingRow): MeetingRecord {
  return {
    meetingId: row.meeting_id,
    kind: row.kind === "group" ? "group" : "dm",
    subjectId: row.subject_id,
    subjectLabel: row.subject_label,
    ...(row.title === null ? {} : { title: row.title }),
    ...(row.title_source === null ? {} : { titleSource: row.title_source as TitleSource }),
    createdAt: row.created_at,
  };
}

/**
 * 开发阶段的一次性迁移：早前版本有 `closed_at`（会议可结束）与 `participants`（成员快照）。
 * 现在会议不再结束、成员实时算 → 重建表保留全部会议行（消息在 messages 表，按 meeting_id 关联，不受影响）。
 */
function migrate(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  const exists = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meetings'").all() as { name: string }[]).length > 0;
  if (exists) {
    const columns = (db.prepare("PRAGMA table_info(meetings)").all() as { name: string }[]).map((column) => column.name);
    if (columns.includes("closed_at") || columns.includes("participants")) {
      db.exec("BEGIN");
      try {
        db.exec(`
          DROP INDEX IF EXISTS idx_meetings_current;
          CREATE TABLE meetings_next (
            meeting_id    TEXT PRIMARY KEY,
            kind          TEXT NOT NULL,
            subject_id    TEXT NOT NULL,
            subject_label TEXT NOT NULL,
            title         TEXT,
            title_source  TEXT,
            created_at    TEXT NOT NULL
          );
          INSERT INTO meetings_next (meeting_id, kind, subject_id, subject_label, title, title_source, created_at)
            SELECT meeting_id, kind, subject_id, subject_label, title, title_source, created_at FROM meetings;
          DROP TABLE meetings;
          ALTER TABLE meetings_next RENAME TO meetings;
        `);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        db.close();
        throw error;
      }
    }
  }
  return db;
}

export function openMeetingStore(file: string): MeetingStore {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = migrate(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS meetings (
      meeting_id    TEXT PRIMARY KEY,
      kind          TEXT NOT NULL,
      subject_id    TEXT NOT NULL,
      subject_label TEXT NOT NULL,
      title         TEXT,
      title_source  TEXT,
      created_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_meetings_subject ON meetings(kind, subject_id, created_at);
  `);

  const insert = db.prepare(
    "INSERT INTO meetings (meeting_id, kind, subject_id, subject_label, title, title_source, created_at) VALUES (?, ?, ?, ?, NULL, NULL, ?)",
  );
  const selectOne = db.prepare("SELECT * FROM meetings WHERE meeting_id = ?");
  const selectLatest = db.prepare("SELECT * FROM meetings WHERE kind = ? AND subject_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1");
  const selectSubject = db.prepare("SELECT * FROM meetings WHERE kind = ? AND subject_id = ? ORDER BY created_at DESC, rowid DESC");
  const selectAll = db.prepare("SELECT * FROM meetings ORDER BY created_at ASC, rowid ASC");
  const deleteOne = db.prepare("DELETE FROM meetings WHERE meeting_id = ?");
  // 覆盖规则：manual 恒覆盖；其余只盖「没有标题」或「现状是 fallback」。
  const updateTitle = db.prepare(`
    UPDATE meetings SET title = ?, title_source = ?
    WHERE meeting_id = ? AND (? = 'manual' OR title IS NULL OR title_source IS NULL OR title_source = 'fallback')
  `);

  const record = (meetingId: string): MeetingRecord => {
    const row = selectOne.get(meetingId) as StoredMeetingRow | undefined;
    if (row === undefined) throw new Error(`会议不存在：${meetingId}`);
    return toRecord(row);
  };

  return {
    create(input) {
      const meetingId = `mtg_${randomUUID()}`;
      insert.run(meetingId, input.kind, input.subjectId, input.subjectLabel, input.now);
      return record(meetingId);
    },
    latest(kind, subjectId) {
      const row = selectLatest.get(kind, subjectId) as StoredMeetingRow | undefined;
      return row === undefined ? undefined : toRecord(row);
    },
    get(meetingId) {
      const row = selectOne.get(meetingId) as StoredMeetingRow | undefined;
      return row === undefined ? undefined : toRecord(row);
    },
    getMany(meetingIds) {
      const out = new Map<string, MeetingRecord>();
      for (const meetingId of meetingIds) {
        const row = selectOne.get(meetingId) as StoredMeetingRow | undefined;
        if (row !== undefined) out.set(meetingId, toRecord(row));
      }
      return out;
    },
    list(kind, subjectId) {
      return (selectSubject.all(kind, subjectId) as StoredMeetingRow[]).map(toRecord);
    },
    listAll() {
      return (selectAll.all() as StoredMeetingRow[]).map(toRecord);
    },
    setTitle(meetingId, title, source) {
      updateTitle.run(title, source, meetingId, source);
      return record(meetingId);
    },
    delete(meetingId) {
      deleteOne.run(meetingId);
    },
    close() {
      db.close();
    },
  };
}
