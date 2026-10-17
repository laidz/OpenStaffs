import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { listEmployees, loadEmployee } from "../domain/employee.ts";
import { listProjects } from "../domain/project.ts";
import { parseMembers } from "../domain/access-control.ts";
import { bossNamesFor, formatModelRef, readBossName, resolveEmployeeModel, type WorkspaceConfig } from "../domain/config.ts";
import { employeeDir, projectDir, type Workspace } from "../domain/paths.ts";
import { mergeRoomMessages, parseRoomKey } from "../app/rooms.ts";
import { pinCounts, readPins, setPin } from "../app/pins.ts";
import { Outbox, queuedItemView } from "../app/outbox.ts";
import {
  findSessionOwner, interruptRoom, roomTranscripts, sessionChains, type Relation,
} from "../app/conversations.ts";
import { EmptyGroupError, KeyedQueue, NoTargetsError, sendToRoom } from "../app/send.ts";
import type { PermissionRequestStore } from "../domain/permission-requests.ts";
import { permissionRequestView, resolvePermissionRequest, PermissionRequestNotFoundError } from "../app/permission-flow.ts";
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
  /** 待发表（排队中的老板消息）：与 Pump 共享同一实例；缺省自建（则只服务本服务器的展示与撤回）。 */
  outbox?: Outbox;
  /** 授权请求存储（装配层注入；缺省时相关端点降级）。 */
  permissionRequests?: PermissionRequestStore;
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
  outbox: Outbox,
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
  const bossNames = bossNamesFor(deps.ws);

  if (rest.length === 1 && rest[0] === "messages" && method === "GET") {
    const members = await roomTranscripts(deps.ws, harness, relation);
    const merged = mergeRoomMessages(roomKey, members, memberIds, bossNames);
    // pinned 只回当前视图里可见的 pin（与红点口径一致）：前端据此高亮，条数即红点数。
    const pinnedKeys = new Set(readPins(deps.ws).pins[roomKey] ?? []);
    const pinned = merged.filter((m) => pinnedKeys.has(`${m.convId}:${m.entryId}`)).map((m) => `${m.convId}:${m.entryId}`);
    // queued：还没投递给员工的老板消息（排队中）；刷新 / 重连 / 换标签页都能拿到真值。
    json(res, 200, { roomKey, messages: merged, pinned, queued: outbox.list(roomKey).map(queuedItemView) });
    return;
  }

  if (rest.length === 1 && rest[0] === "messages" && method === "POST") {
    const body = (await readJsonBody(req)) as { text?: unknown; requestId?: unknown; newSession?: unknown } | undefined;
    const text = typeof body?.text === "string" ? body.text : "";
    if (text.trim() === "") {
      json(res, 400, { error: "消息不能为空" });
      return;
    }
    const requestId = typeof body?.requestId === "string" && body.requestId !== "" ? body.requestId : undefined;
    const newSession = body?.newSession === true;
    try {
      const result = await sendToRoom(deps.ws, harness, relation, text, {
        queue: deps.queue,
        defaults,
        newSession,
        ...(requestId === undefined ? {} : { requestId }),
      });
      for (const delivery of result.deliveries) {
        // 排队中（员工在跑）：记进待发表 + 广播，前端在消息区显示「排队中」并允许单条撤回。
        if (delivery.status === "queued") {
          const item = outbox.add({
            submissionId: delivery.submissionId,
            roomKey,
            memberId: delivery.memberId,
            roomMessageId: result.roomMessageId,
            text: text.trim(),
            convId: delivery.convId,
          });
          deps.hub?.broadcast({ type: "room.queued", item: queuedItemView(item) });
        }
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

  if (rest.length === 2 && rest[0] === "queue" && rest[1] === "cancel" && method === "POST") {
    const body = (await readJsonBody(req)) as { roomMessageId?: unknown } | undefined;
    const roomMessageId = typeof body?.roomMessageId === "string" ? body.roomMessageId : "";
    if (roomMessageId === "") {
      json(res, 400, { error: "roomMessageId 必填" });
      return;
    }
    // 单条撤回 = 撤掉这条消息里所有还没开始的投递（开始投递的拦不住 —— 那是「中断」的语义）。
    const cancelled: string[] = [];
    for (const item of outbox.byRoomMessage(roomKey, roomMessageId)) {
      let ok = false;
      try {
        ok = await harness.withdrawSubmission(item.convId, item.submissionId);
      } catch {
        ok = false; // 坏会话（链指向不存在的 convId 等）：不连坐其它投递
      }
      if (!ok) continue;
      outbox.take(item.submissionId);
      cancelled.push(item.submissionId);
      deps.hub?.broadcast({ type: "room.dequeued", roomKey, submissionId: item.submissionId, reason: "cancelled" });
    }
    if (cancelled.length === 0) {
      json(res, 409, { error: "这条消息已经开始投递，撤不回了（要停住请看「中断」）" });
      return;
    }
    json(res, 200, { cancelled });
    return;
  }

  if (rest.length === 1 && rest[0] === "interrupt" && method === "POST") {
    json(res, 200, await interruptRoom(deps.ws, harness, relation));
    return;
  }

  if (rest.length === 1 && rest[0] === "pin" && method === "POST") {
    const body = (await readJsonBody(req)) as { convId?: unknown; entryId?: unknown; pinned?: unknown } | undefined;
    const convId = typeof body?.convId === "string" ? body.convId : "";
    const entryId = typeof body?.entryId === "string" ? body.entryId : "";
    if (convId === "" || entryId === "" || typeof body?.pinned !== "boolean") {
      json(res, 400, { error: "convId / entryId / pinned 必填" });
      return;
    }
    const members = await roomTranscripts(deps.ws, harness, relation);
    const merged = mergeRoomMessages(roomKey, members, memberIds, bossNames);
    // 只允许 pin 房间视图里真实存在的消息：防止前端 bug 往 pin 存储里塞垃圾键。
    if (!merged.some((m) => m.convId === convId && m.entryId === entryId)) {
      json(res, 404, { error: "消息不存在" });
      return;
    }
    const state = setPin(deps.ws, roomKey, `${convId}:${entryId}`, body.pinned);
    const count = pinCounts([{ key: roomKey, messages: merged }], state).rooms[roomKey] ?? 0;
    deps.hub?.broadcast({ type: "room.pins", roomKey, count });
    json(res, 200, { ok: true, count });
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
    ], memberIds, bossNames);
    json(res, 200, { convId, memberId: owner, messages });
    return;
  }

  json(res, 404, { error: "接口不存在" });
}

