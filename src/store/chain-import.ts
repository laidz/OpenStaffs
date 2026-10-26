import fs from "node:fs";
import path from "node:path";
import { listProjects } from "../domain/project.ts";
import { parseMembers } from "../domain/access-control.ts";
import { stateDir, workDir, type Workspace } from "../domain/paths.ts";
import type { SessionStore } from "./sessions.ts";

/**
 * 一次性迁移：把老的**会话链 markdown** 导入会话表（`sessions`），然后把旧文件搬到
 * `openstaffs/.data/legacy-chains/<时间戳>/` 并删掉原处，此后链文件彻底退役（不再读写）。
 *
 * 旧形态：
 * - 私聊：`work/<员工id>/conversation_ids.md`
 * - 群聊：`openstaffs/.data/chains/group-<项目id>/<成员id>.md`
 *
 * 只导入一次：全部文件搬走后目录即空，重复启动无副作用。
 */
export function importLegacyChains(ws: Workspace, sessions: SessionStore): { imported: number } {
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  const backupRoot = path.join(stateDir(ws), "legacy-chains", stamp);
  let imported = 0;

  const importFile = (file: string, room: string, memberId: string, kind: "dm" | "group"): void => {
    let rows: { id: string; started: string; ended: string | null; previous: string | null }[];
    try {
      rows = parseChain(fs.readFileSync(file, "utf8"));
    } catch {
      return; // 没有该文件 / 读不了：跳过（不算错误）
    }
    if (rows.length === 0) return;
    for (const row of rows) {
      if (sessions.get(row.id) !== undefined) continue; // 幂等：已导入过的不重复写
      sessions.open({ convId: row.id, room, memberId, kind, now: row.started });
      if (row.ended !== null) sessions.closeAt(row.id, row.ended);
      imported += 1;
    }
    // 搬走旧文件（保留一份备份，原处不再留），避免下次启动重复扫描。
    const target = path.join(backupRoot, path.relative(ws.root, file));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(file, target);
  };

  // 私聊链：work/<员工>/conversation_ids.md
  const workRoot = path.join(ws.root, "work");
  if (fs.existsSync(workRoot)) {
    for (const entry of fs.readdirSync(workRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const memberId = entry.name;
      const file = path.join(workDir(ws, memberId), "conversation_ids.md");
      if (fs.existsSync(file)) importFile(file, `dm:${memberId}`, memberId, "dm");
    }
  }

  // 群聊链：.data/chains/group-<项目>/<成员>.md（只导 config 里还有的项目/成员）
  for (const project of listProjects(ws)) {
    for (const memberId of parseMembers(ws, project.id)) {
      const file = path.join(stateDir(ws), "chains", `group-${project.id}`, `${memberId}.md`);
      if (fs.existsSync(file)) importFile(file, `group:${project.id}`, memberId, "group");
    }
  }
  // 清掉空目录（best-effort）
  try {
    const chainsDir = path.join(stateDir(ws), "chains");
    if (fs.existsSync(chainsDir)) fs.rmSync(chainsDir, { recursive: true, force: true });
  } catch {
    // 删不掉不影响正确性（文件已搬走）
  }
  return { imported };
}

/** 旧链文件解析（与原 `domain/conversation-chain.ts` 的格式一致：4 列表格）。 */
function parseChain(raw: string): { id: string; started: string; ended: string | null; previous: string | null }[] {
  const rows: { id: string; started: string; ended: string | null; previous: string | null }[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed.replace(/^\|/u, "").replace(/\|$/u, "").split("|").map((cell) => cell.trim());
    if (cells.length !== 4) continue;
    const [id, started, ended, previous] = cells as [string, string, string, string];
    if (id === "id" || id.startsWith("---")) continue;
    if (id === "" || started === "") continue;
    rows.push({ id, started, ended: ended === "" ? null : ended, previous: previous === "-" || previous === "" ? null : previous });
  }
  return rows;
}
