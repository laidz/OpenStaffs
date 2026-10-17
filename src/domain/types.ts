export type EmployeeId = string;
export type ProjectName = string;

/** 一个「关系」：私聊（老板 ↔ 某员工）或群聊（某项目）。目录名即 id。 */
export type Relation =
  | { kind: "dm"; employeeId: EmployeeId }
  | { kind: "group"; project: ProjectName };

export type ModelChoice = {
  provider: string;
  modelId: string;
  thinkingLevel?: string;
};
