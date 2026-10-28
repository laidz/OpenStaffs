import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { openMessageStore, type MessageStore } from "../../src/store/messages.ts";

let dir: string;
let store: MessageStore;
const file = (): string => path.join(dir, "openstaffs.sqlite");

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "os-msg-"));
  store = openMessageStore(file());
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const msg = (meetingId: string, text: string, sendTime = "2026-10-26T10:00:00.000Z") => ({
  sendTime,
  meetingId,
  fromId: "__boss",
  toIds: ["alice"],
  text,
});

test("append：seq 从 1 递增，meetingId 原样", () => {
  const first = store.append(msg("mtg_a", "一"));
  const second = store.append(msg("mtg_a", "二"));
  expect(first.seq).toBe(1);
  expect(second.seq).toBe(2);
  expect(first.meetingId).toBe("mtg_a");
  expect(first.id).toMatch(/^m_/u);
  expect(second.toIds).toEqual(["alice"]);
});

test("byMeeting：只返回该会议的行，按 seq 升序", () => {
  store.append(msg("mtg_a", "一"));
  store.append(msg("mtg_b", "别的会"));
  store.append(msg("mtg_a", "二"));
  expect(store.byMeeting("mtg_a").map((row) => row.text)).toEqual(["一", "二"]);
  expect(store.byMeeting("mtg_b").map((row) => row.text)).toEqual(["别的会"]);
  expect(store.byMeeting("mtg_none")).toEqual([]);
});

test("老库带 room 列时开库直接重建（新表没有 room / session_start）", () => {
  store.close();
  const db = new DatabaseSync(file());
  db.exec("DROP TABLE messages");
  db.exec(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, seq INTEGER NOT NULL, send_time TEXT NOT NULL, room TEXT NOT NULL,
    project_id TEXT, from_id TEXT NOT NULL, to_ids TEXT NOT NULL, text TEXT NOT NULL,
    session_start INTEGER NOT NULL DEFAULT 0
  )`);
  db.close();

  store = openMessageStore(file());
  const row = store.append(msg("mtg_new", "重建后"));
  expect(row.seq).toBe(1);
  const columns = (() => {
    const probe = new DatabaseSync(file());
    try {
      return (probe.prepare("PRAGMA table_info(messages)").all() as { name: string }[]).map((column) => column.name);
    } finally {
      probe.close();
    }
  })();
  expect(columns).toContain("meeting_id");
  expect(columns).not.toContain("room");
  expect(columns).not.toContain("session_start");
});
