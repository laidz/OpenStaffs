import { readBossName } from "../domain/config.ts";
import type { McpSessionResolver } from "../domain/mcp.ts";
import { findPerson, loadOrg } from "../domain/org.ts";
import type { Workspace } from "../domain/paths.ts";
import { agentConfigFile } from "../config/naming.ts";
import { appendPermissionPaths } from "../config/write.ts";
import { loadEmployee, type Employee } from "../domain/employee.ts";
import { normalizeTool, type PermissionRequest, type PermissionRequestStore } from "../domain/permission-requests.ts";
import type { HarnessPort } from "../harness/port.ts";
import type { MessageStore } from "../store/messages.ts";
import type { SessionStore } from "../store/sessions.ts";
import type { SessionDefaults } from "./conversations.ts";
import { parseRoomKey, toRoomMessage, type RoomMessage } from "./rooms.ts";
import { sendToRoom, type KeyedQueue } from "./send.ts";

/** 请求不存在，或已在处理中（并发防重）。 */
export class PermissionRequestNotFoundError extends Error {}

/** 广播 / REST 输出用的视图（补发起者展示名）。 */
export type PermissionRequestView = PermissionRequest & { agentName: string };

export function permissionRequestView(ws: Workspace, request: PermissionRequest): PermissionRequestView {
  const alias = findPerson(loadOrg(ws), request.agentId)?.alias;
  return { ...request, agentName: alias ?? request.agentId };
}

export type PermissionFlowDeps = {
  ws: Workspace;
  harness: HarnessPort;
  store: PermissionRequestStore;
  queue: KeyedQueue;
  defaults?: SessionDefaults;
  /** MCP 扩展选择（随发送时的新会话装配）。 */
  mcp?: McpSessionResolver;
  /** 自有消息库（P1）：审批结果也是老板投递，一并落库，房间视图才看得到（缺省不落库）。 */
  messages?: MessageStore;
  /** 会话表：发送路径的唯一解析入口 `resolveSession` 需要它。 */
  sessions: SessionStore;
  /** best-effort 订阅新触发的会话（与 HTTP 发送同口径）。 */
  register?: (convId: string, ref: { roomKey: string; memberId: string }) => Promise<void>;
  /** 处理完成广播（SSE permission.resolved）。 */
  broadcast?: (id: string) => void;
  /** 房间消息广播（R-P1-12）：审批结果落库后广播库行，老板实时可见（缺省不广播）。 */
  broadcastMessage?: (roomKey: string, message: RoomMessage) => void;
};

/** 同 id 并发防重（进程内单例）。 */
const inFlight = new Set<string>();

/**
 * 处理一条授权请求：
 * accept → 把路径追加进发起者 agent config 的 `permissions[tool]`（tool 缺省 write）；随后（两种决策）以老板消息投递结果、清请求、广播。
 * 写盘失败会抛出且请求保留；投递失败不抛（授权已生效），返回带 warning 的结果。
 */
export async function resolvePermissionRequest(
  deps: PermissionFlowDeps,
  id: string,
  decision: "accept" | "reject",
): Promise<{ ok: true; warning?: string }> {
  if (inFlight.has(id)) throw new PermissionRequestNotFoundError(`授权请求不存在或已处理：${id}`);
  inFlight.add(id);
  try {
    const request = deps.store.get(id);
    if (request === undefined) throw new PermissionRequestNotFoundError(`授权请求不存在或已处理：${id}`);

    if (decision === "accept") {
      // 接受即框架/负责人代写发起者的 agent config（R-P3-11：不经过工具闸门）。
      let employee: Employee;
      try {
        employee = loadEmployee(deps.ws, request.agentId);
      } catch {
        throw new PermissionRequestNotFoundError(`发起者已不存在：${request.agentId}（可点「拒绝」清除该请求）`);
      }
      appendPermissionPaths(agentConfigFile(employee.dir, request.agentId), normalizeTool(request.tool), request.paths);
    }

    const relation = parseRoomKey(request.roomKey);
    if (relation === undefined) throw new Error(`授权请求的房间键不合法：${request.roomKey}`);
    const verb = decision === "accept" ? "已完成授权" : "已拒绝授权";
    const text = relation.kind === "group" ? `@${request.agentId} ${verb}` : verb;

    let warning: string | undefined;
    try {
      const result = await sendToRoom(deps.ws, deps.harness, relation, text, {
        queue: deps.queue,
        sessions: deps.sessions,
        ...(deps.defaults === undefined ? {} : { defaults: deps.defaults }),
        ...(deps.mcp === undefined ? {} : { mcp: deps.mcp }),
        ...(deps.messages === undefined ? {} : { store: deps.messages }),
        requestId: `permission:${id}`,
      });
      // 广播刚落的库行（R-P1-12）：审批结果是老板可见的发言，写路径自持广播（键 store:<seq>）。
      // 与 HTTP 发送同口径：附一个仅 UI 用的 roomMessageId 副本（不入库），前端「排队中」占位据此贴真气泡。
      if (result.recorded !== undefined) {
        deps.broadcastMessage?.(request.roomKey, {
          ...toRoomMessage(result.recorded, readBossName(deps.ws), deps.ws),
          roomMessageId: result.roomMessageId,
        });
      }
      for (const delivery of result.deliveries) {
        try {
          await deps.register?.(delivery.convId, { roomKey: request.roomKey, memberId: delivery.memberId });
        } catch {
          // 订阅失败不影响投递（重启扫描兜底）
        }
      }
    } catch (error) {
      // 授权已落盘：审批结果不因投递失败而回滚（对齐既有 best-effort 语义）。
      console.error(`[openstaffs] 授权结果投递失败（${id}）：${error instanceof Error ? error.message : String(error)}`);
      warning = "已完成处理，但通知消息投递失败（详见服务端日志）";
    }

    deps.store.remove(id);
    deps.broadcast?.(id);
    return warning === undefined ? { ok: true } : { ok: true, warning };
  } finally {
    inFlight.delete(id);
  }
}
