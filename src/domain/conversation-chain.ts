import fs from "node:fs";

export type SessionRow = {
  id: string;
  started: string;
  ended: string | null;
  previous: string | null;
};

const HEADER = ["# 会话链", "", "| id | started | ended | previous |", "|----|---------|-------|----------|"];

function encode(rows: SessionRow[]): string {
  const body = rows.map((r) =>
    `| ${r.id} | ${r.started} | ${r.ended ?? ""} | ${r.previous ?? "-"} |`,
  );
  return [...HEADER, ...body, ""].join("\n");
}

export function readChain(file: string): SessionRow[] {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const rows: SessionRow[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed.replace(/^\|/u, "").replace(/\|$/u, "").split("|").map((c) => c.trim());
    if (cells.length !== 4) continue;
    const [id, started, ended, previous] = cells as [string, string, string, string];
    if (id === "id" || id.startsWith("---")) continue;
    rows.push({
      id,
      started,
      ended: ended === "" ? null : ended,
      previous: previous === "-" || previous === "" ? null : previous,
    });
  }
  return rows;
}

export function activeSession(file: string): SessionRow | undefined {
  const rows = readChain(file).filter((row) => row.ended === null);
  return rows.length === 0 ? undefined : rows[rows.length - 1];
}

export function startNewSession(file: string, id: string, now: string): SessionRow[] {
  const rows = readChain(file).map((row) => (row.ended === null ? { ...row, ended: now } : row));
  const previous = rows.length === 0 ? null : rows[rows.length - 1]!.id;
  rows.push({ id, started: now, ended: null, previous });
  fs.writeFileSync(file, encode(rows));
  return rows;
}
