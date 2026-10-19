import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { openMessageStore, type MessageStore } from "../../src/store/messages.ts";

let dir: string;
let store: MessageStore;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "os-msg-"));
  store = openMessageStore(path.join(dir, "messages.sqlite"));
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
  const nested = path.join(dir, "deep", "nested", "messages.sqlite");
  const nestedStore = openMessageStore(nested);
  try {
    nestedStore.append({ ...base, projectId: null, toIds: ["alice"], text: "自动建目录" });
    expect(nestedStore.listByRoom("dm:alice").map((r) => r.text)).toEqual(["自动建目录"]);
  } finally {
    nestedStore.close();
  }
});
