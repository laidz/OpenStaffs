import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { loadProjectConfig } from "../config/load.ts";
import { listProjects } from "../domain/project.ts";
import { parseMembers } from "../domain/access-control.ts";
import { bossNamesFor, formatModelRef, readBossName, resolveEmployeeModel, type WorkspaceConfig } from "../domain/config.ts";
import type { McpSessionResolver } from "../domain/mcp.ts";
import { findPerson, loadOrg, type OrgDepartment, type OrgTree } from "../domain/org.ts";
import type { Workspace } from "../domain/paths.ts";
import { parseRoomKey, roomMessagesOfTranscript, toRoomMessage, type RoomMessage } from "../app/rooms.ts";
import { messageKey, pinCounts, readPins, setPin } from "../app/pins.ts";
import { Outbox, queuedItemView } from "../app/outbox.ts";
import {
  findSessionOwner, interruptRoom, roomSessionInfo, sessionChains, sessionDefaults, type Relation,
} from "../app/conversations.ts";
import { EmptyGroupError, KeyedQueue, NoTargetsError, sendToRoom } from "../app/send.ts";
import type { PermissionRequestStore } from "../domain/permission-requests.ts";
import { permissionRequestView, resolvePermissionRequest, PermissionRequestNotFoundError } from "../app/permission-flow.ts";
import type { MessageStore } from "../store/messages.ts";
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
  /** 自有消息库（P1）：全进程唯一实例，由 main.ts 创建并注入；老板发消息时落一行。 */
  store: MessageStore;
  publicDir: string;
  /** 实际监听端口（启动参数 / config / 默认值解析后的结果）；status 展示用。 */
  port: number;
  pump?: PumpLike;
  hub?: SseHub;
  /** 待发表（排队中的老板消息）：与 Pump 共享同一实例；缺省自建（则只服务本服务器的展示与撤回）。 */
  outbox?: Outbox;
  /** 授权请求存储（装配层注入；缺省时相关端点降级）。 */
  permissionRequests?: PermissionRequestStore;
  /** MCP 扩展选择（发送 / 授权结果投递时装配新会话）。 */
  mcp?: McpSessionResolver;
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

type OrgPersonJson = { id: string; alias?: string; model: string };
type OrgDeptJson = { path: string; name: string; people: OrgPersonJson[]; departments: OrgDeptJson[] };

/** 部门 → 视图：展示名 = department.config.json 的 alias，根部门兜底「办公室」。 */
function orgDeptView(config: WorkspaceConfig, dept: OrgDepartment): OrgDeptJson {
  return {
    path: dept.path,
    name: dept.path === "" ? (dept.alias ?? "办公室") : (dept.alias ?? dept.name),
    people: dept.people.map((person) => ({
      id: person.id,
      ...(person.alias === undefined ? {} : { alias: person.alias }),
      model: formatModelRef(resolveEmployeeModel(config.model, person.model)),
    })),
    departments: dept.departments.map((child) => orgDeptView(config, child)),
  };
}

