import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { listEmployees, loadEmployee } from "../domain/employee.ts";
import { listProjects } from "../domain/project.ts";
import { parseMembers } from "../domain/access-control.ts";
import { formatModelRef, resolveEmployeeModel, type WorkspaceConfig } from "../domain/config.ts";
import { employeeDir, projectDir, type Workspace } from "../domain/paths.ts";
import { countUnread, mergeRoomMessages, parseRoomKey } from "../app/rooms.ts";
import { markSeen, readSeen, unreadCounts } from "../app/unread.ts";
import {
  activeMemberSessions, findSessionOwner, interruptRoom, newSession, roomTranscripts, sessionChains, type Relation,
} from "../app/conversations.ts";
import { EmptyGroupError, KeyedQueue, NoTargetsError, sendToRoom } from "../app/send.ts";
import type { HarnessPort } from "../harness/port.ts";
import type { SseHub } from "./sse.ts";

export type PumpLike = {
  register(convId: string, ref: { roomKey: string; memberId: string }): Promise<void>;
  unregister(convId: string): Promise<void>;
};

export type ServerDeps = {
  ws: Workspace;
  getConfig: () => WorkspaceConfig | undefined;
  getHarness: () => HarnessPort | undefined;
  queue: KeyedQueue;
  publicDir: string;
  /** 实际监听端口（启动参数 / config / 默认值解析后的结果）；status 展示用。 */
  port: number;
  pump?: PumpLike;
  hub?: SseHub;
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 1024 * 1024) throw new Error("请求体过大");
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("请求体不是合法 JSON");
  }
}

function memberSummaries(ws: Workspace, project: string): { id: string; alias?: string }[] {
  return parseMembers(ws, project).map((id) => {
    try {
      const employee = loadEmployee(ws, id);
      return { id, ...(employee.alias === undefined ? {} : { alias: employee.alias }) };
    } catch {
      return { id };
    }
  });
}

function resolveStatic(publicDir: string, pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined; // 畸形百分号编码（如 /%ZZ）→ 404，不是 500
  }
  const rel = decoded === "/" ? "index.html" : decoded.replace(/^\/+/u, "");
  const base = path.resolve(publicDir);
  const target = path.resolve(base, rel);
  if (target === base) return path.join(base, "index.html");
  if (!target.startsWith(base + path.sep)) return undefined;
  return target;
}

function roomExists(ws: Workspace, relation: Relation): boolean {
  return relation.kind === "dm"
    ? fs.existsSync(employeeDir(ws, relation.employeeId))
    : fs.existsSync(projectDir(ws, relation.project));
}

async function handleRooms(
  deps: ServerDeps,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  rawKey: string,
  rest: string[],
): Promise<void> {
  let roomKey: string;
  try {
    roomKey = decodeURIComponent(rawKey);
  } catch {
    json(res, 404, { error: "房间不存在" });
    return;
  }
  const relation = parseRoomKey(roomKey);
  const harness = deps.getHarness();
  const config = deps.getConfig();
  if (relation === undefined || harness === undefined || config === undefined || !roomExists(deps.ws, relation)) {
    json(res, 404, { error: "房间不存在" });
    return;
  }
  const defaults = { model: config.model };
  // 群聊归一化需要成员表（判定 @ 对象是否有效、决定“视为发给老板”的兜底）。
  const memberIds = relation.kind === "group" ? parseMembers(deps.ws, relation.project) : [];

  if (rest.length === 1 && rest[0] === "messages" && method === "GET") {
    const members = await roomTranscripts(deps.ws, harness, relation);
    json(res, 200, { roomKey, messages: mergeRoomMessages(roomKey, members, memberIds) });
    return;
  }

  if (rest.length === 1 && rest[0] === "messages" && method === "POST") {
    const body = (await readJsonBody(req)) as { text?: unknown; requestId?: unknown } | undefined;
    const text = typeof body?.text === "string" ? body.text : "";
    if (text.trim() === "") {
      json(res, 400, { error: "消息不能为空" });
      return;
    }
    const requestId = typeof body?.requestId === "string" && body.requestId !== "" ? body.requestId : undefined;
    try {
      const result = await sendToRoom(deps.ws, harness, relation, text, {
        queue: deps.queue,
        defaults,
        ...(requestId === undefined ? {} : { requestId }),
      });
      for (const delivery of result.deliveries) {
        // best-effort：消息已落盘，订阅缺失由重启扫描兜底；pump 故障不得把已 admitted 的发送变成 500。
        try {
          await deps.pump?.register(delivery.convId, { roomKey, memberId: delivery.memberId });
        } catch {
          // 忽略：见上
        }
      }
      json(res, 202, result);
    } catch (error) {
      if (error instanceof EmptyGroupError || error instanceof NoTargetsError) {
        json(res, 400, { error: error.message });
        return;
      }
      throw error;
    }
    return;
  }

  if (rest.length === 1 && rest[0] === "new-session" && method === "POST") {
    const body = (await readJsonBody(req)) as { memberId?: unknown } | undefined;
    let speakerId: string;
    if (relation.kind === "dm") {
      speakerId = relation.employeeId;
    } else {
      const memberId = typeof body?.memberId === "string" ? body.memberId : "";
      if (!parseMembers(deps.ws, relation.project).includes(memberId)) {
        json(res, 400, { error: "memberId 必须是该群成员" });
        return;
      }
      speakerId = memberId;
    }
    const old = activeMemberSessions(deps.ws, relation).find((s) => s.memberId === speakerId);
    if (old !== undefined) await deps.pump?.unregister(old.convId);
    const convId = await newSession(deps.ws, harness, relation, speakerId, defaults);
    // best-effort：会话已建；订阅缺失由重启扫描兜底，pump 故障不得改变"新开会话成功"的语义（响应仍返回 convId）。
    try {
      await deps.pump?.register(convId, { roomKey, memberId: speakerId });
    } catch {
      // 忽略：见上
    }
    json(res, 200, { convId });
    return;
  }

  if (rest.length === 1 && rest[0] === "interrupt" && method === "POST") {
    json(res, 200, await interruptRoom(deps.ws, harness, relation));
    return;
  }

  if (rest.length === 1 && rest[0] === "read" && method === "POST") {
    const members = await roomTranscripts(deps.ws, harness, relation);
    const merged = mergeRoomMessages(roomKey, members, memberIds);
    const max = merged.reduce((acc, m) => Math.max(acc, Number(m.entryId)), 0);
    if (max > 0) markSeen(deps.ws, roomKey, String(max));
    const count = countUnread(merged, readSeen(deps.ws).seen[roomKey]);
    deps.hub?.broadcast({ type: "room.unread", roomKey, count });
    json(res, 200, { ok: true });
    return;
  }

  if (rest.length === 1 && rest[0] === "sessions" && method === "GET") {
    json(res, 200, { chains: sessionChains(deps.ws, relation) });
    return;
  }

  if (rest.length === 3 && rest[0] === "sessions" && rest[2] === "messages" && method === "GET") {
    let convId: string;
    try {
      convId = decodeURIComponent(rest[1]!);
    } catch {
      json(res, 404, { error: "房间不存在" });
      return;
    }
    const owner = findSessionOwner(deps.ws, relation, convId);
    if (owner === undefined) {
      json(res, 404, { error: "会话不存在" });
      return;
    }
    let alias: string | undefined;
    try {
      alias = loadEmployee(deps.ws, owner).alias;
    } catch {
      alias = undefined;
    }
    const messages = mergeRoomMessages(roomKey, [
      { memberId: owner, ...(alias === undefined ? {} : { alias }), convId, messages: await harness.transcript(convId) },
    ], memberIds);
    json(res, 200, { convId, memberId: owner, messages });
    return;
  }

  json(res, 404, { error: "接口不存在" });
}