export function createHttpServer(deps: ServerDeps): http.Server {
  const outbox = deps.outbox ?? new Outbox();
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
              bossName: readBossName(deps.ws),
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
            await handleRooms(deps, outbox, req, res, method, segments[2], segments.slice(3));
            return;
          }
          if (segments[1] === "permission-requests" && harness !== undefined) {
            const store = deps.permissionRequests;
            if (segments.length === 2 && method === "GET") {
              const requests = store?.list() ?? [];
              json(res, 200, { requests: requests.map((request) => permissionRequestView(deps.ws, request)) });
              return;
            }
            if (segments.length === 4 && segments[2] !== undefined && segments[3] === "resolve" && method === "POST") {
              if (store === undefined) {
                json(res, 503, { error: "授权请求服务未启用" });
                return;
              }
              let id: string;
              try {
                id = decodeURIComponent(segments[2]);
              } catch {
                json(res, 404, { error: "授权请求不存在或已处理" });
                return;
              }
              const body = (await readJsonBody(req)) as { decision?: unknown } | undefined;
              const decision = body?.decision;
              if (decision !== "accept" && decision !== "reject") {
                json(res, 400, { error: "decision 必须是 accept 或 reject" });
                return;
              }
              try {
                const result = await resolvePermissionRequest(
                  {
                    ws: deps.ws,
                    harness,
                    store,
                    queue: deps.queue,
                    defaults: { model: config.model },
                    ...(deps.pump === undefined ? {} : { register: (convId, ref) => deps.pump!.register(convId, ref) }),
                    ...(deps.hub === undefined ? {} : { broadcast: (rid) => deps.hub!.broadcast({ type: "permission.resolved", id: rid }) }),
                  },
                  id,
                  decision,
                );
                json(res, 200, result);
              } catch (error) {
                if (error instanceof PermissionRequestNotFoundError) {
                  json(res, 404, { error: error.message });
                  return;
                }
                throw error;
              }
              return;
            }
          }
          if (segments[1] === "pins" && method === "GET" && harness !== undefined) {
            const bossNames = bossNamesFor(deps.ws);
            const rooms: { key: string; messages: ReturnType<typeof mergeRoomMessages> }[] = [];
            for (const employee of listEmployees(deps.ws)) {
              const key = `dm:${employee.id}`;
              rooms.push({ key, messages: mergeRoomMessages(key, await roomTranscripts(deps.ws, harness, { kind: "dm", employeeId: employee.id }), [], bossNames) });
            }
            for (const project of listProjects(deps.ws)) {
              const key = `group:${project.id}`;
              rooms.push({ key, messages: mergeRoomMessages(key, await roomTranscripts(deps.ws, harness, { kind: "group", project: project.id }), [], bossNames) });
            }
            json(res, 200, pinCounts(rooms, readPins(deps.ws)));
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
