import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../../src/domain/paths.ts";
import { createEntity, touch, writeProfile } from "../../../src/domain/memory/store.ts";
import { buildIndex, evaluate, renderMemoryBlock } from "../../../src/domain/memory/view.ts";
import type { MemEntity } from "../../../src/domain/memory/types.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-memview-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const ws = createWorkspace(root);

const entity = (over: Partial<MemEntity> = {}): MemEntity => ({
  id: "a",
  title: "A",
  description: "简介",
  pinned: false,
  created: "2026-01-01T00:00:00+08:00",
  updated: "2026-01-01T00:00:00+08:00",
  body: "正文",
  path: "/tmp/a.md",
  ...over,
});

describe("新鲜度", () => {
  it("正好 90 天不淘汰，超过才淘汰；pinned 永不淘汰", () => {
    const now = new Date("2026-04-01T00:00:00+08:00"); // 2026-01-01 起正好 90 天
    expect(evaluate(entity(), undefined, 90, now).evicted).toBe(false);
    const later = new Date("2026-04-02T00:00:00+08:00");
    expect(evaluate(entity(), undefined, 90, later).evicted).toBe(true);
    expect(evaluate(entity({ pinned: true }), undefined, 90, later).evicted).toBe(false);
  });

  it("lastUsed 优先于 updated", () => {
    const now = new Date("2026-04-02T00:00:00+08:00");
    const f = evaluate(entity(), "2026-03-31T00:00:00+08:00", 90, now);
    expect(f.evicted).toBe(false);
    expect(f.remainingDays).toBe(88);
  });
});

describe("索引", () => {
  it("pinned 置顶，其余按最近使用排序", () => {
    const state = { b: "2026-03-01T00:00:00+08:00", c: "2026-02-01T00:00:00+08:00" };
    const index = buildIndex(
      [entity({ id: "a", title: "A" }), entity({ id: "b", title: "B" }), entity({ id: "c", title: "C", pinned: true })],
      state,
      { ttlDays: 90, maxEntries: 40, maxBytes: 16384 },
      { now: new Date("2026-03-02T00:00:00+08:00") },
    );
    expect(index.entries.map((e) => e.id)).toEqual(["c", "b", "a"]);
  });

  it("非 pinned 超过条数上限只截断注入，pinned 不受限", () => {
    const many = Array.from({ length: 45 }, (_, i) => entity({ id: `m${i}`, title: `M${i}`, pinned: i === 0 }));
    const index = buildIndex(
      many,
      {},
      { ttlDays: 90, maxEntries: 40, maxBytes: 16384 },
      { now: new Date("2026-01-01T00:00:00+08:00") },
    );
    expect(index.entries).toHaveLength(41);
    expect(index.truncated).toBe(4);
  });

  it("超过字节上限按顺序截断", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      entity({ id: `m${i}`, title: `M${i}`, description: "字".repeat(80) }),
    );
    const index = buildIndex(
      many,
      {},
      { ttlDays: 90, maxEntries: 40, maxBytes: 600 },
      { now: new Date("2026-01-01T00:00:00+08:00") },
    );
    expect(index.entries.length).toBeLessThan(10);
    expect(index.truncated).toBeGreaterThan(0);
  });
});

describe("注入文本", () => {
  it("空记忆 → 空串", () => {
    expect(renderMemoryBlock(ws, "alice")).toBe("");
  });

  it("profile + 索引", () => {
    writeProfile(ws, "alice", "身份是测试");
    createEntity(ws, "alice", { title: "A", description: "做 A 时看", body: "正文" });
    // 计时起点给一个「刚刚」的时间：写死具体日期会随墙钟漂移（2026-10-25T10:00 在次日 10:00 后就算作 1 天前 → 剩 89 天）。
    touch(ws, "alice", "a", new Date(Date.now() - 60_000).toISOString());
    const text = renderMemoryBlock(ws, "alice");
    expect(text).toContain("## 你的记忆");
    expect(text).toContain("### 常驻 profile（全文）");
    expect(text).toContain("身份是测试");
    expect(text).toContain("### 记忆索引（需要正文时用 memory_get <id>）");
    expect(text).toContain("- a · A — 做 A 时看（剩 90 天）");
  });
});
