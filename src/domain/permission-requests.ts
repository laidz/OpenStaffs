import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stateDir, type Workspace } from "./paths.ts";

/** 一条待处理的授权申请（落盘于 openstaffs/.data/permission-requests.json）。 */
export type PermissionRequest = {
  id: string;         // "pr_" + uuid
  agentId: string;    // 发起者（= 授权受益者）
  roomKey: string;    // 来源房间：dm:<员工id> | group:<项目id>
  /** 权限工具名（缺省 "write"；D9 按工具：write / read / bash 各一张路径表）。 */
  tool?: string;
  paths: string[];    // 绝对路径（≥1 条）
  reason: string;     // 简短理由（非空）
  createdAt: string;  // ISO
};

export function requestsFile(ws: Workspace): string {
  return path.join(stateDir(ws), "permission-requests.json");
}

function isValidRequest(value: unknown): value is PermissionRequest {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" && entry.id !== "" &&
    typeof entry.agentId === "string" && entry.agentId !== "" &&
    typeof entry.roomKey === "string" && entry.roomKey !== "" &&
    (entry.tool === undefined || typeof entry.tool === "string") &&
    Array.isArray(entry.paths) && entry.paths.length > 0 && entry.paths.every((p) => typeof p === "string" && p !== "") &&
    typeof entry.reason === "string" &&
    typeof entry.createdAt === "string"
  );
}

/** 读请求列表：缺失/坏 JSON → []；坏条目跳过（不崩溃、不阻主流程）。 */
export function readPermissionRequests(ws: Workspace): PermissionRequest[] {
  let raw = "";
  try {
    raw = fs.readFileSync(requestsFile(ws), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { requests?: unknown };
    if (!Array.isArray(parsed.requests)) return [];
    return parsed.requests.filter(isValidRequest);
  } catch {
    return [];
  }
}

/** 路径集合键（顺序无关）。 */
function pathsKey(paths: string[]): string {
  return [...paths].sort().join("\u0000");
}

/** 权限工具名归一：缺省 / 空串（或纯空白）→ `"write"`（D9 按工具；旧档无 `tool` 字段等价于 write）。 */
export function normalizeTool(tool: string | undefined): string {
  const key = tool?.trim();
  return key === undefined || key === "" ? "write" : key;
}

/** 同一 agent + 同一工具 + 同一路径集合的已有请求（重复申请判定；工具不同 = 不同申请）。 */
export function findDuplicate(
  requests: PermissionRequest[],
  agentId: string,
  paths: string[],
  tool?: string,
): PermissionRequest | undefined {
  const key = pathsKey(paths);
  const wanted = normalizeTool(tool);
  return requests.find(
    (request) =>
      request.agentId === agentId && normalizeTool(request.tool) === wanted && pathsKey(request.paths) === key,
  );
}

function writePermissionRequests(ws: Workspace, requests: PermissionRequest[]): void {
  fs.mkdirSync(stateDir(ws), { recursive: true });
  const file = requestsFile(ws);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ requests }, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** 内存单例：启动时 load 一次；add/remove 同步改内存并落盘（fs 同步调用，进程内无交错）。 */
export class PermissionRequestStore {
  readonly #ws: Workspace;
  #requests: PermissionRequest[];

  constructor(ws: Workspace) {
    this.#ws = ws;
    this.#requests = readPermissionRequests(ws);
  }

  list(): PermissionRequest[] {
    return [...this.#requests];
  }

  get(id: string): PermissionRequest | undefined {
    return this.#requests.find((request) => request.id === id);
  }

  findDuplicate(agentId: string, paths: string[], tool?: string): PermissionRequest | undefined {
    return findDuplicate(this.#requests, agentId, paths, tool);
  }

  /** `tool` 缺省 write（旧档无此字段，向后兼容）。 */
  add(input: { agentId: string; roomKey: string; tool?: string; paths: string[]; reason: string }): PermissionRequest {
    const request: PermissionRequest = {
      id: `pr_${randomUUID()}`,
      agentId: input.agentId,
      roomKey: input.roomKey,
      ...(input.tool === undefined ? {} : { tool: input.tool }),
      paths: [...input.paths],
      reason: input.reason,
      createdAt: new Date().toISOString(),
    };
    this.#requests = [request, ...this.#requests];
    this.#persist();
    return request;
  }

  remove(id: string): boolean {
    const before = this.#requests.length;
    this.#requests = this.#requests.filter((request) => request.id !== id);
    if (this.#requests.length === before) return false;
    this.#persist();
    return true;
  }

  #persist(): void {
    try {
      writePermissionRequests(this.#ws, this.#requests);
    } catch (error) {
      // 内存态为准：落盘失败不阻断主流程（重启后该请求可能重现/丢失，属可接受降级）。
      console.error(`[openstaffs] 授权请求落盘失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
