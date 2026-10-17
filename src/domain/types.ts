export type EmployeeId = string;
export type ProjectName = string;

/** 一个「关系」：私聊（老板 ↔ 某员工）或群聊（某项目）。目录名即 id。 */
export type Relation =
  | { kind: "dm"; employeeId: EmployeeId }
  | { kind: "group"; project: ProjectName };

export type ModelChoice = {
  /** 模型引用 "provider/modelId"（第一个 / 前为供应商，其余为模型 id）；空串 = 用全局默认模型。 */
  model: string;
  thinkingLevel?: string;
};
