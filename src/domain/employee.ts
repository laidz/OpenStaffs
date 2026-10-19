// src/domain/employee.ts —— 【薄适配层：P2 保留；是否彻底删由 P5 收口（B1）】
// 调用方（P3 `roomExists` / P5 `loadEmployee` / `renderInstructions`）按旧名读「展示名 / 人员枚举 / instructions」。
// 新代码一律直接用 `src/domain/org.ts`；本文件把旧 API 折到 org 上，导出签名对外不变。
import fs from "node:fs";
import path from "node:path";
import { findPerson, loadOrg, type OrgPerson } from "./org.ts";
import { employeeDir, workDir, type Workspace } from "./paths.ts";

export type Employee = OrgPerson;

/** 人员存在性检查（缺失抛错，沿用旧口径）。 */
export function loadEmployee(ws: Workspace, id: string): Employee {
  const person = findPerson(loadOrg(ws), id);
  if (person === undefined) throw new Error(`员工不存在: ${id}`);
  return person;
}

export function listEmployees(ws: Workspace): Employee[] {
  return loadOrg(ws).people;
}

/** 人级 instructions = 内联 prompt（D5：员工侧不再有独立的提示词 / 记忆文件）。 */
export function renderInstructions(person: Employee): string {
  return person.prompt;
}

/** 本文件当前没有 fs / readText，P3 自己加这个私有 helper。 */
function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** 记忆（D27）：优先 work/<id>/MEMORY.md；旧位置回落由 P5 删除。 */
export function memoryOf(ws: Workspace, id: string): string {
  const work = readText(path.join(workDir(ws, id), "MEMORY.md"));
  if (work.trim() !== "") return work;
  return readText(path.join(employeeDir(ws, id), "MEMORY.md"));
}
