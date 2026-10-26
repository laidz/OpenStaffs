import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, test } from "vitest";
import { openMessageStore, type MessageStore } from "../../src/store/messages.ts";

let dir: string;
let store: MessageStore;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "os-msg-"));
  store = openMessageStore(path.join(dir, "openstaffs.sqlite"));
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const base = {
  sendTime: "2026-10-19T10:00:00.000Z",
  projectId: "seo" as string | null,
  fromId: "__boss",
  toIds: ["alice"],
  text: "你好",
};

test("append 返回带自增 seq 与 id 的整行；listByRoom 按 seq 升序", () => {
  const a = store.append({ ...base, projectId: null, toIds: ["alice"], text: "一" });
  const b = store.append({ ...base, projectId: null, toIds: ["alice"], text: "二" });
  expect(a.id).not.toBe(b.id);
  expect(b.seq).toBeGreaterThan(a.seq);
  const rows = store.listByRoom("dm:alice");
  expect(rows.map((r) => r.text)).toEqual(["一", "二"]);
});

test("群聊：projectId 非空 → room = group:<projectId>；不同房间互不串", () => {
  store.append({ ...base, text: "群里的话" });
  store.append({ ...base, projectId: null, toIds: ["alice"], text: "私聊的话" });
  expect(store.listByRoom("group:seo").map((r) => r.text)).toEqual(["群里的话"]);
  expect(store.listByRoom("dm:alice").map((r) => r.text)).toEqual(["私聊的话"]);
});

test("toIds 以 JSON 往返，多收件人保序", () => {
  store.append({ ...base, toIds: ["alice", "bob", "__boss"] });
  expect(store.listByRoom("group:seo")[0]!.toIds).toEqual(["alice", "bob", "__boss"]);
});

test("空房间返回 []（不抛）", () => {
  expect(store.listByRoom("group:nope")).toEqual([]);
});

test("父目录不存在时也能开库（openMessageStore 自建父目录）", () => {
  const nested = path.join(dir, "deep", "nested", "openstaffs.sqlite");
  const nestedStore = openMessageStore(nested);
  try {
    nestedStore.append({ ...base, projectId: null, toIds: ["alice"], text: "自动建目录" });
    expect(nestedStore.listByRoom("dm:alice").map((r) => r.text)).toEqual(["自动建目录"]);
  } finally {
    nestedStore.close();
  }
});

test("currentWindow：只返回最近一条 sessionStart 之后的行；listByRoom 仍是整本流水", () => {
  store.append({ ...base, projectId: null, toIds: ["alice"], text: "上一轮 1" });
  store.append({ ...base, projectId: null, toIds: ["alice"], text: "上一轮 2" });
  store.append({ ...base, projectId: null, toIds: ["alice"], text: "新一轮", sessionStart: true });
  store.append({ ...base, projectId: null, toIds: ["alice"], text: "新一轮里再说一句" });
  // 别的房间的起点不影响本房间
  store.append({ ...base, toIds: ["bob"], text: "别的房间", sessionStart: true });

  expect(store.currentWindow("dm:alice").map((r) => r.text)).toEqual(["新一轮", "新一轮里再说一句"]);
  expect(store.listByRoom("dm:alice").map((r) => r.text)).toEqual(["上一轮 1", "上一轮 2", "新一轮", "新一轮里再说一句"]);
});

test("currentWindow：多次新开会话只认最后一次；没有起点行 = 整本流水", () => {
  store.append({ ...base, projectId: null, toIds: ["alice"], text: "第一轮" });
  expect(store.currentWindow("dm:alice").map((r) => r.text)).toEqual(["第一轮"]);
  store.append({ ...base, projectId: null, toIds: ["alice"], text: "第二轮", sessionStart: true });
  store.append({ ...base, projectId: null, toIds: ["alice"], text: "第三轮", sessionStart: true });
  store.append({ ...base, projectId: null, toIds: ["alice"], text: "接着第三轮" });
  expect(store.currentWindow("dm:alice").map((r) => r.text)).toEqual(["第三轮", "接着第三轮"]);
  expect(store.currentWindow("dm:nobody")).toEqual([]);
});

test("sessionStart 落库往返：起点行读回来带 sessionStart，普通行不带", () => {
  store.append({ ...base, projectId: null, toIds: ["alice"], text: "普通" });
  store.append({ ...base, projectId: null, toIds: ["alice"], text: "起点", sessionStart: true });
  expect(store.listByRoom("dm:alice").map((r) => r.sessionStart)).toEqual([undefined, true]);
});

test("旧库（含死列 session_id、无 session_start）开库自动迁移：旧行保留、起点照常可用", () => {
  const file = path.join(dir, "legacy.sqlite");
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, seq INTEGER NOT NULL, send_time TEXT NOT NULL, room TEXT NOT NULL,
      project_id TEXT, from_id TEXT NOT NULL, to_ids TEXT NOT NULL, text TEXT NOT NULL, session_id TEXT
    );
  `);
  legacy
    .prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("m_old", 1, base.sendTime, "dm:alice", null, "__boss", JSON.stringify(["alice"]), "迁移前的老消息", null);
  legacy.close();

  const migrated = openMessageStore(file);
  try {
    expect(migrated.listByRoom("dm:alice").map((r) => r.text)).toEqual(["迁移前的老消息"]);
    expect(migrated.currentWindow("dm:alice").map((r) => r.text)).toEqual(["迁移前的老消息"]); // 无起点 = 全本
    migrated.append({ ...base, projectId: null, toIds: ["alice"], text: "新起点", sessionStart: true });
    expect(migrated.currentWindow("dm:alice").map((r) => r.text)).toEqual(["新起点"]);
  } finally {
    migrated.close();
  }
});
