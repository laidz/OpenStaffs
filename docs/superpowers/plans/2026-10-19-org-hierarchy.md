# 组织架构（P2）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「人」从 `agents/<id>/` 自包含文件夹改成 `agents/**/<名字>.agent.config.json` 单文件、文件夹即部门（可嵌套），落地「负责人 + 穿透管理权」的权限骨架，侧栏换成可折叠的部门树。

**Architecture:** 新增两个**纯域模块**（D34）：`src/domain/org-config.ts`（部门 / 人配置文件的命名解析、解析、扫描，走盘）与 `src/domain/org.ts`（组织树、负责人、穿透管理权，纯结构运算 + `loadOrg` 薄封装）。`access-control` 把「写自己员工目录」换成「写运行时授予的目录列表」（自己的工作目录 `work/<id>/` + 主管管理子树的目录），并新增「配置文件一律不可被员工写」的硬规则。装配层（`conversations.ts`）改读人级 `prompt`、DM 工作目录与会话链移到 `work/<id>/`；HTTP 用 `/api/org` 输出树；前端侧栏渲染可折叠部门树。

**Tech Stack:** Node ≥ 22.19（本机 24.3.0，`npm start` = strip-only TS）、Vitest、vanilla TS + esbuild（`web/` 打进浏览器 bundle）、**不新增依赖**。

**Spec:** `docs/superpowers/specs/2026-10-18-agent-org-hierarchy-design.md`（§3 目录结构、§4 统一配置字段表、§5 负责人与管理权、§6 权限模型要点、§10 P2 行、§12 模块化边界；决策 D1/D4/D6/D7/D8/D13/D20/D27/D30/D34）

## Global Constraints

- Node ≥ 22.19（本机 24.3.0）；`npm start` = `node src/server/main.ts`，**strip-only TS**：不得用参数属性（`constructor(private x)`）、`enum`、装饰器；类型导入一律 `import type` 或内联 `type`。
- **不新增依赖**；`node:fs` / `node:path` 即可。
- **强模块化（D34）**：组织逻辑只放 `src/domain/org-config.ts` 与 `src/domain/org.ts`，不得塞进 `conversations.ts` / `http.ts` 等既有大文件；基座（Pi）只出现在 `harness/`，本计划不碰 `harness/` 的行为。
- **不做迁移（D30）**：老形态（`agents/<id>/` 文件夹 + `AGENTS.md` + `profile.md` + `config.json` + `memo/permission.json`）一律不兼容；但**现有测试必须同步改到新形态**（每任务列出要改的测试文件），不得留红。
- **P2 范围边界**：只做「部门嵌套 + 人文件 + 负责人 + 穿透管理权 + 侧栏树」。**不做**：五层统一配置解析器 / 按工具权限与 attenuation（P3）；`openstaffs/.data/` 路径迁移 / Staff0 自动创建（P4）；`prompt` 渲染与累加 / `work/<id>/MEMORY.md` / 彻底不管 `AGENTS.md`（P5）。
- **依赖 P1 已完成**：P1（自有消息库）正在同一工作树并行实现，`src/domain/paths.ts`、`src/app/send.ts`、`src/server/pump.ts`、`src/server/http.ts`、`src/app/rooms.ts`、`web/state.ts` 会被 P1 先改。本计划的 Task 5 / Task 6 / Task 7 的 diff **以 P1 合并后的形态为准**（房间键仍是 `dm:<id>` / `group:<项目>`，消息读写已走 `src/store/`）。若 P1 尚未合并，先完成 P1 再执行本计划。
- 提交：**简体中文祈使句**，一任务一提交；在**本地分支** `feat/org-hierarchy` 上做，**不 push 远程**；完成后 `merge --squash` 回主分支（仓库 AGENTS.md 约定）。
- TDD：每任务**先写失败测试 → 跑失败 → 实现 → 跑通过**；每任务收尾跑 `npm test && npm run typecheck` 全绿。
- 文档同步（仓库 AGENTS.md 约定）：Task 8 必须按表格更新 `src/skills/openstaffs/SKILL.md`、`src/skills/openstaffs-ops/SKILL.md`、`README.md`、`docs/产品规划.md`。

## Review Focus

按「最可能咬人」排序，每一条都在对应任务里钉了测试：

1. **`agents/` 下的坏 / 半成品文件**（坏 JSON、空文件名 `agents/.agent.config.json`、`department.config.json` 缺 `head`、id 含空白或 `@`）→ 必须**照常列出其余的人**、只记 `warnings`，绝不崩、绝不 500。（Task 1 / Task 2 测试）
2. **人 id 全局唯一被破坏**（两个部门各有 `bob.agent.config.json`）→ 只保留扫描到的第一个 + `warnings`，`findPerson` 只返回一个，房间仍是 `dm:bob`（不出现两个同名房间）。（Task 2 测试）
3. **`head` 写了不存在的 id / 子部门成员 / 自己人写自己部门** → 「匹配不到 = 视为无负责人」，`managersOf` 继续沿祖先链向上找；**人不能写任何 `*.agent.config.json` / `department.config.json` / `*.permission.json`**（防自任命）。`head` 自荐是最容易被利用的越权入口。（Task 2 / Task 3 测试）
4. **主管写权的穿透方向**：主管可写**自己部门整棵子树**（任意深度、含孙级），**写不了兄弟部门**，也写不了被排除的配置文件。（Task 3 测试）
5. **人 / 关系指向不存在的对象**（`dm:ghost`、群成员写了不存在的人、`work/<id>/` 目录还不存在）→ 404 / 明确中文报错，不 500；会话 cwd 目录必须被创建。 （Task 4 / Task 6 测试）
6. **侧栏折叠不能吞掉可见信息**：空部门仍渲染部门头且可折叠；折叠父部门时子部门整体不渲染（不是叠着显示）；没有 `org` 数据时退回平铺（首帧被吞掉的窗口不白屏）。（Task 7 测试 + 手工冒烟）

## 跨阶段假设（P1 / P3 / P4 / P5）

执行者必须知道：本计划**依赖**下面这些「以后才有的东西」，并**刻意不实现**它们。

> **2026-10-19 跨计划裁定（`docs/superpowers/plans/2026-10-19-p2-p5-preflight-rulings.md`，优先于本计划正文）**：① **保留** `src/domain/employee.ts` 与 `paths.employeeDir`（B1：`employee.ts` 改薄适配层，够 P3 / P5 继续消费，不删）；② org 模块接口以本计划**实际签名为准**，并**新增** `managedSubtreeOf(ws, id)` 适配器给 P3（B2）；③ `workDir(ws, id)` 是工作目录函数的**唯一实现**，P3 / P5 只 import（B3）；④ 五层配置模块落在 **`src/config/*`**，`src/domain/config.ts` 只留机器私有配置（B4）。

| 假设 | 出处 | P2 怎么做 | 假设不成立会怎样 |
|---|---|---|---|
| P1 提供 `src/store/`（`StoredMessage` 含 `sessionId?` 列）与 `messagesDbFile(ws)` | P1 计划 | P2 **不碰 `src/store/`**；不补填 `sessionId`（P2 不改变消息 → 会话的映射关系，房间键与成员装载点都没动；补填属于 P1 那条线：写行时用 `work/<id>/conversation_ids.md` 的活跃行） | 若 P2 需要改 `store`：改动点集中在 `src/store/`，与 org 模块无耦合；在计划执行日志里显式登记 |
| P1 已把 `paths.ts` 加了 `messagesDbFile`、并把房间读写改走 `store` | P1 计划 | P2 只在 `paths.ts` **追加** `workDir`/`WORK_DIR_NAME`，不改 P1 的函数 | 若 P1 未合并：Task 5/6/7 的 diff 要重做（先合 P1） |
| P3 提供**五层统一解析器**，落在 **`src/config/*`**（P3 方案：`schema.ts` / `naming.ts` / `load.ts` / `write.ts`，B4；**不是** `src/domain/config.ts`）。覆盖 `*.config.json`：系统 / 空间 `openstaffs/space.config.json` / 项目 `projects/<名字>.project.config.json` / 部门 / 员工，字段含 `alias? avatar? prompt? skills? mcp? permissions?`，并接管项目成员（`project.config.json.members` 取代 `members.md`） | spec §4 / §7 / §10 P3 行 | P2 的 `org-config.ts` 只解析**部门 / 人**两层的 `alias` / `model` / `prompt`（人）与 `alias` / `head`（部门）；`AgentConfig` / `DepartmentConfig` 是**窄接口**，P3 在解析器内部扩展字段，org 模块不受影响。P2 **不**从 `src/domain/config.ts` 取统一解析器 API（该文件本重构后只保留机器私有配置职责：`readConfig` / `readBossName` / `bossNamesFor` 等）；P2 用到的 `formatModelRef` / `resolveEmployeeModel` 是既有模型辅助，仍由 `src/domain/config.ts` 提供。项目成员仍读 `members.md`（`parseMembers` 是唯一装载入口，签名不变） | 若 P3 用不同形状：只改 `org-config.ts` 的解析函数体；若 P3 换掉 `parseMembers`，改它的 5 个调用点（`access-control` / `conversations` / `http` / `pump` / `registry`）——P2 已把它们收敛到一处 |
| P3 提供按工具权限（`permissions = { write, read, bash, … }` 路径列表）+ attenuation，并提供「主管/群主写下级 `permissions`」的写路径 | spec §6 / §10 P3 行 | P2 的「主管写权」= **运行时目录写权**（子树内**非配置文件**）；权限声明仍只有项目级 `permission.json` + 人级 `<id>.permission.json`（过渡命名） | 若 P3 把 `permissions` 收进 config：删掉 `<id>.permission.json` 过渡文件（改 `agentPermissionFileOf` 与 `permission-flow` 的落点），`isWriteAllowed` 的形态不变 |
| P4 把 `stateDir` 迁到 `openstaffs/.data/`，并首次启动自动创建 `agents/staff0.agent.config.json`（权限 = 写空间根 `./`） | spec §8 / §10 P4 行 | P2 不碰 `.openstaffs/`；`staff0.agent.config.json` 放在 `agents/` 根下时 P2 的扫描**已经能发现**（无需改动），只是 P2 不给它额外的空间写权 | 若 P4 的 Staff0 落在别处（如 `agents/` 之外的目录）：org 扫描不到 → 需在 P4 里把它纳入（P2 的扫描根是 `agents/`） |
| P5 提供 `prompt` 渲染（空间 + 部门累加，换行分割）与 `work/<id>/MEMORY.md` 注入 | spec §5 / §7 / §10 P5 行 | P2 的 `instructionsFor` 只把**人级 `prompt`** 放进 instructions（取代 `entry+profile+memory`），空间 / 项目 `AGENTS.md` 的读取**原样保留**（P5 才撤） | 若 P5 提前撤 `AGENTS.md`：删 `instructionsFor` 里两处 `readTextOrEmpty(...AGENTS.md)` 即可，不影响其他任务 |
| D27（`work/<id>/MEMORY.md`）属 P5 | spec §10 | P2 **只创建 `work/<id>/` 目录**（会话链文件落这里），**不发 `MEMORY.md`** | 若要求 P2 就发：在 Task 4 的 `ensureCwd` 里补一行写文件即可，但会与 P5 重复 |

---

## File Structure

**新建**

- `src/domain/org-config.ts` — 部门 / 人配置文件的命名解析、解析、扫描（走盘；`OrgScan`）。
- `src/domain/org.ts` — 组织树（`buildOrg` / `loadOrg`）、负责人（`headsOf` / `managersOf`）、穿透管理权（`managedDepartmentsOf` / `managedDirsOf` / `isManagedDepartment`）；另有 **`managedSubtreeOf(ws, id)`**（B2：给 P3 的子树目录适配器）。
- `tests/domain/org-config.test.ts`、`tests/domain/org.test.ts`。

**保留（改薄适配层，不删除）**

- `src/domain/employee.ts` — 改为对 `org` 模块的**薄适配层**，导出签名不变（`Employee` / `loadEmployee` / `listEmployees` / `renderInstructions`）；P3 / P5 仍消费它，**不删**（B1）。对应测试 `tests/domain/employee.test.ts` **保留并适配**。
- `src/domain/paths.ts` 的 `employeeDir` — **保留**（B1；供 P3 的 `roomExists` 与 P5 继续使用）。

**修改（src）**

- `src/domain/paths.ts` — `+WORK_DIR_NAME` / `+workDir(ws,id)`（Task 3 加）；`employeeDir` **保留**（B1，不删）。
- `src/domain/access-control.ts` — `AccessContext.+writableDirs`；`isWriteAllowed` 改判（运行时目录 + 受保护配置文件名）；`+isProtectedConfigName`。
- `src/app/conversations.ts` — DM 工作目录 / 会话链 → `work/<id>/`；人级 `prompt`；人级权限文件；`accessFor` 注入 `writableDirs`；`skillDirsFor` 去员工技能目录。
- `src/app/permission-flow.ts` — 人级权限文件落点；存在性检查改走 org。
- `src/domain/mcp.ts` — `loadMcpSnapshot` 不再扫员工层（`sourcesFor` 保留 `employee` 分支给 P3 复用）。
- `src/domain/prompt-vars.ts`、`src/app/send.ts`、`src/server/pump.ts`、`src/tools/registry.ts`、`src/server/http.ts` — 展示名 / 人员枚举改走 org；`http.ts` 用 `/api/org` 取代 `/api/employees`。
- `src/domain/employee.ts` — **薄适配层**（Task 4 改读 org；**保留**，B1 —— 只改实现来源，不改调用方）。

