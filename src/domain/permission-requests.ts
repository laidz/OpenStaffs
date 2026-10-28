import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stateDir, type Workspace } from "./paths.ts";

/** 一条待处理的授权申请（落盘于 openstaffs/.data/permission-requests.json）。 */
export type PermissionRequest = {
  id: string;         // "pr_" + uuid
  agentId: string;    // 发起者（= 授权受益者）
  meetingId: string;  // 来源会议（框架自持的会话身份）
  /** 要申请的工具权限（**至少一个**，必须由发起者明确指定：write / read / bash …）。 */
  tools: string[];
  paths: string[];    // 绝对路径（≥1 条）
  reason: string;     // 简短理由（非空）
  createdAt: string;  // ISO
};

export function requestsFile(ws: Workspace): string {
  return path.join(stateDir(ws), "permission-requests.json");
}

/** 工具名归一：去空白、去重、丢掉非字符串与空串。 */
export function normalizeTools(input: unknown): string[] {
  const list = Array.isArray(input) ? input : typeof input === "string" ? [input] : [];
  const out = list
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  return [...new Set(out)];
}

/** 路径集合键（顺序无关）。 */
function pathsKey(paths: string[]): string {
  return [...paths].sort().join("\u0000");
}

/**
 * 一条落盘记录 → 请求对象；坏条目返回 undefined。
 * 旧档兼容：只有 `tool`（单值）或无 `tool`（历史上等价 write）时归一成 `tools`，
 * 避免升级后老板还没处理的旧请求丢失；**新请求必须显式给 tools**（工具层校验）。
 */
function parseRequest(value: unknown): PermissionRequest | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const entry = value as Record<string, unknown>;
  const rawTools = entry.tools ?? entry.tool;
  const tools = normalizeTools(rawTools);
  // 旧档没有 tools 时：historically 等价 write（含 tool 写成空串的坏档）——只在读盘兼容时兜底。
  const legacyTools = tools.length === 0 && entry.tools === undefined ? ["write"] : tools;
  if (
    typeof entry.id !== "string" || entry.id === "" ||
    typeof entry.agentId !== "string" || entry.agentId === "" ||
    typeof entry.meetingId !== "string" || entry.meetingId === "" ||
    legacyTools.length === 0 ||
    !Array.isArray(entry.paths) || entry.paths.length === 0 || !entry.paths.every((p) => typeof p === "string" && p !== "") ||
    typeof entry.reason !== "string" ||
    typeof entry.createdAt !== "string"
  ) {
    return undefined;
  }
  return {
    id: entry.id,
    agentId: entry.agentId,
    meetingId: entry.meetingId,
    tools: legacyTools,
    paths: [...(entry.paths as string[])],
    reason: entry.reason,
    createdAt: entry.createdAt,
  };
}

/** 读全部请求（已归一；坏条目跳过）。不做合并——合并由 store 在加载时做一次并落盘。 */
function readRaw(ws: Workspace): PermissionRequest[] {
  let raw = "";
  try {
    raw = fs.readFileSync(requestsFile(ws), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { requests?: unknown };
    if (!Array.isArray(parsed.requests)) return [];
    return parsed.requests.map(parseRequest).filter((request): request is PermissionRequest => request !== undefined);
  } catch {
    return [];
  }
}

/**
 * 同一「人 × 会议 × 目录组」的请求合并成一条（工具取并集，理由/创建时间保留最早出现的那条）。
 * 合并键只认**完全相同的路径集合**（顺序无关）；目录不同就是不同申请。
 */
function coalesce(requests: PermissionRequest[]): PermissionRequest[] {
  const out: PermissionRequest[] = [];
  const byKey = new Map<string, PermissionRequest>();
  for (const request of requests) {
    const key = `${request.agentId}\u0000${request.meetingId}\u0000${pathsKey(request.paths)}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, request);
      out.push(request);
      continue;
    }
    const known = new Set(existing.tools);
    const added = request.tools.filter((tool) => !known.has(tool));
    if (added.length > 0) existing.tools = [...existing.tools, ...added];
  }
  return out;
}

/** 读请求列表：缺失/坏 JSON → []；旧档 `tool` 归一成 `tools`；同人同会议的重复请求已合并。 */
export function readPermissionRequests(ws: Workspace): PermissionRequest[] {
  return coalesce(readRaw(ws));
}

/** 同一 agent + 同一会议 + 同一路径集合的待处理请求（合并目标）。 */
export function findMergeTarget(
  requests: PermissionRequest[],
  agentId: string,
  meetingId: string,
  paths: string[],
): PermissionRequest | undefined {
  const key = pathsKey(paths);
  return requests.find(
    (request) => request.agentId === agentId && request.meetingId === meetingId && pathsKey(request.paths) === key,
  );
}

function writePermissionRequests(ws: Workspace, requests: PermissionRequest[]): void {
  fs.mkdirSync(stateDir(ws), { recursive: true });
  const file = requestsFile(ws);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ requests }, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export type AddPermissionRequestResult = {
  request: PermissionRequest;
  /** 命中了同目录的待处理请求（没有新建卡片）。 */
  merged: boolean;
  /** 这次真正并进去的新工具（`merged` 且为空 = 完全重复的申请）。 */
  addedTools: string[];
};

/** 内存单例：启动时 load 一次；add/remove 同步改内存并落盘（fs 同步调用，进程内无交错）。 */
export class PermissionRequestStore {
  readonly #ws: Workspace;
  #requests: PermissionRequest[];

  constructor(ws: Workspace) {
    this.#ws = ws;
    const raw = readRaw(ws);
    this.#requests = coalesce(raw);
    // 升级前留下的重复请求（同人同会议同目录）在启动时合并掉，别让老板一次点好几张卡。
    if (this.#requests.length !== raw.length) this.#persist();
  }

  list(): PermissionRequest[] {
    return [...this.#requests];
  }

  get(id: string): PermissionRequest | undefined {
    return this.#requests.find((request) => request.id === id);
  }

  findMergeTarget(agentId: string, meetingId: string, paths: string[]): PermissionRequest | undefined {
    return findMergeTarget(this.#requests, agentId, meetingId, paths);
  }

  /**
   * 发起申请。`tools` **必填**（至少一个）；同人 + 同会议 + 同目录组的已有请求会被合并
   * （工具取并集、仍是一张卡），完全相同的重复申请不产生任何变化。
   */
  add(input: { agentId: string; meetingId: string; tools: string[]; paths: string[]; reason: string }): AddPermissionRequestResult {
    const tools = normalizeTools(input.tools);
    if (tools.length === 0) throw new Error("tools 不能为空：必须明确要哪种权限（write / read / bash）");
    const target = this.findMergeTarget(input.agentId, input.meetingId, input.paths);
    if (target !== undefined) {
      const known = new Set(target.tools);
      const addedTools = tools.filter((tool) => !known.has(tool));
      if (addedTools.length > 0) {
        target.tools = [...target.tools, ...addedTools];
        this.#persist();
      }
      return { request: target, merged: true, addedTools };
    }
    const request: PermissionRequest = {
      id: `pr_${randomUUID()}`,
      agentId: input.agentId,
      meetingId: input.meetingId,
      tools,
      paths: [...input.paths],
      reason: input.reason,
      createdAt: new Date().toISOString(),
    };
    this.#requests = [request, ...this.#requests];
    this.#persist();
    return { request, merged: false, addedTools: tools };
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
