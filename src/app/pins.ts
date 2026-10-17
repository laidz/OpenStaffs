import fs from "node:fs";
import path from "node:path";
import { stateDir, type Workspace } from "../domain/paths.ts";
import type { RoomMessage } from "./rooms.ts";

export type PinState = { pins: Record<string, string[]> };

export function pinsFile(ws: Workspace): string {
  return path.join(stateDir(ws), "state.json");
}

/** 读 pin 标记；缺失/坏 JSON → 空状态（丢失只导致红点重置，无资产损失）。 */
export function readPins(ws: Workspace): PinState {
  let raw = "";
  try {
    raw = fs.readFileSync(pinsFile(ws), "utf8");
  } catch {
    return { pins: {} };
  }
  try {
    const parsed = JSON.parse(raw) as { pins?: unknown };
    const pins: Record<string, string[]> = {};
    if (typeof parsed.pins === "object" && parsed.pins !== null) {
      for (const [key, value] of Object.entries(parsed.pins)) {
        if (!Array.isArray(value)) continue;
        const keys = value.filter((item): item is string => typeof item === "string");
        if (keys.length > 0) pins[key] = keys;
      }
    }
    return { pins };
  } catch {
    return { pins: {} };
  }
}

function writePins(ws: Workspace, state: PinState): void {
  fs.mkdirSync(stateDir(ws), { recursive: true });
  const file = pinsFile(ws);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** 消息在 pin 存储里的身份：convId:entryId（与前端去重键一致）。 */
export function messageKey(message: RoomMessage): string {
  return `${message.convId}:${message.entryId}`;
}

/** 置/清一条消息的 pin 标记（幂等），返回新状态。 */
export function setPin(ws: Workspace, roomKey: string, key: string, pinned: boolean): PinState {
  const state = readPins(ws);
  const keys = new Set(state.pins[roomKey] ?? []);
  if (pinned) keys.add(key);
  else keys.delete(key);
  if (keys.size === 0) delete state.pins[roomKey];
  else state.pins[roomKey] = [...keys];
  writePins(ws, state);
  return state;
}

/** 逐房间红点计数与总数（老板自己的 pin）：只数房间当前视图里被 pin 的消息。 */
export function pinCounts(
  rooms: { key: string; messages: RoomMessage[] }[],
  state: PinState,
): { total: number; rooms: Record<string, number> } {
  const counts: Record<string, number> = {};
  let total = 0;
  for (const room of rooms) {
    const pinned = new Set(state.pins[room.key] ?? []);
    if (pinned.size === 0) continue;
    const count = room.messages.filter((message) => pinned.has(messageKey(message))).length;
    if (count > 0) {
      counts[room.key] = count;
      total += count;
    }
  }
  return { total, rooms: counts };
}
