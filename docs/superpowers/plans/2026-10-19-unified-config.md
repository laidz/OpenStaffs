# 统一配置 + 按工具权限（P3）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把四类能力（`prompt` / `skills` / `mcp` / `permissions`）在空间 / 项目 / 部门 / 员工四个作用域上收敛为**同一种形状**的 `*.config.json` + **一套解析器**，并把权限从「只管控写」升级为「**按工具 → 路径列表**」（含运行时授予与 attenuation）。

**Architecture:** 新增三个**纯域模块**（D34）：
- `src/config/` —— 命名解析 + 字段校验 + 加载 `*.config.json`（**不依赖任何其它域模块**）；
- `src/permissions/` —— 默认值 / 解析 / 累加 / 匹配 / 运行时有效集 / attenuation（依赖 `config` + `org`）；
- `src/capabilities/` —— 作用域链装配（`prompt` / `skills` / `mcp` **累加**）+ 引用解析（依赖 `config` + `org`）。

旧的四套机制（`AGENTS.md` / `skills/` 目录 / 四层 `mcp.json` / `permission.json`）在 P3 里**退出运行时**：不再有任何代码读它们。工具权限闸门（`src/tools/gate.ts`）统一替换 `access-control.isWriteAllowed`，对 `read` / `write` / `edit` / `bash` 与未来文件系统工具用**同一套逻辑**。

**Tech Stack:** Node ≥ 22.19（`npm start` 直接跑 TS，strip-only：无 `enum` / 无参数属性 / 无装饰器）、Vitest、vanilla TS。

**Spec:** `docs/superpowers/specs/2026-10-18-agent-org-hierarchy-design.md`（§4 统一配置字段、§6 权限模型、§7 合并规则、§10 P3 行、§12 模块化边界；决策 D9–D17、D25–D28、D30、D34）

## Global Constraints

- Node ≥ 22.19；`npm start` = `node src/server/main.ts`；**strip-only TS**：不得用 `enum` / 参数属性 / 装饰器；导入一律带 `.ts` 后缀。
- `*.config.json` 四种文件名**逐字**：`space.config.json`、`<部门路径>/department.config.json`、`<名字>.project.config.json`、`<名字>.agent.config.json`（D3/D26）。
- 合并**一律累加**、**接受同值重复**、**无覆盖 / 无优先级**（D10）。
- 权限落盘路线**只有** `project.config.json` + `agent.config.json`；`space` / `department` 的 `permissions` **不进**权限路线（D11）。
- 能力累加路线 = `space` + `department`（根 → 叶递归）+ `project`（仅群聊）+ `agent`（D12）。
- 默认值：`write: []`、`read: ["./"]`、`bash: ["./"]`；**新工具默认空**（D14）。`permissions` 里的相对路径**相对该配置文件所在目录**解析。
- 引用解析：`skills` → `openstaffs/skills/<技能名>/`；`mcp` → `openstaffs/mcps.json`（D16/D17）。
- **人不可写任何 `<名字>.agent.config.json`（含自己的）**（§6 硬规则）。
- **不做迁移**（D30）：允许破坏性更新，不写任何兼容旧格式的读取分支。
- **浏览器 bundle 边界**：`web/` 不得值导入 `src/config/`、`src/permissions/`、`src/capabilities/`、`src/tools/`（这些模块带 `node:` 内置导入）。`tests/web/bundle.test.ts` 是守卫。
- TDD：每任务**先写失败测试**；提交信息用 `<type>(<scope>): <简体中文描述>`（scope 用英文小写，如 `feat(config)` / `refactor(conv)`；改动多时空行后加正文）；每任务独立验收、独立提交。
- **中间态约定**：Task 7–10 会改掉一批旧夹具依赖的 API（项目目录 / `AGENTS.md` / `permission.json` / 四层 MCP）。这些任务**只跑自己任务列出的定向测试**；**不要**在中间态追全量绿。Task 11 负责把剩余夹具一次性迁完，并让 `npm test` + `npm run typecheck` 全绿。若在 Task 7–10 跑全量时看到红，先看它是否属于「未迁移的旧夹具」，不要为了让旧夹具变绿而保留旧机制。

## Review Focus

1. **attenuation 的包含语义**：请求集必须是写者有效集的**子路径集**（授 `/a` 可写 `/a/b`；授 `/a/b` 不可写 `/a`）；空集恒 ⊆ 任意集；路径比较**大小写敏感**、`/` 特例不可漏。→ 由 Task 4 的 `tests/permissions/attenuation.test.ts` 钉住。
2. **配置落盘安全**：坏 JSON / `permissions` 非对象的配置文件**抛错拒写**，绝不静默清空别人的定义；正常写入必须**保留** `alias`/`model`/`prompt`/`head`… 全部原有字段。→ 由 Task 2 的 `tests/config/write.test.ts` 钉住。
3. **未登记工具 / 新工具默认空 + 运行时工作目录对所有工具生效**：`permissions` 里没出现的工具名不得报错、不得继承别的工具的路径；同时 agent 自己的工作目录对**所有**工具可用（D13①）。→ 由 Task 4 的 `tests/permissions/effective.test.ts` 钉住。
4. **员工配置保护与配置整体写**：写 `*.agent.config.json`（含自己的）恒被拦；`edit` 改任何 `*.config.json` 恒被拦（引导改用 `write` 以便校验 attenuation）；`bash` 走**近似**路径检查（软边界，非沙箱）。→ 由 Task 9 的 `tests/tools/gate.test.ts` 钉住。
5. **引用缺失不崩**：`skills` / `mcp` 里写了不存在的名字 → 跳过 + 记进 `missing`，不得抛异常、不得拖垮建会话。→ 由 Task 5 / Task 6 的测试钉住。

---

## File Structure

**Create**

- `src/config/schema.ts` —— `ScopeKind` / `PermissionTable` / `ConfigFields` / `LoadedConfig` / `parseConfigFields`。
- `src/config/naming.ts` —— 四类文件名常量与路径 / 反解工具（纯字符串 + `node:path`）。
- `src/config/load.ts` —— `readConfigFile` 与四个作用域的加载包装。
- `src/config/write.ts` —— `appendPermissionPaths(file, tool, paths)`（原子写、保字段、坏文件拒写）。
- `src/permissions/types.ts` —— `ResolvedPermissions` / `RuntimeGrants` / `OnDiskPermissions`。
- `src/permissions/defaults.ts` —— `DEFAULT_PERMISSIONS` / `defaultPathsFor` / `defaultPermissionTable`。
- `src/permissions/resolve.ts` —— `resolvePermissionTable` / `accumulatePermissions`。
- `src/permissions/match.ts` —— `matchesPath` / `isSubsetOf`。
- `src/permissions/effective.ts` —— `effectivePermissions` / `pathsFor`。
- `src/permissions/runtime.ts` —— `runtimeGrantsFor`（唯一 `org` 接缝之一；工作目录 / 主管子树 / 技能 read 根）。
- `src/permissions/attenuation.ts` —— `checkAttenuation`。
- `src/capabilities/assemble.ts` —— `assembleCapabilities`。
- `src/capabilities/skills.ts` —— `resolveSkillRefs`。
- `src/capabilities/scopes.ts` —— `scopeChain` / `scopesForOrg`（唯一另一个 `org` 接缝）。
- `src/tools/gate.ts` —— `TOOL_PERMISSION_KEYS` / `gateToolCall` / `bashPathsIn` / `writeBlockMessage`。
- `tests/helpers/office.ts` —— 按新目录结构铺办公空间的夹具助手。
- 测试：`tests/config/{schema,naming,load,write}.test.ts`、`tests/permissions/{resolve,match,effective,attenuation}.test.ts`、`tests/capabilities/{assemble,skills,scopes}.test.ts`、`tests/tools/gate.test.ts`。

**Modify**

- `src/domain/paths.ts` —— **不自建工作目录函数**（统一 import P2 的 `workDir(ws, id)`，见 B3）；`groupConversationIdsFile` 改到 `stateDir/chains/`；删 `membersFile` / `projectDir`。
- `src/domain/project.ts` —— 项目改为**扁平 config 文件**（`projects/<id>.project.config.json`），成员进 `members` 字段。
- `src/domain/access-control.ts` —— `parseMembers` / `projectsOf` 走项目 config；`AccessContext` 改为「有效权限表」；删 `isWriteAllowed`。
- `src/domain/employee.ts` —— P2 已是薄适配层；P3 只**追加** `memoryOf`（用 `node:fs` 直接读 `work/<id>/MEMORY.md`，回落旧位置），**不删** `renderInstructions` / `Employee` / `loadEmployee` / `listEmployees`（彻底收口归 P5）。
- `src/domain/mcp.ts` —— 四层 → **`openstaffs/mcps.json` 全局定义 + 按名引用**。
- `src/harness/mcp-manager.ts` —— 快照单一来源；`extensionsFor(names)`。
- `src/harness/access-extension.ts` —— 改用 `gateToolCall`。
- `src/harness/port.ts` —— `ConversationSpec.access` 类型随之调整（值不变）。
- `src/app/conversations.ts` —— `instructionsFor` 走 `capabilities`；`accessFor` 走 `permissions`；`relationCwd` = agent 工作目录；删 `permissionFilesFor` / `skillDirsFor`。
- `src/app/permission-flow.ts` —— 授权落盘改为「往 agent config 的 `permissions[tool]` 追加」。
- `src/app/send.ts` —— `parseMembers` 语义随项目 config 变化（调用点不变）；`data.author` 不变。
- `src/tools/registry.ts` —— `member_profile` 读 config `prompt`；`request_permission` 加可选 `tool`。
- `src/server/http.ts` —— `roomExists`（群聊）改判扁平 config；其余随 P1 走向。
- `src/server/main.ts` —— `new McpManager({ ws })`（去掉 `systemFile`）。
- 测试（同步到新形态）：`tests/domain/{paths,project,access-control,employee,mcp,skills,prompt,prompt-vars}.test.ts`、`tests/harness/{access-extension,mcp-manager,mcp-harness,pi-durable}.test.ts`、`tests/app/{conversations,send,permission-flow}.test.ts`、`tests/tools/{registry,extension}.test.ts`、`tests/server/{http,pump-trigger,sse}.test.ts`。

**Delete**

- `src/domain/permissions.ts`（被 `src/permissions/*` + `src/config/write.ts` 取代）。
- `src/mcp.json`（系统级 MCP 定义退役，D16 只留 `openstaffs/mcps.json`）。
- `tests/domain/permissions.test.ts`（拆成 `tests/permissions/*` 与 `tests/tools/gate.test.ts`）。

**文档（Task 12）**

- `src/skills/openstaffs/SKILL.md`、`src/skills/openstaffs-ops/SKILL.md`、`README.md`、`docs/产品规划.md`。

---

## 跨阶段假设（P2 已提供的接口）

本计划**假定 P2 已落地**，并只在这**几处**耦合 P2（改 P2 实现时只需改这几处）：

1. `src/domain/org.ts`（P2 新建）导出**按 P2 实际签名**的接口（跨计划裁定 B2 已统一命名；人带 `dir` / `departmentPath`）：

```ts
/** 建 / 读组织树（走盘）。 */
export function loadOrg(ws: Workspace): OrgTree;
/** 定位一人；不存在 → undefined。人带 dir（配置文件所在部门目录）与 departmentPath（相对 agents/）。 */
export function findPerson(tree: OrgTree, id: string): OrgPerson | undefined;
/** 全部人（P2 顺序）。 */
export function listPeople(ws: Workspace): OrgPerson[];
/** 取一人；不存在 → 抛 `员工不存在: <id>`。 */
export function loadPerson(ws: Workspace, id: string): OrgPerson;
/** 该部门链（自根到该部门，含自身）；根下的人 → 只含根。 */
export function ancestryOf(tree: OrgTree, deptPath: string): OrgDepartment[];
/** 该主管管理范围（部门路径）与其可写目录（绝对路径）。 */
export function managedDepartmentsOf(tree: OrgTree, managerId: string): string[];
export function managedDirsOf(tree: OrgTree, ws: Workspace, managerId: string): string[];
/** **由 P2 按跨计划裁定 B2 新增的适配器**（P3 需要）；不是 P2 原有名字。 */
export function managedSubtreeOf(ws: Workspace, agentId: string): { departmentDirs: string[]; agentDirs: string[] };
```

> 除上面标注「**由 P2 按跨计划裁定 B2 新增的适配器**」的 `managedSubtreeOf` 外，其余 org 接口一律以 **P2 实际签名为准**：`findPerson` / `listPeople` / `loadPerson` / `ancestryOf` / `managedDirsOf` / `managedDepartmentsOf`，**人带 `dir` / `departmentPath`**。（`managedSubtreeOf` 返回 `{ departmentDirs, agentDirs }`，由 P2 补一个。）

2. `workDir(ws, id): string`（P2 在 `src/domain/paths.ts` 提供，`= <root>/work/<id>`）：本计划**不自建** `employeeWorkDir`，一律 **import P2 的 `workDir(ws, id)`**（跨计划裁定 B3）。

3. `loadEmployee(ws, id)`（P2 按跨计划裁定 B1 **保留**的 `src/domain/employee.ts` 薄适配层）仍返回 `Employee = OrgPerson`（`{ id, dir, departmentPath, file, alias?, model: ModelChoice, prompt }`），且员工定义文件是 `<dir>/<名字>.agent.config.json`；`employeeDir(ws, id)` 也仍然可用（`agents/<id>`，现仅作 `memoryOf` 的旧位置回落）。

**若 P2 的实现与之不同**：
- 只有 `src/capabilities/scopes.ts` 的 `scopesForOrg()` 与 `src/permissions/runtime.ts` 的 `runtimeGrantsFor()` 需要改（换函数名 / 换取值方式）；其余模块与全部测试不受影响。
- `scopesForOrg` 用 `loadPerson(ws, agentId).dir` 作 `agentDir`、用 `ancestryOf(tree, person.departmentPath).map((d) => d.dir)` 作 `departmentDirs`（见 Task 5）。
- 若 P2 没有 `managedSubtreeOf`（主管写权未落地）：`runtimeGrantsFor` 先返回 `managedWriteDirs: []`，并**保留该参数**，P2 补齐后填回，不改变本计划的任何其它契约。
- 若 `loadEmployee` 丢了 `dir`：`src/config/naming.ts` 的 `agentConfigFile(dir, id)` 无处取基路径，需 P2 补 `dir`（这是硬依赖）。

**P1 已落地事实（对齐；本计划不得与之冲突）**

- 房间消息读写全归自有库 `src/store/`：`openMessageStore(file)` / `MessageStore` / `roomKeyOfMessage` / `messagesDbFile(ws) = path.join(stateDir(ws), "messages.sqlite")`；**`mergeRoomMessages` 已删除**（不要假设它存在）。
- **房间条目键** = `RoomMessage.convId = "store"`、`entryId = String(seq)`（**不是** `convId:entryId`）；`web/` 未改键机制。
- **库实例**：生产路径唯一，由 `src/server/main.ts` 创建并注入 `Pump`（`Deps.store` 必填）与 `ServerDeps.store`（必填），退出时 `close()`；`room_history` / `send_message` 自开实例（`openMessageStore` + `finally close()`）。**本计划不得另开库实例**。
- 本计划与 P1 的接触面只有 `src/server/http.ts` 的 `roomExists`（改判扁平 config，见 Task 7）与 `src/app/conversations.ts` 的装配，均**不触碰** `src/store/`。

**与并行 P4 / P5 计划的接口对齐（避免同名不同物）**

