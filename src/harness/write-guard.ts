// src/harness/write-guard.ts —— 同一员工多会话并行时的写冲突保护（write / edit）。
// 规则：`work/**` 下已存在的文件必须先 `read` 才能写；写时版本（大小 + 内容 hash）变了就拦。
// `bash` 无法可靠解析目标文件，不在此保护范围（文档明确说明）。
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AccessContext } from "../domain/access-control.ts";

const READ_TOOL = "read";
const WRITE_TOOLS = new Set(["write", "edit"]);
/** 预留写锁的过期时间：工具被中断 / 抛错没走到 afterTool 时不至于永久占着。 */
const RESERVE_TTL_MS = 60_000;

type Reservation = { convId: string; at: number };

function versionOf(file: string): string | undefined {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return undefined;
    const content = fs.readFileSync(file);
    return `${content.byteLength}:${createHash("sha256").update(content).digest("hex")}`;
  } catch {
    return undefined;
  }
}

export class WriteGuard {
  readonly #root: string;
  readonly #reads = new Map<string, Map<string, string>>();
  readonly #writing = new Map<string, Reservation>();

  constructor(root: string) {
    this.#root = path.resolve(root);
  }

  /** 只有 read / write / edit 且目标在 `<root>/work/` 下才参与。 */
  #target(ctx: AccessContext, name: string, args: unknown): string | undefined {
    if (name !== READ_TOOL && !WRITE_TOOLS.has(name)) return undefined;
    if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
    const raw = (args as Record<string, unknown>)["path"];
    if (typeof raw !== "string" || raw.trim() === "") return undefined;
    const target = path.resolve(ctx.cwd, raw);
    const workRoot = path.join(this.#root, "work");
    if (target !== workRoot && !target.startsWith(`${workRoot}${path.sep}`)) return undefined;
    return target;
  }

  #session(convId: string): Map<string, string> {
    let reads = this.#reads.get(convId);
    if (reads === undefined) {
      reads = new Map();
      this.#reads.set(convId, reads);
    }
    return reads;
  }

  #holderOf(target: string, convId: string, now: number): Reservation | undefined {
    const holder = this.#writing.get(target);
    if (holder === undefined) return undefined;
    if (now - holder.at > RESERVE_TTL_MS) {
      this.#writing.delete(target);
      return undefined;
    }
    return holder.convId === convId ? undefined : holder;
  }

  beforeTool(
    ctx: AccessContext,
    convId: string,
    name: string,
    args: unknown,
  ): { block: string } | undefined {
    const target = this.#target(ctx, name, args);
    if (target === undefined) return undefined;
    const reads = this.#session(convId);

    if (name === READ_TOOL) {
      const version = versionOf(target);
      if (version === undefined) reads.delete(target);
      else reads.set(target, version);
      return undefined;
    }

    const now = Date.now();
    if (this.#holderOf(target, convId, now) !== undefined) {
      return { block: "并发写保护：另一条会话正在写这个文件，请稍后重试。" };
    }
    const version = versionOf(target);
    if (version !== undefined) {
      const stamp = reads.get(target);
      if (stamp === undefined) {
        return { block: "并发写保护：写已有文件前请先用 read 读取它（避免覆盖其他会话的修改）。" };
      }
      if (stamp !== version) {
        return { block: "并发写保护：文件已被其他会话修改，请重新 read 后再写。" };
      }
    }
    this.#writing.set(target, { convId, at: now });
    return undefined;
  }

  afterTool(
    ctx: AccessContext,
    convId: string,
    name: string,
    args: unknown,
    isError: boolean,
  ): void {
    const target = this.#target(ctx, name, args);
    if (target === undefined) return;
    const reads = this.#session(convId);

    if (name === READ_TOOL) {
      if (isError) {
        reads.delete(target);
        return;
      }
      const version = versionOf(target);
      if (version === undefined) reads.delete(target);
      else reads.set(target, version);
      return;
    }

    const holder = this.#writing.get(target);
    if (holder?.convId === convId) this.#writing.delete(target);
    if (isError) return;
    const version = versionOf(target);
    if (version === undefined) reads.delete(target);
    else reads.set(target, version);
  }
}

