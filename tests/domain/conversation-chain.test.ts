import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activeSession, readChain, startNewSession } from "../../src/domain/conversation-chain.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-chain-"));
beforeEach(() => fs.mkdirSync(dir, { recursive: true }));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const file = path.join(dir, "conversation_ids.md");

describe("conversation chain", () => {
  it("文件不存在时返回空", () => {
    expect(readChain(file)).toEqual([]);
    expect(activeSession(file)).toBeUndefined();
  });

  it("开始一条新会话会落盘，且成为活跃", () => {
    startNewSession(file, "1", "2026-10-16T10:00:00Z");
    expect(readChain(file)).toEqual([
      { id: "1", started: "2026-10-16T10:00:00Z", ended: null, previous: null },
    ]);
    expect(activeSession(file)?.id).toBe("1");
  });

  it("新开会话结束上一条并链接到 previous", () => {
    startNewSession(file, "1", "2026-10-16T10:00:00Z");
    startNewSession(file, "2", "2026-10-16T11:00:00Z");
    const rows = readChain(file);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ id: "1", started: "2026-10-16T10:00:00Z", ended: "2026-10-16T11:00:00Z", previous: null });
    expect(rows[1]).toEqual({ id: "2", started: "2026-10-16T11:00:00Z", ended: null, previous: "1" });
    expect(activeSession(file)?.id).toBe("2");
  });

  it("有多行进行中时取最后一行", () => {
    fs.writeFileSync(file, [
      "| id | started | ended | previous |",
      "|----|---------|-------|----------|",
      "| 1 | t |  | - |",
      "| 2 | t |  | 1 |",
    ].join("\n"));
    expect(activeSession(file)?.id).toBe("2");
  });
});
