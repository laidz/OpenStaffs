// src/domain/memory/store.ts —— 记忆的磁盘层：路径、扫描、增删改、新鲜度侧车、profile。
// 全部同步 IO：单进程内一次工具调用不会读到半截文件；写入走「临时文件 + rename」。
import fs from "node:fs";
import path from "node:path";
import { workDir, type Workspace } from "../paths.ts";
import { memSlug, nowIso, parseFrontmatter, serializeEntity, validateMeta } from "./frontmatter.ts";
import { PROFILE_FILE, PROFILE_MAX_BYTES, type MemEntity, type MemMeta } from "./types.ts";

/** id 只允许字母 / 数字 / 连字符（中文按字母算）。 */
const ID_PATTERN = /^[\p{L}\p{N}-]+$/u;

export function memoryDir(ws: Workspace, agentId: string): string {
  return path.join(workDir(ws, agentId), "memory");
}

export function profileFile(ws: Workspace, agentId: string): string {
  return path.join(memoryDir(ws, agentId), PROFILE_FILE);
}

export function entityFile(ws: Workspace, agentId: string, id: string): string {
  return path.join(memoryDir(ws, agentId), `${id}.md`);
}

export function archiveDir(ws: Workspace, agentId: string): string {
  return path.join(memoryDir(ws, agentId), "archive");
}

export function archiveFile(ws: Workspace, agentId: string, id: string): string {
  return path.join(archiveDir(ws, agentId), `${id}.md`);
}

export function stateFile(ws: Workspace, agentId: string): string {
  return path.join(memoryDir(ws, agentId), ".state.json");
}

export function gitignoreFile(ws: Workspace, agentId: string): string {
  return path.join(memoryDir(ws, agentId), ".gitignore");
}

export type LoadResult = { entities: MemEntity[]; errors: { file: string; error: string }[] };
export type LastUsed = Record<string, string>;

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

function assertId(id: string): string {
  const trimmed = id.trim();
  if (trimmed === "" || trimmed === "." || trimmed === ".." || !ID_PATTERN.test(trimmed)) {
    throw new Error(`非法记忆 id：${id}`);
  }
  return trimmed;
}

function ensureGitignore(ws: Workspace, agentId: string): void {
  const file = gitignoreFile(ws, agentId);
  if (fs.existsSync(file)) return;
  writeAtomic(file, ".state.json\n");
}

