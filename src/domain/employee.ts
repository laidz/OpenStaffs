// src/domain/employee.ts —— 【薄适配层：P2 保留；是否彻底删由 P5 收口（B1）】
// 调用方（P3 `roomExists` / P5 `loadEmployee` / `renderInstructions`）按旧名读「展示名 / 人员枚举 / instructions」。
// 新代码一律直接用 `src/domain/org.ts`；本文件把旧 API 折到 org 上，导出签名对外不变。
import { findPerson, loadOrg, type OrgPerson } from "./org.ts";
import type { Workspace } from "./paths.ts";

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

/** 人级 instructions = 内联 prompt（D5：取消员工侧 AGENTS.md / profile.md / MEMORY.md）。 */
export function renderInstructions(person: Employee): string {
  return person.prompt;
}