- **`spaceConfigFile`（跨计划裁定 N2）**：按执行顺序 **P3 在前**，本计划在 `src/config/naming.ts` 的 `spaceConfigFile` 是**唯一实现**；P4 计划在 `src/domain/space.ts` 的同名函数应由 P4 改为 **re-export P3 的定义**（`export { spaceConfigFile } from "../config/naming.ts";`），P4 侧不重复实现。**本计划不动 P4 的文件**。
- **五层 config 模块落点（跨计划裁定 B4）**：五层配置一律落在 **`src/config/*`**（本计划的 `schema.ts` / `naming.ts` / `load.ts` / `write.ts`）——**不是** `src/domain/config.ts`。P5 / P2 若需五层配置，**import 自 `src/config/*`**；`src/domain/config.ts` **只保留机器私有配置职责**（`readConfig` / `readBossName` / `bossNamesFor` 等）。
- **`src/capabilities/` 归属（跨计划裁定 B5）**：本计划**先建** `capabilities/scopes.ts` / `capabilities/skills.ts`，它们此后是**唯一实现**。**P5 不得重写 `capabilities/scopes.ts` / `capabilities/skills.ts`，只能 import 并按需追加导出**（P5 计划里的 `capabilities/prompt.ts`（`{{ }}` 渲染）与「记忆补建」由 P5 在本计划之后**追加新文件**，不得改这两个文件的行为）。P5 若要 `capabilityScopesFor` 这个名字，在 `scopes.ts` 末尾加一行 `export const capabilityScopesFor = scopesForOrg;` 即可。
- **P5 假定的 config 名字**：P5 计划用 `CapabilityConfig` / `ToolPermissionMap` / `readSpaceConfig` / `readProjectConfig`。它们都应 import 自 `src/config/*`（B4）；若 P5 先落地，在 `src/config/load.ts` 末尾加四行别名，不改语义：

```ts
export type CapabilityConfig = ConfigFields;
export type ToolPermissionMap = PermissionTable;
export const readSpaceConfig = loadSpaceConfig;
export const readProjectConfig = loadProjectConfig;
```

- **落序**：spec §10 的顺序是 P3 → P4 → P5。若实际并行导致重复，**以本计划的契约为准**（P3 是配置 / 权限的唯一真相源），P5 只做「prompt 渲染 + 记忆 + 删除遗留」。若 P5 已先落地同一件事，本计划对应步骤改为「核对 + 删除重复实现」，验收标准不变。

**与 P4 / P5 的边界（本计划不做）**

- **P4**：`.openstaffs/` → `openstaffs/.data/` 迁移（`stateDir` 落点）、启动探测、引导页、`.gitignore`、首次启动自动建 Staff0、**系统内置 prompt 物化进 `space.config.json`（D32）**。本计划的 `stateDir` 用法（`groupConversationIdsFile`）**不假设落点**，P4 搬家后自动跟随。
- **P5**：`prompt` 变量渲染（`{{ }}`）、记忆彻底搬进 `work/<id>/MEMORY.md` 并删旧读取回落、技能库集中、删除剩余多文件载体。本计划只把 `AGENTS.md` / `profile.md` **移出运行时**，`memoryOf` 的旧位置回落留给 P5 删除。
- **不在 P3**：`BOSS_ID` 由 `"boss"` 统一为 `"__boss"`（P1 计划的遗留项，与配置 / 权限无关，本计划一律使用 `BOSS_ID` 常量，不硬编码字面量）。

---

## Task 1: `src/config/` —— 命名、字段校验与加载

**Files:**
- Create: `src/config/schema.ts`、`src/config/naming.ts`、`src/config/load.ts`
- Test: `tests/config/schema.test.ts`、`tests/config/naming.test.ts`、`tests/config/load.test.ts`

**Interfaces:**
- Produces:
  - `type ScopeKind = "space" | "project" | "department" | "agent"`
  - `type PermissionTable = Record<string, string[]>`
  - `type ConfigFields = { alias?: string; avatar?: string; prompt?: string; skills: string[]; mcp: string[]; permissions: PermissionTable; model?: string; thinkingLevel?: string; head: string[]; owner: string[]; members: string[] }`
  - `type LoadedConfig = { scope: ScopeKind; id: string; file: string; baseDir: string; fields: ConfigFields; issues: string[] }`
  - `parseConfigFields(raw: unknown): { fields: ConfigFields; issues: string[] }`
  - `emptyConfigFields(): ConfigFields`
  - `spaceConfigFile(ws)`、`projectConfigFile(ws, id)`、`departmentConfigFile(dir)`、`agentConfigFile(dir, id)`、`agentIdOfConfigFile(file)`、`projectIdOfConfigFile(file)`、`isConfigFileName(base)`
  - `readConfigFile(file, scope, id): LoadedConfig | undefined`、`loadSpaceConfig(ws)`、`loadProjectConfig(ws, id)`、`loadDepartmentConfig(dir)`、`loadAgentConfig(dir, id)`

- [ ] **Step 1: 写失败测试（字段校验）**

```ts
// tests/config/schema.test.ts
import { expect, test } from "vitest";
import { parseConfigFields } from "../../src/config/schema.ts";

test("全字段解析：trim、数组保序", () => {
  const { fields, issues } = parseConfigFields({
    alias: " 爱丽丝 ",
    avatar: "avatars/a.png",
    prompt: "你是运营。",
    skills: ["report", "seo"],
    mcp: ["github"],
    permissions: { write: ["../shared"], read: ["./"], bash: [] },
    model: "opencode-go/x",
    thinkingLevel: "high",
    head: ["alice"],
    owner: ["bob"],
    members: ["alice", "bob"],
  });
  expect(issues).toEqual([]);
  expect(fields).toEqual({
    alias: "爱丽丝", avatar: "avatars/a.png", prompt: "你是运营。",
    skills: ["report", "seo"], mcp: ["github"],
    permissions: { write: ["../shared"], read: ["./"], bash: [] },
    model: "opencode-go/x", thinkingLevel: "high",
    head: ["alice"], owner: ["bob"], members: ["alice", "bob"],
  });
});

test("字段缺省：数组为空、permissions 为空对象、可选字段不出现", () => {
  const { fields, issues } = parseConfigFields({});
  expect(issues).toEqual([]);
  expect(fields).toEqual({ skills: [], mcp: [], permissions: {}, head: [], owner: [], members: [] });
});

test("坏条目被跳过并记 issue（不崩、不放大权限）", () => {
  const { fields, issues } = parseConfigFields({
    skills: ["ok", 5, ""],
    permissions: { write: ["./a", "", "  "], bad: "nope", "  ": ["./x"] },
  });
  expect(fields.skills).toEqual(["ok"]);
  expect(fields.permissions).toEqual({ write: ["./a"] });
  expect(issues.length).toBeGreaterThanOrEqual(3);
});

test("非对象 / prompt 非字符串 → 空字段 + issue / 字段缺省", () => {
  const array = parseConfigFields([]);
  expect(array.fields.skills).toEqual([]);
  expect(array.issues.length).toBe(1);
  expect(parseConfigFields({ prompt: 42 }).fields.prompt).toBeUndefined();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/config/schema.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 `src/config/schema.ts`**

```ts
// src/config/schema.ts
/** 五层配置的统一形状（spec §4）。本模块是**纯域**：不依赖任何其它域模块。 */

export type ScopeKind = "space" | "project" | "department" | "agent";

/** 按工具 → 路径列表；路径写法相对**该配置文件所在目录**。 */
export type PermissionTable = Record<string, string[]>;

export type ConfigFields = {
  alias?: string;
  avatar?: string;
  /** 内联提示词（取消所有 AGENTS.md，D5）。 */
  prompt?: string;
  skills: string[];
  mcp: string[];
  permissions: PermissionTable;
  model?: string;
  thinkingLevel?: string;
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
  fields.skills = textArray(raw["skills"], "skills", issues);
  fields.mcp = textArray(raw["mcp"], "mcp", issues);
  fields.head = textArray(raw["head"], "head", issues);
  fields.owner = textArray(raw["owner"], "owner", issues);
  fields.members = textArray(raw["members"], "members", issues);
  fields.permissions = permissionTable(raw["permissions"], issues);
  return { fields, issues };
}
```

- [ ] **Step 4: 写失败测试（命名）**

```ts
// tests/config/naming.test.ts
import { expect, test } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import {
  agentConfigFile, agentIdOfConfigFile, departmentConfigFile, isConfigFileName, projectConfigFile, projectIdOfConfigFile, spaceConfigFile,
} from "../../src/config/naming.ts";

test("四类配置文件的落点（spec §3 / D3 / D26）", () => {
  const ws = createWorkspace("/office");
  expect(spaceConfigFile(ws)).toBe("/office/openstaffs/space.config.json");
  expect(projectConfigFile(ws, "seo")).toBe("/office/projects/seo.project.config.json");
  expect(departmentConfigFile("/office/agents/eng")).toBe("/office/agents/eng/department.config.json");
  expect(agentConfigFile("/office/agents/eng", "alice")).toBe("/office/agents/eng/alice.agent.config.json");
});

test("文件名反解 + 识别", () => {
  expect(agentIdOfConfigFile("/office/agents/eng/alice.agent.config.json")).toBe("alice");
  expect(agentIdOfConfigFile("/office/agents/eng/department.config.json")).toBeUndefined();
  expect(projectIdOfConfigFile("/office/projects/seo.project.config.json")).toBe("seo");
  expect(projectIdOfConfigFile("/office/projects/seo.agent.config.json")).toBeUndefined();
  expect(isConfigFileName("department.config.json")).toBe(true);
  expect(isConfigFileName("space.config.json")).toBe(true);
  expect(isConfigFileName("x.agent.config.json")).toBe(true);
  expect(isConfigFileName("x.project.config.json")).toBe(true);
  expect(isConfigFileName("permission.json")).toBe(false);
  expect(isConfigFileName("mcp.json")).toBe(false);
});
```

- [ ] **Step 5: 实现 `src/config/naming.ts`**

```ts
// src/config/naming.ts
import path from "node:path";
import { projectsDir, spaceDir, type Workspace } from "../domain/paths.ts";

export const SPACE_CONFIG_NAME = "space.config.json";
export const DEPARTMENT_CONFIG_NAME = "department.config.json";
export const AGENT_CONFIG_SUFFIX = ".agent.config.json";
export const PROJECT_CONFIG_SUFFIX = ".project.config.json";

export function spaceConfigFile(ws: Workspace): string {
  return path.join(spaceDir(ws), SPACE_CONFIG_NAME);
}

/** 项目 = 扁平配置文件（D26；无目录、无 data/）。 */
export function projectConfigFile(ws: Workspace, id: string): string {
  return path.join(projectsDir(ws), `${id}${PROJECT_CONFIG_SUFFIX}`);
}

export function departmentConfigFile(dir: string): string {
  return path.join(dir, DEPARTMENT_CONFIG_NAME);
}

export function agentConfigFile(dir: string, id: string): string {
  return path.join(dir, `${id}${AGENT_CONFIG_SUFFIX}`);
}

export function agentIdOfConfigFile(file: string): string | undefined {
  const base = path.basename(file);
  if (!base.endsWith(AGENT_CONFIG_SUFFIX)) return undefined;
  const id = base.slice(0, -AGENT_CONFIG_SUFFIX.length);
  return id === "" ? undefined : id;
}

export function projectIdOfConfigFile(file: string): string | undefined {
  const base = path.basename(file);
  if (!base.endsWith(PROJECT_CONFIG_SUFFIX)) return undefined;
  const id = base.slice(0, -PROJECT_CONFIG_SUFFIX.length);
  return id === "" ? undefined : id;
}

export function isConfigFileName(base: string): boolean {
  return (
    base === SPACE_CONFIG_NAME ||
    base === DEPARTMENT_CONFIG_NAME ||
    base.endsWith(AGENT_CONFIG_SUFFIX) ||
    base.endsWith(PROJECT_CONFIG_SUFFIX)
  );
}
```

- [ ] **Step 6: 写失败测试（加载）**

```ts
// tests/config/load.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { loadAgentConfig, loadProjectConfig, loadSpaceConfig, readConfigFile } from "../../src/config/load.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-cfg-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function write(file: string, body: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`);
}

test("缺失 / 坏 JSON → undefined（不崩）", () => {
  expect(readConfigFile(path.join(root, "none.agent.config.json"), "agent", "none")).toBeUndefined();
  const bad = path.join(root, "bad.agent.config.json");
  write(bad, "{坏");
  expect(readConfigFile(bad, "agent", "bad")).toBeUndefined();
});

test("合法 → baseDir = 文件所在目录；issues 随字段级问题", () => {
  const file = path.join(root, "ok.agent.config.json");
  write(file, { prompt: "你好", skills: ["a", 5] });
  const loaded = readConfigFile(file, "agent", "ok")!;
  expect(loaded.baseDir).toBe(root);
  expect(loaded.fields.prompt).toBe("你好");
  expect(loaded.issues).toHaveLength(1);
});

test("四个作用域加载包装：缺文件 undefined，有文件即读到", () => {
  const ws = createWorkspace(root);
  expect(loadSpaceConfig(ws)).toBeUndefined();
  expect(loadProjectConfig(ws, "seo")).toBeUndefined();
  expect(loadAgentConfig(path.join(root, "agents", "eng"), "alice")).toBeUndefined();
  write(path.join(root, "openstaffs", "space.config.json"), { prompt: "空间" });
  expect(loadSpaceConfig(ws)?.fields.prompt).toBe("空间");
  write(path.join(root, "projects", "seo.project.config.json"), { members: ["alice"] });
  expect(loadProjectConfig(ws, "seo")?.fields.members).toEqual(["alice"]);
  write(path.join(root, "agents", "eng", "alice.agent.config.json"), { alias: "爱丽丝" });
  expect(loadAgentConfig(path.join(root, "agents", "eng"), "alice")?.fields.alias).toBe("爱丽丝");
});
```

- [ ] **Step 7: 实现 `src/config/load.ts`**

```ts
// src/config/load.ts
import fs from "node:fs";
import path from "node:path";
import { agentConfigFile, departmentConfigFile, projectConfigFile, spaceConfigFile } from "./naming.ts";
import { parseConfigFields, type LoadedConfig, type ScopeKind } from "./schema.ts";
import type { Workspace } from "../domain/paths.ts";

/** 读一个 `*.config.json`：缺失 / 坏 JSON / 坏顶层 → undefined（安全降级，不崩）。 */
export function readConfigFile(file: string, scope: ScopeKind, id: string): LoadedConfig | undefined {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const { fields, issues } = parseConfigFields(parsed);
  return { scope, id, file, baseDir: path.dirname(file), fields, issues };
}

export function loadSpaceConfig(ws: Workspace): LoadedConfig | undefined {
  return readConfigFile(spaceConfigFile(ws), "space", "space");
}

export function loadProjectConfig(ws: Workspace, id: string): LoadedConfig | undefined {
  return readConfigFile(projectConfigFile(ws, id), "project", id);
}

/** 部门 id = 相对办公空间的部门路径（展示 / 诊断用）。 */
export function loadDepartmentConfig(dir: string): LoadedConfig | undefined {
  return readConfigFile(departmentConfigFile(dir), "department", path.basename(dir));
}

export function loadAgentConfig(dir: string, id: string): LoadedConfig | undefined {
  return readConfigFile(agentConfigFile(dir, id), "agent", id);
}
```

> `src/config/naming.ts` 依赖 `src/domain/paths.ts`（`projectsDir` / `spaceDir`）；`paths.ts` 只依赖 `node:path`，因此 `config` 仍满足「纯域、无域模块依赖」。

- [ ] **Step 8: 跑测试确认通过**

Run: `npx vitest run tests/config`
Expected: PASS（3 个文件全绿）。

- [ ] **Step 9: 提交**

```bash
git add src/config tests/config
git commit -m "feat(config): 新增 *.config.json 统一解析模块（命名 / 校验 / 加载）"
```

---

## Task 2: `src/config/write.ts` —— permissions 落盘（保字段、坏文件拒写）

**Files:**
- Create: `src/config/write.ts`
- Test: `tests/config/write.test.ts`

**Interfaces:**
- Produces: `appendPermissionPaths(file: string, tool: string, paths: readonly string[]): void`
- 行为契约：`tool` 空 → 抛错；`paths` 清洗后为空 → 空操作（不建文件）；文件缺失 → 新建 `{ permissions: { [tool]: [...] } }`；正常文件 → **保留全部原有字段**，只合并该工具的路径（去重、保序）；坏 JSON / 顶层非对象 / `permissions` 非对象 / 该工具已有值非数组 → **抛错且不写**。

- [ ] **Step 1: 写失败测试**

```ts
// tests/config/write.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { appendPermissionPaths } from "../../src/config/write.ts";

