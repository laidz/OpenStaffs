// src/domain/org.ts —— 组织树、负责人与管理权（D34：独立域模块）。
// 纯结构运算（buildOrg 不碰文件系统）+ loadOrg 薄封装；管理权按 spec §5「主管制 + 穿透」。
import path from "node:path";
import { agentsDir, type Workspace } from "./paths.ts";
import { scanOrg, type AgentConfig, type OrgScan } from "./org-config.ts";

export type OrgPerson = AgentConfig;

export type OrgDepartment = {
  /** 相对 agents/ 的路径；根 = ""。 */
  path: string;
  /** 文件夹名；根 = "agents"。 */
  name: string;
  alias?: string;
  /** 配置里写的 head（未过滤；有效值用 headsOf）。 */
  head: string[];
  /** 本级直属的人（不含子部门）。 */
  people: OrgPerson[];
  departments: OrgDepartment[];
};

export type OrgTree = {
  root: OrgDepartment;
  /** 全量的人（DFS 顺序）。 */
  people: OrgPerson[];
  /** 全量部门（含根）。 */
  departments: OrgDepartment[];
  warnings: string[];
};

export function buildOrg(scan: OrgScan): OrgTree {
  const warnings = [...scan.warnings];
  const nodes = new Map<string, OrgDepartment>();
  for (const record of scan.departments) {
    nodes.set(record.path, {
      path: record.path,
      name: record.name,
      head: record.head,
      people: [],
      departments: [],
      ...(record.alias === undefined ? {} : { alias: record.alias }),
    });
  }
  const root = nodes.get("");
  if (root === undefined) throw new Error("组织扫描缺少根部门");

  for (const record of scan.departments) {
    if (record.path === "") continue;
    const parentPath = record.path.includes("/") ? record.path.slice(0, record.path.lastIndexOf("/")) : "";
    (nodes.get(parentPath) ?? root).departments.push(nodes.get(record.path)!);
  }

  const people: OrgPerson[] = [];
  const seen = new Set<string>();
  for (const agent of scan.agents) {
    if (seen.has(agent.id)) {
      warnings.push(`人员 id 重复（全局唯一；只保留第一个）：${agent.id}`);
      continue;
    }
    seen.add(agent.id);
    people.push(agent);
    (nodes.get(agent.departmentPath) ?? root).people.push(agent);
  }

  // head 只认本级直属成员（D6「只能从本级成员里选」）；匹配不到即视为无。
  for (const node of nodes.values()) {
    const own = new Set(node.people.map((person) => person.id));
    for (const id of node.head) {
      if (!own.has(id)) warnings.push(`负责人不在本级成员里（忽略）：${node.path === "" ? "（根）" : node.path}/${id}`);
    }
  }

  return { root, people, departments: [...nodes.values()], warnings };
}

export function loadOrg(ws: Workspace): OrgTree {
  return buildOrg(scanOrg(ws));
}

export function listPeople(ws: Workspace): OrgPerson[] {
  return loadOrg(ws).people;
}

export function findPerson(tree: OrgTree, id: string): OrgPerson | undefined {
  return tree.people.find((person) => person.id === id);
}

/** 人不存在 → 抛错（旧 `loadEmployee` 口径，调用方可读不可空）。 */
export function loadPerson(ws: Workspace, id: string): OrgPerson {
  const person = findPerson(loadOrg(ws), id);
  if (person === undefined) throw new Error(`员工不存在: ${id}`);
  return person;
}

/** 展示名：alias 缺省 = id；未知人 → id（展示层尽力而为，不抛）。 */
export function personDisplayName(ws: Workspace, id: string): string {
  return findPerson(loadOrg(ws), id)?.alias ?? id;
}

export function departmentAt(tree: OrgTree, deptPath: string): OrgDepartment | undefined {
  return tree.departments.find((department) => department.path === deptPath);
}

export function departmentOfPerson(tree: OrgTree, id: string): OrgDepartment | undefined {
  const person = findPerson(tree, id);
  return person === undefined ? undefined : departmentAt(tree, person.departmentPath);
}

/** 祖先链（自根到该部门，含自身）；未知路径 → []。 */
export function ancestryOf(tree: OrgTree, deptPath: string): OrgDepartment[] {
  const segments = deptPath === "" ? [] : deptPath.split("/");
  const chain: OrgDepartment[] = [];
  for (let i = 0; i <= segments.length; i += 1) {
    const node = departmentAt(tree, segments.slice(0, i).join("/"));
    if (node === undefined) return [];
    chain.push(node);
  }
  return chain;
}

/** 有效 head：只认本级直属成员（写子部门成员 / 写错 id 都不算）。 */
export function headsOf(tree: OrgTree, deptPath: string): string[] {
  const department = departmentAt(tree, deptPath);
  if (department === undefined) return [];
  const own = new Set(department.people.map((person) => person.id));
  return department.head.filter((id) => own.has(id));
}

/** X 的管理者（D7）：沿祖先链（含自身所在部门）向上找最近的有 head 的部门 → 其全部有效 head；全链无 → []（= 老板）。 */
export function managersOf(tree: OrgTree, deptPath: string): string[] {
  const chain = ancestryOf(tree, deptPath);
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const heads = headsOf(tree, chain[i]!.path);
    if (heads.length > 0) return heads;
  }
  return [];
}

export function isInSubtree(ancestorPath: string, deptPath: string): boolean {
  if (ancestorPath === "") return true;
  return deptPath === ancestorPath || deptPath.startsWith(`${ancestorPath}/`);
}

/** 管理者的管理范围（D7 穿透）：其担任 head 的部门路径列表。 */
export function managedDepartmentsOf(tree: OrgTree, managerId: string): string[] {
  return tree.departments.filter((department) => headsOf(tree, department.path).includes(managerId)).map((d) => d.path);
}

export function isManagedDepartment(tree: OrgTree, managerId: string, deptPath: string): boolean {
  return managedDepartmentsOf(tree, managerId).some((root) => isInSubtree(root, deptPath));
}

/** 管理者的可写目录（绝对路径；access-control 的 writableDirs 用）。 */
export function managedDirsOf(tree: OrgTree, ws: Workspace, managerId: string): string[] {
  return managedDepartmentsOf(tree, managerId).map((deptPath) => path.join(agentsDir(ws), deptPath));
}

/**
 * 管理者子树内的目录集合（**B2 适配器，给 P3**）：部门目录 + 人所在目录，均为绝对路径、各自去重。
 * 转调 `managedDepartmentsOf` + `isInSubtree`；不是任何部门的 head → 两个空数组。
 */
export function managedSubtreeOf(ws: Workspace, id: string): { departmentDirs: string[]; agentDirs: string[] } {
  const tree = loadOrg(ws);
  const roots = managedDepartmentsOf(tree, id);
  const inManaged = (deptPath: string): boolean => roots.some((root) => isInSubtree(root, deptPath));
  return {
    departmentDirs: tree.departments
      .filter((department) => inManaged(department.path))
      .map((department) => path.join(agentsDir(ws), department.path)),
    agentDirs: [...new Set(tree.people.filter((person) => inManaged(person.departmentPath)).map((person) => person.dir))],
  };
}