**修改（web）**

- `web/api.ts`（`org()` + `OrgDept` / `OrgPerson` 类型）、`web/state.ts`（`org` / `collapsedDepts` / `flattenOrg`）、`web/render.ts`（部门树）、`web/main.ts`（取 org + 绑定折叠）、`web/styles.css`（树样式）。

**修改（tests）**

- 新增：`tests/domain/org-config.test.ts`、`tests/domain/org.test.ts`。
- 夹具迁移（人 = 单文件）：`tests/app/conversations.test.ts`、`tests/app/send.test.ts`、`tests/app/permission-flow.test.ts`、`tests/server/http.test.ts`、`tests/server/pump-trigger.test.ts`、`tests/server/sse.test.ts`、`tests/tools/registry.test.ts`、`tests/tools/extension.test.ts`、`tests/domain/prompt-vars.test.ts`、`tests/domain/mcp.test.ts`、`tests/harness/mcp-manager.test.ts`、`tests/harness/mcp-harness.test.ts`、`tests/harness/pi-durable.test.ts`、`tests/harness/access-extension.test.ts`。
- 保留并适配：`tests/domain/employee.test.ts`（B1：`employee.ts` 不删，测试随之保留、断言改为「适配层对 org 的转发行为」）。
- 行为断言改写：`tests/domain/paths.test.ts`、`tests/domain/access-control.test.ts`、`tests/web/state.test.ts`、`tests/web/render.test.ts`、`tests/web/api.test.ts`。

**测试夹具的标准形态（Task 4 起统一用这个，逐文件替换各自的 `seedEmployee`）**

```ts
// 人 = 一个配置文件；department 缺省 = agents/ 根
function seedEmployee(id: string, alias?: string, department?: string): void {
  const dir = department === undefined ? path.join(root, "agents") : path.join(root, "agents", department);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.agent.config.json`),
    JSON.stringify({ model: "faux/faux-model", prompt: `你是 ${id}。`, ...(alias === undefined ? {} : { alias }) }),
  );
}