let root = "";
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-cfgwrite-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function write(file: string, body: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`);
}

function read(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

test("缺失文件 → 新建 { permissions: { tool: paths } }（2 空格缩进 + 尾换行 + 无 .tmp）", () => {
  const file = path.join(root, "agents", "eng", "alice.agent.config.json");
  appendPermissionPaths(file, "write", ["/abs/new"]);
  expect(read(file)).toEqual({ permissions: { write: ["/abs/new"] } });
  const raw = fs.readFileSync(file, "utf8");
  expect(raw.endsWith("\n")).toBe(true);
  expect(raw).toContain("  ");
  expect(fs.existsSync(`${file}.tmp`)).toBe(false);
});

test("已有文件：保留全部原有字段，只合并该工具路径（去重保序）", () => {
  const file = path.join(root, "alice.agent.config.json");
  write(file, {
    alias: "爱丽丝",
    model: "opencode-go/x",
    prompt: "你是运营。",
    mcp: ["github"],
    permissions: { write: ["../shared/"], read: ["./"] },
  });
  appendPermissionPaths(file, "write", ["/abs/new", "../shared/", " "]);
  expect(read(file)).toEqual({
    alias: "爱丽丝",
    model: "opencode-go/x",
    prompt: "你是运营。",
    mcp: ["github"],
    permissions: { write: ["../shared/", "/abs/new"], read: ["./"] },
  });
});

test("坏 JSON / 顶层非对象 / permissions 非对象 / 该工具值非数组 → 抛错且不改文件", () => {
  const bad = path.join(root, "bad.agent.config.json");
  write(bad, "{ 坏");
  expect(() => appendPermissionPaths(bad, "write", ["/a"])).toThrow();
  expect(fs.readFileSync(bad, "utf8")).toBe("{ 坏");

  const array = path.join(root, "array.agent.config.json");
  write(array, [1, 2]);
  expect(() => appendPermissionPaths(array, "write", ["/a"])).toThrow();

  const perm = path.join(root, "perm.agent.config.json");
  write(perm, { permissions: { write: "nope" } });
  expect(() => appendPermissionPaths(perm, "write", ["/a"])).toThrow();
  expect(read(perm)).toEqual({ permissions: { write: "nope" } });

  const weird = path.join(root, "weird.agent.config.json");
  write(weird, { permissions: [] });
  expect(() => appendPermissionPaths(weird, "write", ["/a"])).toThrow();
});

test("空 tool 抛错；空 paths 空操作（不建文件）", () => {
  const file = path.join(root, "none.agent.config.json");
  expect(() => appendPermissionPaths(file, "  ", ["/a"])).toThrow();
  appendPermissionPaths(file, "write", ["", "   "]);
  expect(fs.existsSync(file)).toBe(false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/config/write.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

```ts
// src/config/write.ts
import fs from "node:fs";
import path from "node:path";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 把路径追加进配置文件 `permissions[tool]`（去重、保序、原子写）。
 * **保留其它字段**；坏文件一律抛错拒写（宁可不生效，也不清空别人的定义）。
 */
export function appendPermissionPaths(file: string, tool: string, paths: readonly string[]): void {
  const key = tool.trim();
  if (key === "") throw new Error("permissions 的工具名不能为空");
  const cleaned = [...new Set(paths.map((entry) => entry.trim()).filter((entry) => entry !== ""))];
  if (cleaned.length === 0) return;

  let root: Record<string, unknown> = {};
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    // 文件缺失：新建
  }
  if (raw.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`配置文件不是合法 JSON，拒绝覆盖：${file}`);
    }
    if (!isPlainObject(parsed)) throw new Error(`配置文件顶层必须是对象，拒绝覆盖：${file}`);
    root = parsed;
  }

  const current = root["permissions"];
  if (current !== undefined && !isPlainObject(current)) {
    throw new Error(`permissions 必须是对象，拒绝覆盖：${file}`);
  }
  const table = (current ?? {}) as Record<string, unknown>;
  const existingRaw = table[key];
  if (existingRaw !== undefined && !Array.isArray(existingRaw)) {
    throw new Error(`permissions.${key} 必须是字符串数组，拒绝覆盖：${file}`);
  }
  const existing = Array.isArray(existingRaw)
    ? existingRaw.filter((entry): entry is string => typeof entry === "string")
    : [];
  const merged = [...existing];
  for (const entry of cleaned) {
    if (!merged.includes(entry)) merged.push(entry);
  }
  table[key] = merged;
  root["permissions"] = table;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(root, null, 2)}\n`);
  fs.renameSync(tmp, file);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/config/write.test.ts`
Expected: PASS（4 passed）。

- [ ] **Step 5: 提交**

```bash
git add src/config/write.ts tests/config/write.test.ts
git commit -m "feat(config): permissions 落盘改为追加进 *.config.json（保字段、坏文件拒写）"
```

---

## Task 3: `src/permissions/` —— 默认值、解析、累加、匹配

**Files:**
- Create: `src/permissions/types.ts`、`src/permissions/defaults.ts`、`src/permissions/resolve.ts`、`src/permissions/match.ts`
- Test: `tests/permissions/resolve.test.ts`、`tests/permissions/match.test.ts`

**Interfaces:**
- Consumes: `PermissionTable`（`src/config/schema.ts`）
- Produces:
  - `type ResolvedPermissions = Record<string, string[]>`（绝对路径）
  - `DEFAULT_PERMISSIONS: Readonly<PermissionTable>`、`defaultPathsFor(tool)`、`defaultPermissionTable(extraTools?)`
  - `resolvePermissionTable(table, baseDir): ResolvedPermissions`
  - `accumulatePermissions(sources: readonly ResolvedPermissions[]): ResolvedPermissions`
  - `matchesPath(patterns: readonly string[], targetAbs: string): boolean`
  - `isSubsetOf(requested: readonly string[], granted: readonly string[]): boolean`

- [ ] **Step 1: 写失败测试（解析 / 累加）**

```ts
// tests/permissions/resolve.test.ts
import { expect, test } from "vitest";
import { accumulatePermissions, resolvePermissionTable } from "../../src/permissions/resolve.ts";
import { DEFAULT_PERMISSIONS, defaultPathsFor, defaultPermissionTable } from "../../src/permissions/defaults.ts";

test("相对路径按 baseDir 归一；绝对路径原样；空工具名跳过", () => {
  const table = resolvePermissionTable(
    { write: ["../shared"], read: ["./"], bash: ["/"], "  ": ["./x"] },
    "/office/agents/alice",
  );
  expect(table["write"]).toEqual(["/office/agents/shared"]);
  expect(table["read"]).toEqual(["/office/agents/alice"]);
  expect(table["bash"]).toEqual(["/"]);
  expect(table[""]).toBeUndefined();
});

test("累加：同名工具按来源顺序拼接、接受同值重复、不覆盖", () => {
  const merged = accumulatePermissions([
    { write: ["/a"] },
    { write: ["/b"], read: ["/c"] },
    { write: ["/a"] },
    {},
  ]);
  expect(merged["write"]).toEqual(["/a", "/b", "/a"]);
  expect(merged["read"]).toEqual(["/c"]);
});

test("默认值：write 空、read/bash 为 ./；未登记的新工具默认空（D14）", () => {
  expect(DEFAULT_PERMISSIONS).toEqual({ write: [], read: ["./"], bash: ["./"] });
  expect(defaultPathsFor("bash")).toEqual(["./"]);
  expect(defaultPathsFor("future_tool")).toEqual([]);
  expect(defaultPermissionTable(["future_tool"])).toEqual({
    write: [], read: ["./"], bash: ["./"], future_tool: [],
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/permissions/resolve.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 `types.ts` / `defaults.ts` / `resolve.ts`**

```ts
// src/permissions/types.ts
import type { PermissionTable } from "../config/schema.ts";

export type { PermissionTable };

/** 解析为**绝对路径**后的权限表。 */
export type ResolvedPermissions = Record<string, string[]>;

/** 运行时授予（D13，不落盘）。 */
export type RuntimeGrants = {
  /** agent 自己的工作目录 → 所有工具。 */
  workdir: string;
  /** 技能库根 → read（否则 agent 读不到技能正文）。 */
  readRoots: string[];
  /** 主管对管理子树的写权。 */
  managedWriteDirs: string[];
};

/** 落盘路线的一层（D11）：项目 / 员工配置的 permissions + 其所在目录。 */
export type OnDiskPermissions = { table: PermissionTable; baseDir: string };
```

```ts
// src/permissions/defaults.ts
import type { PermissionTable } from "../config/schema.ts";

/** 新建设置：write 空、read / bash 为 ./；**新工具默认空**（D14）。 */
export const DEFAULT_PERMISSIONS: Readonly<PermissionTable> = { write: [], read: ["./"], bash: ["./"] };

/** 某工具的默认路径（未登记的工具 = 空）。 */
export function defaultPathsFor(tool: string): string[] {
  return [...(DEFAULT_PERMISSIONS[tool] ?? [])];
}

/** 新建 agent / 项目时写入的 permissions 表。 */
export function defaultPermissionTable(extraTools: readonly string[] = []): PermissionTable {
  const table: PermissionTable = { write: [], read: ["./"], bash: ["./"] };
  for (const tool of extraTools) {
    if (tool.trim() !== "" && table[tool] === undefined) table[tool] = [];
  }
  return table;
}
```

```ts
// src/permissions/resolve.ts
import path from "node:path";
import type { PermissionTable } from "../config/schema.ts";
import type { ResolvedPermissions } from "./types.ts";

/** 相对路径按 baseDir 归一为绝对路径（与旧 permission.json 的相对语义一致）。 */
export function resolvePermissionTable(table: PermissionTable, baseDir: string): ResolvedPermissions {
  const out: ResolvedPermissions = {};
  for (const [rawTool, paths] of Object.entries(table)) {
    const tool = rawTool.trim();
    if (tool === "") continue;
    out[tool] = paths.filter((entry) => entry.trim() !== "").map((entry) => path.resolve(baseDir, entry.trim()));
  }
  return out;
}

/** 累加：同名工具按来源顺序拼接，**接受同值重复、不覆盖**（D10）。 */
export function accumulatePermissions(sources: readonly ResolvedPermissions[]): ResolvedPermissions {
  const out: ResolvedPermissions = {};
  for (const source of sources) {
    for (const [tool, paths] of Object.entries(source)) {
      (out[tool] ??= []).push(...paths);
    }
  }
  return out;
}
```

- [ ] **Step 4: 写失败测试（匹配 / 子集）**

```ts
// tests/permissions/match.test.ts
import { expect, test } from "vitest";
import { isSubsetOf, matchesPath } from "../../src/permissions/match.ts";

test("相等或在其下命中；不误命中兄弟目录", () => {
  expect(matchesPath(["/office/agents/alice"], "/office/agents/alice")).toBe(true);
  expect(matchesPath(["/office/agents/alice"], "/office/agents/alice/data/a.md")).toBe(true);
  expect(matchesPath(["/office/agents/alice/data"], "/office/agents/alice/data2/x.md")).toBe(false);
  expect(matchesPath(["/office/agents/alice/data"], "/office/agents/alice/dataX")).toBe(false);
});

test("空集不命中；大小写敏感；\"/\" 命中全盘", () => {
  expect(matchesPath([], "/etc/passwd")).toBe(false);
  expect(matchesPath(["/Shared"], "/shared/a")).toBe(false);
  expect(matchesPath(["/"], "/etc/passwd")).toBe(true);
  expect(matchesPath(["/"], "/")).toBe(true);
});

test("isSubsetOf：请求 ⊆ 授予（子目录可授，父目录不可授）", () => {
  expect(isSubsetOf(["/office/agents/alice/data"], ["/office/agents/alice"])).toBe(true);
  expect(isSubsetOf(["/office/agents/alice"], ["/office/agents/alice/data"])).toBe(false);
  expect(isSubsetOf(["/a", "/b"], ["/a"])).toBe(false);
  expect(isSubsetOf([], ["/a"])).toBe(true);
  expect(isSubsetOf(["/a"], [])).toBe(false);
});
```

- [ ] **Step 5: 实现 `src/permissions/match.ts`**

```ts
// src/permissions/match.ts
import path from "node:path";

/** targetAbs 命中任一 pattern（相等或在其下）即 true。pattern 必须是绝对路径。 */
export function matchesPath(patterns: readonly string[], targetAbs: string): boolean {
  return patterns.some((pattern) => {
    const root = path.parse(pattern).root;
    return targetAbs === pattern || targetAbs.startsWith(pattern === root ? root : pattern + path.sep);
  });
}

