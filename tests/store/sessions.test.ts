import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { openMessageStore, type MessageStore } from "../../src/store/messages.ts";

let dir: string;
let store: MessageStore;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "os-sess-"));
  store = openMessageStore(path.join(dir, "openstaffs.sqlite"));
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

test("没有标题时 sessionOf 返回 undefined；sessionsOf 跳过不存在的 id", () => {
  expect(store.sessionOf("conv_x")).toBeUndefined();
  expect(store.sessionsOf(["conv_x"]).size).toBe(0);
});

test("setTitle 落库并原样返回；sessionsOf 批量取", () => {
  store.setTitle("conv_a", "10-26 15:32", "fallback");
  store.setTitle("conv_b", "改过的名字", "manual");
  const map = store.sessionsOf(["conv_a", "conv_b", "conv_missing"]);
  expect(map.get("conv_a")?.title).toBe("10-26 15:32");
  expect(map.get("conv_a")?.titleSource).toBe("fallback");
  expect(map.get("conv_b")?.titleSource).toBe("manual");
  expect(map.has("conv_missing")).toBe(false);
});

test("auto 覆盖 fallback；auto 不覆盖 manual；manual 覆盖一切", () => {
  store.setTitle("conv_a", "10-26 15:32", "fallback");
  expect(store.setTitle("conv_a", "自动名字", "auto").title).toBe("自动名字");
  expect(store.setTitle("conv_a", "手改的名字", "manual").title).toBe("手改的名字");
  // 关键：飞行中的自动命名结果不得覆盖手动改名
  expect(store.setTitle("conv_a", "迟到的自动名字", "auto").title).toBe("手改的名字");
  expect(store.sessionOf("conv_a")?.titleSource).toBe("manual");
});

test("fallback 也只覆盖 fallback（不覆盖 auto / manual）", () => {
  store.setTitle("conv_a", "自动名字", "auto");
  expect(store.setTitle("conv_a", "10-26 16:00", "fallback").title).toBe("自动名字");
});
