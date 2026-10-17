import type { RoomMessage } from "../src/app/rooms.ts";
import type { PermissionRequestView } from "../src/app/permission-flow.ts";

export type { PermissionRequestView } from "../src/app/permission-flow.ts";

export type Status = { configured: boolean; root: string; port: number; model?: string; providers?: string[]; bossName: string };
export type EmployeeSummary = { id: string; alias?: string; model: string };
export type ProjectSummary = { id: string; alias: string; members: { id: string; alias?: string }[] };
export type RoomMessages = { roomKey: string; messages: RoomMessage[] };
export type SendResult = { roomMessageId: string; deliveries: { memberId: string; convId: string }[] };
export type ChainRow = { id: string; started: string; ended: string | null; previous: string | null };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const text = await res.text();
  const body = text === "" ? undefined : (JSON.parse(text) as unknown);
  if (!res.ok) {
    const message = (body as { error?: string } | undefined)?.error ?? `HTTP ${res.status}`;
    throw new Error(message);
  }
  return body as T;
}

function roomPath(roomKey: string): string {
  return `/api/rooms/${encodeURIComponent(roomKey)}`;
}

export const api = {
  status: () => request<Status>("/api/status"),
  employees: () => request<EmployeeSummary[]>("/api/employees"),
  projects: () => request<ProjectSummary[]>("/api/projects"),
  messages: (roomKey: string) => request<RoomMessages>(`${roomPath(roomKey)}/messages`),
  send: (roomKey: string, text: string, requestId: string) =>
    request<SendResult>(`${roomPath(roomKey)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, requestId }),
    }),
  newSession: (roomKey: string, memberId?: string) =>
    request<{ convId: string }>(`${roomPath(roomKey)}/new-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(memberId === undefined ? {} : { memberId }),
    }),
  sessions: (roomKey: string) =>
    request<{ chains: { memberId: string; rows: ChainRow[] }[] }>(`${roomPath(roomKey)}/sessions`),
  history: (roomKey: string, convId: string) =>
    request<{ convId: string; memberId: string; messages: RoomMessage[] }>(
      `${roomPath(roomKey)}/sessions/${encodeURIComponent(convId)}/messages`,
    ),
  read: (roomKey: string) => request<{ ok: boolean }>(`${roomPath(roomKey)}/read`, { method: "POST" }),
  interrupt: (roomKey: string) => request<{ aborted: string[] }>(`${roomPath(roomKey)}/interrupt`, { method: "POST" }),
  unread: () => request<{ total: number; rooms: Record<string, number> }>("/api/unread"),
  permissionRequests: () => request<{ requests: PermissionRequestView[] }>("/api/permission-requests"),
  resolvePermission: (id: string, decision: "accept" | "reject") =>
    request<{ ok: boolean; warning?: string }>(`/api/permission-requests/${encodeURIComponent(id)}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    }),
};
