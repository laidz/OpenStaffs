/** 五层配置的统一形状（spec §4）。本模块是**纯域**：不依赖任何其它域模块。 */

export type ScopeKind = "space" | "project" | "department" | "agent";

/** 按工具 → 路径列表；路径写法相对**该配置文件所在目录**。 */
export type PermissionTable = Record<string, string[]>;

export type ConfigFields = {
  alias?: string;
  avatar?: string;
  /** 内联提示词（D5：提示词内联进配置，不再有独立提示词文件）。 */
  prompt?: string;
  skills: string[];
  mcp: string[];
  permissions: PermissionTable;
  model?: string;
  thinkingLevel?: string;
  /** 空间层专用：自动命名会话用的模型（必须是非思考模型）；未指定 = 自动命名不可用。 */
  namingModel?: string;
  /** 记忆开关；缺省 = 跟随空间级配置。 */
  memory?: boolean;
  head: string[];
  owner: string[];
  members: string[];
};

export type LoadedConfig = {
  scope: ScopeKind;
  /** 空间 = "space"；部门 = 相对部门路径；项目 / 员工 = 名字。 */
  id: string;
  file: string;
  /** 相对路径（permissions）以此为基。 */
  baseDir: string;
  fields: ConfigFields;
  issues: string[];
};

export function emptyConfigFields(): ConfigFields {
  return { skills: [], mcp: [], permissions: {}, head: [], owner: [], members: [] };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function textArray(value: unknown, field: string, issues: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push(`${field} 必须是字符串数组`);
    return [];
  }
  const out: string[] = [];
  for (const entry of value) {
    const item = text(entry);
    if (item === undefined) {
      issues.push(`${field} 含非字符串或空条目（已跳过）`);
      continue;
    }
    out.push(item);
  }
  return out;
}

function permissionTable(value: unknown, issues: string[]): PermissionTable {
  if (value === undefined) return {};
  if (!isObject(value)) {
    issues.push("permissions 必须是对象（工具名 → 路径列表）");
    return {};
  }
  const out: PermissionTable = {};
  for (const [rawTool, rawPaths] of Object.entries(value)) {
    const tool = rawTool.trim();
    if (tool === "") {
      issues.push("permissions 含空工具名（已跳过）");
      continue;
    }
    if (!Array.isArray(rawPaths) || rawPaths.some((entry) => typeof entry !== "string")) {
      issues.push(`permissions.${tool} 必须是字符串数组（已跳过）`);
      continue;
    }
    out[tool] = (rawPaths as string[]).map((entry) => entry.trim()).filter((entry) => entry !== "");
  }
  return out;
}

export function parseConfigFields(raw: unknown): { fields: ConfigFields; issues: string[] } {
  const issues: string[] = [];
  const fields = emptyConfigFields();
  if (!isObject(raw)) {
    issues.push("配置必须是 JSON 对象");
    return { fields, issues };
  }
  const alias = text(raw["alias"]);
  if (alias !== undefined) fields.alias = alias;
  const avatar = text(raw["avatar"]);
  if (avatar !== undefined) fields.avatar = avatar;
  const prompt = typeof raw["prompt"] === "string" ? raw["prompt"].trim() : undefined;
  if (prompt !== undefined && prompt !== "") fields.prompt = prompt;
  const model = text(raw["model"]);
  if (model !== undefined) fields.model = model;
  const thinkingLevel = text(raw["thinkingLevel"]);
  if (thinkingLevel !== undefined) fields.thinkingLevel = thinkingLevel;
  const namingModel = text(raw["namingModel"]);
  if (namingModel !== undefined) fields.namingModel = namingModel;
  else if (raw["namingModel"] !== undefined) issues.push("namingModel 必须是非空字符串（已忽略）");
  const memory = raw["memory"];
  if (typeof memory === "boolean") fields.memory = memory;
  else if (memory !== undefined) issues.push("memory 必须是布尔值（已忽略）");
  fields.skills = textArray(raw["skills"], "skills", issues);
  fields.mcp = textArray(raw["mcp"], "mcp", issues);
  fields.head = textArray(raw["head"], "head", issues);
  fields.owner = textArray(raw["owner"], "owner", issues);
  fields.members = textArray(raw["members"], "members", issues);
  fields.permissions = permissionTable(raw["permissions"], issues);
  return { fields, issues };
}
