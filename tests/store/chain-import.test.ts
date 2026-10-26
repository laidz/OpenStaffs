import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createWorkspace, officeDbFile, stateDir } from "../../src/domain/paths.ts";
import { importLegacyChains } from "../../src/store/chain-import.ts";
import { openSessionStore, type SessionStore } from "../../src/store/sessions.ts";
import { seedOffice } from "../helpers/office.ts";

const CHAIN_HEADER = ["# 会话链", "", "| id | started | ended | previous |", "|----|---------|-------|----------|"];

let root: string;
let store: SessionStore;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "os-chain-import-"));
  const ws = createWorkspace(root);
  fs.mkdirSync(stateDir(ws), { recursive: true });
  store = openSessionStore(officeDbFile(ws));
});
afterEach(() => {
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function writeChain(file: string, rows: string[][]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [...CHAIN_HEADER, ...rows.map((cells) => `| ${cells.join(" | ")} |`), ""].join("\n"));
}

test("私聊 / 群聊链文件导入会话表：房间与主人推对，ended 保留；旧文件搬到 .data/legacy-chains 后原处不留", () => {
  const ws = createWorkspace(root);
  seedOffice(root, { agents: [{ id: "alice" }, { id: "bob" }], projects: [{ id: "yt", members: ["alice", "bob"] }] });
  writeChain(path.join(root, "work", "alice", "conversation_ids.md"), [
    ["conv_a1", "2026-10-26T10:00:00.000Z", "2026-10-26T11:00:00.000Z", "-"],
    ["conv_a2", "2026-10-26T11:00:00.000Z", "", "conv_a1"],
  ]);
  writeChain(path.join(stateDir(ws), "chains", "group-yt", "bob.md"), [
    ["conv_b1", "2026-10-26T12:00:00.000Z", "", "-"],
  ]);

  const result = importLegacyChains(ws, store);
  expect(result.imported).toBe(3);

  const dm = store.list("dm:alice");
  expect(dm.map((row) => [row.convId, row.ended, row.previous])).toEqual([
    ["conv_a1", "2026-10-26T11:00:00.000Z", null],
    ["conv_a2", null, "conv_a1"],
  ]);
  expect(store.active("dm:alice", "alice")?.convId).toBe("conv_a2");
  expect(store.owner("conv_b1")).toEqual({ room: "group:yt", memberId: "bob" });
  expect(store.get("conv_b1")?.kind).toBe("group");

  // 旧文件已搬走（原处不留），备份存在
  expect(fs.existsSync(path.join(root, "work", "alice", "conversation_ids.md"))).toBe(false);
  expect(fs.existsSync(path.join(stateDir(ws), "chains"))).toBe(false);
  const backups = fs.readdirSync(path.join(stateDir(ws), "legacy-chains"));
  expect(backups.length).toBe(1);
});

test("重复执行幂等：已导入的会话不重复写，无链文件时不报错", () => {
  const ws = createWorkspace(root);
  seedOffice(root, { agents: [{ id: "alice" }] });
  writeChain(path.join(root, "work", "alice", "conversation_ids.md"), [
    ["conv_a1", "2026-10-26T10:00:00.000Z", "", "-"],
  ]);
  expect(importLegacyChains(ws, store).imported).toBe(1);
  expect(importLegacyChains(ws, store).imported).toBe(0); // 文件已搬走
  expect(store.list("dm:alice")).toHaveLength(1);
});

test("旧 sessions 表（只有标题）会被重建：会话表以 conv_id + 房间 + 主人为准", () => {
  const ws = createWorkspace(root);
  const file = officeDbFile(ws);
  store.close();
  const legacy = new DatabaseSync(file);
  legacy.exec("DROP TABLE sessions");
  legacy.exec("CREATE TABLE sessions (conv_id TEXT PRIMARY KEY, title TEXT NOT NULL, title_source TEXT NOT NULL, updated_at TEXT NOT NULL)");
  legacy.close();

  store = openSessionStore(file);
  store.open({ convId: "conv_new", room: "dm:alice", memberId: "alice", kind: "dm", now: "2026-10-26T10:00:00.000Z" });
  expect(ws.root).toBe(root);
  expect(store.active("dm:alice", "alice")?.convId).toBe("conv_new");
});