// 部门声明（含负责人）
function seedDepartment(deptPath: string, head: string[], alias?: string): void {
  const dir = path.join(root, "agents", deptPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "department.config.json"), JSON.stringify({ ...(alias === undefined ? {} : { alias }), head }));
}
```

---

## Task 1: `org-config`（部门 / 人配置文件的发现与解析）

**Files:**
- Create: `src/domain/org-config.ts`
- Test: `tests/domain/org-config.test.ts`

**Interfaces:**
- Consumes: `agentsDir(ws)`（`src/domain/paths.ts`，已存在）、`ModelChoice`（`src/domain/types.ts`，已存在）
- Produces:
  - `AGENT_CONFIG_SUFFIX = ".agent.config.json"`、`DEPARTMENT_CONFIG_NAME = "department.config.json"`
  - `agentConfigFileName(id: string): string`、`agentIdOfConfigFile(fileName: string): string | undefined`
  - `type AgentConfig = { id: string; dir: string; departmentPath: string; file: string; alias?: string; model: ModelChoice; prompt: string }`
  - `type DepartmentConfig = { path: string; name: string; dir: string; file: string; alias?: string; head: string[] }`
  - `type OrgScan = { departments: DepartmentConfig[]; agents: AgentConfig[]; warnings: string[] }`
  - `parseAgentConfig(id: string, dir: string, departmentPath: string): AgentConfig`
  - `parseDepartmentConfig(dir: string, name: string, deptPath: string): DepartmentConfig`
  - `scanOrg(ws: Workspace): OrgScan`

- [ ] **Step 1: 写失败测试**

```ts
// tests/domain/org-config.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import {
  AGENT_CONFIG_SUFFIX, agentConfigFileName, agentIdOfConfigFile, scanOrg,
} from "../../src/domain/org-config.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-orgcfg-"));
beforeEach(() => { fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root, { recursive: true }); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const ws = createWorkspace(root);

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe("命名解析", () => {
  it("文件名 ↔ 人 id", () => {
    expect(AGENT_CONFIG_SUFFIX).toBe(".agent.config.json");
    expect(agentConfigFileName("alice")).toBe("alice.agent.config.json");
    expect(agentIdOfConfigFile("alice.agent.config.json")).toBe("alice");
    expect(agentIdOfConfigFile("platform/dave.agent.config.json")).toBeUndefined(); // 只认纯文件名
    expect(agentIdOfConfigFile(".agent.config.json")).toBeUndefined(); // 空 id
    expect(agentIdOfConfigFile("department.config.json")).toBeUndefined();
    expect(agentIdOfConfigFile("alice.json")).toBeUndefined();
  });
});

describe("scanOrg", () => {
  it("缺 agents/ 也给根部门（不抛）；目录 = 部门、可嵌套；root 直属的人在根部门", () => {
    const scan = scanOrg(ws);
    expect(scan.departments.map((d) => d.path)).toEqual([""]);
    expect(scan.agents).toEqual([]);
    expect(scan.warnings).toEqual([]);

    write(path.join(root, "agents", "staff0.agent.config.json"), JSON.stringify({ prompt: "管家" }));
    write(path.join(root, "agents", "eng", "department.config.json"), JSON.stringify({ alias: "研发", head: ["alice"] }));
    write(path.join(root, "agents", "eng", "alice.agent.config.json"), JSON.stringify({ alias: "爱丽丝", model: "faux/m", prompt: "你是 alice。" }));
    write(path.join(root, "agents", "eng", "platform", "bob.agent.config.json"), JSON.stringify({ prompt: "你是 bob。" }));

    const scan2 = scanOrg(ws);
    expect(scan2.departments.map((d) => d.path)).toEqual(["", "eng", "eng/platform"]);
    expect(scan2.departments.find((d) => d.path === "eng")).toEqual({
      path: "eng", name: "eng", dir: path.join(root, "agents", "eng"),
      file: path.join(root, "agents", "eng", "department.config.json"), alias: "研发", head: ["alice"],
    });
    expect(scan2.agents.map((a) => [a.id, a.departmentPath])).toEqual([["staff0", ""], ["alice", "eng"], ["bob", "eng/platform"]]);
    expect(scan2.agents[1]).toEqual({
      id: "alice", dir: path.join(root, "agents", "eng"), departmentPath: "eng",
      file: path.join(root, "agents", "eng", "alice.agent.config.json"),
      alias: "爱丽丝", model: { model: "faux/m" }, prompt: "你是 alice。",
    });
  });

  it("坏 JSON / 缺字段 / 非字符串字段 → 按缺省，不抛", () => {
    write(path.join(root, "agents", "bad.agent.config.json"), "{不是 JSON");
    write(path.join(root, "agents", "lazy.agent.config.json"), JSON.stringify({ alias: 42, model: 7, prompt: null, thinkingLevel: 3 }));
    write(path.join(root, "agents", "eng", "department.config.json"), JSON.stringify({ head: "alice", alias: "  " }));

    const scan = scanOrg(ws);
    expect(scan.agents.find((a) => a.id === "bad")).toEqual({
      id: "bad", dir: path.join(root, "agents"), departmentPath: "",
      file: path.join(root, "agents", "bad.agent.config.json"), model: { model: "" }, prompt: "",
    });
    const lazy = scan.agents.find((a) => a.id === "lazy")!;
    expect(lazy.alias).toBeUndefined();
    expect(lazy.model).toEqual({ model: "" });
    expect(lazy.prompt).toBe("");
    expect(scan.departments.find((d) => d.path === "eng")).toEqual({
      path: "eng", name: "eng", dir: path.join(root, "agents", "eng"),
      file: path.join(root, "agents", "eng", "department.config.json"), head: [],
    });
  });

  it("thinkingLevel / alias 两端空白被 trim；head 只留非空字符串", () => {
    write(path.join(root, "agents", "alice.agent.config.json"), JSON.stringify({ alias: "  爱丽丝  ", model: " faux/m ", thinkingLevel: " high " }));
    write(path.join(root, "agents", "eng", "department.config.json"), JSON.stringify({ head: [" alice ", "", 3, null] }));
    const scan = scanOrg(ws);
    expect(scan.agents[0]!.alias).toBe("爱丽丝");
    expect(scan.agents[0]!.model).toEqual({ model: "faux/m", thinkingLevel: "high" });
    expect(scan.departments.find((d) => d.path === "eng")!.head).toEqual(["alice"]);
  });

  it("跳过隐藏目录 / 隐藏文件；其它 json 不算人", () => {
    write(path.join(root, "agents", ".hidden", "x.agent.config.json"), JSON.stringify({ prompt: "x" }));
    write(path.join(root, "agents", ".hidden.agent.config.json"), JSON.stringify({ prompt: "x" }));
    write(path.join(root, "agents", "notes.json"), JSON.stringify({ prompt: "x" }));
    write(path.join(root, "agents", "alice.agent.config.json"), JSON.stringify({ prompt: "ok" }));
    const scan = scanOrg(ws);
    expect(scan.agents.map((a) => a.id)).toEqual(["alice"]);
    expect(scan.departments.map((d) => d.path)).toEqual([""]);
  });

  it("id 含空白 / @ / 保留前缀 __ → 收录但记 warnings", () => {
    write(path.join(root, "agents", "bad name.agent.config.json"), JSON.stringify({ prompt: "x" }));
    write(path.join(root, "agents", "a@b.agent.config.json"), JSON.stringify({ prompt: "x" }));
    write(path.join(root, "agents", "__boss.agent.config.json"), JSON.stringify({ prompt: "x" }));
    const scan = scanOrg(ws);
    expect(scan.agents.map((a) => a.id).sort()).toEqual(["__boss", "a@b", "bad name"]);
    expect(scan.warnings).toHaveLength(3);
    expect(scan.warnings.join("\n")).toContain("bad name");
    expect(scan.warnings.join("\n")).toContain("__boss");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/domain/org-config.test.ts`
Expected: FAIL —— 模块 `src/domain/org-config.ts` 不存在。

- [ ] **Step 3: 实现 `src/domain/org-config.ts`**

```ts
// src/domain/org-config.ts —— 部门 / 人配置文件的命名解析、解析与扫描（D34：独立域模块）。
// 只解析 P2 需要的窄字段：人 = { alias?, model, prompt }；部门 = { alias?, head }。
// P3 的五层统一解析器会在这两个窄接口内部扩展字段，org 模块无需改动。
import fs from "node:fs";
import path from "node:path";
import { agentsDir, type Workspace } from "./paths.ts";
import type { ModelChoice } from "./types.ts";

/** 人 = `<id>.agent.config.json`（id = 文件名主干，全局唯一）。 */
export const AGENT_CONFIG_SUFFIX = ".agent.config.json";
/** 部门声明文件名（可选：目录本身即部门，声明只为 alias / head）。 */
export const DEPARTMENT_CONFIG_NAME = "department.config.json";

export type AgentConfig = {
  id: string;
  /** 人配置文件所在的部门目录（绝对路径）。 */
  dir: string;
  /** 相对 agents/ 的部门路径（根 = ""）。 */
  departmentPath: string;
  /** 定义文件绝对路径。 */
  file: string;
  alias?: string;
  model: ModelChoice;
  /** 内联提示词（D5）；缺省 ""。 */
  prompt: string;
};

export type DepartmentConfig = {
  /** 相对 agents/ 的路径；根 = ""。 */
  path: string;
  /** 文件夹名；根 = "agents"。 */
  name: string;
  dir: string;
  /** `<dir>/department.config.json`（文件可不存在）。 */
  file: string;
  alias?: string;
  /** 配置里写的负责人名单（**未校验**；「只能从本级成员里选」在 org 模块过滤）。 */
  head: string[];
};

export type OrgScan = { departments: DepartmentConfig[]; agents: AgentConfig[]; warnings: string[] };

export function agentConfigFileName(id: string): string {
  return `${id}${AGENT_CONFIG_SUFFIX}`;
}

/** 文件名 → 人 id；不是人配置文件 / 空 id / 带路径分隔符 → undefined。 */
export function agentIdOfConfigFile(fileName: string): string | undefined {
  if (!fileName.endsWith(AGENT_CONFIG_SUFFIX)) return undefined;
  const id = fileName.slice(0, -AGENT_CONFIG_SUFFIX.length);
  if (id === "" || id.includes("/") || id.includes("\\")) return undefined;
  return id;
}

/** 读 JSON 对象；缺失 / 坏 JSON / 非对象 → undefined（一律按"没写"处理，不抛）。 */
function readJsonObject(file: string): Record<string, unknown> | undefined {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** 人配置文件 → AgentConfig（坏文件按缺省，不抛）。 */
export function parseAgentConfig(id: string, dir: string, departmentPath: string): AgentConfig {
  const file = path.join(dir, agentConfigFileName(id));
  const parsed = readJsonObject(file) ?? {};
  const alias = optionalString(parsed["alias"]);
  const thinkingLevel = optionalString(parsed["thinkingLevel"]);
  const model: ModelChoice = {
    model: optionalString(parsed["model"]) ?? "",
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
  };
  const prompt = typeof parsed["prompt"] === "string" ? parsed["prompt"] : "";
  return { id, dir, departmentPath, file, model, prompt, ...(alias === undefined ? {} : { alias }) };
}

/** 部门声明文件 → DepartmentConfig（坏文件按缺省：无 alias、无 head）。 */
export function parseDepartmentConfig(dir: string, name: string, deptPath: string): DepartmentConfig {
  const file = path.join(dir, DEPARTMENT_CONFIG_NAME);
  const parsed = readJsonObject(file);
  const alias = optionalString(parsed?.["alias"]);
  const rawHead = parsed?.["head"];
  const head = Array.isArray(rawHead)
    ? rawHead.map(optionalString).filter((value): value is string => value !== undefined)
    : [];
  return { path: deptPath, name, dir, file, head, ...(alias === undefined ? {} : { alias }) };
}

/** id 是否合法（空白 / `@` 与提及语法冲突；`__` 前缀是保留参与者 id）。 */
function idWarning(id: string): string | undefined {
  if (/\s/u.test(id)) return `人 id 含空白（无法被 @ 定向）：${JSON.stringify(id)}`;
  if (id.includes("@")) return `人 id 含 @（与提及语法冲突）：${JSON.stringify(id)}`;
  if (id.startsWith("__")) return `人 id 以 __ 开头（保留给 boss / system）：${JSON.stringify(id)}`;
  return undefined;
}

/**
 * 递归扫描 `agents/`：目录 = 部门（可嵌套），`<id>.agent.config.json` = 人。
 * - **根部门恒在**（`agents/` 不存在也给 `{ path: "" }`），调用方不必兜底；
 * - 隐藏条目（`.` 开头）跳过；非人配置文件跳过；
 * - 坏文件不抛、只按缺省解析；可疑 id 收录并记 warnings；
 * - 顺序确定：同级**先收录文件（人）**，再按名字排序进入子目录；部门先于其下内容。
 *   （与前端 `flattenOrg` 同口径：本部门的人在前，再进子部门）
 */
export function scanOrg(ws: Workspace): OrgScan {
  const departments: DepartmentConfig[] = [];
  const agents: AgentConfig[] = [];
  const warnings: string[] = [];

  collect(agentsDir(ws), "", "agents");
  return { departments, agents, warnings };

  function collect(dir: string, deptPath: string, name: string): void {
    departments.push(parseDepartmentConfig(dir, name, deptPath));
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 目录不存在：该部门只有声明，没有人
    }
    const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).filter((entry) => !entry.name.startsWith("."));
    for (const entry of sorted.filter((entry) => !entry.isDirectory())) {
      const id = agentIdOfConfigFile(entry.name);
      if (id === undefined) continue;
      const warning = idWarning(id);
      if (warning !== undefined) warnings.push(warning);
      agents.push(parseAgentConfig(id, dir, deptPath));
    }
    for (const entry of sorted.filter((entry) => entry.isDirectory())) {
      const childPath = deptPath === "" ? entry.name : `${deptPath}/${entry.name}`;
      collect(path.join(dir, entry.name), childPath, entry.name);
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/domain/org-config.test.ts`
Expected: PASS（5 passed）。

- [ ] **Step 5: 提交**

```bash
git add src/domain/org-config.ts tests/domain/org-config.test.ts
git commit -m "feat(org): 新增部门/人配置文件的发现与解析（org-config）"
```

---

## Task 2: `org`（组织树 + 负责人 + 穿透管理权）

**Files:**
- Create: `src/domain/org.ts`
- Test: `tests/domain/org.test.ts`

**Interfaces:**
- Consumes: `scanOrg` / `AgentConfig` / `DepartmentConfig` / `OrgScan`（Task 1）、`agentsDir` / `Workspace`（`paths.ts`）
- Produces（**以下签名是本重构的权威口径**，B2：P5 按此改名；人对象带 `dir`（所在部门目录的绝对路径）与 `departmentPath`（相对 `agents/` 的部门路径，根 = `""`））：
  - `type OrgPerson = AgentConfig`（人本身已带 `dir` / `departmentPath`）
  - `type OrgDepartment = { path: string; name: string; alias?: string; head: string[]; people: OrgPerson[]; departments: OrgDepartment[] }`
  - `type OrgTree = { root: OrgDepartment; people: OrgPerson[]; departments: OrgDepartment[]; warnings: string[] }`
  - `buildOrg(scan: OrgScan): OrgTree`（纯，可脱离文件系统单测）
  - `loadOrg(ws: Workspace): OrgTree`、`listPeople(ws): OrgPerson[]`、`loadPerson(ws, id): OrgPerson`（不存在抛 `员工不存在: <id>`）
  - `findPerson(tree, id)`、`personDisplayName(ws, id)`、`departmentAt(tree, path)`、`departmentOfPerson(tree, id)`、`ancestryOf(tree, path)`
  - `headsOf(tree, path): string[]`（过滤到「本级直属成员」）
  - `managersOf(tree, path): string[]`（穿透：最近的有 `head` 的祖先部门 → 其 head；全链无 → `[]` = 老板）
  - `isInSubtree(ancestorPath, deptPath): boolean`
  - `managedDepartmentsOf(tree, managerId): string[]`、`managedDirsOf(tree, ws, managerId): string[]`、`isManagedDepartment(tree, managerId, deptPath): boolean`
  - `managedSubtreeOf(ws: Workspace, id: string): { departmentDirs: string[]; agentDirs: string[] }`（**B2：给 P3 的适配器**，转调 `loadOrg` + `managedDepartmentsOf`，产出管理者子树内**全部部门目录**与**全部人所在目录**的绝对路径，各去重）

- [ ] **Step 1: 写失败测试**

```ts
// tests/domain/org.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import type { OrgScan } from "../../src/domain/org-config.ts";
import {
  ancestryOf, buildOrg, departmentAt, departmentOfPerson, findPerson, headsOf, isInSubtree, isManagedDepartment,
  listPeople, loadOrg, loadPerson, managedDepartmentsOf, managedDirsOf, managedSubtreeOf, managersOf, personDisplayName,
} from "../../src/domain/org.ts";

/** 手搭扫描结果：不碰文件系统，专测结构运算。 */
function scan(parts: { departments?: [string, string[]][]; agents?: [string, string, string?][] }): OrgScan {
  const departments = [["", [], "agents"] as [string, string[], string]];
  return {
    departments: [...departments, ...(parts.departments ?? []).map(([p, head]) => [p, head, p.split("/").at(-1)!] as [string, string[], string])]
      .map(([p, head, name]) => ({ path: p, name, dir: `/ws/agents/${p}`, file: `/ws/agents/${p}/department.config.json`, head })),
    agents: (parts.agents ?? []).map(([id, deptPath, alias]) => ({
      id, dir: `/ws/agents/${deptPath}`, departmentPath: deptPath, file: `/ws/agents/${deptPath}/${id}.agent.config.json`,
      model: { model: "" }, prompt: `你是 ${id}。`, ...(alias === undefined ? {} : { alias }),
    })),
    warnings: [],
  };
}

// 树：根（staff0）→ eng[alice]（head=alice）→ eng/platform[bob, carol]
const TREE = buildOrg(
  scan({
    departments: [["eng", ["alice"]], ["eng/platform", ["bob"]]],
    agents: [["staff0", ""], ["alice", "eng", "爱丽丝"], ["bob", "eng/platform"], ["carol", "eng/platform"]],
  }),
);

describe("组织树", () => {
  it("部门嵌套、人在其所在部门；根部门恒在", () => {
    expect(TREE.root.path).toBe("");
    expect(TREE.root.people.map((p) => p.id)).toEqual(["staff0"]);
    expect(TREE.root.departments.map((d) => d.path)).toEqual(["eng"]);
    expect(departmentAt(TREE, "eng")!.departments.map((d) => d.path)).toEqual(["eng/platform"]);
    expect(departmentAt(TREE, "eng/platform")!.people.map((p) => p.id)).toEqual(["bob", "carol"]);
    expect(TREE.people.map((p) => p.id)).toEqual(["staff0", "alice", "bob", "carol"]);
  });

  it("findPerson / loadPerson / personDisplayName / departmentOfPerson", () => {
    expect(findPerson(TREE, "alice")!.alias).toBe("爱丽丝");
    expect(findPerson(TREE, "nobody")).toBeUndefined();
    expect(departmentOfPerson(TREE, "bob")!.path).toBe("eng/platform");
    expect(departmentOfPerson(TREE, "staff0")!.path).toBe("");
  });

  it("人 id 重复：保留第一个 + warning（不抛、不双房间）", () => {
    const dup = buildOrg(scan({ departments: [["eng", []]], agents: [["bob", ""], ["bob", "eng"]] }));
    expect(dup.people.map((p) => p.id)).toEqual(["bob"]);
    expect(dup.people[0]!.departmentPath).toBe("");
    expect(dup.warnings.join("\n")).toContain("重复");
    expect(departmentAt(dup, "eng")!.people).toEqual([]);
  });
});

describe("负责人（head）", () => {
  it("只认本级直属成员；写子部门成员 / 写错 id → 视为无 + warning", () => {
    expect(headsOf(TREE, "eng")).toEqual(["alice"]);
    const bad = buildOrg(scan({ departments: [["eng", ["bob", "ghost"]]], agents: [["bob", "eng/platform"], ["alice", "eng"]] }));
    expect(headsOf(bad, "eng")).toEqual([]);
    expect(bad.warnings.join("\n")).toContain("ghost");
    expect(bad.warnings.join("\n")).toContain("bob");
  });

  it("managersOf：沿祖先链取最近的有 head 的部门；全链无 → 空（= 老板）", () => {
    expect(managersOf(TREE, "eng/platform")).toEqual(["bob"]); // 自身部门有 head
    expect(managersOf(TREE, "eng")).toEqual(["alice"]);
    expect(managersOf(TREE, "")).toEqual([]); // 根无 head → 老板
    expect(ancestryOf(TREE, "eng/platform").map((d) => d.path)).toEqual(["", "eng", "eng/platform"]);
    expect(managersOf(TREE, "nope")).toEqual([]);
  });
});

describe("穿透管理权", () => {
  it("管理者的范围 = 其所在部门的整棵子树（任意深度）", () => {
    expect(managedDepartmentsOf(TREE, "alice")).toEqual(["eng"]);
    expect(isManagedDepartment(TREE, "alice", "eng")).toBe(true);
    expect(isManagedDepartment(TREE, "alice", "eng/platform")).toBe(true); // 孙级
    expect(isManagedDepartment(TREE, "bob", "eng")).toBe(false); // 下级管不了上级
    expect(isManagedDepartment(TREE, "bob", "eng/platform")).toBe(true);
    expect(isManagedDepartment(TREE, "bob", "eng/other")).toBe(false);
    expect(managedDepartmentsOf(TREE, "staff0")).toEqual([]); // 不是任何部门的 head
  });

  it("isInSubtree：根包含一切；前缀相同但不是子目录 → false", () => {
    expect(isInSubtree("", "eng/platform")).toBe(true);
    expect(isInSubtree("eng", "eng/platform")).toBe(true);
    expect(isInSubtree("eng", "eng")).toBe(true);
    expect(isInSubtree("eng", "english")).toBe(false);
    expect(isInSubtree("eng", "")).toBe(false);
  });

  it("managedDirsOf 给出绝对目录（access-control 直接用）", () => {
    const ws = createWorkspace("/ws");
    expect(managedDirsOf(TREE, ws, "alice")).toEqual([path.join("/ws", "agents", "eng")]);
    expect(managedDirsOf(TREE, ws, "staff0")).toEqual([]);
  });
});

describe("loadOrg（走盘）", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-org-"));
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function write(file: string, content: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  it("从 agents/ 建树；人不存在时 loadPerson 抛错、personDisplayName 回落 id", () => {
    write(path.join(root, "agents", "eng", "department.config.json"), JSON.stringify({ head: ["alice"] }));
    write(path.join(root, "agents", "eng", "alice.agent.config.json"), JSON.stringify({ alias: "爱丽丝", prompt: "你是 alice。" }));
    const ws = createWorkspace(root);
    const tree = loadOrg(ws);
    expect(tree.people.map((p) => p.id)).toEqual(["alice"]);
    expect(loadPerson(ws, "alice").prompt).toBe("你是 alice。");
    expect(() => loadPerson(ws, "ghost")).toThrow("员工不存在");
    expect(personDisplayName(ws, "alice")).toBe("爱丽丝");
    expect(personDisplayName(ws, "ghost")).toBe("ghost");
    expect(listPeople(ws).map((p) => p.id)).toEqual(["alice"]);
  });
});

describe("managedSubtreeOf（走盘；B2 给 P3 的适配器）", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-subtree-"));
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function write(file: string, content: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  it("给出子树内全部部门目录与全部人所在目录（任意深度、目录去重）；非 head → 空", () => {
    write(path.join(root, "agents", "eng", "department.config.json"), JSON.stringify({ head: ["alice"] }));
    write(path.join(root, "agents", "eng", "alice.agent.config.json"), JSON.stringify({ prompt: "你是 alice。" }));
    write(path.join(root, "agents", "eng", "platform", "bob.agent.config.json"), JSON.stringify({ prompt: "你是 bob。" }));
    write(path.join(root, "agents", "eng", "platform", "carol.agent.config.json"), JSON.stringify({ prompt: "你是 carol。" }));
    write(path.join(root, "agents", "sales", "dave.agent.config.json"), JSON.stringify({ prompt: "你是 dave。" }));
    const ws = createWorkspace(root);
    expect(managedSubtreeOf(ws, "alice")).toEqual({
      // eng + eng/platform（含孙级）
      departmentDirs: [path.join(root, "agents", "eng"), path.join(root, "agents", "eng", "platform")],
      // alice（eng）/ bob、carol（eng/platform）→ 按目录去重；sales 不在子树内
      agentDirs: [path.join(root, "agents", "eng"), path.join(root, "agents", "eng", "platform")],
    });
    expect(managedSubtreeOf(ws, "dave")).toEqual({ departmentDirs: [], agentDirs: [] }); // 不是任何部门的 head
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/domain/org.test.ts`
Expected: FAIL —— 模块 `src/domain/org.ts` 不存在。

- [ ] **Step 3: 实现 `src/domain/org.ts`**

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/domain/org.test.ts`
Expected: PASS（10 passed）。

- [ ] **Step 5: 提交**

```bash
git add src/domain/org.ts tests/domain/org.test.ts
git commit -m "feat(org): 组织树、负责人与穿透管理权（org 模块）"
```

---

## Task 3: 路径与写权限骨架（`workDir` + 运行时目录写权）

**Files:**
- Modify: `src/domain/paths.ts`（追加 `WORK_DIR_NAME` / `workDir`；**保留** `employeeDir`，B1 不删）
- Modify: `src/domain/access-control.ts`
- Test: `tests/domain/paths.test.ts`、`tests/domain/access-control.test.ts`
- 夹具补字段：`tests/harness/access-extension.test.ts`、`tests/harness/pi-durable.test.ts`、`tests/harness/mcp-harness.test.ts`、`tests/tools/extension.test.ts`

**Interfaces:**
- Consumes: `agentsDir` / `projectDir`（`paths.ts`）
- Produces:
  - `WORK_DIR_NAME = "work"`、`workDir(ws: Workspace, id: string): string`
  - `AccessContext = { root; cwd; selfId; memberProjects; permissionFiles; writableDirs: string[] }`（**新增字段，必填**）
  - `isProtectedConfigName(base: string): boolean`（`department.config.json` / `permission.json` / `*.agent.config.json` / `*.permission.json`）
  - `isWriteAllowed(ctx, targetPath)` 新判序：**受保护文件名首先拒绝** → 运行时目录 → 成员项目目录 → 授权文件

> **权威说明（B3）**：`workDir(ws, id)` 是本重构中工作目录函数的**唯一实现**（落在 `src/domain/paths.ts`）；P3 / P5 **只 import，不得另建** —— P3 原拟的 `employeeWorkDir(ws, id)` 与 P5 原拟的 `workDir(ws, id)` 定义**均作废**，一律改为从 `paths.ts` 导入本函数。

- [ ] **Step 1: 写失败测试**（`tests/domain/paths.test.ts`）

```ts
// tests/domain/paths.test.ts（改：追加 workDir 断言；employeeDir 的断言**保留**，B1）
it("给出各标准目录", () => {
  expect(agentsDir(ws)).toBe(path.join("/tmp/company", "agents"));
  expect(workDir(ws, "alice")).toBe(path.join("/tmp/company", "work", "alice"));
  expect(projectDir(ws, "yt")).toBe(path.join("/tmp/company", "projects", "yt"));
  expect(membersFile(ws, "yt")).toBe(path.join("/tmp/company", "projects", "yt", "members.md"));
});
```

- [ ] **Step 2: 写失败测试**（`tests/domain/access-control.test.ts` 的 `ctx()` 加 `writableDirs`，并追加新用例）

```ts
// tests/domain/access-control.test.ts（import 追加 isProtectedConfigName）
import { isProtectedConfigName, isWriteAllowed, parseMembers, projectsOf, type AccessContext } from "../../src/domain/access-control.ts";

function ctx(extra: Partial<AccessContext> = {}): AccessContext {
  return {
    root: ws.root,
    cwd: path.join(tmp, "projects", "yt"),
    selfId: "alice",
    memberProjects: ["yt"],
    permissionFiles: [],
    writableDirs: [],
    ...extra,
  };
}

it("运行时目录（自己的工作目录）可写；目录外仍拒绝", () => {
  const work = path.join(tmp, "work", "alice");
  const c = ctx({ cwd: work, writableDirs: [work] });
  expect(isWriteAllowed(c, "note.md")).toBe(true);
  expect(isWriteAllowed(c, "sub/a.md")).toBe(true);
  expect(isWriteAllowed(c, path.join(tmp, "agents", "bob.agent.config.json"))).toBe(false);
});

it("主管穿透：管理子树内可写（含孙级），兄弟部门 / 子树外不可写", () => {
  const managed = path.join(tmp, "agents", "eng");
  const boss = ctx({ cwd: path.join(tmp, "work", "alice"), writableDirs: [path.join(tmp, "work", "alice"), managed] });
  expect(isWriteAllowed(boss, path.join(tmp, "agents", "eng", "platform", "notes.md"))).toBe(true);
  expect(isWriteAllowed(boss, path.join(tmp, "agents", "sales", "notes.md"))).toBe(false);
  expect(isWriteAllowed(boss, path.join(tmp, "agents", "eng", "alice.agent.config.json"))).toBe(false); // 配置文件不可写
  expect(isWriteAllowed(boss, path.join(tmp, "agents", "eng", "department.config.json"))).toBe(false);
});

it("受保护的配置文件名一律不可写（含人级权限文件与部门声明）", () => {
  const c = ctx({ cwd: tmp, writableDirs: [tmp] });
  expect(isWriteAllowed(c, "agents/alice.agent.config.json")).toBe(false);
  expect(isWriteAllowed(c, "agents/eng/department.config.json")).toBe(false);
  expect(isWriteAllowed(c, "agents/alice.permission.json")).toBe(false);
  expect(isWriteAllowed(c, "projects/yt/permission.json")).toBe(false);
  expect(isProtectedConfigName("bob.agent.config.json")).toBe(true);
  expect(isProtectedConfigName("notes.md")).toBe(false);
});
```

> 既有的「允许写自己的工作区（私聊 cwd = 员工目录）」用例改名并把 `cwd` 换成 `work/<id>`（写法见上面的新用例）；「拒绝写任何 permission.json」用例保留。

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run tests/domain/paths.test.ts tests/domain/access-control.test.ts`
Expected: FAIL —— `workDir` / `isProtectedConfigName` 未导出；`writableDirs` 未生效。

- [ ] **Step 4: 实现 `paths.ts` 追加**

```ts
// src/domain/paths.ts（文件末尾追加；本任务及后续均**不删** employeeDir，B1）
/** 工作树目录名（D20：平铺 `work/<名字>/`，与定义树分离）。 */
export const WORK_DIR_NAME = "work";

/** agent 的工作目录（会话 cwd / 自己的可写目录 / 会话链落点）；P2 只建目录，不预置 MEMORY.md（D27 归 P5）。 */
export function workDir(ws: Workspace, id: string): string {
  return path.join(ws.root, WORK_DIR_NAME, id);
}
```

- [ ] **Step 5: 实现 `access-control.ts` 改判**

```ts
// src/domain/access-control.ts（改）
export type AccessContext = {
  root: string;
  cwd: string;
  selfId: string;
  memberProjects: ProjectName[];
  permissionFiles: string[];
  /**
   * 运行时可写目录（D13，不落盘）：① 自己的工作目录；② 主管对自己所在部门整棵子树的写权（穿透）。
   * 由装配层（conversations.accessFor）计算，配置里不出现。
   */
  writableDirs: string[];
};

/**
 * 受保护的配置文件（人一律不可写；老板 / 框架（授权流程）不受此限）：
 * - `department.config.json` 部门声明（写 head = 自任命）；
 * - `*.agent.config.json` 人定义（§6：人不可写任何 agent 配置，含自己的）；
 * - `permission.json` / `*.permission.json` 授权文件（防自写提权）。
 */
export function isProtectedConfigName(base: string): boolean {
  return (
    base === "department.config.json" ||
    base === "permission.json" ||
    base.endsWith(".agent.config.json") ||
    base.endsWith(".permission.json")
  );
}

export function isWriteAllowed(ctx: AccessContext, targetPath: string): boolean {
  if (targetPath.trim() === "") return false;
  const target = path.resolve(ctx.cwd, targetPath);
  if (isProtectedConfigName(path.basename(target))) return false;
  for (const dir of ctx.writableDirs) {
    if (isWithin(dir, target)) return true;
  }
  for (const project of ctx.memberProjects) {
    if (isWithin(path.join(ctx.root, "projects", project), target)) return true;
  }
  return isWriteAllowedByPermission(ctx.permissionFiles, target);
}
```

- [ ] **Step 6: 给 AccessContext 字面量补 `writableDirs`（4 个测试文件）**

`tests/harness/access-extension.test.ts`、`tests/harness/pi-durable.test.ts`、`tests/harness/mcp-harness.test.ts`、`tests/tools/extension.test.ts` 里形如
`access: { root, cwd, selfId: "alice", memberProjects: [], permissionFiles: [] }`
一律补成
`access: { root, cwd, selfId: "alice", memberProjects: [], permissionFiles: [], writableDirs: [cwd] }`
（这几个用例靠「cwd 内可写」成立，`writableDirs: [cwd]` 即等价旧行为。）

- [ ] **Step 7: 跑测试确认通过**

Run: `npx vitest run tests/domain/paths.test.ts tests/domain/access-control.test.ts tests/harness tests/tools && npm run typecheck`
Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add src/domain/paths.ts src/domain/access-control.ts tests/domain/paths.test.ts tests/domain/access-control.test.ts tests/harness tests/tools
git commit -m "feat(acl): 工作目录与主管穿透写权骨架（workDir / writableDirs / 受保护配置名）"
```

---

## Task 4: 人 = `<名字>.agent.config.json` 接入会话装配与工具层

**Files:**
- Modify: `src/domain/employee.ts`（改成 **org 薄适配层**；**保留**，B1 —— 只改实现来源，不改调用方）
- Modify: `src/app/conversations.ts`、`src/domain/prompt-vars.ts`、`src/tools/registry.ts`
- Test: `tests/app/conversations.test.ts`、`tests/server/sse.test.ts`、`tests/domain/prompt-vars.test.ts`、`tests/tools/registry.test.ts`、`tests/app/send.test.ts`、`tests/app/permission-flow.test.ts`、`tests/server/pump-trigger.test.ts`、`tests/server/http.test.ts`、`tests/domain/mcp.test.ts`、`tests/harness/mcp-manager.test.ts`（夹具迁移见下）
- 保留并适配: `tests/domain/employee.test.ts`（B1：适配到新形态，不删；断言改为「适配层转发到 org」的行为）

**Interfaces:**
- Consumes: `loadOrg` / `loadPerson` / `findPerson` / `personDisplayName` / `managedDirsOf` / `OrgPerson`（Task 2）、`workDir`（Task 3）
- Produces:
  - `employee.ts`（**薄适配层，保留**，B1）：导出签名不变 —— `type Employee = OrgPerson`、`loadEmployee(ws,id)`（走 org，缺失抛 `员工不存在`）、`listEmployees(ws)`、`renderInstructions(person) === person.prompt`
  - `conversations.relationCwd`：DM → `workDir(ws, id)`；群聊 → `projectDir`（不变）
  - `conversations.agentPermissionFileOf(person) = <person.dir>/<id>.permission.json`
  - `conversations.permissionFilesFor(ws, relation, speaker)`：群聊 = `[项目 permission.json, 人级 permission.json]`；私聊 = `[人级 permission.json]`
  - `conversations.accessFor`：`writableDirs = [workDir(ws, selfId), ...managedDirsOf(tree, ws, selfId)]`
  - `conversations.instructionsFor`：人级段 = `speaker.prompt`
  - `conversations.skillDirsFor`：**不再含员工技能目录**（群聊项目 → 空间 → 外部 → 系统内置）

- [ ] **Step 1: 写失败测试**（`tests/app/conversations.test.ts` 追加 / 改）

```ts
// 夹具：人 = 单文件（放在 agents/ 根）
function seedEmployee(id: string, alias?: string, department?: string): void {
  const dir = department === undefined ? path.join(root, "agents") : path.join(root, "agents", department);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.agent.config.json`),
    JSON.stringify({ model: "faux/faux-model", prompt: `你是 ${id}。`, ...(alias === undefined ? {} : { alias }) }),
  );
}

it("开私聊：会话 cwd = work/<id>/（目录自动创建），会话链落 work/<id>/conversation_ids.md", async () => {
  seedEmployee("alice");
  const ws = createWorkspace(root);
  const harness = harnessWithFaux();
  await harness.open();
  try {
    const convId = await openDm(ws, harness, "alice");
    expect(fs.existsSync(path.join(root, "work", "alice"))).toBe(true);
    const chain = readChain(path.join(root, "work", "alice", "conversation_ids.md"));
    expect(chain.map((r) => r.id)).toEqual([convId]);
  } finally {
    await harness.close();
  }
});

it("私聊只挂人级 permission.json；群聊项目在前", () => {
  seedEmployee("alice", undefined, "eng");
  const ws = createWorkspace(root);
  const speaker = loadPerson(ws, "alice");
  expect(permissionFilesFor(ws, { kind: "dm", employeeId: "alice" }, speaker)).toEqual([
    path.join(root, "agents", "eng", "alice.permission.json"),
  ]);
  expect(permissionFilesFor(ws, { kind: "group", project: "yt" }, speaker)).toEqual([
    path.join(root, "projects", "yt", "permission.json"),
    path.join(root, "agents", "eng", "alice.permission.json"),
  ]);
});

it("access：writableDirs = 自己的工作目录 + 主管管理的部门目录（穿透）", () => {
  seedEmployee("alice", undefined, "eng");
  seedEmployee("bob", undefined, "eng/platform");
  fs.writeFileSync(path.join(root, "agents", "eng", "department.config.json"), JSON.stringify({ head: ["alice"] }));
  const ws = createWorkspace(root);
  const access = accessFor(ws, { kind: "dm", employeeId: "alice" }, loadPerson(ws, "alice"));
  expect(access.writableDirs).toEqual([path.join(root, "work", "alice"), path.join(root, "agents", "eng")]);
  expect(access.writableDirs).not.toContain(path.join(root, "agents", "eng", "platform")); // 子树覆盖由前缀判定，不展开
  expect(accessFor(ws, { kind: "dm", employeeId: "bob" }, loadPerson(ws, "bob")).writableDirs).toEqual([
    path.join(root, "work", "bob"),
  ]);
});

it("人级 instructions 用 prompt（不再读 profile.md / MEMORY.md）", () => {
  seedEmployee("alice");
  const ws = createWorkspace(root);
  const out = instructionsFor(ws, { kind: "dm", employeeId: "alice" }, loadPerson(ws, "alice"));
  expect(out).toContain("你是 alice。");
});

it("技能目录不再含员工技能目录（项目 → 空间 → 外部 → 系统内置）", () => {
  seedEmployee("alice");
  const ws = createWorkspace(root);
  const speaker = loadPerson(ws, "alice");
  expect(skillDirsFor(ws, { kind: "dm", employeeId: "alice" }, speaker)).toEqual([
    path.join(root, "openstaffs", "skills"), FRAMEWORK_SKILLS_DIR,
  ]);
  expect(skillDirsFor(ws, { kind: "group", project: "yt" }, speaker)).toEqual([
    path.join(root, "projects", "yt", "skills"), path.join(root, "openstaffs", "skills"), FRAMEWORK_SKILLS_DIR,
  ]);
});
```

> 同时改写文件内已有断言：会话链路径 `agents/alice/conversation_ids.md` → `work/alice/conversation_ids.md`（第 47 / 64 / 88 行的三处）；`loadEmployee` 的 import 换成 `loadPerson`（`src/domain/org.ts`）并改 12 处调用；`agents/alice/skills/*` 相关断言与用例删掉员工技能段（第 176–200、260–270 行范围）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/app/conversations.test.ts`
Expected: FAIL —— cwd 仍是 `agents/alice`、权限文件仍是 `agents/alice/permission.json`、技能目录仍含员工技能。

- [ ] **Step 3: `src/domain/employee.ts` 改为薄适配层**

```ts
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
```

- [ ] **Step 4: 实现 `conversations.ts` 改动**

```ts
// src/app/conversations.ts（改动点）
import { conversationIdsFile, groupConversationIdsFile, projectDir, spaceSkillsDir, workDir, type Workspace } from "../domain/paths.ts";
import { findPerson, loadOrg, loadPerson, managedDirsOf, type OrgPerson } from "../domain/org.ts";
// 删：import { loadEmployee, renderInstructions, type Employee } from "../domain/employee.ts";

/** 人级额外写权限文件（过渡命名：与人同目录、同主干 + `.permission.json`；P3 收进配置的 permissions）。 */
export function agentPermissionFileOf(person: OrgPerson): string {
  return path.join(person.dir, `${person.id}.permission.json`);
}

export function relationCwd(ws: Workspace, relation: Relation): string {
  return relation.kind === "dm" ? workDir(ws, relation.employeeId) : projectDir(ws, relation.project);
}

export function permissionFilesFor(ws: Workspace, relation: Relation, speaker: OrgPerson): string[] {
  const files: string[] = [];
  if (relation.kind === "group") files.push(path.join(projectDir(ws, relation.project), "permission.json"));
  files.push(agentPermissionFileOf(speaker));
  return files;
}

function chainFileFor(ws: Workspace, relation: Relation, speakerId: string): string {
  return relation.kind === "dm"
    ? conversationIdsFile(ws, workDir(ws, relation.employeeId))
    : groupConversationIdsFile(ws, relation.project, speakerId);
}

export function skillDirsFor(
  ws: Workspace, relation: Relation, speaker: OrgPerson, externalSkillDirs: readonly string[] = [],
): string[] {
  const dirs: string[] = [];
  if (relation.kind === "group") dirs.push(path.join(projectDir(ws, relation.project), "skills"));
  // 员工技能目录随「人 = 文件」取消（P3 用 config 的 skills 名引用恢复）
  dirs.push(spaceSkillsDir(ws));
  dirs.push(...externalSkillDirs);
  dirs.push(FRAMEWORK_SKILLS_DIR);
  return dirs;
}

export function accessFor(ws: Workspace, relation: Relation, speaker: OrgPerson): AccessContext {
  const cwd = relationCwd(ws, relation);
  const tree = loadOrg(ws);
  return {
    root: ws.root,
    cwd,
    selfId: speaker.id,
    memberProjects: projectsOf(ws, speaker.id),
    permissionFiles: permissionFilesFor(ws, relation, speaker),
    // 运行时写权（D13）：自己的工作目录 + 主管管理的部门目录（整棵子树由前缀判定覆盖）
    writableDirs: [workDir(ws, speaker.id), ...managedDirsOf(tree, ws, speaker.id)],
  };
}

/** 会话 cwd 必须是真实目录（工具落点与 Pi 会话都要求）。 */
function ensureCwd(cwd: string): string {
  fs.mkdirSync(cwd, { recursive: true });
  return cwd;
}

function specFor(
  ws: Workspace, relation: Relation, speaker: OrgPerson, defaults?: SessionDefaults, mcp?: McpSessionResolver,
): ConversationSpec {
  if (relation.kind === "dm" && speaker.id !== relation.employeeId) {
    throw new Error(`私聊关系与发言人不一致: ${relation.employeeId} ≠ ${speaker.id}`);
  }
  const cwd = ensureCwd(relationCwd(ws, relation));
  // …其余不变
}
```

`instructionsFor` 里的人级段：

```ts
  parts.push(speaker.prompt); // 原：renderInstructions(speaker)
```

`ensure` / `newSession` 里的 `loadEmployee(ws, speakerId)` → `loadPerson(ws, speakerId)`；`roomTranscripts` / `findSessionOwner` 里读 alias 的两处 `loadEmployee(ws, id).alias` → `findPerson(loadOrg(ws), id)?.alias`（注意：`const person = findPerson(...); person?.alias`，避免每行两次扫盘）。

- [ ] **Step 5: `prompt-vars.ts` 改展示名来源**

```ts
// src/domain/prompt-vars.ts（改）
import { personDisplayName } from "./org.ts";
// 删：import { loadEmployee } from "./employee.ts";

function displayNameOf(ws: Workspace, id: string): string {
  return personDisplayName(ws, id);
}
```

- [ ] **Step 6: `registry.ts` 改人员枚举与成员资料**

```ts
// src/tools/registry.ts（改）
import { listPeople, loadPerson, personDisplayName } from "../domain/org.ts";
// 删：import { listEmployees, loadEmployee } from "../domain/employee.ts";

function displayName(ws: Workspace, id: string): string {
  return personDisplayName(ws, id);
}

const officeList: ToolDef = {
  name: "office_list",
  description:
    "列出办公室：全部成员（id、展示名、所在部门）与全部项目（id、展示名、成员 id、你是否在其中）。想了解有哪些同事 / 哪些群聊时用它。",
  parameters: Type.Object({}),
  async run(_args, ctx) {
    const employees = listPeople(ctx.ws).map((p) => ({
      id: p.id,
      name: p.alias ?? p.id,
      department: p.departmentPath === "" ? "（办公室直属）" : p.departmentPath,
    }));
    // …projects 部分不变
  },
};

const memberProfile: ToolDef = {
  name: "member_profile",
  description: "读某位成员的资料：id、展示名与 prompt 正文（人格 / 职责 / 岗位）。参数 member 是成员 id（`<id>.agent.config.json` 的文件名主干）。",
  parameters: Type.Object({ member: Type.String({ description: "成员 id（agents/ 下 `<id>.agent.config.json` 的主干）" }) }),
  async run(args, ctx) {
    const member = String(args["member"]);
    const person = loadPerson(ctx.ws, member);
    const prompt = person.prompt.trim();
    return [`成员：${person.alias ?? person.id}（${person.id}）`, prompt === "" ? "（prompt 为空）" : prompt].join("\n\n");
  },
};
```

- [ ] **Step 7: 迁移其余测试夹具（机械替换，逐文件）**

把每个文件里的 `seedEmployee` 换成 File Structure 里的标准形态（保留各自的签名与调用），并按下面逐文件核对断言：

| 文件 | 必改点 |
|---|---|
| `tests/server/sse.test.ts` | 第 22 行 `rmSync(root/"agents")` 之外补 `rmSync(root/"work")`；第 112 / 195 / 290 行的员工夹具改单文件；第 535–536 行的 `employeeDir(ws,"alice")` → `workDir(ws,"alice")`（会话链已迁移） |
| `tests/app/send.test.ts` | 夹具改单文件；断言不变（展示名 / 投递） |
| `tests/app/permission-flow.test.ts` | 夹具改单文件（**授权链路的行为断言留到 Task 5**） |
| `tests/server/pump-trigger.test.ts` | 夹具改单文件 |
| `tests/server/http.test.ts` | 第 74–84 行夹具改单文件（alice 带 alias/model、carol 无） |
| `tests/domain/prompt-vars.test.ts` | 夹具改单文件（alias 仍生效） |
| `tests/tools/registry.test.ts` | `member_profile` 用例：删 `profile.md` 写入，改为夹具的 `prompt: "职责：后端工程师。"`；`office_list` 用例追加断言含 `"（办公室直属）"`；第 78 / 186 行的 `agents/bob/profile.md`、`agents/alice/conversation_ids.md` 路径删 / 改 `work/alice/conversation_ids.md` |
| `tests/domain/mcp.test.ts`、`tests/harness/mcp-manager.test.ts` | 夹具改单文件（本任务只改夹具，**员工层 mcp.json 用例留到 Task 5**） |
| `tests/domain/employee.test.ts` | **保留并适配**（B1：`employee.ts` 不删，能力虽被 `org-config.test.ts` / `org.test.ts` 覆盖，仍保留对适配层的转发断言） |

- [ ] **Step 8: 跑全量确认通过**

Run: `npm test && npm run typecheck`
Expected: 全绿（`tests/domain/employee.test.ts` 已保留并适配，未删）。

- [ ] **Step 9: 提交**

```bash
git add -A src/domain/employee.ts src/app/conversations.ts src/domain/prompt-vars.ts src/tools/registry.ts tests
git commit -m "refactor(org): 人 = <名字>.agent.config.json 接入会话装配与工具层（DM 工作目录 / 人级 prompt / 人级权限文件）"
```

---

## Task 5: 权限落点与能力来源迁移（permission-flow / mcp / pump / send）

**Files:**
- Modify: `src/app/permission-flow.ts`、`src/domain/mcp.ts`、`src/server/pump.ts`、`src/app/send.ts`
- Test: `tests/app/permission-flow.test.ts`、`tests/domain/mcp.test.ts`、`tests/harness/mcp-manager.test.ts`、`tests/server/http.test.ts`（授权链路断言）、`tests/tools/extension.test.ts`

**Interfaces:**
- Consumes: `findPerson` / `loadOrg` / `personDisplayName`（Task 2）、`agentPermissionFileOf`（Task 4）
- Produces:
  - `permissionFilePath(ws, agentId) = <人所在目录>/<id>.permission.json`（找不到人 → 回落 `agents/<id>.permission.json`）
  - `resolvePermissionRequest` accept 分支：存在性用 `findPerson(loadOrg(ws), id) !== undefined`
  - `loadMcpSnapshot`：不再扫员工层 `agents/<id>/mcp.json`；`sourcesFor` 保留 `employee` 分支（P3 用配置的 `mcp` 名引用恢复）
  - `Pump` / `send.ts`：内部展示名与人员枚举改走 org

- [ ] **Step 1: 写失败测试**

```ts
// tests/app/permission-flow.test.ts（改）
it("accept：写人级 permission.json（<人所在目录>/<id>.permission.json），投递「已完成授权」", async () => {
  seedEmployee("alice", "爱丽丝", "eng"); // 人落在 agents/eng/
  const { ws, store, port, register, broadcast, deps } = setup();
  const target = path.join(root, "outside", "shared");
  const request = store.add({ agentId: "alice", roomKey: "dm:alice", paths: [target], reason: "要写共享目录" });

  const result = await resolvePermissionRequest(deps, request.id, "accept");
  expect(result).toEqual({ ok: true });
  expect(permissionFilePath(ws, "alice")).toBe(path.join(root, "agents", "eng", "alice.permission.json"));
  expect(JSON.parse(fs.readFileSync(permissionFilePath(ws, "alice"), "utf8"))).toEqual([target]);
  expect(agentPermissionFileOf(loadPerson(ws, "alice"))).toBe(permissionFilePath(ws, "alice"));
  // …其余断言（投递 / 去重键 / 广播 / 清请求）不变
});

// tests/domain/mcp.test.ts（删员工层用例，改断言）
it("员工层不再有 mcp.json 来源：私聊只有空间 + 系统", () => {
  writeJson(path.join(root, "agents", "alice.agent.config.json"), JSON.stringify({ prompt: "x" }));
  writeJson(path.join(root, "agents", "alice", "mcp.json"), { mcpServers: { gone: server("employee") } });
  const snapshot = loadMcpSnapshot(ws, { systemFile });
  expect(snapshot.sources.some((s) => s.scope.kind === "employee")).toBe(false);
  expect(resolveMcpServers(snapshot, { kind: "dm", employeeId: "alice" }, "alice").selections).toEqual([]);
});
```

> 同文件另两处断言一并改：第 101 行「发起者已不存在」用例 → 断言 `fs.existsSync(permissionFilePath(ws, "ghost")) === false`（找不到人时回落到 `agents/ghost.permission.json`，依旧不存在）；第 129–140 行「写盘失败」用例 → 把 `agents/eng` 建成**文件**（占位），人落在 `agents/eng/` 下 → 人级权限文件的 `mkdir` 失败 → 仍抛错且请求保留、不投递、不广播。
>
> `tests/harness/mcp-manager.test.ts` 第 63–76、214–228 行的「员工层隔离」用例改为**项目层隔离**（`projects/p1/mcp.json` 与 `projects/p2/mcp.json`），断言 `mcp:project:p1:*` 不串到 p2。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/app/permission-flow.test.ts tests/domain/mcp.test.ts`
Expected: FAIL —— 权限文件仍落在旧路径；员工层 mcp.json 仍被读入。

- [ ] **Step 3: 实现 `permission-flow.ts`**

```ts
// src/app/permission-flow.ts（改）
import { agentsDir, type Workspace } from "../domain/paths.ts";
import { findPerson, loadOrg } from "../domain/org.ts";
import { agentPermissionFileOf } from "./conversations.ts";

/** 人级授权文件（人 = 文件后，授权与定义同目录、同主干；找不到人 → 回落 agents/ 根）。 */
export function permissionFilePath(ws: Workspace, agentId: string): string {
  const person = findPerson(loadOrg(ws), agentId);
  return person === undefined ?
    path.join(agentsDir(ws), `${agentId}.permission.json`) :
    agentPermissionFileOf(person);
}

export function permissionRequestView(ws: Workspace, request: PermissionRequest): PermissionRequestView {
  const alias = findPerson(loadOrg(ws), request.agentId)?.alias;
  return { ...request, agentName: alias ?? request.agentId };
}

// accept 分支的存在性检查：
    if (decision === "accept") {
      if (findPerson(loadOrg(deps.ws), request.agentId) === undefined) {
        throw new PermissionRequestNotFoundError(`发起者已不存在：${request.agentId}（可点「拒绝」清除该请求）`);
      }
      appendPermissionPaths(permissionFilePath(deps.ws, request.agentId), request.paths);
    }
```

- [ ] **Step 4: 实现 `mcp.ts`（去掉员工层扫描）**

```ts
// src/domain/mcp.ts（改 loadMcpSnapshot：删掉 for (const employee of listEmployees(ws)) { … } 整段）
// 同时删 import { listEmployees } from "./employee.ts"; 与 employeeDir 的 import（若不再使用）
export function loadMcpSnapshot(ws: Workspace, options?: { systemFile?: string }): McpSnapshot {
  const credentials = readMcpCredentials(ws);
  const sources: McpSource[] = [];
  sources.push(readMcpSource({ kind: "system" }, options?.systemFile ?? SYSTEM_MCP_FILE, credentials));
  sources.push(readMcpSource({ kind: "space" }, path.join(spaceDir(ws), "mcp.json"), credentials));
  // 员工层 mcp.json 随「人 = 文件」取消；P3 用 agent.config.json 的 `mcp` 名引用恢复
  for (const project of listProjects(ws)) {
    sources.push(readMcpSource({ kind: "project" }, path.join(projectDir(ws, project.id), "mcp.json"), credentials));
  }
  return { sources };
}
```

- [ ] **Step 5: 实现 `pump.ts` / `send.ts` 直连 org**

```ts
// src/server/pump.ts（改）
import { findPerson, loadOrg, listPeople } from "../domain/org.ts";
// 删：import { loadEmployee, listEmployees } from "../domain/employee.ts";

// register()：
    const alias = findPerson(loadOrg(this.#deps.ws), ref.memberId)?.alias;
    const fullRef: RoomRef = { ...ref, ...(alias === undefined ? {} : { alias }) };

// registerAll()：for (const person of listPeople(ws)) { … roomKey: `dm:${person.id}` … }

// src/app/send.ts（改）
import { personDisplayName } from "../domain/org.ts";
// 删：import { loadEmployee } from "../domain/employee.ts";
function senderLabel(ws: Workspace, senderId: string): string {
  const alias = personDisplayName(ws, senderId);
  return alias === senderId ? senderId : `${alias}（${senderId}）`;
}
```

- [ ] **Step 6: 跑全量确认通过**

Run: `npm test && npm run typecheck`
Expected: 全绿。

- [ ] **Step 7: 提交**

```bash
git add src/app/permission-flow.ts src/domain/mcp.ts src/server/pump.ts src/app/send.ts tests
git commit -m "refactor(org): 权限落点与能力来源迁移（人级权限文件 / 去员工层 mcp.json / 推流与展示名）"
```

---

## Task 6: HTTP `/api/org`（`employee.ts` 收口为薄适配层，B1 不删）

**Files:**
- Modify: `src/server/http.ts`、`src/domain/employee.ts`（收口复核：薄适配层，B1）、`src/domain/paths.ts`（`employeeDir` **保留**）
- Test: `tests/server/http.test.ts`、`tests/domain/paths.test.ts`、`tests/domain/employee.test.ts`

**Interfaces:**
- Consumes: `loadOrg` / `findPerson`（Task 2）、`workDir`（Task 3）、`formatModelRef` / `resolveEmployeeModel`（`config.ts`）
- Produces:
  - `GET /api/org` → `{ root: { path; name; people: { id; alias?; model }[]; departments: [...] } }`
  - `GET /api/employees` **移除**（破坏性；前端 Task 7 同步换）
  - `roomExists` 的私聊分支：`findPerson(loadOrg(ws), id) !== undefined`

- [ ] **Step 1: 写失败测试**（`tests/server/http.test.ts`）

```ts
it("GET /api/org：部门树 + 人（含模型兜底）；/api/employees 已移除", async () => {
  fs.mkdirSync(path.join(root, "agents", "eng"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", "eng", "department.config.json"), JSON.stringify({ alias: "研发部", head: ["alice"] }));
  fs.writeFileSync(path.join(root, "agents", "eng", "alice.agent.config.json"), JSON.stringify({ alias: "爱丽丝", model: "anthropic/claude-x", prompt: "你是 alice。" }));
  fs.mkdirSync(path.join(root, "agents", "eng", "platform"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", "eng", "platform", "bob.agent.config.json"), JSON.stringify({ prompt: "你是 bob。" }));
  fs.writeFileSync(path.join(root, "agents", "staff0.agent.config.json"), JSON.stringify({ prompt: "管家" }));

  const ws = createWorkspace(root);
  const { base, close } = await start({ ws, getConfig: () => configured, getHarness: () => undefined, queue: new KeyedQueue(), publicDir, port: 4319 });
  try {
    const org = (await (await fetch(`${base}/api/org`)).json()) as { root: { path: string; name: string; people: { id: string; alias?: string; model: string }[]; departments: unknown[] } };
    expect(org.root.path).toBe("");
    expect(org.root.name).toBe("办公室");
    expect(org.root.people.map((p) => p.id)).toEqual(["staff0"]);
    expect(org.root.departments).toHaveLength(1);
    const eng = org.root.departments[0] as { name: string; people: { id: string; alias?: string; model: string }[]; departments: { name: string; people: { id: string; model: string }[] }[] };
    expect(eng.name).toBe("研发部");
    expect(eng.people[0]).toEqual({ id: "alice", alias: "爱丽丝", model: "anthropic/claude-x" });
    expect(eng.departments[0]!.name).toBe("platform");
    expect(eng.departments[0]!.people[0]).toEqual({ id: "bob", model: "faux/faux-model" }); // 兜底全局模型
    expect((await fetch(`${base}/api/employees`)).status).toBe(404);
  } finally {
    await close();
  }
});
```

> 既有「employees/projects 列表」用例改成 `/api/org` 断言；`/api/projects` 的成员 alias 仍需正确（走 org）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/server/http.test.ts`
Expected: FAIL —— `/api/org` 404；`/api/employees` 仍 200。

- [ ] **Step 3: 实现 `http.ts`**

```ts
// src/server/http.ts（改）
import { findPerson, loadOrg, type OrgDepartment, type OrgTree } from "../domain/org.ts";
import { projectDir, type Workspace } from "../domain/paths.ts";
// 删：import { listEmployees, loadEmployee } from "../domain/employee.ts";

type OrgPersonJson = { id: string; alias?: string; model: string };
type OrgDeptJson = { path: string; name: string; people: OrgPersonJson[]; departments: OrgDeptJson[] };

/** 部门 → 视图：展示名 = department.config.json 的 alias，根部门兜底「办公室」。 */
function orgDeptView(config: WorkspaceConfig, dept: OrgDepartment): OrgDeptJson {
  return {
    path: dept.path,
    name: dept.path === "" ? (dept.alias ?? "办公室") : (dept.alias ?? dept.name),
    people: dept.people.map((person) => ({
      id: person.id,
      ...(person.alias === undefined ? {} : { alias: person.alias }),
      model: formatModelRef(resolveEmployeeModel(config.model, person.model)),
    })),
    departments: dept.departments.map((child) => orgDeptView(config, child)),
  };
}

function roomExists(ws: Workspace, relation: Relation): boolean {
  return relation.kind === "dm"
    ? findPerson(loadOrg(ws), relation.employeeId) !== undefined
    : fs.existsSync(projectDir(ws, relation.project));
}

function memberSummaries(ws: Workspace, tree: OrgTree, project: string): { id: string; alias?: string }[] {
  return parseMembers(ws, project).map((id) => {
    const person = findPerson(tree, id);
    return { id, ...(person?.alias === undefined ? {} : { alias: person.alias }) };
  });
}

// 路由：把 segments[1] === "employees" 整段替换为
          if (segments[1] === "org" && method === "GET") {
            json(res, 200, { root: orgDeptView(config, loadOrg(deps.ws).root) });
            return;
          }
```

`memberSummaries` 的调用点（`/api/projects`）改成一次 `const tree = loadOrg(deps.ws)` 后传进去；`pins` 端点的 `for (const employee of listEmployees(deps.ws))` → `for (const person of loadOrg(deps.ws).people)`，roomKey 用 `dm:${person.id}`。

- [ ] **Step 4: `employee.ts` 收口为薄适配层（不删；`employeeDir` 保留）**

- `src/domain/employee.ts`：保持导出签名不变（`Employee` / `loadEmployee` / `listEmployees` / `renderInstructions`），实现**只转调 `src/domain/org.ts`**（B1；P3 / P5 仍消费它，调用方一律不动）；Task 4 已改过一遍，这里只做收口复核；
- `src/domain/paths.ts`：`employeeDir` **保留**（B1；供 P3 的 `roomExists`、P5 继续使用）；
- 确认适配层无自行实现：`grep -n "scanOrg\|readdirSync\|readFileSync" src/domain/employee.ts` → 输出为空（取数全部来自 org）。

- [ ] **Step 5: 跑全量确认通过**

Run: `npm test && npm run typecheck`
Expected: 全绿（`employee.ts` 与 `employeeDir` 均按 B1 **保留**，故不再要求 `grep` 清零）。

- [ ] **Step 6: 提交**

```bash
git add -A src/server/http.ts src/domain/employee.ts src/domain/paths.ts tests/server/http.test.ts tests/domain/paths.test.ts tests/domain/employee.test.ts
git commit -m "feat(server): /api/org 输出部门树；employee.ts 收口为薄适配层"
```

---

## Task 7: 侧栏可折叠部门树（web）

**Files:**
- Modify: `web/api.ts`、`web/state.ts`、`web/render.ts`、`web/main.ts`、`web/styles.css`
- Test: `tests/web/render.test.ts`、`tests/web/state.test.ts`、`tests/web/api.test.ts`

**Interfaces:**
- Consumes: `GET /api/org`（Task 6）
- Produces:
  - `api.org(): Promise<{ root: OrgDept }>`；类型 `OrgPerson = { id; alias?; model }`、`OrgDept = { path; name; people: OrgPerson[]; departments: OrgDept[] }`
  - `State.org?: OrgDept`、`State.collapsedDepts: string[]`；`UiEvent += { type:"org"; root }` / `{ type:"toggle-dept"; path }`
  - `flattenOrg(root: OrgDept): EmployeeSummary[]`（DFS；喂 `state.employees`）
  - `sidebarHtml`：根部门直属人平铺 + 子部门可折叠；折叠时不渲染其正文

- [ ] **Step 1: 写失败测试**

```ts
// tests/web/state.test.ts（追加）
const ORG = {
  path: "", name: "办公室",
  people: [{ id: "staff0", model: "faux/faux-model" }],
  departments: [
    { path: "eng", name: "研发", people: [{ id: "alice", alias: "爱丽丝", model: "faux/x" }],
      departments: [{ path: "eng/platform", name: "平台", people: [{ id: "bob", model: "faux/y" }], departments: [] }] },
  ],
};

it("org 事件：喂树 + 拍平 employees（DFS 顺序）", () => {
  const state = reduce(initialState, { type: "org", root: ORG });
  expect(state.org).toEqual(ORG);
  expect(state.employees.map((e) => e.id)).toEqual(["staff0", "alice", "bob"]);
});

it("toggle-dept：可折叠可展开（幂等）", () => {
  let state = reduce(initialState, { type: "toggle-dept", path: "eng" });
  expect(state.collapsedDepts).toEqual(["eng"]);
  state = reduce(state, { type: "toggle-dept", path: "eng/platform" });
  expect(state.collapsedDepts).toEqual(["eng", "eng/platform"]);
  state = reduce(state, { type: "toggle-dept", path: "eng" });
  expect(state.collapsedDepts).toEqual(["eng/platform"]);
});

// tests/web/render.test.ts（追加；本文件自带一份组织树夹具）
const ORG = {
  path: "", name: "办公室",
  people: [{ id: "staff0", model: "faux/faux-model" }],
  departments: [
    { path: "eng", name: "研发", people: [{ id: "alice", alias: "爱丽丝", model: "faux/x" }],
      departments: [{ path: "eng/platform", name: "平台", people: [{ id: "bob", model: "faux/y" }], departments: [] }] },
  ],
};

it("sidebarHtml：部门树（嵌套 + 折叠时不渲染正文 + 空部门仍出部门头）", () => {
  const state = { ...initialState, configured: true, org: ORG, pins: { "dm:bob": 1 } };
  const html = sidebarHtml(state);
  expect(html).toContain('data-toggle-dept="eng"');
  expect(html).toContain('data-toggle-dept="eng/platform"');
  expect(html).toContain('data-room="dm:alice"');
  expect(html).toContain('data-room="dm:bob"');
  expect(html).toContain('<span class="badge">1</span>');
  expect(html).toContain("爱丽丝");
  expect(html).toContain('aria-expanded="true"');

  const collapsed = sidebarHtml({ ...state, collapsedDepts: ["eng"] });
  expect(collapsed).toContain('data-toggle-dept="eng"');
  expect(collapsed).not.toContain('data-room="dm:alice"'); // 折叠后正文不渲染
  expect(collapsed).not.toContain('data-room="dm:bob"');
  expect(collapsed).toContain('aria-expanded="false"');

  const empty = sidebarHtml({ ...initialState, configured: true, org: { path: "", name: "办公室", people: [], departments: [{ path: "eng", name: "研发", people: [], departments: [] }] } });
  expect(empty).toContain('data-toggle-dept="eng"');
  expect(empty).not.toContain("还没有员工");
});

it("sidebarHtml：无 org 数据时回落平铺（首帧不白屏）；都没有才出提示", () => {
  const flat = sidebarHtml({ ...initialState, configured: true, employees: [{ id: "alice", alias: "爱丽丝", model: "faux/x" }] });
  expect(flat).toContain('data-room="dm:alice"');
  const empty = sidebarHtml({ ...initialState, configured: true });
  expect(empty).toContain("还没有员工");
  expect(empty).toContain("&lt;名字&gt;.agent.config.json");
});

// tests/web/api.test.ts（追加）
it("org：GET /api/org", async () => {
  const calls = stubFetch({ root: { path: "", name: "办公室", people: [], departments: [] } });
  await api.org();
  expect(calls[0]!.url).toBe("/api/org");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/web`
Expected: FAIL —— `api.org` / `org` 事件 / 折叠渲染均不存在。

- [ ] **Step 3: 实现 `web/api.ts`**

```ts
export type OrgPerson = { id: string; alias?: string; model: string };
export type OrgDept = { path: string; name: string; people: OrgPerson[]; departments: OrgDept[] };

export const api = {
  status: () => request<Status>("/api/status"),
  /** 组织树（部门嵌套 + 人）；取代旧的 /api/employees 平铺列表。 */
  org: () => request<{ root: OrgDept }>("/api/org"),
  projects: () => request<ProjectSummary[]>("/api/projects"),
  // …其余不变（删掉 employees）
};
```

- [ ] **Step 4: 实现 `web/state.ts`**

```ts
import type { EmployeeSummary, OrgDept, PermissionRequestView, ProjectSummary, RoomSessionInfo } from "./api.ts";

export type State = {
  // …既有字段
  /** 组织树（部门嵌套）；未拿到时为 undefined（侧栏回落平铺）。 */
  org?: OrgDept;
  /** 折叠的部门路径（**不持久化**：刷新回到全展开）。 */
  collapsedDepts: string[];
};

export const initialState: State = { /* …既有 */ org: undefined, collapsedDepts: [] };

export type UiEvent =
  | { type: "status"; configured: boolean; bossName: string }
  | { type: "org"; root: OrgDept }
  // …（删掉 { type: "employees" }）
  | { type: "toggle-dept"; path: string };

/** 部门树 → 平铺的人员列表（DFS：本部门的人在前，再依次进子部门）；chat / 会话信息条仍读平铺列表。 */
export function flattenOrg(root: OrgDept): EmployeeSummary[] {
  const out: EmployeeSummary[] = [];
  const walk = (dept: OrgDept): void => {
    out.push(...dept.people);
    for (const child of dept.departments) walk(child);
  };
  walk(root);
  return out;
}

// reduce()：
    case "org":
      return { ...state, org: event.root, employees: flattenOrg(event.root) };
    case "toggle-dept": {
      const collapsed = state.collapsedDepts.includes(event.path)
        ? state.collapsedDepts.filter((path) => path !== event.path)
        : [...state.collapsedDepts, event.path];
      return { ...state, collapsedDepts: collapsed };
    }
```

- [ ] **Step 5: 实现 `web/render.ts` 侧栏**

```ts
// web/render.ts（改：sidebarHtml 换成部门树；新增 personItemHtml / deptHtml）
import type { EmployeeSummary, OrgDept } from "./api.ts";

function personItemHtml(state: State, person: EmployeeSummary): string {
  const roomKey = `dm:${person.id}`;
  const pins = state.pins[roomKey] ?? 0;
  const busy = state.busy[person.id] === true ? '<span class="dot"></span>' : "";
  const active = state.roomKey === roomKey ? " active" : "";
  return `<button class="item${active}" data-room="${escapeHtml(roomKey)}"><span>${escapeHtml(person.alias ?? person.id)}${busy}</span>${pins > 0 ? `<span class="badge">${pins}</span>` : ""}</button>`;
}

/** 部门节点：可折叠（折叠时不渲染正文——不是藏起来再叠着显示）。 */
function deptHtml(state: State, dept: OrgDept): string {
  const collapsed = state.collapsedDepts.includes(dept.path);
  const body = [...dept.people.map((p) => personItemHtml(state, p)), ...dept.departments.map((d) => deptHtml(state, d))].join("");
  return `<div class="dept" data-dept="${escapeHtml(dept.path)}">
    <button type="button" class="dept-head" data-toggle-dept="${escapeHtml(dept.path)}" aria-expanded="${collapsed ? "false" : "true"}"><span class="caret">${collapsed ? "▸" : "▾"}</span><span>${escapeHtml(dept.name)}</span></button>
    ${collapsed ? "" : `<div class="dept-body">${body}</div>`}
  </div>`;
}

export function sidebarHtml(state: State): string {
  const root = state.org;
  const employeeItems =
    root === undefined
      ? state.employees.map((person) => personItemHtml(state, person)).join("") // 首帧（org 未到）回落平铺
      : [...root.people.map((person) => personItemHtml(state, person)), ...root.departments.map((dept) => deptHtml(state, dept))].join("");
  // …projectItems 保持不变
  return `<aside class="sidebar" id="sidebar">
    <h3>员工</h3>${employeeItems || `<p class="hint">还没有员工：在 agents/ 下创建 &lt;名字&gt;.agent.config.json（见 README.md）。</p>`}
    <h3>项目</h3>${projectItems || `<p class="hint">还没有项目：在 projects/ 下创建目录并写 members.md（见 README.md）。</p>`}
  </aside>`;
}
```

> 根部门的人直接平铺在「员工」下（不再包一层可折叠节点）；根部门的 `name`（`alias ?? 办公室`）不在侧栏显示。

- [ ] **Step 6: 实现 `web/main.ts`**

```ts
// 折叠绑定（renderSidebar 重建侧栏后必须重挂）
function bindDeptToggles(): void {
  for (const button of app.querySelectorAll<HTMLElement>("[data-toggle-dept]")) {
    button.addEventListener("click", () => dispatch({ type: "toggle-dept", path: button.dataset.toggleDept! }));
  }
}

function renderSidebar(): void {
  const sidebar = document.getElementById("sidebar");
  if (sidebar === null) return;
  sidebar.outerHTML = sidebarHtml(state);
  bindRoomButtons(); // outerHTML 重建了侧栏，需重新挂载房间点击
  bindDeptToggles(); // 以及部门折叠
}

function bindEvents(): void {
  bindRoomButtons();
  bindDeptToggles();
  // …其余不变
}

// main() 与 refreshAll()：api.employees() → api.org()，dispatch({ type: "org", root: org.root }, "all")
```

- [ ] **Step 7: 实现 `web/styles.css` 树样式**

```css
/* 部门树（侧栏） */
.dept-head { display: flex; align-items: center; gap: 4px; width: 100%; border: 0; background: transparent; padding: 6px 6px; cursor: pointer; font-size: 13px; color: #5b6169; text-align: left; }
.dept-head:hover { background: #f0f2f5; border-radius: 8px; }
.dept-body { padding-left: 12px; }
.caret { width: 10px; font-size: 10px; color: #a0a6ad; }
```

- [ ] **Step 8: 跑测试确认通过**

Run: `npm test && npm run typecheck && npm run build:web`
Expected: 全绿；bundle 构建成功。

- [ ] **Step 9: 手工冒烟（真实链路）**

1. `cd <测试办公空间> && npm start -- /path/to/office`（框架目录里执行）；
2. 建 `agents/eng/department.config.json`（`{"alias":"研发部","head":["alice"]}`）+ `agents/eng/alice.agent.config.json`（`{"prompt":"你是 alice。"}`）+ `agents/eng/platform/bob.agent.config.json`；
3. 刷新页面：侧栏「员工」下出现 `▾ 研发部`，其下有 alice 与 `▾ platform → bob`；
4. 点 `研发部`：alice 与 platform 整体消失，箭头变 `▸`；再点恢复；
5. 点 alice 进私聊发一句 → 回复正常；`<办公空间>/work/alice/` 被创建（含 `conversation_ids.md`）；
6. 让 alice 尝试 `write` 到 `agents/eng/platform/bob.agent.config.json` → 被拦截并提示可 `request_permission`（用一次 write 工具的越界路径即可观察）。

- [ ] **Step 10: 提交**

```bash
git add web tests/web
git commit -m "feat(web): 侧栏换成可折叠部门树（/api/org）"
```

---

## Task 8: 文档同步（仓库约定的四份）

**Files:**
- Modify: `src/skills/openstaffs/SKILL.md`（员工能力真相源）
- Modify: `src/skills/openstaffs-ops/SKILL.md`（运维真相源）
- Modify: `README.md`
- Modify: `docs/产品规划.md`

**Interfaces:**
- Consumes: 前面任务落地的实际行为（无法凭空写）
- Produces: 四份文档与新形态一致（改错就是"员工不知道自己能做什么"）

- [ ] **Step 1: `src/skills/openstaffs/SKILL.md`**

- 「你是谁、在哪工作」：`每个员工 = 一个文件夹 agents/<员工 id>/` → **`人 = agents/<部门…>/<名字>.agent.config.json` 一个文件；文件夹 = 部门（可嵌套）**；**私聊工作目录 = `work/<你的名字>/`**；群聊工作目录 = 项目目录（本轮仍是目录）。
- 「写权限边界」1. → **你自己的目录 `work/<你自己>/`**；新增 3. **你作为主管时，可写你所在部门整棵子树（部门 + 人，任意深度；同级兄弟不可写）**；明确「任何人（含主管）都**不能**写 `*.agent.config.json` / `department.config.json` / `*.permission.json`」。
- 「可用工具」：`office_list` 增加「所在部门」；`member_profile` 改说 `prompt`（不再是 `profile.md`）。
- 「MCP 外部工具」：删掉「你可以在自己的目录写 `agents/<你>/mcp.json`」这句，改为「本版本员工级 MCP 挂载已取消（合并进统一配置是后续阶段）；需要新 server 请找老板加空间 / 项目层」。
- 「产出约定」：记忆 `MEMORY.md` 的落点改 `work/<你>/MEMORY.md`（并注明「本阶段只分配工作目录，默认记忆文件在后续阶段提供」）。
- 「可用技能」：技能来源去掉「员工技能目录」，改为 项目 → 空间（含老板外部技能库）→ 系统内置。

- [ ] **Step 2: `src/skills/openstaffs-ops/SKILL.md`**

- 「办公空间全景」目录树重写为 spec §3 形态：`agents/`（部门文件夹 + `department.config.json` + `<名字>.agent.config.json` + `projects/` + `work/<名字>/` + `openstaffs/` + `.openstaffs/`）。
- 「级别定义」表：员工行「人格／记忆／技能／权限」→「人格 prompt / 部门归属 / 授权文件」，落点改 `agents/**/<名字>.agent.config.json`。
- 「员工目录」整节改写为**「人在哪：`agents/**/<名字>.agent.config.json`」**：字段表（`alias` / `model` / `thinkingLevel` / `prompt`）+ 部门声明 `department.config.json`（`alias` / `head`）+ 负责人规则（只能选**本级直属成员**；写不匹配的 id 视为无）+ 穿透管理权口径 + 「同一 id 全局唯一，重复取第一个」+ 人级授权文件 `agents/**/<id>.permission.json`（机器 / 老板写，员工不可写）。
- 「MCP」节：去掉员工层 mcp.json，保留 系统 / 空间 / 项目三层，并注明员工层是后续阶段。
- 「改动生效方式」：员工 prompt / alias / model 的生效口径（alias 刷新即生效；prompt / model 新开会话生效）。
- 「常见故障对照」：补两条 —— 「改了 `.agent.config.json` 不生效：私聊会话用旧快照，点新开会话」；「某人不见了：文件名不是 `<名字>.agent.config.json` 或落在隐藏目录」。

- [ ] **Step 3: `README.md`**

- 「2. Agent（员工）」：最小做法改为

```bash
mkdir -p agents/eng
cat > agents/eng/alice.agent.config.json <<'EOF'
{ "alias": "爱丽丝", "model": "opencode-go/deepseek-v4.1-flash", "prompt": "你是 alice，负责前端开发。用中文汇报。" }
EOF
```

外加一句：`agents/` 下**文件夹 = 部门、可任意嵌套**；`department.config.json` 的 `head` 写部门负责人（只能写本级直属成员）；人的工作目录是 `work/<名字>/`。
- 「3. 项目（群聊）」不变（项目形态本轮不动）。
- 侧栏说明补一句「员工按部门折叠成树，点部门名展开 / 收起」。

- [ ] **Step 4: `docs/产品规划.md`**

- 「未落地」表：
  - 「组织架构」行：当前实现改为 **`agents/` 部门树（文件夹 = 部门、`<名字>.agent.config.json` = 人）+ 负责人（`head`）+ 穿透管理权**；Staff0 仍留「未实现（见路线图）」。
  - 「员工人格文件」行：当前实现改为 `agents/**/<名字>.agent.config.json` 的 `prompt`（不再有 `AGENTS.md` + `profile.md`）。
  - 「技能清单」行：注明员工技能目录已随「人 = 文件」取消，后续阶段用配置的名引用恢复。
- 「空间层命名与落点」表：员工行的落点更新为 `agents/**/<名字>.agent.config.json` / （员工技能：后续阶段）/ （员工 MCP：后续阶段）。

- [ ] **Step 5: 提交**

```bash
git add src/skills/openstaffs/SKILL.md src/skills/openstaffs-ops/SKILL.md README.md docs/产品规划.md
git commit -m "docs: 同步能力手册 / 运维参考 / README / 产品规划（组织架构 P2）"
```

---

## Task 9: 全量回归 + 冒烟记录

**Files:**
- Modify: 本计划文件（**文件末尾、Self-Review 之后**追加 `## 执行记录`）；如回归暴露问题，回到对应任务修补

- [ ] **Step 1: 全量校验**

Run: `npm test && npm run typecheck && npm run build:web`
Expected: 全绿。

- [ ] **Step 2: 残留引用扫描**

Run: `grep -rn "api\.employees\|/api/employees" src web tests`
Expected: 无匹配（`/api/employees` 已被 `/api/org` 取代）。注：`employeeDir` / `loadEmployee` / `listEmployees` / `renderInstructions` / `domain/employee` 按 **B1 保留**，不再要求清零——`src/domain/employee.ts` 是本重构的**长期薄适配层**（是否彻底删由 P5 收口）。

- [ ] **Step 3: 端到端冒烟（照着 Task 7 Step 9 的 6 步重跑一遍，加两条）**

7. 主管写权：把 alice 设为 `eng` 的 head 后，让她写 `agents/eng/platform/notes.md` → 成功；写 `agents/sales/notes.md` → 被拦截；
8. 权限链路：让 alice 对空间外路径 `request_permission` → 界面弹框接受 → `agents/eng/alice.permission.json` 出现该路径 → alice 再写该路径成功。

- [ ] **Step 4: 记录执行结果**

在本文件末尾追加：

```markdown
## 执行记录

- 日期：YYYY-MM-DD · 分支：feat/org-hierarchy
- `npm test` / `npm run typecheck` / `npm run build:web`：<通过 / 失败原因>
- 手工冒烟：<Task 7 Step 9 六步 + Task 9 Step 3 两步的实际结果；失败就写现象与后续单>
- 与 P1 的衔接：P1 已合并 / 未合并；`sessionId` 是否补填：否（理由：P2 不改变消息→会话映射；补填走 store 写行时用 `work/<id>/conversation_ids.md` 的活跃行）
- 跨阶段假设是否被证伪：<P3/P4/P5 若有提前落地的改动，记在此>
```

- [ ] **Step 5: 提交**

```bash
git add docs/superpowers/plans/2026-10-19-org-hierarchy.md
git commit -m "test: P2 组织架构全量回归与冒烟记录"
```

---

## Self-Review 记录

**1. Spec 覆盖**

| Spec | 落点 |
|---|---|
| §3 目录结构（`agents/` 部门嵌套、`<名字>.agent.config.json`、根 `department.config.json`） | Task 1（扫描）· Task 6（`/api/org`） |
| §4 字段表（人：`alias?` / `model?` / `prompt?`；部门：`head?`；`avatar` / `skills` / `mcp` / `permissions` 归 P3） | Task 1（窄解析）· 跨阶段假设（P3 接手其余字段） |
| §5 负责人（数组、可空、只能选本级成员、匹配不到即无）+ 穿透管理权（最近有 head 的祖先部门；管整棵子树） | Task 2 |
| §6 权限要点（D13 运行时写权：自己的工作目录 + 主管子树；人不可写任何 agent 配置） | Task 3（判序与受保护名）· Task 4（`writableDirs` 计算） |
| §10 P2 行（部门嵌套 / 发现与解析 / head 与穿透 / 侧栏可折叠树） | Task 1–7 |
| §12 模块化（config / org 两域模块；基座只在 harness） | Task 1 / Task 2（本计划不碰 `harness/`） |
| D30 不做迁移 | Global Constraints + Task 4 的夹具全量迁移（无兼容分支） |
| D20 / D27（`work/<名字>/`；MEMORY 归 P5） | Task 3（`workDir`）· Task 4（cwd / 会话链落点，不写 MEMORY） |
| 仓库 AGENTS.md 文档同步表 | Task 8（四份文档全覆盖） |
| P1 衔接（`sessionId` / `messagesDbFile`） | 跨阶段假设表 + Task 9 Step 4 记录「不补填」 |
| P3 / P4 / P5 边界 | 跨阶段假设表（明确不做项与证伪后果） |

**2. Placeholder 扫描**：无 TODO / TBD；每个实现步骤都给了可直接抄的代码或逐文件必改点表；测试步骤给了完整断言。Task 7 Step 9 与 Task 9 Step 3 是**手工冒烟清单**（前端交互无法用单测覆盖），逐条可执行、可判真假。

**3. 类型一致性**

- `OrgPerson = AgentConfig`（Task 1 产出）贯穿 Task 2 / 4 / 5 / 6；`departmentPath` 在扫描期就填好，避免 `buildOrg` 做路径运算。
- `headsOf` / `managersOf` / `managedDepartmentsOf` / `managedDirsOf`（Task 2）→ `accessFor.writableDirs`（Task 4）→ `isWriteAllowed`（Task 3）：`writableDirs` 存**绝对目录**，`isManagedDepartment` 存**部门路径**，两者不混用。
- `agentPermissionFileOf(person)`（Task 4）与 `permissionFilePath(ws, id)`（Task 5）在测试里互相断言相等，防止两处各写一套命名。
- `OrgDept`（web，Task 7）与 `orgDeptView`（server，Task 6）字段对齐：`path / name / people{id,alias?,model} / departments`；`flattenOrg` 产出的对象形状 = `EmployeeSummary`（`chatHtml` / `sessionInfoHtml` 无需改）。

**4. Review Focus 覆盖**

1. 坏 / 半成品文件 → Task 1 Step 1（坏 JSON、空 id、非字符串字段）+ Task 2（重复 id、非法 head）。
2. id 全局唯一 → Task 2「人 id 重复」用例。
3. head 自荐 / 写错 id / 写子部门成员 → Task 2「只认本级直属成员」用例 + Task 3「受保护的配置文件名」用例。
4. 主管穿透方向 → Task 3「主管穿透」用例（孙级可写、兄弟不可写）。
5. 不存在的人 / 缺目录 → Task 2 `loadPerson` 抛错 · Task 4「cwd 自动创建」· Task 6 `roomExists` 404。
6. 侧栏折叠不吞信息 → Task 7「折叠时不渲染正文 / 空部门仍出部门头 / 无 org 回落平铺」用例 + 手工冒烟第 3–4 步。

**5. 2026-10-19 按跨计划裁定修订**（依据 `docs/superpowers/plans/2026-10-19-p2-p5-preflight-rulings.md`，优先于本计划正文）

- **B1**：收回「删 `src/domain/employee.ts` + `grep loadEmployee` 为空」——`employee.ts` 改为对 `org` 的**薄适配层**、导出签名不变，`paths.employeeDir` 与 `tests/domain/employee.test.ts` 均**保留并适配**（File Structure / Task 3 / Task 4 / Task 6 / Task 9 一并改）。
- **B2**：org 模块接口以本计划实际签名为准（`findPerson` / `listPeople` / `loadPerson` / `ancestryOf` / `managedDirsOf` / `managedDepartmentsOf`，人带 `dir` / `departmentPath`），并在 Task 2 新增 **`managedSubtreeOf(ws, id) -> { departmentDirs, agentDirs }`** 适配器 + 走盘单测（P3 消费）。
- **B3**：Task 3 加权威说明——`workDir(ws, id)` 是工作目录函数的**唯一实现**，P3 的 `employeeWorkDir` 与 P5 的 `workDir` 定义作废、改为 import。
- **B4**：跨阶段假设表的五层配置解析器路径由 `src/domain/config.ts` 改为 **`src/config/*`**（P3 提供）；`src/domain/config.ts` 只保留机器私有配置职责（`readConfig` / `readBossName` / `bossNamesFor` 等）。