/** 扫一个员工的记忆目录；坏文件跳过并收集错误，不抛。 */
export function loadMemory(ws: Workspace, agentId: string): LoadResult {
  const dir = memoryDir(ws, agentId);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { entities: [], errors: [] };
  }
  const entities: MemEntity[] = [];
  const errors: { file: string; error: string }[] = [];
  for (const name of names.filter((n) => n.endsWith(".md") && !n.startsWith(".") && n !== PROFILE_FILE && n !== "AGENTS.md").sort()) {
    const id = name.slice(0, -3);
    if (!ID_PATTERN.test(id)) {
      errors.push({ file: name, error: `非法 id：${id}` });
      continue;
    }
    try {
      const parsed = parseFrontmatter(readText(path.join(dir, name)));
      if (parsed.error !== undefined) {
        errors.push({ file: name, error: parsed.error });
        continue;
      }
      const errs = validateMeta(parsed.meta ?? {}, id);
      if (errs.length > 0) {
        errors.push({ file: name, error: errs.join("；") });
        continue;
      }
      const meta = parsed.meta as MemMeta;
      entities.push({
        id,
        title: meta.title,
        description: meta.description,
        pinned: meta.pinned === true,
        created: meta.created ?? "",
        updated: meta.updated ?? "",
        body: parsed.body ?? "",
        path: path.join(dir, name),
      });
    } catch (error) {
      errors.push({ file: name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { entities, errors };
}

export function findEntity(ws: Workspace, agentId: string, id: string): MemEntity | undefined {
  return loadMemory(ws, agentId).entities.find((entity) => entity.id === id);
}

export function readState(ws: Workspace, agentId: string): LastUsed {
  try {
    const data = JSON.parse(readText(stateFile(ws, agentId))) as { lastUsed?: unknown };
    const raw = data.lastUsed;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    const out: LastUsed = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function writeState(ws: Workspace, agentId: string, state: LastUsed): void {
  writeAtomic(stateFile(ws, agentId), `${JSON.stringify({ version: 1, lastUsed: state }, null, 2)}\n`);
}

export function touch(ws: Workspace, agentId: string, id: string, at = nowIso()): void {
  const state = readState(ws, agentId);
  state[id] = at;
  writeState(ws, agentId, state);
}

export function forgetState(ws: Workspace, agentId: string, id: string): void {
  const state = readState(ws, agentId);
  delete state[id];
  writeState(ws, agentId, state);
}

export function readProfile(ws: Workspace, agentId: string): string {
  return readText(profileFile(ws, agentId)).trim();
}

/** 整体重写 profile；返回写入字节数。 */
export function writeProfile(ws: Workspace, agentId: string, body: string): number {
  const text = body.trim();
  if (text === "") throw new Error("profile 正文不能为空");
  const bytes = Buffer.byteLength(text);
  if (bytes > PROFILE_MAX_BYTES) {
    throw new Error(`profile 正文 ${bytes} 字节，超过上限 ${PROFILE_MAX_BYTES}；请把细节拆到普通记忆`);
  }
  ensureGitignore(ws, agentId);
  writeAtomic(profileFile(ws, agentId), `${text}\n`);
  return bytes;
}

export type CreateInput = { title: string; description: string; body: string; pinned?: boolean };

export function createEntity(ws: Workspace, agentId: string, input: CreateInput): MemEntity {
  const title = input.title.trim();
  const description = input.description.trim();
  const body = input.body.trim();
  if (body === "") throw new Error("正文不能为空");
  const base = memSlug(title);
  if (base === "") throw new Error("标题无法生成合法 id，请换个标题");
  // `profile.md` 是常驻记忆的保留文件名，不能被实体占用。
  const taken = (candidate: string) =>
    candidate === "profile" || fs.existsSync(entityFile(ws, agentId, candidate));
  let id = base;
  for (let n = 2; taken(id); n++) id = `${base}-${n}`;
  const now = nowIso();
  const meta: MemMeta = {
    id,
    title,
    description,
    pinned: input.pinned ?? false,
    created: now,
    updated: now,
  };
  const errs = validateMeta(meta, id);
  if (errs.length > 0) throw new Error(errs.join("；"));
  ensureGitignore(ws, agentId);
  const file = entityFile(ws, agentId, id);
  writeAtomic(file, serializeEntity(meta, body));
  touch(ws, agentId, id, now);
  return { ...meta, body, path: file };
}

export type UpdateInput = {
  title?: string;
  description?: string;
  body?: string;
  append?: string;
  pinned?: boolean;
};

export function updateEntity(ws: Workspace, agentId: string, rawId: string, patch: UpdateInput): MemEntity {
  const id = assertId(rawId);
  const changed =
    patch.title !== undefined ||
    patch.description !== undefined ||
    patch.body !== undefined ||
    patch.append !== undefined ||
    patch.pinned !== undefined;
  if (!changed) throw new Error("没有要更新的内容");
  if (patch.body !== undefined && patch.append !== undefined) throw new Error("body 与 append 不能同时使用");
  const current = findEntity(ws, agentId, id);
  if (current === undefined) throw new Error(`找不到记忆：${id}`);
  const now = nowIso();
  let body = patch.body !== undefined ? patch.body.trim() : current.body;
  if (patch.append !== undefined) {
    const extra = patch.append.trim();
    if (extra === "") throw new Error("append 不能为空");
    body = body === "" ? extra : `${body}\n${extra}`;
  }
  if (body === "") throw new Error("正文不能为空");
  const meta: MemMeta = {
    id,
    title: (patch.title ?? current.title).trim(),
    description: (patch.description ?? current.description).trim(),
    pinned: patch.pinned ?? current.pinned,
    created: current.created === "" ? now : current.created,
    updated: now,
  };
  const errs = validateMeta(meta, id);
  if (errs.length > 0) throw new Error(errs.join("；"));
  const file = entityFile(ws, agentId, id);
  writeAtomic(file, serializeEntity(meta, body));
  touch(ws, agentId, id, now);
  return { ...meta, body, path: file };
}

/** 归档删除；返回归档路径。pinned 必须先取消置顶。 */
export function removeEntity(ws: Workspace, agentId: string, rawId: string): string {
  const id = assertId(rawId);
  const current = findEntity(ws, agentId, id);
  if (current === undefined) throw new Error(`找不到记忆：${id}`);
  if (current.pinned) throw new Error(`记忆 ${id} 已置顶，请先用 memory_update 取消置顶再删除`);
  fs.mkdirSync(archiveDir(ws, agentId), { recursive: true });
  let target = archiveFile(ws, agentId, id);
  if (fs.existsSync(target)) {
    const stamp = nowIso().slice(0, 19).replace(/[-:T]/g, "");
    target = path.join(archiveDir(ws, agentId), `${id}-${stamp}.md`);
  }
  fs.renameSync(current.path, target);
  forgetState(ws, agentId, id);
  return target;
}
