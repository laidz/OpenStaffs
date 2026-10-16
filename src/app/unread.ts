import fs from "node:fs";
import path from "node:path";
import { stateDir, type Workspace } from "../domain/paths.ts";
import { countUnread, type RoomMessage } from "./rooms.ts";

export type SeenState = { seen: Record<string, number> };

export function seenFile(ws: Workspace): string {
  return path.join(stateDir(ws), "state.json");
}

/** 读已读水印；缺失/坏 JSON → 空状态（丢失只导致未读重置，无资产损失）。 */
export function readSeen(ws: Workspace): SeenState {
  let raw = "";
  try {
    raw = fs.readFileSync(seenFile(ws), "utf8");
  } catch {
    return { seen: {} };
  }
  try {
    const parsed = JSON.parse(raw) as { seen?: unknown };
    const seen: Record<string, number> = {};
    if (typeof parsed.seen === "object" && parsed.seen !== null) {
      for (const [key, value] of Object.entries(parsed.seen)) {
        if (typeof value === "number" && Number.isFinite(value)) seen[key] = value;
      }
    }
    return { seen };
  } catch {
    return { seen: {} };
  }
}

function writeSeen(ws: Workspace, state: SeenState): void {
  fs.mkdirSync(stateDir(ws), { recursive: true });
  const file = seenFile(ws);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** 把房间已读水位推进到 entryId（单调不倒退），返回新状态。 */
export function markSeen(ws: Workspace, roomKey: string, entryId: string): SeenState {
  const state = readSeen(ws);
  const value = Number(entryId);
  if (Number.isFinite(value)) {
    state.seen[roomKey] = Math.max(state.seen[roomKey] ?? 0, value);
  }
  writeSeen(ws, state);
  return state;
}

/** 逐房间未读计数与总数（老板自己的发言不计）。 */
export function unreadCounts(
  rooms: { key: string; messages: RoomMessage[] }[],
  seen: SeenState,
): { total: number; rooms: Record<string, number> } {
  const counts: Record<string, number> = {};
  let total = 0;
  for (const room of rooms) {
    const count = countUnread(room.messages, seen.seen[room.key]);
    if (count > 0) {
      counts[room.key] = count;
      total += count;
    }
  }
  return { total, rooms: counts };
}
