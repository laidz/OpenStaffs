import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, test } from "vitest";
import { openMeetingStore, type MeetingStore } from "../../src/store/meetings.ts";

let dir: string;
let store: MeetingStore;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "os-meet-"));
  store = openMeetingStore(path.join(dir, "openstaffs.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const group = (now = "2026-10-26T10:00:00.000Z", subjectId = "yt") => ({
  kind: "group" as const,
  subjectId,
  subjectLabel: "油管",
  now,
});

test("create：id 前缀 mtg_；不再有结束 / 成员快照字段；get 读得回", () => {
  const meeting = store.create(group());
  expect(meeting.meetingId).toMatch(/^mtg_/u);
  expect(meeting).toMatchObject({ kind: "group", subjectId: "yt", subjectLabel: "油管" });
  expect(meeting).not.toHaveProperty("closedAt");
  expect(meeting).not.toHaveProperty("participants");
  expect(store.get(meeting.meetingId)?.meetingId).toBe(meeting.meetingId);
});

test("同 subject 再 create：旧会议不被结束，latest 是新的，旧会议仍在列表里", () => {
  const first = store.create(group("2026-10-26T10:00:00.000Z"));
  const second = store.create(group("2026-10-26T11:00:00.000Z"));
  expect(store.latest("group", "yt")?.meetingId).toBe(second.meetingId);
  expect(store.get(first.meetingId)).toBeDefined(); // 旧会议还活着（随时能继续聊）
  expect(store.list("group", "yt").map((row) => row.meetingId)).toEqual([second.meetingId, first.meetingId]);
});

test("不同 subject 互不影响：dm:alice 与 group:yt 各自 latest", () => {
  const dm = store.create({ kind: "dm", subjectId: "alice", subjectLabel: "爱丽丝", now: "2026-10-26T10:00:00.000Z" });
  const grp = store.create(group());
  expect(store.latest("dm", "alice")?.meetingId).toBe(dm.meetingId);
  expect(store.latest("group", "yt")?.meetingId).toBe(grp.meetingId);
});

test("list 按 created_at 倒序；listAll 含所有主题", () => {
  const first = store.create(group("2026-10-26T10:00:00.000Z"));
  const second = store.create(group("2026-10-26T11:00:00.000Z"));
  const other = store.create({ kind: "dm", subjectId: "alice", subjectLabel: "爱丽丝", now: "2026-10-26T12:00:00.000Z" });
  expect(store.list("group", "yt").map((row) => row.meetingId)).toEqual([second.meetingId, first.meetingId]);
  expect(store.list("group", "nope")).toEqual([]);
  expect(store.listAll().map((row) => row.meetingId)).toEqual([first.meetingId, second.meetingId, other.meetingId]);
});

test("setTitle 覆盖规则：manual 恒覆盖；auto 不盖 manual；fallback 可被 auto 覆盖", () => {
  const meeting = store.create(group());
  expect(store.setTitle(meeting.meetingId, "10-26 10:00", "fallback")).toMatchObject({ title: "10-26 10:00", titleSource: "fallback" });
  expect(store.setTitle(meeting.meetingId, "自动命名", "auto")).toMatchObject({ title: "自动命名", titleSource: "auto" });
  expect(store.setTitle(meeting.meetingId, "手动改名", "manual")).toMatchObject({ title: "手动改名", titleSource: "manual" });
  expect(store.setTitle(meeting.meetingId, "又被自动改", "auto").title).toBe("手动改名");
  expect(store.setTitle(meeting.meetingId, "又一条兜底", "fallback").title).toBe("手动改名");
});

test("delete：会议行删除；latest 回退到上一场；删空后 latest 为 undefined", () => {
  const first = store.create(group("2026-10-26T10:00:00.000Z"));
  const second = store.create(group("2026-10-26T11:00:00.000Z"));
  store.delete(second.meetingId);
  expect(store.get(second.meetingId)).toBeUndefined();
  expect(store.latest("group", "yt")?.meetingId).toBe(first.meetingId);
  store.delete(first.meetingId);
  expect(store.latest("group", "yt")).toBeUndefined();
  expect(store.list("group", "yt")).toEqual([]);
});

test("删除不存在的会议：幂等无异常", () => {
  expect(() => store.delete("mtg_nope")).not.toThrow();
});

test("重开库后数据仍在", () => {
  const meeting = store.create(group());
  store.setTitle(meeting.meetingId, "会议标题", "manual");
  store.close();
  store = openMeetingStore(path.join(dir, "openstaffs.sqlite"));
  expect(store.get(meeting.meetingId)).toMatchObject({ title: "会议标题" });
});

test("旧库迁移：closed_at / participants 列消失，会议行全部保留且不再有「结束」", () => {
  const file = path.join(dir, "legacy.sqlite");
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE meetings (
      meeting_id TEXT PRIMARY KEY, kind TEXT NOT NULL, subject_id TEXT NOT NULL,
      subject_label TEXT NOT NULL, participants TEXT NOT NULL,
      title TEXT, title_source TEXT, created_at TEXT NOT NULL, closed_at TEXT
    );
    CREATE UNIQUE INDEX idx_meetings_current ON meetings(kind, subject_id) WHERE closed_at IS NULL;
    INSERT INTO meetings VALUES
      ('mtg_old_open','group','yt','油管','["alice","bob"]','旧标题','manual','2026-10-26T10:00:00.000Z',NULL),
      ('mtg_old_closed','group','yt','油管','["alice"]','已结束的','manual','2026-10-26T09:00:00.000Z','2026-10-26T10:00:00.000Z');
  `);
  legacy.close();

  const migrated = openMeetingStore(file);
  try {
    expect(migrated.list("group", "yt").map((row) => row.meetingId)).toEqual(["mtg_old_open", "mtg_old_closed"]);
    expect(migrated.latest("group", "yt")?.meetingId).toBe("mtg_old_open");
    expect(migrated.get("mtg_old_closed")).toMatchObject({ title: "已结束的" }); // 旧的「已结束」也变成普通会议
    const columns = (new DatabaseSync(file).prepare("PRAGMA table_info(meetings)").all() as { name: string }[]).map((row) => row.name);
    expect(columns).not.toContain("closed_at");
    expect(columns).not.toContain("participants");
  } finally {
    migrated.close();
  }
});
