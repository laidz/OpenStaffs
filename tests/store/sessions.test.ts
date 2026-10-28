import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { openMeetingStore, type MeetingStore } from "../../src/store/meetings.ts";
import { openSessionStore, type SessionStore } from "../../src/store/sessions.ts";

let dir: string;
let store: SessionStore;
let meetings: MeetingStore;
const file = (): string => path.join(dir, "openstaffs.sqlite");

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "os-sess-"));
  meetings = openMeetingStore(file());
  store = openSessionStore(file());
});
afterEach(() => {
  store.close();
  meetings.close();
  rmSync(dir, { recursive: true, force: true });
});

const meeting = (now = "2026-10-26T10:00:00.000Z", subjectId = "alice") =>
  meetings.create({ kind: "dm", subjectId, subjectLabel: subjectId, now });

test("open / convOf：conv 按 (meeting, member) 取回", () => {
  const m = meeting();
  store.open({ convId: "conv_1", meetingId: m.meetingId, memberId: "alice", started: "2026-10-26T10:00:01.000Z" });
  expect(store.convOf(m.meetingId, "alice")).toEqual({
    convId: "conv_1",
    meetingId: m.meetingId,
    memberId: "alice",
    started: "2026-10-26T10:00:01.000Z",
  });
  expect(store.convOf(m.meetingId, "bob")).toBeUndefined();
});

test("同 (meeting, member) 再 open：UPSERT 换 convId，行数仍 1", () => {
  const m = meeting();
  store.open({ convId: "conv_1", meetingId: m.meetingId, memberId: "alice", started: "2026-10-26T10:00:01.000Z" });
  store.open({ convId: "conv_2", meetingId: m.meetingId, memberId: "alice", started: "2026-10-26T10:05:00.000Z" });
  expect(store.convOf(m.meetingId, "alice")?.convId).toBe("conv_2");
  expect(store.listByMeeting(m.meetingId)).toHaveLength(1);
});

test("listByMeeting：按成员返回该会议全部 conv；别的会议不串", () => {
  const m1 = meeting("2026-10-26T10:00:00.000Z", "alice");
  const m2 = meeting("2026-10-26T10:00:00.000Z", "bob");
  store.open({ convId: "c_a", meetingId: m1.meetingId, memberId: "alice", started: "2026-10-26T10:00:01.000Z" });
  store.open({ convId: "c_b", meetingId: m2.meetingId, memberId: "bob", started: "2026-10-26T10:00:02.000Z" });
  expect(store.listByMeeting(m1.meetingId).map((row) => row.convId)).toEqual(["c_a"]);
  expect(store.listByMeeting(m2.meetingId).map((row) => row.convId)).toEqual(["c_b"]);
  expect(store.listByMeeting("mtg_none")).toEqual([]);
});

test("listAll：返回全部 conv（会议不再有「结束」，重启要恢复所有会话）", () => {
  const m1 = meeting("2026-10-26T10:00:00.000Z", "alice");
  const m2 = meeting("2026-10-26T11:00:00.000Z", "bob");
  store.open({ convId: "c_a", meetingId: m1.meetingId, memberId: "alice", started: "2026-10-26T10:00:01.000Z" });
  store.open({ convId: "c_b", meetingId: m2.meetingId, memberId: "bob", started: "2026-10-26T11:00:01.000Z" });
  expect(store.listAll().map((row) => row.convId)).toEqual(["c_a", "c_b"]);
});

test("deleteByMeeting：只删该会议的映射，返回条数", () => {
  const m1 = meeting("2026-10-26T10:00:00.000Z", "alice");
  const m2 = meeting("2026-10-26T11:00:00.000Z", "bob");
  store.open({ convId: "c_a1", meetingId: m1.meetingId, memberId: "alice", started: "2026-10-26T10:00:01.000Z" });
  store.open({ convId: "c_a2", meetingId: m1.meetingId, memberId: "bob", started: "2026-10-26T10:00:02.000Z" });
  store.open({ convId: "c_b", meetingId: m2.meetingId, memberId: "bob", started: "2026-10-26T11:00:01.000Z" });
  expect(store.deleteByMeeting(m1.meetingId)).toBe(2);
  expect(store.listByMeeting(m1.meetingId)).toEqual([]);
  expect(store.get("c_b")).toBeDefined();
});

test("owner：conv → (meeting, member)；未知 conv 返回 undefined", () => {
  const m = meeting();
  store.open({ convId: "c_a", meetingId: m.meetingId, memberId: "alice", started: "2026-10-26T10:00:01.000Z" });
  expect(store.owner("c_a")).toEqual({ meetingId: m.meetingId, memberId: "alice" });
  expect(store.owner("c_none")).toBeUndefined();
});

test("remove：删行后 owner 为 undefined", () => {
  const m = meeting();
  store.open({ convId: "c_a", meetingId: m.meetingId, memberId: "alice", started: "2026-10-26T10:00:01.000Z" });
  store.remove("c_a");
  expect(store.owner("c_a")).toBeUndefined();
  expect(store.convOf(m.meetingId, "alice")).toBeUndefined();
});