/** 请求集 ⊆ 授予集（每个请求路径都落在某个授予路径之内）。 */
export function isSubsetOf(requested: readonly string[], granted: readonly string[]): boolean {
  return requested.every((target) => matchesPath(granted, target));
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run tests/permissions`
Expected: PASS（2 个文件全绿）。

- [ ] **Step 7: 提交**

```bash
git add src/permissions tests/permissions
git commit -m "feat(perm): 新增按工具权限的默认值、解析、累加与路径匹配"
```

---

## Task 4: `src/permissions/` —— 运行时有效集与 attenuation

**Files:**
- Create: `src/permissions/effective.ts`、`src/permissions/runtime.ts`、`src/permissions/attenuation.ts`
- Test: `tests/permissions/effective.test.ts`、`tests/permissions/attenuation.test.ts`

**Interfaces:**
- Consumes: `resolvePermissionTable` / `accumulatePermissions`（Task 3）、`matchesPath` / `isSubsetOf`（Task 3）、`spaceSkillsDir`（`src/domain/paths.ts`）、`FRAMEWORK_SKILLS_DIR`（`src/domain/skills.ts`）、`managedSubtreeOf(ws, agentId)`（P2 的 `src/domain/org.ts` **按跨计划裁定 B2 新增的适配器**，见「跨阶段假设」）
- Produces:
  - `effectivePermissions(input: { onDisk: readonly OnDiskPermissions[]; runtime: RuntimeGrants }): ResolvedPermissions`
  - `pathsFor(effective: ResolvedPermissions, tool: string, workdir: string): string[]`
  - `runtimeGrantsFor(input: { ws: Workspace; agentId: string; workdir: string; extraReadRoots?: readonly string[] }): RuntimeGrants`
  - `checkAttenuation(requested: PermissionTable, requestedBaseDir: string, writer: ResolvedPermissions, workdir: string): { ok: true } | { ok: false; violations: { tool: string; paths: string[] }[] }`

- [ ] **Step 1: 写失败测试（有效集）**

```ts
// tests/permissions/effective.test.ts
import { expect, test } from "vitest";
import { effectivePermissions, pathsFor } from "../../src/permissions/effective.ts";

const runtime = {
  workdir: "/office/work/alice",
  readRoots: ["/office/openstaffs/skills", "/framework/skills"],
  managedWriteDirs: ["/office/agents/eng"],
};

test("有效集 = 落盘累加 + 运行时工作目录（所有工具）+ 主管写权（write）+ 技能根（read）", () => {
  const perms = effectivePermissions({
    onDisk: [
      { table: { write: [], read: ["./"], bash: ["./"] }, baseDir: "/office/projects" },
      { table: { write: [], read: ["./"], bash: ["./"] }, baseDir: "/office/agents/eng" },
    ],
    runtime,
  });
  expect(perms["write"]).toEqual(["/office/work/alice", "/office/agents/eng"]);
  expect(perms["read"]).toEqual([
    "/office/projects", "/office/agents/eng", "/office/work/alice", "/office/openstaffs/skills", "/framework/skills",
  ]);
  expect(perms["bash"]).toEqual(["/office/projects", "/office/agents/eng", "/office/work/alice"]);
});

test("未登记的工具：pathsFor 只回运行时工作目录（D13① / 新工具默认空 D14）", () => {
  const perms = effectivePermissions({ onDisk: [], runtime });
  expect(perms["write"]).toEqual(["/office/work/alice"]);
  expect(pathsFor(perms, "future_tool", "/office/work/alice")).toEqual(["/office/work/alice"]);
  expect(pathsFor(perms, "write", "/office/work/alice")).toEqual(["/office/work/alice"]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/permissions/effective.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 `src/permissions/effective.ts`**

```ts
// src/permissions/effective.ts
import { accumulatePermissions, resolvePermissionTable } from "./resolve.ts";
import { DEFAULT_PERMISSIONS } from "./defaults.ts";
import type { OnDiskPermissions, ResolvedPermissions, RuntimeGrants } from "./types.ts";

/**
 * 有效权限 = 落盘路线（项目 → 员工，D11）累加后，再叠加**运行时授予**（D13）：
 * ① 自己的工作目录 → 所有工具；② 主管对管理子树的写权；③ 技能库根 → read。
 */
export function effectivePermissions(input: {
  onDisk: readonly OnDiskPermissions[];
  runtime: RuntimeGrants;
}): ResolvedPermissions {
  const resolved = accumulatePermissions(input.onDisk.map((source) => resolvePermissionTable(source.table, source.baseDir)));
  const tools = new Set<string>([...Object.keys(DEFAULT_PERMISSIONS), ...Object.keys(resolved)]);
  for (const tool of tools) {
    const paths = resolved[tool] ?? [];
    paths.push(input.runtime.workdir);
    if (tool === "write") paths.push(...input.runtime.managedWriteDirs);
    if (tool === "read") paths.push(...input.runtime.readRoots);
    resolved[tool] = paths;
  }
  return resolved;
}

/** 某工具的有效路径：未登记的工具 = 只有运行时工作目录。 */
export function pathsFor(effective: ResolvedPermissions, tool: string, workdir: string): string[] {
  return [...(effective[tool] ?? [workdir])];
}
```

- [ ] **Step 4: 写失败测试（attenuation）**

```ts
// tests/permissions/attenuation.test.ts
import { expect, test } from "vitest";
import { checkAttenuation } from "../../src/permissions/attenuation.ts";
import { effectivePermissions } from "../../src/permissions/effective.ts";

const writer = effectivePermissions({
  onDisk: [{ table: { write: ["../eng", "../../work/alice"], read: ["./"], bash: [] }, baseDir: "/office/agents/alice" }],
  runtime: { workdir: "/office/work/alice", readRoots: [], managedWriteDirs: [] },
});

test("请求 ⊆ 写者有效集 → ok（子目录可授）", () => {
  expect(checkAttenuation({ write: ["./platform"] }, "/office/agents/eng", writer, "/office/work/alice")).toEqual({ ok: true });
  expect(checkAttenuation({}, "/office/agents/eng", writer, "/office/work/alice")).toEqual({ ok: true });
  expect(checkAttenuation({ write: [] }, "/office/agents/eng", writer, "/office/work/alice")).toEqual({ ok: true });
});

test("越界 → 报出越界的工具与路径（父目录 / 界外 / 别的工具）", () => {
  const bad = checkAttenuation(
    { write: ["/etc", "../..", "/office/agents/eng"], read: ["/office/agents/bob"] },
    "/office/agents/eng/platform",
    writer,
    "/office/work/alice",
  );
  expect(bad.ok).toBe(false);
  if (bad.ok) return;
  expect(bad.violations).toEqual([
    { tool: "write", paths: ["/etc", "/office/agents"] },
    { tool: "read", paths: ["/office/agents/bob"] },
  ]);
});
```

> 说明：`{ read: [...] }` 在上面第二条用例里，写者的 `read` 有效集 = `/office/agents/alice`（它自己配置里的 `./`）+ 运行时工作目录，所以 `/office/agents/bob` 越界。

- [ ] **Step 5: 实现 `attenuation.ts` 与 `runtime.ts`**

```ts
// src/permissions/attenuation.ts
import { matchesPath } from "./match.ts";
import { pathsFor } from "./effective.ts";
import { resolvePermissionTable } from "./resolve.ts";
import type { PermissionTable } from "../config/schema.ts";
import type { ResolvedPermissions } from "./types.ts";

export type AttenuationViolation = { tool: string; paths: string[] };

/**
 * 写入校验（D15 / D28，全工具统一、与工具语义无关）：
 * 请求里每个工具的每条路径，都必须落在写者该工具的**有效集**之内。
 */
export function checkAttenuation(
  requested: PermissionTable,
  requestedBaseDir: string,
  writer: ResolvedPermissions,
  workdir: string,
): { ok: true } | { ok: false; violations: AttenuationViolation[] } {
  const resolved = resolvePermissionTable(requested, requestedBaseDir);
  const violations: AttenuationViolation[] = [];
  for (const [tool, paths] of Object.entries(resolved)) {
    const granted = pathsFor(writer, tool, workdir);
    const outside = paths.filter((target) => !matchesPath(granted, target));
    if (outside.length > 0) violations.push({ tool, paths: outside });
  }
  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}
```

```ts
// src/permissions/runtime.ts
import { managedSubtreeOf } from "../domain/org.ts";
import { spaceSkillsDir, type Workspace } from "../domain/paths.ts";
import { FRAMEWORK_SKILLS_DIR } from "../domain/skills.ts";
import type { RuntimeGrants } from "./types.ts";

/** 运行时授予（D13）：自己的工作目录（所有工具）+ 主管写权 + 技能库根（read）。 */
export function runtimeGrantsFor(input: {
  ws: Workspace;
  agentId: string;
  workdir: string;
  extraReadRoots?: readonly string[];
}): RuntimeGrants {
  const subtree = managedSubtreeOf(input.ws, input.agentId);
  return {
    workdir: input.workdir,
    readRoots: [spaceSkillsDir(input.ws), ...(input.extraReadRoots ?? []), FRAMEWORK_SKILLS_DIR],
    managedWriteDirs: [...subtree.departmentDirs, ...subtree.agentDirs],
  };
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run tests/permissions`
Expected: PASS（4 个文件全绿）。

- [ ] **Step 7: 提交**

```bash
git add src/permissions tests/permissions
git commit -m "feat(perm): 有效权限（运行时授予）与 attenuation 校验"
```

---

## Task 5: `src/capabilities/` —— 累加装配、技能引用解析、作用域链

**Files:**
- Create: `src/capabilities/assemble.ts`、`src/capabilities/skills.ts`、`src/capabilities/scopes.ts`
- Test: `tests/capabilities/assemble.test.ts`、`tests/capabilities/skills.test.ts`、`tests/capabilities/scopes.test.ts`

**Interfaces:**
- Consumes: `LoadedConfig`（Task 1）、`loadSpaceConfig` / `loadProjectConfig` / `loadDepartmentConfig` / `loadAgentConfig`（Task 1）、`spaceSkillsDir`（`src/domain/paths.ts`）、`loadOrg` / `findPerson` / `ancestryOf`（P2 的 `src/domain/org.ts`，见「跨阶段假设」）
- Produces:
  - `assembleCapabilities(scopes: readonly LoadedConfig[]): { prompt: string; skills: string[]; mcp: string[] }`
  - `resolveSkillRefs(ws, names: readonly string[], extraRoots?: readonly string[]): { resolved: { name: string; dir: string }[]; missing: string[] }`
  - `scopeChain(input: { ws; agentId; agentDir; departmentDirs; projectId? }): LoadedConfig[]`
  - `scopesForOrg(ws, agentId, projectId?): LoadedConfig[]`

- [ ] **Step 1: 写失败测试（累加）**

```ts
// tests/capabilities/assemble.test.ts
import { expect, test } from "vitest";
import { assembleCapabilities } from "../../src/capabilities/assemble.ts";
import type { LoadedConfig } from "../../src/config/schema.ts";

function cfg(scope: LoadedConfig["scope"], id: string, fields: Partial<LoadedConfig["fields"]>): LoadedConfig {
  return {
    scope,
    id,
    file: `/x/${id}`,
    baseDir: "/x",
    fields: { skills: [], mcp: [], permissions: {}, head: [], owner: [], members: [], ...fields },
    issues: [],
  };
}

test("prompt 累加（换行分割）、skills / mcp 累加且接受重复", () => {
  const caps = assembleCapabilities([
    cfg("space", "space", { prompt: "空间总纲", skills: ["report"], mcp: ["github"] }),
    cfg("department", "eng", { prompt: "部门规矩", skills: ["report"] }),
    cfg("project", "seo", { prompt: "项目规范", skills: ["seo"], mcp: ["github"] }),
    cfg("agent", "alice", { prompt: "你是运营。" }),
  ]);
  expect(caps.prompt).toBe("空间总纲\n部门规矩\n项目规范\n你是运营。");
  expect(caps.skills).toEqual(["report", "report", "seo"]);
  expect(caps.mcp).toEqual(["github", "github"]);
});

test("空 prompt 段被跳过；全空 → 空串与空数组", () => {
  expect(assembleCapabilities([cfg("space", "space", {}), cfg("agent", "alice", { prompt: "   " })])).toEqual({
    prompt: "", skills: [], mcp: [],
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/capabilities/assemble.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 `src/capabilities/assemble.ts`**

```ts
// src/capabilities/assemble.ts
import type { LoadedConfig } from "../config/schema.ts";

/** 作用域链装配结果（D12）：一律累加，无覆盖、无优先级。 */
export type Capabilities = { prompt: string; skills: string[]; mcp: string[] };

export function assembleCapabilities(scopes: readonly LoadedConfig[]): Capabilities {
  const prompts: string[] = [];
  const skills: string[] = [];
  const mcp: string[] = [];
  for (const scope of scopes) {
    if (scope.fields.prompt !== undefined && scope.fields.prompt.trim() !== "") prompts.push(scope.fields.prompt);
    skills.push(...scope.fields.skills);
    mcp.push(...scope.fields.mcp);
  }
  return { prompt: prompts.join("\n"), skills, mcp };
}
```

- [ ] **Step 4: 写失败测试（技能引用解析）**

```ts
// tests/capabilities/skills.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { resolveSkillRefs } from "../../src/capabilities/skills.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-skillref-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function skill(dir: string, name: string): void {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\n---\n正文`);
}

test("按名解析到 openstaffs/skills/<技能名>/；缺失进 missing（不崩）", () => {
  const ws = createWorkspace(root);
  const spaceSkills = path.join(root, "openstaffs", "skills");
  skill(spaceSkills, "report");
  const result = resolveSkillRefs(ws, ["report", "nope", "report"]);
  expect(result.resolved).toEqual([{ name: "report", dir: path.join(spaceSkills, "report") }]);
  expect(result.missing).toEqual(["nope"]);
});

test("外部技能根作为后备（老板配的 skillPaths），同名先命中者胜", () => {
  const ws = createWorkspace(root);
  const extra = path.join(root, "external-skills");
  skill(path.join(root, "openstaffs", "skills"), "report");
  skill(extra, "report");
  skill(extra, "only-external");
  expect(resolveSkillRefs(ws, ["report"]).resolved[0]!.dir).toBe(path.join(root, "openstaffs", "skills", "report"));
  expect(resolveSkillRefs(ws, ["only-external"], [extra]).resolved[0]!.dir).toBe(path.join(extra, "only-external"));
});

test("不安全的技能名（含 / 或 .. 或点开头）→ missing，不探测目录", () => {
  const ws = createWorkspace(root);
  expect(resolveSkillRefs(ws, ["../etc", "a/b", ".hidden"]).missing).toEqual(["../etc", "a/b", ".hidden"]);
});
```

- [ ] **Step 5: 实现 `src/capabilities/skills.ts`**

```ts
// src/capabilities/skills.ts
import fs from "node:fs";
import path from "node:path";
import { spaceSkillsDir, type Workspace } from "../domain/paths.ts";

export type SkillRef = { name: string; dir: string };

/** 技能名必须能安全拼进路径：非空、无空白 / 路径分隔符 / NUL、不以点开头。 */
function isSafeSkillName(name: string): boolean {
  return (
    name.trim() !== "" &&
    !/\s/u.test(name) &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0") &&
    !name.startsWith(".")
  );
}

/**
 * 按名解析技能（D17）：主根 `openstaffs/skills/`，后备是老板配的外部技能库；
 * 缺失 / 不安全的名字进 missing（不抛）。去重保序（先出现者胜）。
 */
export function resolveSkillRefs(
  ws: Workspace,
  names: readonly string[],
  extraRoots: readonly string[] = [],
): { resolved: SkillRef[]; missing: string[] } {
  const roots = [spaceSkillsDir(ws), ...extraRoots];
  const resolved: SkillRef[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const rawName of names) {
    const name = rawName.trim();
    if (seen.has(name)) continue;
    if (!isSafeSkillName(name)) {
      missing.push(name);
      continue;
    }
    const hit = roots.map((root) => path.join(root, name)).find((dir) => fs.existsSync(path.join(dir, "SKILL.md")));
    if (hit === undefined) {
      missing.push(name);
      continue;
    }
    seen.add(name);
    resolved.push({ name, dir: hit });
  }
  return { resolved, missing };
}
```

- [ ] **Step 6: 写失败测试（作用域链）**

```ts
// tests/capabilities/scopes.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { scopeChain } from "../../src/capabilities/scopes.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-chain-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function write(file: string, body: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
}

test("顺序 = 空间 → 部门（根 → 叶）→ 项目（仅群聊）→ 员工；缺失层跳过", () => {
  const ws = createWorkspace(root);
  write(path.join(root, "openstaffs", "space.config.json"), { prompt: "空间" });
  write(path.join(root, "agents", "eng", "department.config.json"), { prompt: "eng" });
  write(path.join(root, "agents", "eng", "platform", "department.config.json"), { prompt: "platform" });
  write(path.join(root, "projects", "seo.project.config.json"), { prompt: "seo" });
  write(path.join(root, "agents", "eng", "platform", "bob.agent.config.json"), { prompt: "bob" });
  const dirs = [path.join(root, "agents", "eng"), path.join(root, "agents", "eng", "platform")];

  expect(
    scopeChain({ ws, agentId: "bob", agentDir: dirs[1]!, departmentDirs: dirs, projectId: "seo" }).map((c) => c.id + ":" + c.fields.prompt),
  ).toEqual(["space:空间", "eng:eng", "platform:platform", "seo:seo", "bob:bob"]);

  expect(
    scopeChain({ ws, agentId: "bob", agentDir: dirs[1]!, departmentDirs: dirs }).map((c) => c.scope),
  ).toEqual(["space", "department", "department", "agent"]);
});

test("部门链去重；部门无配置文件则跳过该层", () => {
  const ws = createWorkspace(root);
  write(path.join(root, "agents", "eng", "alice.agent.config.json"), { prompt: "alice" });
  const chain = scopeChain({
    ws, agentId: "alice", agentDir: path.join(root, "agents", "eng"),
    departmentDirs: [path.join(root, "agents", "eng"), path.join(root, "agents", "eng")],
  });
  expect(chain.map((c) => c.id)).toEqual(["alice"]);
});
```

- [ ] **Step 7: 实现 `src/capabilities/scopes.ts`**

```ts
// src/capabilities/scopes.ts
import { ancestryOf, findPerson, loadOrg } from "../domain/org.ts";
import { loadAgentConfig, loadDepartmentConfig, loadProjectConfig, loadSpaceConfig } from "../config/load.ts";
import type { LoadedConfig } from "../config/schema.ts";
import type { Workspace } from "../domain/paths.ts";

/**
 * 能力累加路线（D12）：空间 → 部门（根 → 叶）→ 项目（仅群聊）→ 员工。
 * 纯函数式接缝：只吃目录，不依赖 org；缺配置的层直接跳过。
 */
export function scopeChain(input: {
  ws: Workspace;
  agentId: string;
  agentDir: string;
  departmentDirs: readonly string[];
  projectId?: string;
}): LoadedConfig[] {
  const out: LoadedConfig[] = [];
  const space = loadSpaceConfig(input.ws);
  if (space !== undefined) out.push(space);
  for (const dir of [...new Set(input.departmentDirs)]) {
    const department = loadDepartmentConfig(dir);
    if (department !== undefined) out.push(department);
  }
  if (input.projectId !== undefined) {
    const project = loadProjectConfig(input.ws, input.projectId);
    if (project !== undefined) out.push(project);
  }
  const agent = loadAgentConfig(input.agentDir, input.agentId);
  if (agent !== undefined) out.push(agent);
  return out;
}

/** 作用域链的 org 接缝（P2 的 org.ts 只在这里被读到）。 */
export function scopesForOrg(ws: Workspace, agentId: string, projectId?: string): LoadedConfig[] {
  const tree = loadOrg(ws);
  const person = findPerson(tree, agentId);
  if (person === undefined) return [];
  return scopeChain({
    ws,
    agentId,
    agentDir: person.dir,
    departmentDirs: ancestryOf(tree, person.departmentPath).map((department) => department.dir),
    ...(projectId === undefined ? {} : { projectId }),
  });
}
```

- [ ] **Step 8: 跑测试确认通过**

Run: `npx vitest run tests/capabilities`
Expected: PASS（3 个文件全绿）。`scopes.test.ts` 只测 `scopeChain`、不导入 `org.ts`，因此不依赖 P2。

- [ ] **Step 9: 提交**

```bash
git add src/capabilities tests/capabilities
git commit -m "feat(cap): 作用域链累加装配与 skills 按名引用解析"
```

---

## Task 6: MCP —— 全局定义 `openstaffs/mcps.json` + 按名引用

**Files:**
- Modify: `src/domain/mcp.ts`、`src/harness/mcp-manager.ts`、`src/server/main.ts`
- Delete: `src/mcp.json`
- Test: `tests/domain/mcp.test.ts`（重写）、`tests/harness/mcp-manager.test.ts`（改夹具）、`tests/harness/mcp-harness.test.ts`（改夹具）

**Interfaces:**
- Consumes: `spaceDir`（`src/domain/paths.ts`）、`readMcpCredentials`（`src/domain/config.ts`）
- Produces:
  - `mcpDefinitionsFile(ws): string` = `<space>/mcps.json`
  - `type McpSelection = { name: string; config: McpServerConfig }`
  - `type McpSessionResolver = { extensionsFor(names: readonly string[]): string[] }`
  - `mcpExtensionName(server: string): string` = `mcp:global:<server>`
  - `loadMcpSnapshot(ws): { source: McpSource }`、`resolveMcpServers(snapshot, names): { selections; missing }`
  - 删除：`SYSTEM_MCP_FILE`、`McpScope`、`mcpScopeKey`、按层的 `sourcesFor`；`McpManager` 的 `systemFile` 选项。

- [ ] **Step 1: 重写 `tests/domain/mcp.test.ts`**

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { mcpDefinitionsFile, loadMcpSnapshot, mcpExtensionName, mcpToolName, resolveMcpServers } from "../../src/domain/mcp.ts";

let root = "";
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-mcp-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function writeJson(file: string, body: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
}

describe("全局 mcps.json + 按名引用（D16）", () => {
  it("定义落在 openstaffs/mcps.json；按名选择保留配置顺序", () => {
    const ws = createWorkspace(root);
    expect(mcpDefinitionsFile(ws)).toBe(path.join(root, "openstaffs", "mcps.json"));
    writeJson(mcpDefinitionsFile(ws), {
      mcpServers: { github: { command: "gh-mcp" }, files: { command: "fs-mcp", args: ["--root", "."] } },
    });
    const snapshot = loadMcpSnapshot(ws);
    const selected = resolveMcpServers(snapshot, ["files", "github"]);
    expect(selected.missing).toEqual([]);
    expect(selected.selections.map((item) => [item.name, item.config.command])).toEqual([
      ["files", "fs-mcp"],
      ["github", "gh-mcp"],
    ]);
  });

  it("未定义的 mcp 名 → missing（不崩、不抛）", () => {
    const ws = createWorkspace(root);
    writeJson(mcpDefinitionsFile(ws), { mcpServers: { github: { command: "gh-mcp" } } });
    const selected = resolveMcpServers(loadMcpSnapshot(ws), ["github", "nope"]);
    expect(selected.selections.map((item) => item.name)).toEqual(["github"]);
    expect(selected.missing).toEqual(["nope"]);
  });

  it("缺失文件 / 坏 JSON / 非法 server → 降级：空选择 + errors（不崩）", () => {
    const ws = createWorkspace(root);
    expect(loadMcpSnapshot(ws).source.servers).toEqual([]);
    writeJson(mcpDefinitionsFile(ws), { mcpServers: { "bad.name": { command: "x" } } });
    const snapshot = loadMcpSnapshot(ws);
    expect(snapshot.source.servers).toEqual([]);
    expect(snapshot.source.invalid).toEqual(["bad.name"]);
    expect(snapshot.source.errors.length).toBeGreaterThan(0);
  });

  it("扩展名与工具名：mcp:global:<server> / mcp__<server>__<tool>", () => {
    expect(mcpExtensionName("github")).toBe("mcp:global:github");
    expect(mcpToolName("github", "create_issue")).toBe("mcp__github__create_issue");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/domain/mcp.test.ts`
Expected: FAIL —— `mcpDefinitionsFile` 未定义。

- [ ] **Step 3: 改造 `src/domain/mcp.ts`**

按下面要点改写（保留既有的 `parseServer` / `interpolate` / `CREDENTIAL_REF` / `SAFE_SERVER_NAME` / `McpServerConfig` / `mcpToolName` 逻辑不动）：

```ts
// src/domain/mcp.ts（改造后的头部与关键函数）
export const MCP_DEFINITIONS_FILE_NAME = "mcps.json";
export const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 60_000;
export const MCP_DEFERRED_THRESHOLD = 20;

export type McpSource = { file: string; servers: McpServerConfig[]; invalid: string[]; errors: string[] };
export type McpSnapshot = { source: McpSource };
export type McpSelection = { name: string; config: McpServerConfig };

/** 会话装配层需要的查询接口（实现见 McpManager，测试可注入假实现）。 */
export type McpSessionResolver = { extensionsFor(names: readonly string[]): string[] };

export function mcpDefinitionsFile(ws: Workspace): string {
  return path.join(spaceDir(ws), MCP_DEFINITIONS_FILE_NAME);
}

export function mcpExtensionName(server: string): string {
  return `mcp:global:${server}`;
}

/** 读全局定义文件：缺失视为空；坏 JSON / 坏 server 记在 errors。 */
export function readMcpSource(file: string, credentials: McpCredentials): McpSource {
  // 与旧实现同体，去掉 scope 参数与 source.scope 字段；cwd 相对该文件所在目录解析。
}

/** 启动快照：只读 openstaffs/mcps.json（D16）。 */
export function loadMcpSnapshot(ws: Workspace): McpSnapshot {
  const credentials = readMcpCredentials(ws);
  return { source: readMcpSource(mcpDefinitionsFile(ws), credentials) };
}

/** 按名解析（引用顺序即装配顺序）；未定义 → missing，非法定义 → 跳过（errors 已记录）。 */
export function resolveMcpServers(
  snapshot: McpSnapshot,
  names: readonly string[],
): { selections: McpSelection[]; missing: string[] } {
  const byName = new Map(snapshot.source.servers.map((config) => [config.name, config]));
  const selections: McpSelection[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const rawName of names) {
    const name = rawName.trim();
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    if (snapshot.source.invalid.includes(name)) continue;
    const config = byName.get(name);
    if (config === undefined) {
      missing.push(name);
      continue;
    }
    selections.push({ name, config });
  }
  return { selections, missing };
}
```

删除：`SYSTEM_MCP_FILE`、`McpScope`、`McpSource.scope`、`mcpScopeKey`、`sourcesFor`、`loadMcpSnapshot` 的 `options` 参数。凭据缺失文案里的目录名 `.openstaffs/config.json` 暂不改（P4 负责搬家）。

- [ ] **Step 4: 改造 `src/harness/mcp-manager.ts`**

- `McpManagerOptions` 去掉 `systemFile`。
- `start()`：`this.#snapshot = loadMcpSnapshot(this.#ws)`；runtimes 来自 `this.#snapshot.source.servers`（key = `mcpExtensionName(config.name)`；`selection` 去掉 `scope`）。
- `Runtime` 去掉 `scope` 字段（`createMcpExtension` 的 `scopeKey` 传 `"global"`）。
- `extensionsFor(names: readonly string[])`：

```ts
extensionsFor(names: readonly string[]): string[] {
  const byKey = new Map(this.#runtimes.map((runtime) => [runtime.key, runtime]));
  const out: string[] = [];
  for (const selection of resolveMcpServers(this.#snapshot, names).selections) {
    const runtime = byKey.get(mcpExtensionName(selection.name));
    if (runtime?.extension !== undefined) out.push(runtime.extension.name);
  }
  return out;
}
```

- 删除 `import type { Relation }`（若不再使用）。

- [ ] **Step 5: 改 `src/server/main.ts` 与删 `src/mcp.json`**

```ts
mcp = new McpManager({ ws });   // 去掉 systemFile
```

```bash
git rm src/mcp.json
```

- [ ] **Step 6: 改两个 harness 测试的夹具**

- `tests/harness/mcp-manager.test.ts`：`manager()` 去掉 `systemFile` 形参与 `McpManager` 的 `systemFile` 选项；把 `writeJson(systemFile, ...)` 改成 `writeJson(path.join(root, "openstaffs", "mcps.json"), { mcpServers: { fixture: options.server } })`；删掉写 `agents/alice/mcp.json` / `projects/p1/mcp.json` 的两处（改为把这些 server 名写进同一份 `mcps.json`）；断言从 `extensionsFor({kind:...}, "alice")` 改成 `extensionsFor(["fixture", "employeeOnly"])` 这类**显式名字列表**，扩展名期望值改为 `mcp:global:<name>`。
- `tests/harness/mcp-harness.test.ts`：把 `systemFile` 那段改成写 `path.join(root, "openstaffs", "mcps.json")`，`new McpManager({ ws: createWorkspace(root), log: () => {} })`。

- [ ] **Step 7: 跑测试确认通过**

Run: `npx vitest run tests/domain/mcp.test.ts tests/harness/mcp-manager.test.ts tests/harness/mcp-harness.test.ts`
Expected: PASS。若 `mcp-manager` 里还有 `scope` 相关断言残留，一并改到 `mcp:global:` 形式。

- [ ] **Step 8: 提交**

```bash
git add src/domain/mcp.ts src/harness/mcp-manager.ts src/server/main.ts tests/domain/mcp.test.ts tests/harness/mcp-manager.test.ts tests/harness/mcp-harness.test.ts
git commit -m "feat(mcp): MCP 改全局定义 openstaffs/mcps.json + 按名引用"
```

---

## Task 7: 项目扁平化 + 成员进 config + 群会话链搬家

**Files:**
- Modify: `src/domain/paths.ts`、`src/domain/project.ts`、`src/domain/access-control.ts`、`src/app/conversations.ts`（仅 `relationCwd` / 链文件）、`src/server/http.ts`（`roomExists`）
- Test: `tests/helpers/office.ts`（新建）、`tests/domain/paths.test.ts`（改）、`tests/domain/project.test.ts`（重写）、`tests/domain/access-control.test.ts`（改）

**Interfaces:**
- Produces:
  - （工作目录函数由 P2 提供，本计划**只 import**）`workDir(ws, id): string` = `<root>/work/<id>`
  - `groupConversationIdsFile(ws, project, agentId)` = `<stateDir>/chains/group-<project>/<agentId>.md`
  - `loadProject(ws, id): Project` 其中 `Project = { id; alias; config: LoadedConfig }`；`createProject(ws, id, memberIds, alias?)` 写扁平 config
  - `parseMembers(ws, name): EmployeeId[]`（读 `project.config.json.members`）、`projectsOf(ws, id)`
- 删除：`membersFile`、`projectDir`

- [ ] **Step 1: 写失败测试（paths）**

```ts
// tests/domain/paths.test.ts（改）
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkspace, groupConversationIdsFile, stateDir, workDir } from "../../src/domain/paths.ts";

describe("路径", () => {
  const ws = createWorkspace("/tmp/company");
  it("agent 工作目录 = work/<id>（D20；workDir 由 P2 提供，本计划只 import）", () => {
    expect(workDir(ws, "alice")).toBe(path.join("/tmp/company", "work", "alice"));
  });
  it("群会话链落在 stateDir 下（项目已无目录，D26）", () => {
    expect(groupConversationIdsFile(ws, "yt", "alice")).toBe(path.join(stateDir(ws), "chains", "group-yt", "alice.md"));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/domain/paths.test.ts`
Expected: FAIL —— `groupConversationIdsFile` 仍落在项目目录（`workDir` 由 P2 已提供，本计划只 import）。

- [ ] **Step 3: 实现 `src/domain/paths.ts` 的增删**

工作目录函数**不自建**（跨计划裁定 B3）：统一用 P2 的 `workDir(ws, id)`（在 `src/domain/paths.ts`，`= <root>/work/<id>`），本计划**只 import**、不重复定义。

```ts
/** 项目 = 扁平配置文件（D26），没有目录；群会话链改放机器私有区。 */
export function groupConversationIdsFile(ws: Workspace, name: string, agentId: string): string {
  return path.join(stateDir(ws), "chains", `group-${name}`, `${agentId}.md`);
}
```

删除 `membersFile` 与 `projectDir`（`projectDir` 不再有任何生产代码引用；`config/naming.ts` 用 `projectsDir`）。

- [ ] **Step 4: 写失败测试（项目 / 成员）**

```ts
// tests/domain/project.test.ts（重写）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createWorkspace, projectsDir } from "../../src/domain/paths.ts";
import { createProject, listProjects, loadProject } from "../../src/domain/project.ts";
import { parseMembers, projectsOf } from "../../src/domain/access-control.ts";
import { defaultPermissionTable } from "../../src/permissions/defaults.ts";

let root = "";
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-project-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test("建群 = 写扁平 config：alias / members / prompt / 默认 permissions（D14/D22/D26）", () => {
  const ws = createWorkspace(root);
  createProject(ws, "yt", ["alice", "bob"], "YouTube 增长");
  const file = path.join(projectsDir(ws), "yt.project.config.json");
  expect(fs.existsSync(file)).toBe(true);
  expect(fs.existsSync(path.join(root, "projects", "yt"))).toBe(false);
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
    alias: "YouTube 增长",
    members: ["alice", "bob"],
    permissions: defaultPermissionTable(),
  });
  expect(parseMembers(ws, "yt")).toEqual(["alice", "bob"]);
  expect(projectsOf(ws, "alice")).toEqual(["yt"]);
});

test("alias 缺省 = id；重复立项抛错；缺失/坏 JSON → 成员为空、列表里也不出现", () => {
  const ws = createWorkspace(root);
  createProject(ws, "xhs-01", []);
  expect(loadProject(ws, "xhs-01").alias).toBe("xhs-01");
  expect(() => createProject(ws, "xhs-01", [])).toThrow();
  expect(parseMembers(ws, "nope")).toEqual([]);
  expect(listProjects(ws).map((project) => project.id)).toEqual(["xhs-01"]);
  fs.writeFileSync(path.join(projectsDir(ws), "broken.project.config.json"), "{坏");
  expect(listProjects(ws).map((project) => project.id)).toEqual(["xhs-01"]);
  expect(parseMembers(ws, "broken")).toEqual([]);
});
```

- [ ] **Step 5: 实现 `src/domain/project.ts` 与 `src/domain/access-control.ts`**

```ts
// src/domain/project.ts（改造后）
import fs from "node:fs";
import { projectConfigFile } from "../config/naming.ts";
import { loadProjectConfig, readConfigFile } from "../config/load.ts";
import type { LoadedConfig } from "../config/schema.ts";
import { defaultPermissionTable } from "../permissions/defaults.ts";
import { projectsDir, type Workspace } from "./paths.ts";
import type { EmployeeId, ProjectName } from "./types.ts";

export type Project = { id: ProjectName; alias: string; config: LoadedConfig };

function assertValidProjectId(id: string): void { /* 与现状一致，不动 */ }

/** 建群 = 立项：写 projects/<id>.project.config.json（扁平；无目录、无 data/，D26）。 */
export function createProject(ws: Workspace, id: ProjectName, memberIds: EmployeeId[], alias?: string): Project {
  assertValidProjectId(id);
  const file = projectConfigFile(ws, id);
  if (fs.existsSync(file)) throw new Error(`项目已存在: ${id}`);
  const displayName = alias === undefined || alias.trim() === "" ? id : alias.trim();
  const body = {
    alias: displayName,
    members: [...memberIds],
    permissions: defaultPermissionTable(),
  };
  fs.mkdirSync(projectsDir(ws), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  return { id, alias: displayName, config: loadProjectConfig(ws, id)! };
}

/** 读项目；config 缺失/坏 JSON → 抛错（与现状「项目不存在」一致）。 */
export function loadProject(ws: Workspace, id: ProjectName): Project {
  const config = loadProjectConfig(ws, id);
  if (config === undefined) throw new Error(`项目不存在: ${id}`);
  return { id, alias: config.fields.alias ?? id, config };
}

/** 扫描 projects/*.project.config.json（坏文件跳过）。 */
export function listProjects(ws: Workspace): Project[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(projectsDir(ws), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Project[] = [];
  for (const entry of entries.filter((item) => item.isFile() && !item.name.startsWith(".")).map((item) => item.name).sort()) {
    if (!entry.endsWith(".project.config.json")) continue;
    const id = entry.slice(0, -".project.config.json".length);
    if (id === "") continue;
    const config = loadProjectConfig(ws, id);
    if (config === undefined) continue;
    out.push({ id, alias: config.fields.alias ?? id, config });
  }
  return out;
}
```

```ts
// src/domain/access-control.ts（改造后：只留成员 / 项目查询；AccessContext 换成有效权限）
import type { ResolvedPermissions } from "../permissions/types.ts";
import { listProjects, loadProject } from "./project.ts";
import type { Workspace } from "./paths.ts";
import type { EmployeeId, ProjectName } from "./types.ts";

/** 会话访问上下文：权限已含运行时授予，路径均为绝对路径。 */
export type AccessContext = {
  root: string;
  cwd: string;
  selfId: string;
  permissions: ResolvedPermissions;
};

/** 群成员（读 projects/<id>.project.config.json 的 members；D22）；项目缺失 → []。 */
export function parseMembers(ws: Workspace, name: ProjectName): EmployeeId[] {
  try {
    return [...loadProject(ws, name).config.fields.members];
  } catch {
    return [];
  }
}

export function projectsOf(ws: Workspace, id: EmployeeId): ProjectName[] {
  return listProjects(ws).filter((project) => project.config.fields.members.includes(id)).map((project) => project.id);
}
```

- [ ] **Step 6: 改 `src/app/conversations.ts` 的 cwd 与链文件 + `src/server/http.ts` 的 `roomExists`**

```ts
/** 会话工作目录 = **agent 自己的工作目录**（D25/D27：项目没有工作目录）。 */
export function relationCwd(ws: Workspace, relation: Relation, speakerId: string): string {
  return workDir(ws, speakerId);   // workDir 由 P2 提供（src/domain/paths.ts），本计划只 import
}
```

`src/server/http.ts`：

```ts
function roomExists(ws: Workspace, relation: Relation): boolean {
  return relation.kind === "dm"
    ? findPerson(loadOrg(ws), relation.employeeId) !== undefined  // dm 分支 P2 已落地，保持不动
    : loadProjectConfig(ws, relation.project) !== undefined;      // 仅群聊分支改判扁平 config
}
```

（`http.ts` 补 `import { loadProjectConfig } from "../config/load.ts";`——`findPerson` / `loadOrg` 已 import；`conversations.ts` 已 import `workDir`（P2 落地），无需再补；`relationCwd` 在 http.ts 若有调用点，补 `speakerId` 实参。）

- [ ] **Step 7: 新建 `tests/helpers/office.ts`（后续任务共用夹具）**

```ts
// tests/helpers/office.ts
import fs from "node:fs";
import path from "node:path";
import { createWorkspace, type Workspace } from "../../src/domain/paths.ts";
import { projectConfigFile, spaceConfigFile } from "../../src/config/naming.ts";

export type OfficeSpec = {
  space?: { alias?: string; prompt?: string; skills?: string[]; mcp?: string[] };
  /** path 是相对 agents/ 的部门路径，如 "eng" 或 "eng/platform"。 */
  departments?: { path: string; head?: string[]; prompt?: string; skills?: string[]; mcp?: string[] }[];
  agents?: {
    id: string; department?: string; alias?: string; model?: string; thinkingLevel?: string;
    prompt?: string; skills?: string[]; mcp?: string[]; permissions?: Record<string, string[]>;
  }[];
  projects?: { id: string; alias?: string; members?: string[]; owner?: string[]; prompt?: string }[];
};

export function writeJsonFile(file: string, body: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
}

/** 按 spec §3 铺一个办公空间（定义树 = *.config.json；不含旧多文件载体）。 */
export function seedOffice(root: string, spec: OfficeSpec): Workspace {
  const ws = createWorkspace(root);
  for (const dir of ["agents", "projects", "work"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
  if (spec.space !== undefined) writeJsonFile(spaceConfigFile(ws), spec.space);
  for (const department of spec.departments ?? []) {
    const files = { ...department } as Record<string, unknown>;
    delete files["path"];
    writeJsonFile(path.join(root, "agents", department.path, "department.config.json"), files);
  }
  for (const agent of spec.agents ?? []) {
    const files = { ...agent } as Record<string, unknown>;
    delete files["id"];
    delete files["department"];
    const dir = agent.department === undefined ? path.join(root, "agents") : path.join(root, "agents", agent.department);
    writeJsonFile(path.join(dir, `${agent.id}.agent.config.json`), files);
  }
  for (const project of spec.projects ?? []) {
    const files = { ...project } as Record<string, unknown>;
    delete files["id"];
    writeJsonFile(projectConfigFile(ws, project.id), files);
  }
  return ws;
}
```

- [ ] **Step 8: 改 `tests/domain/access-control.test.ts`**

保留 `parseMembers` / `projectsOf` 的断言，把夹具从 `projects/<id>/members.md` 改成 `seedOffice(root, { projects: [{ id: "yt", members: ["alice"] }] })`；删除整段 `isWriteAllowed` 相关用例（权限行为迁到 Task 9 的 `tests/tools/gate.test.ts`）。

- [ ] **Step 9: 跑测试确认通过**

Run: `npx vitest run tests/domain/paths.test.ts tests/domain/project.test.ts tests/domain/access-control.test.ts`
Expected: PASS。

- [ ] **Step 10: 提交**

```bash
git add src/domain/paths.ts src/domain/project.ts src/domain/access-control.ts src/app/conversations.ts src/server/http.ts tests/helpers/office.ts tests/domain/paths.test.ts tests/domain/project.test.ts tests/domain/access-control.test.ts
git commit -m "refactor(proj): 项目改扁平 config + 成员进 config；群会话链迁到 stateDir"
```

---

## Task 8: 装配切换 —— instructions 走 capabilities、access 走 permissions

**Files:**
- Modify: `src/app/conversations.ts`、`src/domain/employee.ts`、`src/domain/prompt-vars.ts`、`src/tools/registry.ts`（`office_list` / `member_profile`）
- Test: `tests/domain/employee.test.ts`（改）、`tests/app/conversations.test.ts`（改）、`tests/domain/prompt-vars.test.ts`（改）、`tests/domain/prompt.test.ts`（改）、`tests/tools/registry.test.ts`（改）

**Interfaces:**
- Consumes: `scopesForOrg`（Task 5）、`resolveSkillRefs`（Task 5）、`assembleCapabilities`（Task 5）、`effectivePermissions` / `runtimeGrantsFor`（Task 4）、`loadAgentConfig` / `loadProjectConfig`（Task 1）、`readSkillPaths`（`src/domain/config.ts`）、`findPerson` / `ancestryOf`（P2 的 `src/domain/org.ts`，见「跨阶段假设」）
- Produces:
  - `instructionsFor(ws, relation, speaker): string`（不再吃 `externalSkillDirs`；内部自取 `readSkillPaths(ws)`）
  - `accessFor(ws, relation, speaker): AccessContext`
  - `relationCwd(ws, relation, speakerId): string`
  - `memoryOf(ws, id): string`（`src/domain/employee.ts`）
- 删除：`permissionFilesFor`、`skillDirsFor`（`AGENTS.md` / `profile.md` 退出运行时）
- 保留：`src/domain/employee.ts` 的 `renderInstructions` / `Employee` / `loadEmployee` / `listEmployees`（P2 薄适配层，P5 才收口）；本任务的 `instructionsFor` **不再调用** `renderInstructions`（改用 capabilities）

- [ ] **Step 1: 改 `src/domain/employee.ts`**

`employee.ts` 在 P2 已是薄适配层（`type Employee = OrgPerson`、`loadEmployee`、`listEmployees`、`renderInstructions`；**无 `node:fs` 导入、无 `readText`**）。本步**只追加** `memoryOf`，不动既有导出、不新增 `Employee` 定义：

```ts
// 在现有文件顶部补 import（既有导出保持原样）：
import fs from "node:fs";
import path from "node:path";
import { employeeDir, workDir, type Workspace } from "./paths.ts";

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
```

`renderInstructions` / `Employee` / `loadEmployee` / `listEmployees` **保持不动**（P2 薄适配层；彻底删除由 P5 收口）。

- [ ] **Step 2: 写失败测试（instructions / access）**

```ts
// tests/app/conversations.test.ts（新增用例；其它用例按 seedOffice 改写）
import { seedOffice } from "../helpers/office.ts";

test("instructions：环境段 → 空间/部门/项目/员工 prompt 累加 → 记忆 → 技能目录（含系统内置）", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-conv-"));
  const ws = seedOffice(root, {
    space: { prompt: "空间总纲" },
    departments: [{ path: "eng", prompt: "部门规矩" }],
    agents: [{ id: "alice", department: "eng", prompt: "你是运营。" }],
    projects: [{ id: "yt", members: ["alice"], prompt: "项目规范" }],
  });
  fs.mkdirSync(path.join(root, "work", "alice"), { recursive: true });
  fs.writeFileSync(path.join(root, "work", "alice", "MEMORY.md"), "记忆一条。");
  const speaker = loadEmployee(ws, "alice");
  const text = instructionsFor(ws, { kind: "group", project: "yt" }, speaker);
  const order = ["空间总纲", "部门规矩", "项目规范", "你是运营。", "记忆一条。", "## 可用技能"];
  const positions = order.map((token) => text.indexOf(token));
  expect(positions.every((index) => index >= 0)).toBe(true);
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);
});

test("局部（hu）工作目录 = work/<id>（项目没有工作目录，D25）", () => {
  const ws = seedOffice(root, { agents: [{ id: "alice" }] });
  expect(relationCwd(ws, { kind: "group", project: "yt" }, "alice")).toBe(path.join(root, "work", "alice"));
  expect(relationCwd(ws, { kind: "dm", employeeId: "alice" }, "alice")).toBe(path.join(root, "work", "alice"));
});

test("access：权限 = 项目 + 员工累加 + 运行时（工作目录 / 主管写权 / 技能根）", () => {
  const ws = seedOffice(root, {
    agents: [{ id: "alice", department: "eng", permissions: { write: [], read: ["./"], bash: ["./"] } }],
    projects: [{ id: "yt", members: ["alice"], prompt: "" }],
  });
  const access = accessFor(ws, { kind: "group", project: "yt" }, loadEmployee(ws, "alice"));
  expect(access.cwd).toBe(path.join(root, "work", "alice"));
  expect(access.permissions["write"]).toEqual([path.join(root, "work", "alice")]);
  expect(access.permissions["read"]).toContain(path.join(root, "work", "alice"));
  expect(access.permissions["read"]).toContain(path.join(root, "openstaffs", "skills"));
});
```

> 该文件里所有 `fs.writeFileSync(path.join(dir, "AGENTS.md"), ...)` 之类的旧夹具，统一换成 `seedOffice(...)`；`permissionFilesFor` 的两个用例删除（其语义已被上面的 `access` 用例取代）。

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run tests/app/conversations.test.ts -t "instructions"`
Expected: FAIL —— 仍注入 `AGENTS.md` / 无 `prompt` 累加。

- [ ] **Step 4: 改写 `src/app/conversations.ts`**

```ts
import { workDir, /* …其余不变… */ } from "../domain/paths.ts";
import { loadEmployee, memoryOf, type Employee } from "../domain/employee.ts";
import { parseMembers, projectsOf, type AccessContext } from "../domain/access-control.ts";
import { assembleCapabilities } from "../capabilities/assemble.ts";
import { resolveSkillRefs } from "../capabilities/skills.ts";
import { scopesForOrg } from "../capabilities/scopes.ts";
import { effectivePermissions } from "../permissions/effective.ts";
import { runtimeGrantsFor } from "../permissions/runtime.ts";
import { loadAgentConfig, loadProjectConfig } from "../config/load.ts";
import { readSkillPaths } from "../domain/config.ts";

/** 会话工作目录 = agent 自己的工作目录（D25/D27）。 */
export function relationCwd(ws: Workspace, relation: Relation, speakerId: string): string {
  return workDir(ws, speakerId);
}

/** 环境段 → 能力累加 prompt → 记忆 → 技能目录（技能目录恒含系统内置，D17）。 */
export function instructionsFor(ws: Workspace, relation: Relation, speaker: Employee): string {
  const scopes = scopesForOrg(ws, speaker.id, relation.kind === "group" ? relation.project : undefined);
  const capabilities = assembleCapabilities(scopes);
  const parts: string[] = [];
  const environment = renderEnvironment(promptContextFor(ws, relation, speaker));
  if (environment !== "") parts.push(environment);
  if (capabilities.prompt !== "") parts.push(capabilities.prompt);
  const memory = memoryOf(ws, speaker.id);
  if (memory.trim() !== "") parts.push(memory);
  const skillDirs = resolveSkillRefs(ws, capabilities.skills, readSkillPaths(ws)).resolved.map((skill) => skill.dir);
  parts.push(renderSkills(listSkills([...skillDirs, FRAMEWORK_SKILLS_DIR])));
  return parts.filter((part) => part.trim() !== "").join("\n\n");
}

/** 会话访问上下文：落盘路线（项目 → 员工）+ 运行时授予（D11/D13）。 */
export function accessFor(ws: Workspace, relation: Relation, speaker: Employee): AccessContext {
  const cwd = relationCwd(ws, relation, speaker.id);
  const agentConfig = loadAgentConfig(speaker.dir, speaker.id);
  const projectConfig = relation.kind === "group" ? loadProjectConfig(ws, relation.project) : undefined;
  const onDisk = [
    ...(projectConfig === undefined ? [] : [{ table: projectConfig.fields.permissions, baseDir: projectConfig.baseDir }]),
    { table: agentConfig?.fields.permissions ?? {}, baseDir: speaker.dir },
  ];
  const runtime = runtimeGrantsFor({ ws, agentId: speaker.id, workdir: cwd, extraReadRoots: readSkillPaths(ws) });
  return { root: ws.root, cwd, selfId: speaker.id, permissions: effectivePermissions({ onDisk, runtime }) };
}
```

同时：
- `specFor`：`instructions: instructionsFor(ws, relation, speaker)`、`access: accessFor(ws, relation, speaker)`、`mcpExtensions: mcp?.extensionsFor(assembleCapabilities(scopes).mcp) ?? []`（`scopes` 用 `scopesForOrg` 现算一次；把这段抽成模块内私有 `scopesFor(ws, relation, speaker)` 复用）。
- `promptContextFor` 的 `cwd` 改用 `relationCwd(ws, relation, speaker.id)`。
- 新建会话前确保工作目录存在：`fs.mkdirSync(cwd, { recursive: true })`（放在 `specFor` 开头）。
- 删除 `permissionFilesFor`、`skillDirsFor`。

- [ ] **Step 5: 改 `src/domain/prompt-vars.ts`**

`workdir(ctx)` 语义不变（`ctx.cwd` 已是工作目录）；`members()` 仍用 `parseMembers`（现已读 config）；`projectName` 仍用 `loadProject().alias`。**无需改代码**，只把 `tests/domain/prompt-vars.test.ts` 的夹具换成 `seedOffice`。

- [ ] **Step 6: 改 `src/tools/registry.ts` 的成员/项目读取**

```ts
const memberProfile: ToolDef = {
  name: "member_profile",
  description: "读某位成员的资料：id、展示名与其定义 config 的 prompt 正文。参数 member 是成员 id。",
  parameters: Type.Object({ member: Type.String({ description: "成员 id（<名字>.agent.config.json 的名字）" }) }),
  async run(args, ctx) {
    const member = String(args["member"]);
    const employee = loadEmployee(ctx.ws, member);
    const config = loadAgentConfig(employee.dir, employee.id);
    const prompt = config?.fields.prompt ?? "";
    return [`成员：${employee.alias ?? employee.id}（${employee.id}）`, prompt === "" ? "（未配置 prompt）" : prompt].join("\n\n");
  },
};
```

`office_list` 不变（`parseMembers` / `projectsOf` 已换实现）。`request_permission` 的 `paths` 解析里的 `relationCwd(ctx.ws, ctx.relation)` 补第二参：`relationCwd(ctx.ws, ctx.relation, ctx.selfId)`。

- [ ] **Step 7: 跑测试确认通过**

Run: `npx vitest run tests/app/conversations.test.ts tests/domain/employee.test.ts tests/domain/prompt-vars.test.ts tests/domain/prompt.test.ts tests/tools/registry.test.ts`
Expected: PASS（夹具已全部换成 `seedOffice`）。

- [ ] **Step 8: 提交**

```bash
git add src/app/conversations.ts src/domain/employee.ts src/domain/prompt-vars.ts src/tools/registry.ts tests/app/conversations.test.ts tests/domain/employee.test.ts tests/domain/prompt-vars.test.ts tests/domain/prompt.test.ts tests/tools/registry.test.ts
git commit -m "refactor(conv): 装配改走 capabilities/permissions；AGENTS.md/profile.md 退出运行时"
```

---

## Task 9: 工具权限闸门（按工具路径 + attenuation + 配置保护）

**Files:**
- Create: `src/tools/gate.ts`
- Modify: `src/harness/access-extension.ts`
- Delete: `src/domain/permissions.ts`、`tests/domain/permissions.test.ts`
- Test: `tests/tools/gate.test.ts`（新）、`tests/harness/access-extension.test.ts`（改）、`tests/harness/pi-durable.test.ts`（改夹具）

**Interfaces:**
- Consumes: `AccessContext`（Task 7）、`matchesPath` / `pathsFor`（Task 3/4）、`checkAttenuation`（Task 4）、`isConfigFileName`（Task 1）
- Produces:
  - `TOOL_PERMISSION_KEYS: Record<string, string>`
  - `gateToolCall(access: AccessContext, call: { name: string; arguments?: unknown }): { block: string } | undefined`
  - `bashPathsIn(command: string, cwd: string): string[]`
  - `writeBlockMessage(target: string): string`

- [ ] **Step 1: 写失败测试**

```ts
// tests/tools/gate.test.ts
import path from "node:path";
import { expect, test } from "vitest";
import type { AccessContext } from "../../src/domain/access-control.ts";
import { bashPathsIn, gateToolCall } from "../../src/tools/gate.ts";

const root = "/office";
const cwd = "/office/work/alice";

function access(permissions: Record<string, string[]>): AccessContext {
  return { root, cwd, selfId: "alice", permissions };
}

const base = access({
  write: [cwd, "/office/agents/eng"],
  read: [cwd, "/office/agents/alice", "/office/openstaffs/skills"],
  bash: [cwd, "/office/agents/alice"],
});

test("write：界内放行、界外拦下（提示走授权申请）", () => {
  expect(gateToolCall(base, { name: "write", arguments: { path: "notes.md", content: "x" } })).toBeUndefined();
  expect(gateToolCall(base, { name: "write", arguments: { path: "/office/agents/eng/dave.agent.config.json", content: "{}" } })).toBeDefined();
  expect(gateToolCall(base, { name: "write", arguments: { path: "dave.agent.config.json", content: "{}" } })).toBeDefined();
  expect(gateToolCall(base, { name: "write", arguments: { path: "/etc/passwd", content: "x" } })?.block).toContain("request_permission");
});

test("read 闸门按 read 工具的有效集判定", () => {
  expect(gateToolCall(base, { name: "read", arguments: { path: "/office/openstaffs/skills/report/SKILL.md" } })).toBeUndefined();
  expect(gateToolCall(base, { name: "read", arguments: { path: "/office/agents/bob/x.md" } })).toBeDefined();
});

test("edit：任何 *.config.json 一律拦下（引导用 write 整体写入）", () => {
  const result = gateToolCall(base, { name: "edit", arguments: { path: "/office/agents/eng/department.config.json", edits: [] } });
  expect(result?.block).toContain("write");
  expect(gateToolCall(base, { name: "edit", arguments: { path: "/office/work/alice/notes.md", edits: [] } })).toBeUndefined();
});

test("write 配置文件：permissions 越界（attenuation）拦下，界内放行", () => {
  const inside = { permissions: { write: ["./platform"] } };
  expect(gateToolCall(base, { name: "write", arguments: { path: "/office/agents/eng/department.config.json", content: JSON.stringify(inside) } })).toBeUndefined();
  const outside = { permissions: { write: ["/etc"] } };
  const blocked = gateToolCall(base, { name: "write", arguments: { path: "/office/agents/eng/department.config.json", content: JSON.stringify(outside) } });
  expect(blocked?.block).toContain("attenuation");
});

test("write 配置文件：不是合法 JSON / 顶层不是对象 → 拦下", () => {
  expect(gateToolCall(base, { name: "write", arguments: { path: "/office/agents/eng/department.config.json", content: "{坏" } })).toBeDefined();
  expect(gateToolCall(base, { name: "write", arguments: { path: "/office/agents/eng/department.config.json", content: "[]" } })).toBeDefined();
});

test("bash：命令里的界外绝对路径拦下；普通命令放行；不是沙箱（只做近似检查）", () => {
  expect(gateToolCall(base, { name: "bash", arguments: { command: "echo hi && ls data" } })).toBeUndefined();
  expect(gateToolCall(base, { name: "bash", arguments: { command: "cat /etc/passwd" } })).toBeDefined();
  expect(gateToolCall(base, { name: "bash", arguments: { command: "rm -rf /office/projects" } })).toBeDefined();
  expect(bashPathsIn("cp a.txt /tmp/x", cwd)).toEqual(["/tmp/x"]);
});

test("未映射的工具不进路径闸门（自有工具 / MCP 工具）", () => {
  expect(gateToolCall(base, { name: "send_message", arguments: { target: "boss", text: "x" } })).toBeUndefined();
  expect(gateToolCall(base, { name: "mcp__github__create_issue", arguments: {} })).toBeUndefined();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/tools/gate.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 `src/tools/gate.ts`**

```ts
// src/tools/gate.ts
import os from "node:os";
import path from "node:path";
import { isConfigFileName } from "../config/naming.ts";
import { parseConfigFields } from "../config/schema.ts";
import { checkAttenuation } from "../permissions/attenuation.ts";
import { pathsFor } from "../permissions/effective.ts";
import { matchesPath } from "../permissions/match.ts";
import type { AccessContext } from "../domain/access-control.ts";

/** Pi 工具名 → 权限工具名。**新文件系统工具 = 在此加一条**（D28 同一套逻辑）。 */
export const TOOL_PERMISSION_KEYS: Record<string, string> = {
  read: "read",
  write: "write",
  edit: "write",
  bash: "bash",
};

const AGENT_CONFIG_SUFFIX = ".agent.config.json";

/** 越界写拦截文案（引导走授权申请通道）。 */
export function writeBlockMessage(target: string): string {
  return `访问控制：不可写 "${target}"。如确需写入，可调用 request_permission 工具申请授权（异步，批准后会收到通知）。`;
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** 从 bash 命令里粗取路径（绝对 / `~` / 含 `/` 的 token）；**软边界，非沙箱**。 */
export function bashPathsIn(command: string, cwd: string): string[] {
  const out: string[] = [];
  for (const raw of command.split(/[\s;&|<>()`"'=]+/u)) {
    const token = raw.trim();
    if (token === "" || token.startsWith("-")) continue;
    if (!token.startsWith("/") && !token.startsWith("~") && !token.includes("/")) continue;
    const resolved =
      token === "~" ? os.homedir() : token.startsWith("~/") ? path.join(os.homedir(), token.slice(2)) : path.resolve(cwd, token);
    if (!out.includes(resolved)) out.push(resolved);
  }
  return out;
}

/** 单点闸门：beforeTool 调用它决定是否 block。非文件系统工具一律放行。 */
export function gateToolCall(
  access: AccessContext,
  call: { name: string; arguments?: unknown },
): { block: string } | undefined {
  const key = TOOL_PERMISSION_KEYS[call.name];
  if (key === undefined) return undefined;
  const args = asObject(call.arguments);

  if (call.name === "bash") {
    const command = typeof args["command"] === "string" ? args["command"] : "";
    const granted = pathsFor(access.permissions, "bash", access.cwd);
    const outside = bashPathsIn(command, access.cwd).filter((target) => !matchesPath(granted, target));
    if (outside.length > 0) {
      return { block: `访问控制：命令里的路径不可访问（${outside.join("、")}）。如确需操作，可调用 request_permission 申请授权。` };
    }
    return undefined;
  }

  const raw = typeof args["path"] === "string" ? args["path"] : "";
  if (raw.trim() === "") return { block: "访问控制：缺少 path 参数" };
  const target = path.resolve(access.cwd, raw);
  const base = path.basename(target);

  if (base.endsWith(AGENT_CONFIG_SUFFIX)) {
    return { block: `访问控制：不可写 "${raw}"（员工配置只能由上级主管或老板写）` };
  }
  if (isConfigFileName(base) && call.name === "edit") {
    return { block: `访问控制：配置文件的修改请用 write 整体写入（便于校验 permissions 的 attenuation）："${raw}"` };
  }
  if (call.name === "write" && isConfigFileName(base)) {
    const content = typeof args["content"] === "string" ? args["content"] : "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return { block: `访问控制：配置文件必须是合法 JSON："${raw}"` };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { block: `访问控制：配置文件顶层必须是对象："${raw}"` };
    }
    const { fields } = parseConfigFields(parsed);
    const verdict = checkAttenuation(fields.permissions, path.dirname(target), access.permissions, access.cwd);
    if (!verdict.ok) {
      const detail = verdict.violations.map((item) => `${item.tool}: ${item.paths.join("、")}`).join("；");
      return { block: `访问控制：permissions 超出你的权限（attenuation 校验失败：${detail}）。不可提权授予他人。` };
    }
  }
  const granted = pathsFor(access.permissions, key, access.cwd);
  return matchesPath(granted, target) ? undefined : { block: writeBlockMessage(raw) };
}
```

- [ ] **Step 4: 改 `src/harness/access-extension.ts`**

```ts
import { ToolTask, defineExtension, hook, type Extension } from "@earendil-works/pi-durable";
import type { AccessContext } from "../domain/access-control.ts";
import { gateToolCall } from "../tools/gate.ts";

export function createAccessExtension(
  getContext: (convId: string) => AccessContext | undefined,
): Extension {
  return defineExtension({
    name: "openstaffs-access",
    hooks: [
      hook(ToolTask, {
        beforeTool: (call, api) => {
          const ctx = getContext(String(api.conversationId));
          if (ctx === undefined) return { block: "访问控制：未注册的会话" };
          const verdict = gateToolCall(ctx, { name: call.name, arguments: call.arguments });
          return verdict === undefined ? undefined : { block: verdict.block };
        },
      }),
    ],
  });
}
```

- [ ] **Step 5: 删除旧权限模块与测试**

```bash
git rm src/domain/permissions.ts tests/domain/permissions.test.ts
```

- [ ] **Step 6: 改 `tests/harness/access-extension.test.ts` 与 `tests/harness/pi-durable.test.ts`**

- `access-extension.test.ts`：构造 `AccessContext` 时给出 `permissions: { write: [...], read: [...], bash: [...] }`；断言保留「界外写被拦（文案含 `request_permission`）」「界内放行」；新增「未注册会话 → block」。
- `pi-durable.test.ts`：本地 `access(cwd)` 工厂函数返回新的 `AccessContext` 形状（`{ root, cwd, selfId, permissions: { write: [cwd], read: [cwd], bash: [cwd] } }`）。

- [ ] **Step 7: 跑测试确认通过**

Run: `npx vitest run tests/tools/gate.test.ts tests/harness/access-extension.test.ts tests/harness/pi-durable.test.ts`
Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add src/tools/gate.ts src/harness/access-extension.ts tests/tools/gate.test.ts tests/harness/access-extension.test.ts tests/harness/pi-durable.test.ts
git commit -m "feat(gate): 按工具路径的权限闸门（attenuation / 员工配置保护 / bash 近似检查）"
```

---

## Task 10: 授权链路改为写 agent config 的 `permissions[tool]`

**Files:**
- Modify: `src/tools/registry.ts`（`request_permission`）、`src/app/permission-flow.ts`
- Test: `tests/app/permission-flow.test.ts`、`tests/tools/registry.test.ts`（补用例）

**Interfaces:**
- Consumes: `appendPermissionPaths`（Task 2）、`agentConfigFile`（Task 1）、`loadEmployee(...).dir`
- Produces:
  - `request_permission` 参数新增可选 `tool`（缺省 `"write"`）。
  - `resolvePermissionRequest` accept → `appendPermissionPaths(agentConfigFile(employee.dir, agentId), tool, paths)`。
- 删除：`permissionFilePath`。

- [ ] **Step 1: 写失败测试**

```ts
// tests/app/permission-flow.test.ts（accept 用例改写；其余夹具换 seedOffice）
test("accept：把路径追加进发起者 agent config 的 permissions.write，其余字段不动", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-permflow-"));
  const ws = seedOffice(root, { agents: [{ id: "alice", prompt: "你是 alice。" }] });
  // …（沿用既有 harness / store / queue 桩）
  await resolvePermissionRequest(fixture, request.id, "accept");
  const parsed = JSON.parse(fs.readFileSync(path.join(root, "agents", "alice.agent.config.json"), "utf8"));
  expect(parsed.prompt).toBe("你是 alice。");
  expect(parsed.permissions.write).toEqual([targetAbs]);
});

test("accept：request.tool = \"read\" 时写进 permissions.read", async () => {
  // request 用 store.add({ agentId: "alice", roomKey: "dm:alice", tool: "read", paths: [targetAbs], reason: "要读" })
  // 断言 parsed.permissions.read === [targetAbs]
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/app/permission-flow.test.ts -t "permissions.write"`
Expected: FAIL（仍写 `permission.json`）。

- [ ] **Step 3: 改 `src/domain/permission-requests.ts` 与 `src/app/permission-flow.ts`**

```ts
// src/domain/permission-requests.ts：类型加可选 tool（缺省 write，向后兼容旧文件）
export type PermissionRequest = {
  id: string;
  agentId: string;
  roomKey: string;
  /** 权限工具名（缺省 "write"；D9 按工具）。 */
  tool?: string;
  paths: string[];
  reason: string;
  createdAt: string;
};
```
`isValidRequest` 里加：`(entry.tool === undefined || typeof entry.tool === "string")`；`add(input)` 入参加可选 `tool` 并落到记录里。

```ts
// src/app/permission-flow.ts（关键改动）
import { agentConfigFile } from "../config/naming.ts";
import { appendPermissionPaths } from "../config/write.ts";

if (decision === "accept") {
  const employee = loadEmployee(deps.ws, request.agentId); // 不存在会抛，语义同现状「发起者已不存在」
  appendPermissionPaths(agentConfigFile(employee.dir, request.agentId), request.tool ?? "write", request.paths);
}
```

删除 `permissionFilePath` 与旧的 `appendPermissionPaths(permissionFilePath...)` 调用；`loadEmployee` 抛错时的行为保持现状（先 `try/catch` 转成 `PermissionRequestNotFoundError("发起者已不存在：…")`）。

- [ ] **Step 4: 改 `src/tools/registry.ts` 的 `request_permission`**

```ts
parameters: Type.Object({
  paths: Type.Array(Type.String(), { description: "要申请的路径（目录 / 文件，可多个）" }),
  reason: Type.String({ description: "简短理由：为什么需要这些路径（会展示给负责人）" }),
  tool: Type.Optional(Type.String({ description: "权限工具名（缺省 write；如 read / bash）" })),
}),
```

```ts
const tool = (typeof args["tool"] === "string" && args["tool"].trim() !== "" ? args["tool"].trim() : "write");
// 校验工具名安全（字母 / 数字 / _ / -）
if (!/^[A-Za-z0-9_-]+$/u.test(tool)) throw new Error(`tool 不合法：${tool}（只允许字母、数字、下划线、连字符）`);
const request = permissions.store.add({ agentId: ctx.selfId, roomKey: roomKeyOf(ctx.relation), tool, paths, reason });
```

工具说明里补一句：「`tool` 缺省 `write`；权限按工具授予，写 / 读 / bash 各是一张路径表。」

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/app/permission-flow.test.ts tests/tools/registry.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/domain/permission-requests.ts src/app/permission-flow.ts src/tools/registry.ts tests/app/permission-flow.test.ts tests/tools/registry.test.ts
git commit -m "refactor(perm): 授权落盘改为往 agent config 的 permissions[tool] 追加"
```

---

## Task 11: 全量收口 —— 夹具统一、旧机制退场守卫、全绿

**Files:**
- Test（改到新形态）：`tests/app/send.test.ts`、`tests/server/http.test.ts`、`tests/server/pump-trigger.test.ts`、`tests/server/sse.test.ts`、`tests/tools/extension.test.ts`、`tests/domain/skills.test.ts`（补 `resolveSkillRefs` 相关已移到 capabilities，可只留 `listSkills` / `renderSkills`）

- [ ] **Step 1: 把所有仍写旧载体的测试夹具换成 `seedOffice`**

逐个文件替换（**不改断言语义，只改铺数据的方式**）：
- `AGENTS.md`（员工）→ `agents: [{ id, department?, prompt: "你是 <id>。" }]`
- `profile.md` → 合并进 agent config 的 `prompt`
- `projects/<id>/members.md` / `project.json` / 目录 → `projects: [{ id, alias?, members: [...] }]`
- `agents/<id>/permission.json` → agent config 的 `permissions`
- `agents/<id>/mcp.json` / `projects/<id>/mcp.json` → `openstaffs/mcps.json`（用 `writeJsonFile`）

文件清单：`tests/app/send.test.ts`、`tests/server/http.test.ts`（含授权端点用例：`agents/alice/permission.json` → `agents/alice.agent.config.json` 的 `permissions.write`）、`tests/server/pump-trigger.test.ts`、`tests/server/sse.test.ts`、`tests/tools/extension.test.ts`。

- [ ] **Step 2: 跑全量测试**

Run: `npm test`
Expected: PASS。失败项按「测的是旧机制」还是「真的是 bug」分别处理：前者改夹具 / 删用例，后者改实现（并在提交信息里说明）。

- [ ] **Step 3: 类型检查**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 4: 旧机制退场守卫（grep 必须为空）**

```bash
grep -rn "permission\.json\|members\.md\|profile\.md\|project\.json\|\"mcp\.json\"\|AGENTS\.md" src web
```

Expected: **无输出**（`src/skills/**/SKILL.md` 由 Task 12 同步；`src/domain/config.ts` 的 `.openstaffs/config.json` 与 `src/config/` 的 `*.config.json` 不在匹配式里）。

```bash
grep -rn "isWriteAllowed\|permissionFiles\|mergeRoomMessages\|membersFile\|projectDir(" src web
```

Expected: 无输出（`projectDir` 已删）。

- [ ] **Step 5: 浏览器 bundle 守卫**

Run: `npx vitest run tests/web/bundle.test.ts`
Expected: PASS（`web/` 未值导入任何新模块）。

- [ ] **Step 6: 手动冒烟（真实链路）**

按仓库惯例起服务：`npm start -- /path/to/office 4319`，依次验证：
1. 私聊：老板发一句 → 员工回复正常（说明 `*.config.json` 的 prompt 累加进 instructions 生效）；
2. 群聊：`@a @b 开工` → 两人都跑起来（说明项目 config 的 `members` 生效）；
3. 员工读技能：让它用某个技能 → 能 `read` 到 `openstaffs/skills/<名>/SKILL.md`（说明 read 运行时技能根生效）；
4. 越界写：让它写 `agents/<别人>/x.md` → 被拦，提示走 `request_permission`；
5. 授权：批准后 `agents/<自己>.agent.config.json` 的 `permissions.write` 多出该路径，其余字段不变；
6. MCP：在 `openstaffs/mcps.json` 定义一个 server 并在某 config 的 `mcp` 里按名引用 → 新开会话里出现 `mcp__<server>__<tool>`。

- [ ] **Step 7: 提交**

```bash
git add tests
git commit -m "test(config): 全量测试夹具迁到 *.config.json 新形态，旧机制退出运行时"
```

---

## Task 12: 文档同步（AGENTS.md 的文档同步表全覆盖）

**Files:**
- Modify: `src/skills/openstaffs/SKILL.md`、`src/skills/openstaffs-ops/SKILL.md`、`README.md`、`docs/产品规划.md`

- [ ] **Step 1: 改 `src/skills/openstaffs/SKILL.md`（能力真相源）**

- 「你是谁、在哪工作」：员工 = `<名字>.agent.config.json`；**工作目录 = `work/<自己>/`**（私聊 / 群聊相同，项目没有工作目录）；群 = `projects/<名字>.project.config.json`。
- 「写权限边界」改为**按工具**：`permissions = { write / read / bash: 路径列表 }`；运行时自动给你的：① 自己的工作目录（所有工具）② 技能库（read）；越界仍走 `request_permission`（支持 `tool`）。
- 删掉「`permission.json` 不可改写」，改为「任何 `<名字>.agent.config.json`（含自己的）不可写；主管可写下级配置，且**不可提权**（attenuation）」。
- 「可用技能」来源改为：**按名引用**（`openstaffs/skills/<技能名>/`）累加（空间 → 部门 → 项目 → 员工），**系统内置技能恒在**。
- 「MCP」：定义只在 `openstaffs/mcps.json`，各层 config 用 `mcp: ["<server 名>"]` 按名引用；`agent_id` 等变量与凭据引用不变。
- 「产出约定」：协作产物写当前工作目录（`work/<自己>/`）下的子目录（如 `data/`），不再提 `projects/<项目>/data/`。

- [ ] **Step 2: 改 `src/skills/openstaffs-ops/SKILL.md`（运维真相源）**

- 「办公空间全景」目录树改为 spec §3 的形状（`agents/**/department.config.json` + `<名字>.agent.config.json`、`projects/<名字>.project.config.json`、`work/<id>/`、`openstaffs/{space.config.json,skills/,mcps.json,.data/}`）。`.openstaffs/` → `openstaffs/.data/` 的搬家文案写明「P4 落地后」，现状仍按当前落点写。
- 新增「统一配置 `*.config.json`」一节：字段表（照抄 spec §4）+ 累加路线表（照抄 spec §7）+ 默认值（`write: []`、`read: ["./"]`、`bash: ["./"]`、新工具默认空）。
- 权限章节整体重写：按工具路径列表、attenuation、运行时授予（工作目录 / 主管子树写权）、「人不可写员工配置」、「主管可写下级」。
- 删掉 `mcp.json` 四层表 → 改「全局定义 `openstaffs/mcps.json` + 各层按名引用」。
- 「配置如何生效」表：`permissions` 每轮写校验即时读；`prompt` / `skills` / `mcp` 在新开会话时快照。
- 排障表：`members.md` 相关两行改成「项目 config 的 `members` 为空 / 写了不存在的 id」。

- [ ] **Step 3: 改 `README.md`**

「配置」章：Space / Project / Agent 三处写法全部改成 `*.config.json`（给最小可用示例：`space.config.json` 带 `prompt`、`seo.project.config.json` 带 `members`、`alice.agent.config.json` 带 `prompt` / `model` / `permissions`）；MCP 一节改成「`openstaffs/mcps.json` 定义 + 按名引用」；删除一切 `AGENTS.md` / `members.md` / `mcp.json` / `permission.json` 的提法。

- [ ] **Step 4: 改 `docs/产品规划.md`**

- 「空间层命名与落点」表按新形态重写（`*.config.json` 一行一列）。
- 「未落地的愿景细节」表：`BOSS.md` / `SOUL.md` / 技能清单 / 组织架构 四行的「当前实现」列更新为 `*.config.json` + 部门树 + 按工具权限的现状。

- [ ] **Step 5: 全量复核**

Run: `npm test && npm run typecheck && grep -rn "AGENTS\.md\|members\.md\|permission\.json" src/skills README.md docs/产品规划.md`
Expected: 测试与类型全绿；grep 只剩明确讲「旧机制已退役」「P5 才彻底删除」的句子（若有），措辞必须点明已废弃。

- [ ] **Step 6: 提交**

```bash
git add src/skills/openstaffs/SKILL.md src/skills/openstaffs-ops/SKILL.md README.md docs/产品规划.md
git commit -m "docs(config): 同步统一配置与按工具权限（能力 / 运维 / 上手 / 产品规划）"
```

---

## Self-Review 记录

**1. Spec 覆盖**

| Spec 要求 | 落点 |
| --- | --- |
| §4 统一字段表（`alias?` / `avatar?` / `prompt?` / `skills?` / `mcp?` / `permissions?` / `model?` / `head?` / `owner?` / `members?`）+ 四种载体路径 | Task 1（`ConfigFields` / `parseConfigFields` / naming）；`model` / `head` / `owner` 的**语义**由 P2 消费，P3 只保证解析与暴露 |
| §6 权限形态（按工具 → 路径列表） | Task 3（`PermissionTable` / 解析 / 匹配）+ Task 9（闸门） |
| §6 累加路线（落盘仅 `project` + `agent`） | Task 4（`effectivePermissions` 只吃 `onDisk`） |
| §6 运行时授权（工作目录所有工具 + 主管子树写权） | Task 4（`effectivePermissions` / `runtimeGrantsFor`） |
| §6 默认值（`write:[]`、`read:["./"]`、`bash:["./"]`、新工具空） | Task 3（`DEFAULT_PERMISSIONS` / `defaultPathsFor` / `defaultPermissionTable`） |
| §6 attenuation（全工具统一） | Task 4（`checkAttenuation`）+ Task 9（写入闸门） |
| §6 「人不可写任何 `<名字>.agent.config.json`」 | Task 9（`gateToolCall` 第一条硬规则） |
| §7 `skills` / `mcp` 累加路线（space + department 递归 + project + agent） | Task 5（`scopeChain` 顺序 + `assembleCapabilities`） |
| §7 `prompt` 累加（换行分割） | Task 5（`prompts.join("\n")`）+ Task 8（注入顺序） |
| §7 引用解析：`skills` → `openstaffs/skills/<名>/`；`mcp` → `openstaffs/mcps.json` | Task 5（`resolveSkillRefs`）+ Task 6（`loadMcpSnapshot` / `resolveMcpServers`） |
| §10 P3「去掉旧机制的格式分叉」 | Task 6（删 `src/mcp.json`）、Task 8（`AGENTS.md` / `profile.md` 退出）、Task 9（删 `src/domain/permissions.ts`）、Task 10（`permission.json` 退场）、Task 11（grep 守卫） |
| §12 模块化边界（config / permissions / capabilities） | Task 1 / 3–4 / 5：三个模块各自 `tests/<模块>/` 独立单测；`org` 只在两个接缝出现 |
| D26 项目扁平配置文件 | Task 7 |
| D30 不做迁移 | 全计划无兼容读取分支；Task 11 的 grep 守卫是硬门 |
| D32 系统 prompt 物化 | **明确划给 P4**（见「跨阶段假设」） |
| D34 强模块化 | 三个新模块接口在各自 `Interfaces` 块给全；只依赖契约不依赖实现 |

**2. Placeholder 扫描**：无 TBD / 「稍后补」；每个实现步骤都给了可抄的代码或精确的替换清单；测试步骤都有真实断言与命令。

**3. 类型一致性**：`LoadedConfig`（Task 1）↔ `scopeChain` / `assembleCapabilities`（Task 5）↔ `instructionsFor`（Task 8）；`ResolvedPermissions`（Task 3）↔ `effectivePermissions` / `pathsFor`（Task 4）↔ `AccessContext.permissions`（Task 7）↔ `gateToolCall`（Task 9）；`appendPermissionPaths(file, tool, paths)`（Task 2）↔ `permission-flow`（Task 10）；`McpSessionResolver.extensionsFor(names)`（Task 6）↔ `specFor`（Task 8）。`pathsFor` 统一定义在 `src/permissions/effective.ts`，`attenuation.ts` 与 `gate.ts` 都从那里导入（无重复实现）。

**4. Review Focus 对应**：五条各由 Task 4 / Task 2 / Task 4 / Task 9 / Task 5+6 的测试钉住（见 Review Focus 每行末尾的指向）。

**5. 已知风险 / spec 歧义（实现时留意）**

- **read 的技能根是推导授予**：spec 未明写「读技能库」的授权来源，但不给 read 开放技能根，`skills` 引用机制直接不可用。计划把它作为**运行时 read 授予**（`runtimeGrantsFor.readRoots`），需要老板确认口径。
- **`./` 的基准**：计划沿用旧 `permission.json` 的口径（相对**该配置文件所在目录**），因此 agent config 的 `read: ["./"]` = `agents/` 子树、项目 config 的 `./` = `projects/`。spec 未明写基准，若老板期望「相对工作目录」，只需改 `resolvePermissionTable` 的调用处 base（Task 8 的 `onDisk` 传参）。
- **`bash` 不是沙箱**：计划只做命令文本的近似路径检查（非目标：硬档隔离 / 容器），`cd` + 相对路径等仍可绕过；口径写进 `openstaffs` 技能手册，避免员工误以为有强隔离。
- **系统作用域 MCP 退役**：§4 表里系统层 MCP 打 ✔，但 D16 把定义收敛到 `openstaffs/mcps.json`；计划按 D16 执行（删 `src/mcp.json`）。若老板要保留框架预置 server，把它写进 `openstaffs/mcps.json` 即可。
- **`outputs` 目录约定变化**：群聊工作目录从项目目录改为各自 `work/<id>/`，既有「产物写 `projects/<项目>/data/`」的惯例随之变化，需要在 Task 12 同步（已在文档步骤里写明）。

**6. 跨计划裁定修订（2026-10-19 按 `2026-10-19-p2-p5-preflight-rulings.md`）**

- **B2**：「跨阶段假设」的 org 接口由虚构名（`findAgent` / `listAgentIds` / `departmentChainDirs`，人带 `departmentDir`）改为 **P2 实际签名** `loadOrg` / `findPerson` / `listPeople` / `loadPerson` / `ancestryOf` / `managedDirsOf` / `managedDepartmentsOf`（人带 `dir` / `departmentPath`）；`managedSubtreeOf` **保留并注明**为 P2 按裁定新增的适配器。Task 5 的 `scopesForOrg` 实现与 Task 5 / Task 8 的 Consumes 同步改名（`loadPerson(...).dir` + `ancestryOf(...).map(d => d.dir)`）。
- **B3**：删除自建 `employeeWorkDir`（File Structure、Task 7 接口 / 测试 / 实现、Task 8 的 `memoryOf` 与 `relationCwd`），改为 **import P2 的 `workDir(ws, id)`**。
- **B4**：在「跨阶段假设」明确五层配置落 `src/config/*`，P5/P2 import 自 `src/config/*`；`src/domain/config.ts` 只保留机器私有配置职责（`readConfig` / `readBossName` / `bossNamesFor`）。
- **B5**：写死「P5 不得重写 `capabilities/scopes.ts` / `capabilities/skills.ts`，只能 import 并按需追加导出」。
- **N2**：`spaceConfigFile` 按执行顺序 P3 在前 → 由 **P4 re-export 本计划的定义**（仅加说明，未动 P4 文件）。
- **P1 对齐**：在「跨阶段假设」新增「P1 已落地事实」小节（`mergeRoomMessages` 已删除、房间条目键为 `store:<seq>`、库实例唯一不得另开），确保不误假设旧行为。
- **R-P3-1（`employee.ts` 收口）**：保持 P2 薄适配层，P3 只**追加** `memoryOf`（自行 `import fs from "node:fs"` + 本地 `readText`），**不删** `renderInstructions` / `Employee` / `loadEmployee` / `listEmployees`；`instructionsFor` 只是**不再调用** `renderInstructions`（改用 capabilities）。删除理由里早已不存在的 `Employee.entry` / `Employee.profile` 引用。
- **R-P3-2（提交规范）**：全局约束与各任务 `git commit -m` 统一为 `<type>(<scope>): <简体中文描述>`（Task 1/2 `feat(config)`、Task 3/4 `feat(perm)`、Task 5 `feat(cap)`、Task 6 `feat(mcp)`、Task 7 `refactor(proj)`、Task 8 `refactor(conv)`、Task 9 `feat(gate)`、Task 10 `refactor(perm)`、Task 11 `test(config)`、Task 12 `docs(config)`）。
- **R-P3-3（分支）**：本计划在本地新分支 `feat/unified-config` 上执行（非 `feat/org-hierarchy`、非 `master`）；**不 push**。计划正文原本未指定分支，故无需改动，只在此记录口径。
- **P2 落地对齐（`roomExists` / `workDir`）**：Task 7 的 `roomExists` dm 分支保持 P2 已落地的 `findPerson(loadOrg(ws), id)` 不动，**仅群聊分支**改判扁平 config（不再用 `employeeDir`）；`workDir(ws, id)` 已随 P2 落地，Task 7 只 import。
