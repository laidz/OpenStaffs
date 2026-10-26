import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { openSessionStore, type SessionStore } from "../../src/store/sessions.ts";

let dir: string;
let store: SessionStore;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "os-sess-"));
  store = openSessionStore(path.join(dir, "openstaffs.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const dm = (convId: string, memberId = "alice", now = "2026-10-26T10:00:00.000Z") =>
  ({ convId, room: `dm:${memberId}`, memberId, kind: "dm" as const, now });

test("open / active：会话 ID 就是 convId；同 owner 同时只有一条活跃", () => {
  store.open(dm("conv_1"));
  expect(store.active("dm:alice", "alice")).toMatchObject({ convId: "conv_1", ended: null, kind: "dm" });

  store.open(dm("conv_2", "alice", "2026-10-26T11:00:00.000Z"));
  const active = store.active("dm:alice", "alice");
  expect(active).toMatchObject({ convId: "conv_2", previous: "conv_1", ended: null });
  // 旧会话被同事务结束，不会出现两条活跃
  expect(store.get("conv_1")?.ended).toBe("2026-10-26T11:00:00.000Z");
  expect(store.listActive().map((row) => row.convId)).toEqual(["conv_2"]);
});

test("list：按房间给链序（started 升序）；别的房间不串", () => {
  store.open(dm("conv_1", "alice", "2026-10-26T10:00:00.000Z"));
  store.open(dm("conv_2", "alice", "2026-10-26T11:00:00.000Z"));
  store.open({ convId: "conv_g1", room: "group:yt", memberId: "alice", kind: "group", now: "2026-10-26T12:00:00.000Z" });
  expect(store.list("dm:alice").map((row) => row.convId)).toEqual(["conv_1", "conv_2"]);
  expect(store.list("group:yt").map((row) => row.convId)).toEqual(["conv_g1"]);
  expect(store.list("dm:nobody")).toEqual([]);
});

test("owner / get / getMany：convId → 房间 + 主人；不存在的返回 undefined", () => {
  store.open(dm("conv_1"));
  store.open({ convId: "conv_g1", room: "group:yt", memberId: "bob", kind: "group", now: "2026-10-26T12:00:00.000Z" });
  expect(store.owner("conv_1")).toEqual({ room: "dm:alice", memberId: "alice" });
  expect(store.owner("conv_g1")).toEqual({ room: "group:yt", memberId: "bob" });
  expect(store.owner("conv_x")).toBeUndefined();
  expect(store.get("conv_x")).toBeUndefined();
  expect([...store.getMany(["conv_1", "conv_x"]).keys()]).toEqual(["conv_1"]);
});

test("listActive：全部房间的活跃会话（重启扫描用一条 SQL 拿全）", () => {
  store.open(dm("conv_1"));
  store.open({ convId: "conv_g1", room: "group:yt", memberId: "bob", kind: "group", now: "2026-10-26T12:00:00.000Z" });
  store.open(dm("conv_2", "alice", "2026-10-26T13:00:00.000Z")); // 结束 conv_1
  expect(store.listActive().map((row) => [row.convId, row.room, row.memberId])).toEqual([
    ["conv_g1", "group:yt", "bob"],
    ["conv_2", "dm:alice", "alice"],
  ]);
});

test("closeAt：把指定会话标为已结束（一次性迁入历史行用）；已结束的不变", () => {
  store.open(dm("conv_1"));
  store.closeAt("conv_1", "2026-10-26T10:30:00.000Z");
  expect(store.active("dm:alice", "alice")).toBeUndefined();
  store.closeAt("conv_1", "2030-01-01T00:00:00.000Z");
  expect(store.get("conv_1")?.ended).toBe("2026-10-26T10:30:00.000Z");
});

test("setTitle：auto 覆盖 fallback；auto 不覆盖 manual；manual 覆盖一切", () => {
  store.open(dm("conv_a"));
  expect(store.setTitle("conv_a", "10-26 15:32", "fallback").title).toBe("10-26 15:32");
  expect(store.setTitle("conv_a", "自动名字", "auto").title).toBe("自动名字");
  expect(store.setTitle("conv_a", "手改的名字", "manual").title).toBe("手改的名字");
  // 关键：飞行中的自动命名结果不得覆盖手动改名
  expect(store.setTitle("conv_a", "迟到的自动名字", "auto").title).toBe("手改的名字");
  expect(store.get("conv_a")?.titleSource).toBe("manual");
});

test("setTitle：fallback 也只覆盖 fallback（不覆盖 auto / manual）", () => {
  store.open(dm("conv_a"));
  store.setTitle("conv_a", "自动名字", "auto");
  expect(store.setTitle("conv_a", "迟到的 fallback", "fallback").title).toBe("自动名字");
});

test("setTitle：会话不存在时报错（不给幽灵会话写标题）", () => {
  expect(() => store.setTitle("conv_x", "名字", "manual")).toThrow(/会话不存在/u);
});

test("旧结构（只有标题列）开库自动重建：不再读老表，也不丢新写入", () => {
  const file = path.join(dir, "legacy.sqlite");
  const legacy = new DatabaseSync(file);
  legacy.exec("CREATE TABLE sessions (conv_id TEXT PRIMARY KEY, title TEXT NOT NULL, title_source TEXT NOT NULL, updated_at TEXT NOT NULL)");
  legacy.close();
  const migrated = openSessionStore(file);
  try {
    migrated.open(dm("conv_1"));
    expect(migrated.active("dm:alice", "alice")?.convId).toBe("conv_1");
  } finally {
    migrated.close();
  }
});
