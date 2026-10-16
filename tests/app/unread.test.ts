import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { markSeen, readSeen, seenFile, unreadCounts } from "../../src/app/unread.ts";
import type { RoomMessage } from "../../src/app/rooms.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-unread-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function msg(entryId: string, kind: "boss" | "employee", roomKey = "dm:alice"): RoomMessage {
  return kind === "boss"
    ? { convId: "c1", entryId, roomKey, speaker: { kind: "boss" }, text: "t", roomMessageId: `rm_${entryId}` }
    : { convId: "c1", entryId, roomKey, speaker: { kind: "employee", id: "alice" }, text: "t" };
}

describe("未读水印", () => {
  it("缺失/坏 JSON → 空状态；markSeen 原子写入并可读回", () => {
    const ws = createWorkspace(root);
    expect(readSeen(ws)).toEqual({ seen: {} });
    fs.mkdirSync(path.dirname(seenFile(ws)), { recursive: true });
    fs.writeFileSync(seenFile(ws), "{坏");
    expect(readSeen(ws)).toEqual({ seen: {} });
    markSeen(ws, "dm:alice", "42");
    expect(readSeen(ws)).toEqual({ seen: { "dm:alice": 42 } });
    expect(fs.existsSync(`${seenFile(ws)}.tmp`)).toBe(false);
  });

  it("watermark 单调不倒退", () => {
    const ws = createWorkspace(root);
    markSeen(ws, "dm:alice", "42");
    markSeen(ws, "dm:alice", "10");
    expect(readSeen(ws).seen["dm:alice"]).toBe(42);
  });

  it("unreadCounts 逐房间计数与总数", () => {
    const ws = createWorkspace(root);
    markSeen(ws, "dm:alice", "10");
    const counts = unreadCounts(
      [
        { key: "dm:alice", messages: [msg("9", "employee"), msg("10", "employee"), msg("11", "employee"), msg("12", "boss")] },
        { key: "group:demo", messages: [msg("20", "employee", "group:demo")] },
      ],
      readSeen(ws),
    );
    expect(counts.rooms).toEqual({ "dm:alice": 1, "group:demo": 1 });
    expect(counts.total).toBe(2);
  });
});
