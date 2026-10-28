import fs from "node:fs";
import path from "node:path";
import { stateDir, type Workspace } from "../domain/paths.ts";
import type { MeetingMessage } from "../app/meeting-messages.ts";

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
export function messageKey(message: MeetingMessage): string {
  return `${message.convId}:${message.entryId}`;
}

/** 置/清一条消息的 pin 标记（幂等），返回新状态。 */
export function setPin(ws: Workspace, meetingId: string, key: string, pinned: boolean): PinState {
  const state = readPins(ws);
  const keys = new Set(state.pins[meetingId] ?? []);
  if (pinned) keys.add(key);
  else keys.delete(key);
  if (keys.size === 0) delete state.pins[meetingId];
  else state.pins[meetingId] = [...keys];
  writePins(ws, state);
  return state;
}

/** 删除一场会议的全部 pin（删除会议时一并清理）。 */
export function removeMeetingPins(ws: Workspace, meetingId: string): void {
  const state = readPins(ws);
  if (!(meetingId in state.pins)) return;
  delete state.pins[meetingId];
  writePins(ws, state);
}

/** 逐会议红点计数与总数（老板自己的 pin）：只数该会议里被 pin 的消息。 */
export function pinCounts(
  meetings: { meetingId: string; messages: MeetingMessage[] }[],
  state: PinState,
): { total: number; meetings: Record<string, number> } {
  const counts: Record<string, number> = {};
  let total = 0;
  for (const meeting of meetings) {
    const pinned = new Set(state.pins[meeting.meetingId] ?? []);
    if (pinned.size === 0) continue;
    const count = meeting.messages.filter((message) => pinned.has(messageKey(message))).length;
    if (count > 0) {
      counts[meeting.meetingId] = count;
      total += count;
    }
  }
  return { total, meetings: counts };
}
