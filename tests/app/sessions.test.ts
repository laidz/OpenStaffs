import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fallbackTitle, nameNewSession, renameSession, type SessionTitleDeps, type TitleEvent } from "../../src/app/sessions.ts";
import { openMessageStore, type MessageStore } from "../../src/store/messages.ts";

function tempStore(): { store: MessageStore; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "os-title-"));
  const store = openMessageStore(path.join(dir, "openstaffs.sqlite"));
  return { store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("fallbackTitle 形如 10-26 05:07（补零、本地时区）", () => {
  expect(fallbackTitle(new Date(2026, 9, 26, 5, 7))).toBe("10-26 05:07");
});

test("nameNewSession 先落时间标题并广播；命名成功后改成 auto 并再广播一次", async () => {
  const { store, cleanup } = tempStore();
  try {
    const events: TitleEvent[] = [];
    const deps: SessionTitleDeps = { store, notify: (event) => events.push(event), namer: async () => "修复登录 Bug" };
    nameNewSession(deps, "dm:alice", "conv_a", "帮我看看登录为什么 500");
    // 同步部分：fallback 已落库并广播（不 await）
    expect(store.sessionOf("conv_a")?.titleSource).toBe("fallback");
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ roomKey: "dm:alice", convId: "conv_a", title: store.sessionOf("conv_a")!.title });
    await flush();
    expect(store.sessionOf("conv_a")?.title).toBe("修复登录 Bug");
    expect(store.sessionOf("conv_a")?.titleSource).toBe("auto");
    expect(events).toHaveLength(2);
  } finally {
    cleanup();
  }
});

test("命名失败（undefined）只留 fallback 标题", async () => {
  const { store, cleanup } = tempStore();
  try {
    const deps: SessionTitleDeps = { store, notify: () => {}, namer: async () => undefined };
    nameNewSession(deps, "dm:alice", "conv_b", "你好");
    await flush();
    expect(store.sessionOf("conv_b")?.titleSource).toBe("fallback");
  } finally {
    cleanup();
  }
});

test("没有 namer（自动命名不可用）：只落 fallback，不报错", async () => {
  const { store, cleanup } = tempStore();
  try {
    const deps: SessionTitleDeps = { store, notify: () => {} };
    nameNewSession(deps, "dm:alice", "conv_d", "你好");
    await flush();
    expect(store.sessionOf("conv_d")?.titleSource).toBe("fallback");
  } finally {
    cleanup();
  }
});

test("手动改名后再来的自动结果不覆盖", async () => {
  const { store, cleanup } = tempStore();
  try {
    let release: (title: string | undefined) => void = () => {};
    const deps: SessionTitleDeps = {
      store,
      notify: () => {},
      namer: () => new Promise<string | undefined>((resolve) => { release = resolve; }),
    };
    nameNewSession(deps, "dm:alice", "conv_c", "整理周报");
    renameSession(deps, "dm:alice", "conv_c", "我自己的名字", "manual");
    release("自动名字");
    await flush();
    expect(store.sessionOf("conv_c")?.title).toBe("我自己的名字");
    expect(store.sessionOf("conv_c")?.titleSource).toBe("manual");
  } finally {
    cleanup();
  }
});
