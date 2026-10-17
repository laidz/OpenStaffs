import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { messageKey, pinCounts, pinsFile, readPins, setPin } from "../../src/app/pins.ts";
import type { RoomMessage } from "../../src/app/rooms.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-pins-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function msg(entryId: string, convId: string, roomKey = "dm:alice"): RoomMessage {
  return { convId, entryId, roomKey, speaker: { kind: "employee", id: "alice" }, text: "t", bossDirected: true };
}

describe("pin 标记", () => {
  it("缺失/坏 JSON → 空状态；setPin 原子写入并可读回", () => {
    const ws = createWorkspace(root);
    expect(readPins(ws)).toEqual({ pins: {} });
    fs.mkdirSync(path.dirname(pinsFile(ws)), { recursive: true });
    fs.writeFileSync(pinsFile(ws), "{坏");
    expect(readPins(ws)).toEqual({ pins: {} });
    setPin(ws, "dm:alice", "c1:42", true);
    expect(readPins(ws)).toEqual({ pins: { "dm:alice": ["c1:42"] } });
    expect(fs.existsSync(`${pinsFile(ws)}.tmp`)).toBe(false);
  });

  it("setPin 幂等：重复 pin 只留一条；unpin 移除且空房间不留键", () => {
    const ws = createWorkspace(root);
    setPin(ws, "dm:alice", "c1:42", true);
    setPin(ws, "dm:alice", "c1:42", true);
    expect(readPins(ws).pins["dm:alice"]).toEqual(["c1:42"]);
    setPin(ws, "dm:alice", "c1:42", false);
    expect(readPins(ws)).toEqual({ pins: {} });
  });

  it("messageKey：convId:entryId（与前端去重键一致）", () => {
    expect(messageKey(msg("42", "c1"))).toBe("c1:42");
  });

  it("pinCounts：只数房间当前视图里被 pin 的消息；pin 了但已不在视图的不计", () => {
    const ws = createWorkspace(root);
    setPin(ws, "dm:alice", "c1:10", true);
    setPin(ws, "dm:alice", "c1:99", true); // 已不在视图（旧会话）
    setPin(ws, "group:demo", "c2:20", true);
    const counts = pinCounts(
      [
        { key: "dm:alice", messages: [msg("9", "c1"), msg("10", "c1"), msg("11", "c1")] },
        { key: "group:demo", messages: [msg("20", "c2", "group:demo"), msg("21", "c2", "group:demo")] },
      ],
      readPins(ws),
    );
    expect(counts.rooms).toEqual({ "dm:alice": 1, "group:demo": 1 });
    expect(counts.total).toBe(2);
  });
});
