import fs from "node:fs";
import path from "node:path";
import { employeeDir, type Workspace } from "./paths.ts";
import type { EmployeeId, ModelChoice } from "./types.ts";

export type Employee = {
  id: EmployeeId;
  dir: string;
  entry: string;
  profile: string;
  memory: string;
  model: ModelChoice;
  /** 可变展示名；目录名（id）不可变。 */
  alias?: string;
};

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function readModel(dir: string): ModelChoice {
  const raw = readText(path.join(dir, "config.json"));
  if (raw.trim() === "") return { provider: "", modelId: "" };
  try {
    const parsed = JSON.parse(raw) as Partial<ModelChoice>;
    return {
      provider: parsed.provider ?? "",
      modelId: parsed.modelId ?? "",
      ...(parsed.thinkingLevel === undefined ? {} : { thinkingLevel: parsed.thinkingLevel }),
    };
  } catch {
    return { provider: "", modelId: "" };
  }
}

export function loadEmployee(ws: Workspace, id: EmployeeId): Employee {
  const dir = employeeDir(ws, id);
  if (!fs.existsSync(dir)) throw new Error(`员工不存在: ${id}`);
  const alias = readAlias(dir);
  return {
    id,
    dir,
    entry: readText(path.join(dir, "AGENTS.md")),
    profile: readText(path.join(dir, "profile.md")),
    memory: readText(path.join(dir, "MEMORY.md")),
    model: readModel(dir),
    ...(alias === undefined ? {} : { alias }),
  };
}

function readAlias(dir: string): string | undefined {
  const raw = readText(path.join(dir, "config.json"));
  if (raw.trim() === "") return undefined;
  try {
    const parsed = JSON.parse(raw) as { alias?: unknown };
    return typeof parsed.alias === "string" && parsed.alias.trim() !== "" ? parsed.alias.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function renderInstructions(employee: Employee): string {
  return [employee.entry, employee.profile, employee.memory]
    .filter((part) => part.trim() !== "")
    .join("\n\n");
}