function memberSummaries(ws: Workspace, tree: OrgTree, project: string): { id: string; alias?: string }[] {
  return parseMembers(ws, project).map((id) => {
    const person = findPerson(tree, id);
    return { id, ...(person?.alias === undefined ? {} : { alias: person.alias }) };
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
    ? findPerson(loadOrg(ws), relation.employeeId) !== undefined // dm 分支 P2 已落地，保持不动
    : loadProjectConfig(ws, relation.project) !== undefined; // 仅群聊分支改判扁平 config
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
  const defaults = sessionDefaults(config)!;
  // 群聊归一化需要成员表（判定 @ 对象是否有效、决定“视为发给老板”的兜底）。
  const memberIds = relation.kind === "group" ? parseMembers(deps.ws, relation.project) : [];
  const bossNames = bossNamesFor(deps.ws);
  const bossName = readBossName(deps.ws);

  if (rest.length === 1 && rest[0] === "messages" && method === "GET") {
    // 房间视图改读自有消息库（P1）：一次投递 = 一行，按 seq 排序；不再合并各成员 transcript。
    // 仍在排队的库行回填 roomMessageId（与 SSE 广播同口径）：刷新 / 换标签页 / 首次进房时，
    // 前端「排队中」占位据此贴到真气泡上，不出「真气泡 + 灰占位」两条；没有排队的库行不带。
    const queuedByStoreSeq = outbox.roomMessageIdByStoreSeq(roomKey);
    const messages = deps.store.listByRoom(roomKey).map((m) => {
      const view = toRoomMessage(m, bossName, deps.ws);
      const roomMessageId = queuedByStoreSeq.get(m.seq);
      return roomMessageId === undefined ? view : { ...view, roomMessageId };
    });
    // pinned 只回当前视图里可见的 pin（与红点口径一致）：前端据此高亮，条数即红点数。
    const pinnedKeys = new Set(readPins(deps.ws).pins[roomKey] ?? []);
    const pinned = messages.filter((m) => pinnedKeys.has(messageKey(m))).map(messageKey);
    // queued：还没投递给员工的老板消息（排队中）；刷新 / 重连 / 换标签页都能拿到真值。
    json(res, 200, { roomKey, messages, pinned, queued: outbox.list(roomKey).map(queuedItemView) });
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
        store: deps.store,
        defaults,
        newSession,
        ...(deps.mcp === undefined ? {} : { mcp: deps.mcp }),
        ...(requestId === undefined ? {} : { requestId }),
      });
      // 老板发言的实时气泡：广播刚落的库行（键 store:<seq>，与 GET 房间视图 / pin 校验同源）。
      // 不靠各成员会话回显（user 条目已不广播）→ 一句 N 投 = 1 条气泡，pin 也能点。
      // 另附一个**仅 UI 用**的 roomMessageId 副本（不入库，R-P1-11）：前端「排队中」占位据此贴到这条真气泡上
      // （web/render.ts 按 roomMessageId 匹配）。GET 返回的库行默认不带；但仍在排队的那条由 outbox 回填同一 roomMessageId
      // （见 GET 分支），故刷新 / 换标签页也与实时广播同口径、不出重复气泡。
      if (result.recorded !== undefined) {
        deps.hub?.broadcast({
          type: "room.message",
          roomKey,
          message: { ...toRoomMessage(result.recorded, bossName, deps.ws), roomMessageId: result.roomMessageId },
        });
      }
      for (const delivery of result.deliveries) {
        // 排队中（员工在跑）：记进待发表 + 广播，前端在消息区显示「排队中」并允许单条撤回。
        // storeSeq 记下这次发送落的库行 seq：GET 房间时据此把排队标识贴回真气泡（无库行 = 0，永不命中）。
        if (delivery.status === "queued") {
          const item = outbox.add({
            submissionId: delivery.submissionId,
            roomKey,
            memberId: delivery.memberId,
            roomMessageId: result.roomMessageId,
            storeSeq: result.recorded?.seq ?? 0,
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
    const messages = deps.store.listByRoom(roomKey).map((m) => toRoomMessage(m, bossName, deps.ws));
    // 只允许 pin 房间视图里真实存在的消息：防止前端 bug 往 pin 存储里塞垃圾键。
    if (!messages.some((m) => m.convId === convId && m.entryId === entryId)) {
      json(res, 404, { error: "消息不存在" });
      return;
    }
    const state = setPin(deps.ws, roomKey, `${convId}:${entryId}`, body.pinned);
    const count = pinCounts([{ key: roomKey, messages }], state).rooms[roomKey] ?? 0;
    deps.hub?.broadcast({ type: "room.pins", roomKey, count });
    json(res, 200, { ok: true, count });
    return;
  }

  if (rest.length === 2 && rest[0] === "sessions" && rest[1] === "info" && method === "GET") {
    json(res, 200, { sessions: await roomSessionInfo(deps.ws, harness, relation) });
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
    const alias = findPerson(loadOrg(deps.ws), owner)?.alias;
    const messages = roomMessagesOfTranscript(roomKey, {
      memberId: owner, ...(alias === undefined ? {} : { alias }), convId, messages: await harness.transcript(convId),
    }, memberIds, bossNames);
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
            json(res, 409, { error: "尚未配置：请编辑 openstaffs/.data/config.json 后重启服务" });
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
          if (segments[1] === "org" && method === "GET") {
            json(res, 200, { root: orgDeptView(config, loadOrg(deps.ws).root) });
            return;
          }
          if (segments[1] === "projects" && method === "GET") {
            const tree = loadOrg(deps.ws);
            json(
              res,
              200,
              listProjects(deps.ws).map((project) => ({
                id: project.id,
                alias: project.alias,
                members: memberSummaries(deps.ws, tree, project.id),
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
                    messages: deps.store,
                    queue: deps.queue,
                    defaults: sessionDefaults(config)!,
                    ...(deps.mcp === undefined ? {} : { mcp: deps.mcp }),
                    ...(deps.pump === undefined ? {} : { register: (convId, ref) => deps.pump!.register(convId, ref) }),
                    ...(deps.hub === undefined ? {} : { broadcast: (rid) => deps.hub!.broadcast({ type: "permission.resolved", id: rid }) }),
                    ...(deps.hub === undefined ? {} : { broadcastMessage: (roomKey, message) => deps.hub!.broadcast({ type: "room.message", roomKey, message }) }),
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
            const bossName = readBossName(deps.ws);
            const rooms: { key: string; messages: RoomMessage[] }[] = [];
            for (const person of loadOrg(deps.ws).people) {
              const key = `dm:${person.id}`;
              rooms.push({ key, messages: deps.store.listByRoom(key).map((m) => toRoomMessage(m, bossName, deps.ws)) });
            }
            for (const project of listProjects(deps.ws)) {
              const key = `group:${project.id}`;
              rooms.push({ key, messages: deps.store.listByRoom(key).map((m) => toRoomMessage(m, bossName, deps.ws)) });
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