export function createHttpServer(deps: ServerDeps): http.Server {
  return http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const segments = url.pathname.split("/").filter((part) => part !== "");
        const method = req.method ?? "GET";

        if (segments[0] === "api") {
          const config = deps.getConfig();
          if (segments[1] === "status" && method === "GET") {
            json(res, 200, {
              configured: config !== undefined,
              root: deps.ws.root,
              port: deps.port,
              ...(config === undefined ? {} : { model: config.model, providers: Object.keys(config.providers) }),
            });
            return;
          }
          if (config === undefined) {
            json(res, 409, { error: "尚未配置：请编辑 .openstaffs/config.json 后重启服务" });
            return;
          }
          if (segments[1] === "events" && method === "GET") {
            if (deps.hub === undefined) {
              json(res, 503, { error: "推流未启用" });
              return;
            }
            deps.hub.add(req, res);
            return;
          }
          const harness = deps.getHarness();
          if (segments[1] === "employees" && method === "GET") {
            json(
              res,
              200,
              listEmployees(deps.ws).map((employee) => ({
                id: employee.id,
                ...(employee.alias === undefined ? {} : { alias: employee.alias }),
                model: formatModelRef(resolveEmployeeModel(config.model, employee.model)),
              })),
            );
            return;
          }
          if (segments[1] === "projects" && method === "GET") {
            json(
              res,
              200,
              listProjects(deps.ws).map((project) => ({
                id: project.id,
                alias: project.alias,
                members: memberSummaries(deps.ws, project.id),
              })),
            );
            return;
          }
          if (segments[1] === "rooms" && segments[2] !== undefined && harness !== undefined) {
            await handleRooms(deps, req, res, method, segments[2], segments.slice(3));
            return;
          }
          if (segments[1] === "unread" && method === "GET" && harness !== undefined) {
            const rooms: { key: string; messages: ReturnType<typeof mergeRoomMessages> }[] = [];
            for (const employee of listEmployees(deps.ws)) {
              const key = `dm:${employee.id}`;
              rooms.push({ key, messages: mergeRoomMessages(key, await roomTranscripts(deps.ws, harness, { kind: "dm", employeeId: employee.id })) });
            }
            for (const project of listProjects(deps.ws)) {
              const key = `group:${project.id}`;
              rooms.push({ key, messages: mergeRoomMessages(key, await roomTranscripts(deps.ws, harness, { kind: "group", project: project.id })) });
            }
            json(res, 200, unreadCounts(rooms, readSeen(deps.ws)));
            return;
          }
          json(res, 404, { error: "接口不存在" });
          return;
        }

        // 静态文件（GET/HEAD）
        if (method !== "GET" && method !== "HEAD") {
          json(res, 405, { error: "方法不允许" });
          return;
        }
        const target = resolveStatic(deps.publicDir, url.pathname);
        if (target === undefined || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
          json(res, 404, { error: "文件不存在" });
          return;
        }
        res.writeHead(200, { "content-type": MIME[path.extname(target)] ?? "application/octet-stream" });
        const stream = fs.createReadStream(target);
        stream.on("error", () => {
          if (res.headersSent) res.destroy();
          else json(res, 500, { error: "文件读取失败" });
        });
        stream.pipe(res);
      } catch (error) {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    })();
  });
}
