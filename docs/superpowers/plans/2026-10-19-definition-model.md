# 定义模型落地（P5）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「人」的载体彻底收口为单一 `<名字>.agent.config.json`：`prompt` 按作用域链累加渲染、记忆落 `work/<id>/MEMORY.md`、技能库集中到 `openstaffs/skills/` 按名引用，并**删除所有 `AGENTS.md` / `profile.md` / `members.md` / 员工目录内多文件**等旧机制。

**Architecture:** 复用并追加 P3 已建的 `src/capabilities/` 域模块（D34 / §12）：`scopes.ts`（P3 建：作用域链装配 空间 → 部门链 → 项目 → 员工）、`skills.ts`（P3 建；P5 追加 `skillNamesFrom` / `renderSkillCatalog`），并新增 `prompt.ts` 累加渲染 `prompt`。`src/domain/employee.ts` 由 P2 改为 org 薄适配层（继续导出 `loadEmployee` / `listEmployees` / `renderInstructions`）；本计划在其上把定义来源换成「P2 的 org 定位 + P3 的 `src/config/*` 解析」，记忆从 `work/<id>/MEMORY.md` 读。`src/app/conversations.ts` 的 `instructionsFor` 改为「prompt 链 + 记忆 + 技能清单」。项目改扁平配置、群聊工作目录改 `work/<id>/`、会话链移出员工目录。

**Tech Stack:** Node ≥ 22.19（本机 24.3.0，`npm start` 直接跑 TS，strip-only）、Vitest、vanilla TS + 极简 DOM（`web/`）。**不新增任何依赖。**

**Spec:** `docs/superpowers/specs/2026-10-18-agent-org-hierarchy-design.md`（§3 目录结构、§4 字段表、§7 合并规则、§10 P5 行、§12 模块化边界；D2/D5/D16/D17/D20/D22/D25/D26/D27/D30/D32/D33/D34）

## Global Constraints

- **破坏性更新，不做迁移（D30）**：旧文件（`AGENTS.md` / `profile.md` / `config.json` / `mcp.json` / `permission.json` / `members.md` / 员工目录内 `MEMORY.md` / `skills/`）**一律不再读取**，不做兼容、不做搬迁脚本。
- **不使用 `AGENTS.md`（D5/D33）**：空间根、项目目录、员工目录**全部**不再有 `AGENTS.md`；所有引导走各 `*.config.json` 的 `prompt` 字段。`prompt` = **内联字符串**。
- **单一 config 定义（D2）**：人 = `agents/.../<名字>.agent.config.json`；`alias` = 展示名，缺省 = 文件名主干（id）。
- **记忆落点（D27）**：记忆 = `work/<id>/MEMORY.md`（记忆**不再**放进定义树）。
- **工作树平铺（D20）**：`work/<名字>/` 每个 agent 独立，与定义树分离；**工作目录只有 agent 有**（D25/D26：项目无工作目录）。
- **技能库集中（D17/D16）**：`skills` = **按名引用** → `openstaffs/skills/<技能名>/`（外加系统内置 `src/skills/` 与外部 `skillPaths`）；`mcp` = 按名引用 `openstaffs/mcps.json`（P3）。
- **累加无覆盖（D10/D12）**：`prompt` / `skills` 一律累加、接受同值重复，**无优先级 / 覆盖逻辑**；`prompt` 累加顺序 = **空间 → 部门（根→叶）→ 项目 → 员工**，段落以 `\n\n` 连接、空段丢弃。
- **强模块化（D34 / §12）**：`prompt` 渲染属 **capabilities / config** 域；基座（Pi）只出现在 `harness`；本计划**不得**在 `capabilities` / `domain` 里 import `harness`。
- **strip-only TS**：不得用 `enum` / 装饰器 / 构造器参数属性（`constructor(private x)`）。
- **TDD**：每任务**先写失败测试 → 跑失败 → 实现 → 跑通过 → 提交**；每个任务独立验收、独立提交；提交信息用**简体中文祈使句**。
- 仓库文档同步表（根 `AGENTS.md`）：能力变化 → `src/skills/openstaffs/SKILL.md`；运维知识 → `src/skills/openstaffs-ops/SKILL.md`；上手路径 → `README.md`；产品愿景 → `docs/产品规划.md`。本计划把这些写成 Task 7 的硬步骤（并在各任务就地更新自己影响的那几段）。

## 跨阶段假设（P5 依赖 P2/P3/P4 已落地）

P2/P3/P4 与本计划**并行撰写**，接口可能不同名。P5 只消费下列接口；**命名与落点以 `2026-10-19-p2-p5-preflight-rulings.md` 的裁定为准（B1–B5 / N3），其次才是本节的字面写法**。若实现侧命名不同，按名机械替换（不改语义），并就地更新本文档的 import。

**P1（消息库）——已落地，P5 不得与之冲突**（详见 `2026-10-19-p2-p5-preflight-rulings.md`「P1 已落地事实」）

- `RoomMessage` 的条目键是 **`store:<seq>`**（`convId = "store"`、`entryId = String(seq)`）；**`mergeRoomMessages` 已删除**；库实例**唯一化在 `src/server/main.ts`**（注入 `Pump` / `ServerDeps.store`）；`ToolContext` 已带 `broadcast`（`src/tools/extension.ts`）。本计划**不碰** `src/store/` 与 `broadcast`。
- 本计划 Task 6 的会话链 helper 落 `stateDir(ws)/chains/`，与 P1 的 `messagesDbFile(ws) = stateDir(ws)/messages.sqlite` 不冲突（同目录、不同文件）。

**P4（路径）——`src/domain/paths.ts`**

| 假定接口 | 语义 | 若不同 |
|---|---|---|
| `stateDir(ws)` | `openstaffs/.data/` | 本计划新增函数一律相对 `stateDir`，只需改一处 |
| `spaceDir(ws)` | `openstaffs/` | 同上 |
| `spaceSkillsDir(ws)` | `openstaffs/skills/` | 按名替换 |
| `spaceConfigFile(ws)` | `openstaffs/space.config.json`（在 `src/domain/space.ts`） | 按名替换 |
| `builtinSpacePrompt()` / `SPACE_PROMPT_TEMPLATE` | 读框架内置 `src/prompts/space.md`（D32 物化源） | 按名替换 |
| `ensureSpaceConfig(ws)` | 首次启动物化 `space.config.json`（幂等、不覆盖） | P4 已落地；P5 只改 `src/prompts/space.md` 文案 |

> P4 计划（`docs/superpowers/plans/2026-10-19-space-dir-merge.md`）**已经落地**了 `src/prompts/space.md`（内置空间 prompt）+ `src/domain/space.ts`（`builtinSpacePrompt` / `newSpaceConfig` / `ensureSpaceConfig` / `spaceConfigFile`）。P5 直接消费它们，**不再新增空间物化逻辑**。

**P2（组织）——`src/domain/org.ts`（按裁定 B2：以 P2 的实际签名为准）**

| P2 实际接口 | 语义 | P5 怎么用 |
|---|---|---|
| `loadPerson(ws, id)` | `OrgPerson`（人带 **`dir`** 与 **`departmentPath`**）；人不存在 → 抛 `员工不存在: <id>` | 定位人；`Employee.dir = person.dir`。本计划的 `loadEmployee` 就是它的薄包装（裁定 B1：`employee.ts` 仍保留为 org 适配层） |
| `listPeople(ws)` | 全部人（DFS 顺序） | `listEmployees` 直接映射 |
| `findPerson(tree, id)` | `OrgPerson \| undefined`（不抛；需先 `loadOrg(ws)`） | 存在性检查（如 `http.ts` 的 `roomExists`） |
| `ancestryOf(tree, path)` | 祖先链部门（**根→叶**，含自身；未知路径 → `[]`） | 先 `findPerson(loadOrg(ws), id)?.departmentPath`，再 `ancestryOf(tree, path).map((d) => d.dir)` 得部门链目录（**不再是 `departmentChainDirs`**） |
| `managedSubtreeOf(ws, id)` | `{ departmentDirs: string[]; agentDirs: string[] }`（P2 按裁定 B2 新增） | 供 P3 的 `runtimeGrantsFor` 复用；P5 不直接调 |

**P3（统一配置）——`src/config/*`（按裁定 B4：落 `src/config/`，不是 `src/domain/config.ts`）**

`src/domain/config.ts` 只保留机器私有配置（`readConfig` / `readBossName` / `bossNamesFor`），**不含**五层能力配置。

| P3 实际接口 | 语义 | P5 怎么用 |
|---|---|---|
| `src/config/schema.ts`：`ConfigFields` / `PermissionTable` | 五层配置统一形状；「按工具 → 路径列表」 | 用 P3 在 `src/config/load.ts` 提供的别名 `CapabilityConfig = ConfigFields` / `ToolPermissionMap = PermissionTable`（裁定 N3） |
| `src/config/load.ts`：`loadSpaceConfig(ws)` / `loadProjectConfig(ws, id)` / `loadDepartmentConfig(dir)` / `loadAgentConfig(dir, id)` | 返回 `LoadedConfig \| undefined`（`loaded.fields` 已解析；缺失 / 坏 JSON → `undefined`） | 作用域链与 `Employee` 的字段来源 |
| `src/config/naming.ts`：`spaceConfigFile` / `projectConfigFile` / `departmentConfigFile` / `agentConfigFile` / `agentIdOfConfigFile` | 四类配置文件常量与路径 / 反解 | 项目扁平配置与人不变量；P4 的 `spaceConfigFile` 与之 re-export 对齐（裁定 N2） |

**对 P5 语义的连带影响（必须核对）**

1. **若 P2 尚未把测试夹具从 `agents/<id>/AGENTS.md` 切到 `agents/<id>.agent.config.json`**：Task 2 会连带让一批测试红。用
   `grep -rln 'AGENTS\.md' tests | xargs grep -ln 'agents'` 找出来，把「造一个员工存在」的写法统一改成写 `agents/<id>.agent.config.json`（本计划 Task 2 Step 4 给出精确命令）。
2. **若 P3 未把项目载体改成扁平 `projects/<id>.project.config.json`**：Task 5 就是该改动的落地处。
3. **若 P3 未把 MCP 改成 `openstaffs/mcps.json` 按名引用**：P5 不动 MCP 逻辑，只在 Task 7 记一条「MCP 仍读各层 `mcp.json`」的偏差，不擅自扩权限范围。
4. **若 P1/P2 已把会话链移出员工目录**（例如进 SQLite 或 `openstaffs/.data/`）：Task 6 只做「删残留 + 断言」。
5. **P4 的空间 prompt 已存在**：`space.config.json.prompt` 由 `ensureSpaceConfig` 从 `src/prompts/space.md` 物化。P5 把 `src/prompts/space.md` **改写为唯一的内置 prompt**（身份 + 会话事实 + 消息规范；群聊规则用变量表达），并 **删除 `src/prompts/dm.md` / `group.md` 与 `renderEnvironment`**（D32/D33：运行时不再依赖框架模板，只依赖已物化的 `space.config.json`）。
   - 已按 D30 说明：**P4 之后、P5 之前建过的空间**，其 `space.config.json` 里是 P4 的最小文案；P5 **不迁移**。需要新文案时，删掉该空间的 `space.config.json` 后重启（`ensureSpaceConfig` 会重新物化）。
   - 若 P2/P3 另行保留了「系统级环境段」概念，则把本计划的 `space.config.json.prompt` 换回该机制即可，其余（累加顺序 / 渲染 / 技能清单）不变。

---

## Review Focus

以下五类输入 / 失败模式，spec 没有逐条写测试但「合理的人会期望它们不炸」——每一条都钉到拥有该代码的任务里的一个测试（见各任务内 `Review Focus` 标注）：

1. **定义缺失**：`agents/<id>.agent.config.json` 不存在 → `loadEmployee` 抛「员工不存在」，`listEmployees` 跳过那项、不崩；坏 JSON → 与「空配置」等价，不崩。（Task 2）
2. **记忆文件缺失**：`work/<id>/MEMORY.md` 不存在 → `memory` 为空串、不产空段、不崩；会话打开时自动补建一次（幂等、不覆盖已有内容）。（Task 1）
3. **`prompt` 累加边界**：空段 / 只有空白 / 缺字段 → 丢弃；同值重复 → **保留**（D10 不做去重）；顺序 = 空间 → 部门（根→叶）→ 项目 → 员工；每段都过变量渲染。（Task 4）
4. **群聊没有工作目录**：`projects/<id>/` 目录**不存在**；群会话的 cwd 必须是发言 agent 的 `work/<id>/`（D25/D26/D20），且工具侧 `relationCwd` 与 `accessFor` 的口径一致。（Task 6）
5. **技能按名引用解析不到**：`skills` 里写了不存在的名字 → 跳过该名、不崩、不产出坏目录条目；同名重复 → 只出一份（D10 累加 + D17 按名）。（Task 3）

---

## File Structure

**Create（只新建 P3 没有的部分）**
- `src/capabilities/prompt.ts` — `prompt` 累加 + 变量渲染（P5 新增；P3 不建此文件）。
- `tests/capabilities/prompt.test.ts`

**Reuse（复用 P3 已建，**不得重写**；只追加 P5 需要的导出）**
- `src/capabilities/scopes.ts` — 作用域链装配（空间 → 部门链 → 项目 → 员工）；**P3 先建**（`scopesForOrg` / `scopeChain`），P5 只在末尾追加 `export const capabilityScopesFor = scopesForOrg;`（裁定 B5）。
- `src/capabilities/skills.ts` — 技能名 → 技能目录清单字符串；**P3 先建**（`resolveSkillRefs`），P5 只追加 `skillNamesFrom` / `renderSkillCatalog`（裁定 B5）。
- `tests/capabilities/scopes.test.ts` / `tests/capabilities/skills.test.ts` — P3 已建同名文件，P5 **追加**用例，不覆盖。

> 执行 P5 前**先读 P3 的落地代码**；`scopes.ts` / `skills.ts` 一律「复用 + 追加」，**不得重写**（裁定 B5）。

**Modify**
- `src/domain/paths.ts`（追加 `memoryFile` / 项目扁平配置文件；`workDir` **不再新建**——P2 已提供，本计划只 import（裁定 B3）；删 `membersFile` / `projectDir`；`employeeDir` 按裁定 B1 由 P2 保留，本计划不删）
- `src/domain/employee.ts`（**P2 已改为 org 薄适配层**：继续导出 `loadEmployee` / `listEmployees` / `renderInstructions`；本计划只把定义来源换成「P2 org 定位 + P3 config 解析」，记忆改读 `work/<id>/MEMORY.md`，去 `entry` / `profile`）
- `src/domain/skills.ts`（加 `resolveSkillsByName`）
- `src/domain/project.ts`（扁平 `projects/<名>.project.config.json`）
- `src/domain/access-control.ts`（`parseMembers` 读项目 config）
- `src/app/conversations.ts`（`instructionsFor` 改；`relationCwd` 改；会话链落点改）
- `src/tools/registry.ts`（`member_profile` 去 `profile.md`）
- `src/server/http.ts`（`roomExists` 用 org 判定）
- `src/prompts/space.md`（改写为**唯一**内置 prompt：身份 + 会话事实 + 消息规范；D32/D33）
- `src/domain/prompt.ts`（删 `renderEnvironment` / `promptTemplatePath`，只留 `renderTemplate`）
- `src/domain/prompt-vars.ts`（新增 `session_kind` 变量，供内置 prompt 区分私聊 / 群聊）
- `web/render.ts`（空态文案不再提 `AGENTS.md`）
- `src/skills/openstaffs/SKILL.md`、`src/skills/openstaffs-ops/SKILL.md`、`README.md`、`docs/产品规划.md`（文档同步）
- 既有测试夹具：`tests/domain/{employee,paths,skills,project,access-control,prompt,prompt-vars}.test.ts`、`tests/app/{conversations,permission-flow}.test.ts`、`tests/server/{http,sse}.test.ts`、`tests/tools/{registry,extension}.test.ts`

**Delete**
- `src/prompts/dm.md`、`src/prompts/group.md`（被 `space.md` + `space.config.json.prompt` 取代；D32/D33）
- `src/mcp.json`（若 P3 已改用 `openstaffs/mcps.json`，Task 7 删）。
- 旧机制读取代码：`AGENTS.md` / `profile.md` / `members.md` / 员工目录 `MEMORY.md` / 员工与项目 `skills/` 目录扫描 / 各层 `permission.json` / 各层 `mcp.json`。

---

## Task 1: 记忆落点 —— `work/<id>/MEMORY.md`

**Files:**
- Modify: `src/domain/paths.ts`（追加 `memoryFile`；`workDir` 由 P2 提供，本计划只 import 复用——裁定 B3）
- Modify: `src/domain/employee.ts`（`memory` 改读工作目录；加 `ensureMemory`）
- Modify: `src/app/conversations.ts`（会话打开时补建记忆）
- Test: `tests/domain/paths.test.ts`（追加）、`tests/domain/employee.test.ts`（追加）、`tests/app/conversations.test.ts`（追加）

**Interfaces:**
- Consumes: `workDir(ws, id)`（P2，`src/domain/paths.ts`；本计划**不再定义**它——裁定 B3）
- Produces:
  - `memoryFile(ws: Workspace, id: string): string` → `<空间>/work/<id>/MEMORY.md`
  - `ensureMemory(ws: Workspace, id: EmployeeId): void`（幂等建目录 + 空 `MEMORY.md`，不覆盖）
  - `Employee.workDir: string`（= `workDir(ws, id)`）、`Employee.memory: string`（读自 `work/<id>/MEMORY.md`）
- **Review Focus #2** 由本任务的 `ensureMemory` / 缺失文件用例钉住。

- [ ] **Step 1: 写失败测试**

`tests/domain/paths.test.ts` 追加（顶部补 import `memoryFile`；`workDir` 的断言 P2 Task 3 已加，本计划不重复）：

```ts
describe("记忆文件落点（D27）", () => {
  it("memoryFile = <空间>/work/<id>/MEMORY.md", () => {
    const ws = createWorkspace("/office");
    expect(memoryFile(ws, "alice")).toBe(path.join("/office", "work", "alice", "MEMORY.md"));
  });
});
```

`tests/domain/employee.test.ts` 追加（顶部补 import `ensureMemory`、`memoryFile`）：

```ts
describe("记忆落点（D27）", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-mem-"));
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("记忆读自 work/<id>/MEMORY.md（员工目录里的 MEMORY.md 不再是记忆）", () => {
    const ws = createWorkspace(root);
    write("alice", "AGENTS.md", "你是 alice。");
    fs.mkdirSync(path.join(root, "work", "alice"), { recursive: true });
    fs.writeFileSync(memoryFile(ws, "alice"), "老板喜欢简短。");
    expect(loadEmployee(ws, "alice").memory).toBe("老板喜欢简短。");
  });

  it("工作目录 / 记忆文件缺失时不崩（memory = 空串）", () => {
    const ws = createWorkspace(root);
    write("bob", "AGENTS.md", "你是 bob。");
    expect(loadEmployee(ws, "bob").memory).toBe("");
  });

  it("ensureMemory：建目录 + 空 MEMORY.md；已存在不覆盖", () => {
    const ws = createWorkspace(root);
    ensureMemory(ws, "carol");
    expect(fs.readFileSync(memoryFile(ws, "carol"), "utf8")).toBe("");
    fs.writeFileSync(memoryFile(ws, "carol"), "已记住");
    ensureMemory(ws, "carol");
    expect(fs.readFileSync(memoryFile(ws, "carol"), "utf8")).toBe("已记住");
  });
});
```

`tests/app/conversations.test.ts` 追加（用该文件既有的临时空间夹具）：

```ts
it("打开会话时自动补建 work/<id>/MEMORY.md（D27）", async () => {
  seedAgent(ws, "alice"); // 若 P2 已切换夹具，用同一写法；否则先按 Task 2 切换
  await openDm(ws, harness, "alice");
  expect(fs.existsSync(memoryFile(ws, "alice"))).toBe(true);
});
```

> 若该测试文件没有叫 `seedAgent` 的夹具，照抄文件里**现有的**造员工写法，不要新造一套。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/domain/paths.test.ts tests/domain/employee.test.ts`
Expected: FAIL —— `memoryFile` / `ensureMemory` 未定义（模块不导出）；`workDir` 已由 P2 导出、不再由本计划提供。

- [ ] **Step 3: 实现 `src/domain/paths.ts`**

```ts
// src/domain/paths.ts（文件末尾追加 —— `workDir` 已由 P2 提供，此处**不重复定义**，只复用）
/** 默认记忆文件（D27）：工作目录里的 MEMORY.md。 */
export function memoryFile(ws: Workspace, id: string): string {
  return path.join(workDir(ws, id), "MEMORY.md");
}
```

- [ ] **Step 4: 实现 `src/domain/employee.ts`（记忆部分）**

```ts
// src/domain/employee.ts（在文件顶部 import 行加入 memoryFile；workDir 复用 P2 的 paths）
import { employeeDir, memoryFile, workDir, type Workspace } from "./paths.ts";

// loadEmployee 内：memory 改为读工作目录，并暴露 workDir
return {
  id,
  dir,
  workDir: workDir(ws, id),
  entry: readText(path.join(dir, "AGENTS.md")),
  profile: readText(path.join(dir, "profile.md")),
  memory: readText(memoryFile(ws, id)),
  model: readModel(dir),
  ...(alias === undefined ? {} : { alias }),
};

/** 首次使用某 agent 时补建其工作目录与空 MEMORY.md（幂等，不覆盖已有内容）。 */
export function ensureMemory(ws: Workspace, id: EmployeeId): void {
  fs.mkdirSync(workDir(ws, id), { recursive: true });
  const file = memoryFile(ws, id);
  if (!fs.existsSync(file)) fs.writeFileSync(file, "");
}
```

同时给 `Employee` 类型加 `workDir: string;` 字段（放在 `dir` 之后）。

- [ ] **Step 5: `src/app/conversations.ts` 在会话打开 / 新建时补建记忆**

```ts
// src/app/conversations.ts（import 增加 ensureMemory；P2 已把 instructions 走后 speaker.prompt，故不再 import renderInstructions）
import { ensureMemory, loadEmployee, type Employee } from "../domain/employee.ts";

// ensure(...) 与 newSession(...) 里，loadEmployee 之后立即调用：
const speaker = loadEmployee(ws, speakerId);
ensureMemory(ws, speakerId);   // D27：默认发 MEMORY.md
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run tests/domain/paths.test.ts tests/domain/employee.test.ts tests/app/conversations.test.ts`
Expected: PASS。

- [ ] **Step 7: 全量回归 + 提交**

Run: `npm test && npm run typecheck`
Expected: 全绿。

```bash
git add src/domain/paths.ts src/domain/employee.ts src/app/conversations.ts tests/domain/paths.test.ts tests/domain/employee.test.ts tests/app/conversations.test.ts
git commit -m "feat(memory): 记忆落点改为 work/<id>/MEMORY.md（D20/D27）"
```

---

## Task 2: 人 = 单一 `.agent.config.json`（去 `AGENTS.md` / `profile.md`）

**Files:**
- Modify: `src/domain/employee.ts`（整体收口）
- Modify: `src/server/http.ts`（`roomExists` 用 org 判定）
- Modify: `src/tools/registry.ts`（`member_profile` 不再读 `profile.md`）
- Test: `tests/domain/employee.test.ts`（**新建**——P2 已删该文件）、`tests/tools/registry.test.ts`（改夹具）

**Interfaces:**
- Consumes: `loadPerson` / `listPeople` / `findPerson` / `loadOrg`（P2，`src/domain/org.ts`）、`loadAgentConfig`（P3，`src/config/load.ts`）、`memoryFile` / `workDir`（`workDir` 来自 P2，`memoryFile` 为 Task 1）
- Produces:
  - `type Employee = { id; dir; workDir; memory; model; alias?; prompt?; skills: string[]; mcp: string[]; permissions? }`（**无 `entry` / `profile`**）
  - `loadEmployee(ws, id): Employee`（不存在 → 抛 `员工不存在: <id>`；本计划即 P2 适配层的薄包装——裁定 B1）
  - `listEmployees(ws): Employee[]`
  - `renderInstructions(person)`：**仍是 `employee.ts` 的既有导出**（P2 落点：签名 `(person) => person.prompt`），本计划保留不删；Task 4 的 `instructionsFor` 改用 `renderPromptChain` 后它自然不再被调用（裁定 B1）
- **Review Focus #1** 由本任务的缺失 / 坏 JSON 用例钉住。

- [ ] **Step 1: 写失败测试**

`tests/domain/employee.test.ts` 整体重写（新形状）：

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { listEmployees, loadEmployee } from "../../src/domain/employee.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-emp-"));
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** 在 agents/ 下写一个人的定义文件（D1/D2）。 */
function seed(id: string, config: Record<string, unknown> = {}): string {
  const file = path.join(tmp, "agents", `${id}.agent.config.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}

describe("loadEmployee（单一 config 定义）", () => {
  it("从 .agent.config.json 读出 alias / prompt / skills / mcp / model", () => {
    const ws = createWorkspace(tmp);
    seed("alice", {
      alias: "爱丽丝",
      prompt: "你是爱丽丝。",
      skills: ["写报告", "查数据"],
      mcp: ["github"],
      model: "opencode-go/deepseek-v4.1-flash",
      thinkingLevel: "low",
    });
    const e = loadEmployee(ws, "alice");
    expect(e.id).toBe("alice");
    expect(e.alias).toBe("爱丽丝");
    expect(e.prompt).toBe("你是爱丽丝。");
    expect(e.skills).toEqual(["写报告", "查数据"]);
    expect(e.mcp).toEqual(["github"]);
    expect(e.model).toEqual({ model: "opencode-go/deepseek-v4.1-flash", thinkingLevel: "low" });
    expect("entry" in e).toBe(false);   // AGENTS.md 入口已废除（D5）
    expect("profile" in e).toBe(false); // profile.md 已废除（D2）
  });

  it("不再读 AGENTS.md / profile.md（写在同一目录也不生效）", () => {
    const ws = createWorkspace(tmp);
    seed("bob");
    fs.writeFileSync(path.join(tmp, "agents", "AGENTS.md"), "空间总纲（应被忽略）");
    fs.writeFileSync(path.join(tmp, "agents", "bob.agent.config.json"), "{}\n");
    const e = loadEmployee(ws, "bob");
    expect(e.prompt).toBeUndefined();
    expect(JSON.stringify(e)).not.toContain("空间总纲");
  });

  it("定义文件缺失 → 抛「员工不存在」", () => {
    const ws = createWorkspace(tmp);
    expect(() => loadEmployee(ws, "nobody")).toThrow("员工不存在");
  });

  it("坏 JSON / 空文件 → 与空配置等价（不崩，model 为空）", () => {
    const ws = createWorkspace(tmp);
    fs.writeFileSync(path.join(tmp, "agents", "carol.agent.config.json"), "{ not json");
    const e = loadEmployee(ws, "carol");
    expect(e.model).toEqual({ model: "" });
    expect(e.skills).toEqual([]);
  });

  it("thinkingLevel 只接受非空字符串（trim）；数字 / null / 空串忽略", () => {
    const ws = createWorkspace(tmp);
    seed("henry", { model: "faux/m", thinkingLevel: 42 });
    expect(loadEmployee(ws, "henry").model).toEqual({ model: "faux/m" });
    seed("henry", { model: "faux/m", thinkingLevel: "  high  " });
    expect(loadEmployee(ws, "henry").model).toEqual({ model: "faux/m", thinkingLevel: "high" });
    seed("henry", { model: "faux/m", thinkingLevel: "   " });
    expect(loadEmployee(ws, "henry").model).toEqual({ model: "faux/m" });
  });

  it("alias / prompt 两端空白被 trim", () => {
    const ws = createWorkspace(tmp);
    seed("grace", { alias: "  阿草  ", prompt: "  你是阿草。  " });
    expect(loadEmployee(ws, "grace").alias).toBe("阿草");
    expect(loadEmployee(ws, "grace").prompt).toBe("你是阿草。");
  });
});

it("listEmployees：按 id 排序、跳过隐藏项与无定义文件的目录", () => {
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-list-"));
  try {
    for (const id of ["bob", "alice"]) {
      fs.writeFileSync(path.join(root2, "agents", `${id}.agent.config.json`), "{}\n");
    }
    fs.mkdirSync(path.join(root2, "agents", ".hidden"), { recursive: true });
    const ws = createWorkspace(root2);
    expect(listEmployees(ws).map((e) => e.id)).toEqual(["alice", "bob"]);
  } finally {
    fs.rmSync(root2, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/domain/employee.test.ts`
Expected: FAIL —— `loadEmployee` 仍读 `agents/<id>/AGENTS.md`；`entry` / `profile` 仍在。

- [ ] **Step 3: 实现 —— 重写 `src/domain/employee.ts`**

> P2 已把本文件改成 **org 薄适配层**（继续导出 `loadEmployee` / `listEmployees` / `renderInstructions`，裁定 B1）。本步只在其上把定义来源换成「P2 `loadPerson` 定位 + P3 `loadAgentConfig` 解析」，并补齐 `skills` / `mcp` / `permissions` / `memory` / `workDir`。

```ts
// src/domain/employee.ts —— P2 的 org 适配层；本计划补齐能力字段（skills/mcp/permissions）与记忆。
import fs from "node:fs";
import { loadAgentConfig } from "../config/load.ts"; // P3（裁定 B4）
import { listPeople, loadPerson } from "./org.ts";     // P2（裁定 B2）
import { memoryFile, workDir, type Workspace } from "./paths.ts";
import type { ToolPermissionMap } from "../config/schema.ts"; // P3（裁定 N3）
import type { EmployeeId, ModelChoice } from "./types.ts";

export type Employee = {
  id: EmployeeId;
  /** 定义文件所在部门目录（agents/ 子树里的某一层；= person.dir）。 */
  dir: string;
  /** 工作目录 work/<id>/（D20/D27；= P2 的 workDir）。 */
  workDir: string;
  /** 记忆正文（读自 work/<id>/MEMORY.md；缺失 → 空串）。 */
  memory: string;
  /** 模型覆盖（config 的 model / thinkingLevel）。 */
  model: ModelChoice;
  /** 展示名（alias 缺省 = id）。 */
  alias?: string;
  /** config 的内联 prompt（未渲染；渲染见 capabilities/prompt.ts）。 */
  prompt?: string;
  /** 技能名引用（D17）。 */
  skills: string[];
  /** MCP 名引用（D16）。 */
  mcp: string[];
  /** 按工具权限（D9/D15）。 */
  permissions?: ToolPermissionMap;
};

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** 读人：P2 定位（`loadPerson`，不存在 → 抛「员工不存在」）+ P3 解析的字段 + 工作目录记忆。 */
export function loadEmployee(ws: Workspace, id: EmployeeId): Employee {
  const person = loadPerson(ws, id);                 // P2：不存在会抛 `员工不存在: <id>`
  const fields = loadAgentConfig(person.dir, id)?.fields; // P3：缺失 / 坏 JSON → undefined（按空配置）
  const permissions = fields?.permissions;
  const model: ModelChoice = {
    model: fields?.model ?? "",
    ...(fields?.thinkingLevel === undefined ? {} : { thinkingLevel: fields.thinkingLevel }),
  };
  return {
    id,
    dir: person.dir,
    workDir: workDir(ws, id),
    memory: readText(memoryFile(ws, id)).trim(),
    model,
    skills: fields?.skills ?? [],
    mcp: fields?.mcp ?? [],
    ...(fields?.alias === undefined ? {} : { alias: fields.alias }),
    ...(fields?.prompt === undefined ? {} : { prompt: fields.prompt }),
    ...(permissions === undefined ? {} : { permissions }),
  };
}

/** 首次使用某 agent 时补建其工作目录与空 MEMORY.md（幂等，不覆盖已有内容）。 */
export function ensureMemory(ws: Workspace, id: EmployeeId): void {
  fs.mkdirSync(workDir(ws, id), { recursive: true });
  const file = memoryFile(ws, id);
  if (!fs.existsSync(file)) fs.writeFileSync(file, "");
}

/** 全部人（P2 的组织发现顺序；逐个补齐能力字段）。 */
export function listEmployees(ws: Workspace): Employee[] {
  return listPeople(ws).map((person) => loadEmployee(ws, person.id));
}

/** 人级 instructions = 内联 prompt（P2 落点；D5 取消员工侧 AGENTS.md / profile.md / MEMORY.md）。 */
export function renderInstructions(person: Employee): string {
  return person.prompt ?? "";
}
```

> `loadAgentConfig` 已做「缺失 / 坏 JSON → `undefined`」的容错，且字段（`alias` / `prompt` / `model` / `thinkingLevel` / `skills`）在 P3 的 `parseConfigFields` 里已 trim，故本文件不再自行 trim。
> `ToolPermissionMap` 即 P3 `src/config/load.ts` 的别名（= `PermissionTable`，裁定 N3）；若 P3 未提供别名，改从 `src/config/schema.ts` 具名导入 `PermissionTable`。

- [ ] **Step 4: 跑通并切换全仓夹具（`Review Focus #1` 的落地）**

Run: `npx vitest run tests/domain/employee.test.ts`
Expected: PASS。

再找出所有仍以「目录 + `AGENTS.md`」造员工存在的测试：

```bash
grep -rln "AGENTS\.md" tests
```

逐个把这些夹具换成写 `agents/<id>.agent.config.json`（保持该测试原本想要的 `alias` / `model` / `prompt`）。**不要**顺手改与员工定义无关的断言。

Run: `npm test`
Expected: 全绿（若有红，全部来自「夹具还是老写法」，就地修完）。

- [ ] **Step 5: 改调用方（`http.ts` / `registry.ts`）**

`src/server/http.ts`（`roomExists` 改为「人存在」判定——用 P2 的 `findPerson(loadOrg(ws), id)`，不抛；`employeeDir` 按裁定 B1 保留，`projectDir` 由 P3 删）：

```ts
import { findPerson, loadOrg } from "../domain/org.ts"; // P2
import { projectExists } from "../domain/project.ts";

function roomExists(ws: Workspace, relation: Relation): boolean {
  return relation.kind === "dm"
    ? findPerson(loadOrg(ws), relation.employeeId) !== undefined
    : projectExists(ws, relation.project);
}
```

`src/tools/registry.ts`（`member_profile` 不再读 `profile.md`）：

```ts
const memberProfile: ToolDef = {
  name: "member_profile",
  description: "读某位成员的资料：id、展示名、它的 prompt（岗位 / 职责 / 人格）与记忆摘要。参数 member 是成员 id。",
  parameters: Type.Object({ member: Type.String({ description: "成员 id" }) }),
  async run(args, ctx) {
    const member = String(args["member"]);
    const employee = loadEmployee(ctx.ws, member);
    return [
      `成员：${employee.alias ?? employee.id}（${employee.id}）`,
      employee.prompt === undefined ? "（未写 prompt）" : employee.prompt,
      employee.memory === "" ? "（无记忆）" : `记忆：\n${employee.memory}`,
    ].join("\n\n");
  },
};
```

删掉 `registry.ts` 里只服务于 `profile.md` 的 `readTextOrEmpty`（若无其它引用）。

- [ ] **Step 6: 跑全量 + 提交**

Run: `npm test && npm run typecheck`
Expected: 全绿。

```bash
git add src/domain/employee.ts src/server/http.ts src/tools/registry.ts tests
git commit -m "refactor(employee): 人由单一 .agent.config.json 定义（废除 AGENTS.md/profile.md）"
```

---

## Task 3: 技能库集中 —— 按名引用 `openstaffs/skills/<技能名>/`

**Files:**
- Reuse（**复用 P3 已建；不得重写**）: `src/capabilities/scopes.ts`（只追加 `capabilityScopesFor` 别名——裁定 B5）
- Reuse（**复用 P3 已建；不得重写**）: `src/capabilities/skills.ts`（只追加 `skillNamesFrom` / `renderSkillCatalog`——裁定 B5）
- Modify: `src/domain/skills.ts`（加 `resolveSkillsByName`）
- Modify: `src/app/conversations.ts`（用技能名装配，删 `skillDirsFor`）
- Test: `tests/capabilities/scopes.test.ts`、`tests/capabilities/skills.test.ts`（P3 已建同名文件，**追加**用例）、`tests/domain/skills.test.ts`（追加）、`tests/app/conversations.test.ts`（追加）

**Interfaces:**
- Consumes: `scopesForOrg`（P3，`src/capabilities/scopes.ts`；`capabilityScopesFor` 是它的别名）、`loadSpaceConfig` / `loadProjectConfig` / `loadDepartmentConfig` / `loadAgentConfig`（P3，`src/config/load.ts`）、`ConfigFields`（P3，`src/config/schema.ts`）
- Produces:
  - `type CapabilityScope = { kind: "space" | "department" | "project" | "agent"; id: string; config: ConfigFields }`（**复用 P3 的类型**；若 P3 用别的类型名，按名替换）
  - `capabilityScopesFor = scopesForOrg`（P3 的别名方案；P5 只追加这一行）
  - `resolveSkillsByName(ws: Workspace, names: readonly string[], extraDirs?: readonly string[]): Skill[]`
  - `skillNamesFrom(scopes: readonly CapabilityScope[]): string[]`
  - `renderSkillCatalog(ws: Workspace, relation: Relation, speakerId: string, externalDirs?: readonly string[]): string`
- 删除：`skillDirsFor`（P3 也删它，别重复实现）
- **Review Focus #5** 由 `resolveSkillsByName` 的「名字不存在 → 跳过」与「同名只出一份」用例钉住。

- [ ] **Step 1: 写失败测试**

`tests/capabilities/scopes.test.ts`：

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { capabilityScopesFor } from "../../src/capabilities/scopes.ts";
import { createWorkspace } from "../../src/domain/paths.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "oss-scopes-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function write(file: string, config: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config));
}

test("作用域链顺序：空间 → 部门（根→叶）→ 项目 → 员工", () => {
  const ws = createWorkspace(root);
  write(path.join(root, "openstaffs", "space.config.json"), { prompt: "空间" });
  write(path.join(root, "agents", "department.config.json"), { prompt: "根部门" });
  write(path.join(root, "agents", "eng", "department.config.json"), { prompt: "工程部" });
  write(path.join(root, "agents", "eng", "alice.agent.config.json"), { prompt: "爱丽丝" });
  write(path.join(root, "projects", "seo.project.config.json"), { prompt: "SEO 群" });

  const kinds = capabilityScopesFor(ws, { kind: "group", project: "seo" }, "alice");
  expect(kinds.map((s) => s.kind)).toEqual(["space", "department", "department", "project", "agent"]);
  expect(kinds.map((s) => s.config.prompt)).toEqual(["空间", "根部门", "工程部", "SEO 群", "爱丽丝"]);
});

test("私聊不带项目段；根下员工没有部门段", () => {
  const ws = createWorkspace(root);
  write(path.join(root, "openstaffs", "space.config.json"), {});
  write(path.join(root, "agents", "staff0.agent.config.json"), {});
  const kinds = capabilityScopesFor(ws, { kind: "dm", employeeId: "staff0" }, "staff0");
  expect(kinds.map((s) => s.kind)).toEqual(["space", "agent"]);
});

test("配置缺失 → 该层照常出现（不崩，不丢层；字段由 P3 的 `ConfigFields` 缺省）", () => {
  const ws = createWorkspace(root);
  const scopes = capabilityScopesFor(ws, { kind: "dm", employeeId: "ghost" }, "ghost");
  expect(scopes.map((s) => s.kind)).toEqual(["space", "agent"]);
  expect(scopes[1]!.config.prompt).toBeUndefined();
});
```

`tests/domain/skills.test.ts` 追加：

```ts
describe("resolveSkillsByName（按名引用，D17）", () => {
  it("名字 → openstaffs/skills/<名>/；按 names 顺序输出", () => {
    const ws = createWorkspace(root);
    skill(path.join(root, "openstaffs", "skills"), "report", "---\nname: 写报告\ndescription: 生成周报\n---\n");
    const out = resolveSkillsByName(ws, ["report"]);
    expect(out).toEqual([{ name: "写报告", description: "生成周报", dir: path.join(root, "openstaffs", "skills", "report") }]);
  });

  it("解析不到的名字被跳过（不崩），同名重复只出一份", () => {
    const ws = createWorkspace(root);
    skill(path.join(root, "openstaffs", "skills"), "ok", "---\nname: ok\n---\n");
    expect(resolveSkillsByName(ws, ["nope", "ok", "ok"]).map((s) => s.name)).toEqual(["ok"]);
  });

  it("系统内置目录是兜底来源", () => {
    const ws = createWorkspace(root);
    expect(resolveSkillsByName(ws, ["openstaffs"]).map((s) => s.name)).toEqual(["openstaffs"]);
  });
});
```

`tests/capabilities/skills.test.ts`：

```ts
import { expect, test } from "vitest";
import { skillNamesFrom } from "../../src/capabilities/skills.ts";

test("skills 名累加：空间 → 部门 → 项目 → 员工；空串丢弃、重复保留（D10）", () => {
  const names = skillNamesFrom([
    { kind: "space", id: "space", config: { skills: ["a", "b"] } },
    { kind: "department", id: "eng", config: { skills: ["b", "  "] } },
    { kind: "agent", id: "alice", config: { skills: ["c"] } },
  ]);
  expect(names).toEqual(["a", "b", "b", "c"]); // 累加、不去重、空串丢弃
});
```

`tests/app/conversations.test.ts` 追加：

```ts
it("技能清单按 config 的 skills 名解析（不再扫 agents/<id>/skills/）", () => {
  fs.mkdirSync(path.join(ws.root, "agents", "alice", "skills", "ghost"), { recursive: true });
  fs.writeFileSync(path.join(ws.root, "agents", "alice", "skills", "ghost", "SKILL.md"), "---\nname: ghost\n---\n");
  const text = instructionsFor(ws, { kind: "dm", employeeId: "alice" }, loadEmployee(ws, "alice"));
  expect(text).not.toContain("ghost");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/capabilities tests/domain/skills.test.ts`
Expected: FAIL —— `capabilityScopesFor` 别名未追加（`scopes.ts` 里只有 P3 的 `scopesForOrg`）、`skillNamesFrom` / `resolveSkillsByName` 未导出。

- [ ] **Step 3: 复用 P3 的 `src/capabilities/scopes.ts`，只追加 `capabilityScopesFor`**

> P3（`2026-10-19-unified-config.md`）已建 `src/capabilities/scopes.ts`（`scopeChain` / `scopesForOrg`，作用域链顺序 = 空间 → 部门根→叶 → 项目（群聊）→ 员工，字段为 `ConfigFields`）。**不要重写它**（裁定 B5）——只在文件末尾追加别名，并按 P3 的实际类型名对齐 `CapabilityScope`：

```ts
// src/capabilities/scopes.ts（P3 已建；P5 只在末尾追加，不得重写 P3 的实现）
/** P5 用的名字（= P3 的 `scopesForOrg`；签名 `(ws, relation, speakerId)`）。 */
export const capabilityScopesFor = scopesForOrg;
// 若 P3 的作用域条目类型不叫 CapabilityScope，在此按 P3 的类型名再加一行别名（不改语义），
// 例如：export type CapabilityScope = <P3 的类型名>;
```

> 执行时先读 P3 的落地代码：**只加别名**，`CapabilityScope` 的字段名以 P3 为准（本计划的 `prompt.ts` / `skills.ts` 都按它消费）。

- [ ] **Step 4: 实现 `src/domain/skills.ts` 的 `resolveSkillsByName`**

```ts
// src/domain/skills.ts（追加）
import { spaceSkillsDir, type Workspace } from "./paths.ts";

/**
 * 按名解析技能（D17）：名字 → `openstaffs/skills/<名>/`，其次外部技能库，最后系统内置。
 * 名字为空 / 解析不到 → 跳过（不崩）；同名只出一份（先出现者胜）。
 */
export function resolveSkillsByName(
  ws: Workspace,
  names: readonly string[],
  extraDirs: readonly string[] = [],
): Skill[] {
  const roots = [spaceSkillsDir(ws), ...extraDirs, FRAMEWORK_SKILLS_DIR];
  const out: Skill[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = raw.trim();
    if (name === "" || seen.has(name)) continue;
    const dir = roots.map((root) => path.join(root, name)).find((candidate) => fs.existsSync(path.join(candidate, "SKILL.md")));
    if (dir === undefined) continue;
    seen.add(name);
    const meta = readFrontmatter(path.join(dir, "SKILL.md"));
    out.push({ name: meta.name ?? name, description: meta.description ?? "", dir });
  }
  return out;
}
```

- [ ] **Step 5: 在 P3 的 `src/capabilities/skills.ts` 末尾**追加** P5 的两个导出（不得重写 P3 的 `resolveSkillRefs`）**

```ts
// src/capabilities/skills.ts（P3 已建；P5 只追加以下两个导出，不重写 P3 的实现——裁定 B5）
import { renderSkills, resolveSkillsByName } from "../domain/skills.ts";
import type { Workspace } from "../domain/paths.ts";
import type { Relation } from "../domain/types.ts";
import { capabilityScopesFor, type CapabilityScope } from "./scopes.ts";

/** 累加各层的 `skills` 名（D10：不去重、空串丢弃），保序。 */
export function skillNamesFrom(scopes: readonly CapabilityScope[]): string[] {
  const names: string[] = [];
  for (const scope of scopes) {
    for (const raw of scope.config.skills ?? []) {
      if (typeof raw === "string" && raw.trim() !== "") names.push(raw.trim());
    }
  }
  return names;
}

/** 会话的技能清单段落（无技能 → 空串）。 */
export function renderSkillCatalog(
  ws: Workspace,
  relation: Relation,
  speakerId: string,
  externalDirs: readonly string[] = [],
): string {
  const names = skillNamesFrom(capabilityScopesFor(ws, relation, speakerId));
  return renderSkills(resolveSkillsByName(ws, names, externalDirs));
}
```

> `resolveSkillRefs`（P3）与本步的 `resolveSkillsByName`（`src/domain/skills.ts`）各司其职：P3 负责「按名 → 技能目录」（含 `missing`），P5 负责「作用域累加 + 目录清单渲染」。执行时若二者已重合，只保留一份并记进执行日志。

- [ ] **Step 6: `src/app/conversations.ts` 改装配、删 `skillDirsFor`**

```ts
// 删除 function skillDirsFor(...) 及其 import（FRAMEWORK_SKILLS_DIR / listSkills）。
import { renderSkillCatalog } from "../capabilities/skills.ts";

// instructionsFor 里把技能那行换成：
parts.push(renderSkillCatalog(ws, relation, speaker.id, externalSkillDirs));
```

- [ ] **Step 7: 跑全量 + 提交**

Run: `npm test && npm run typecheck`
Expected: 全绿（`grep -rn "skillDirsFor" src` 为空）。

```bash
git add src/capabilities/scopes.ts src/capabilities/skills.ts src/domain/skills.ts src/app/conversations.ts tests
git commit -m "feat(skills): 技能库集中为 openstaffs/skills 按名引用（D17/D34）"
```

---

## Task 4: `prompt` 累加渲染（capabilities 域）；废空间 / 项目 `AGENTS.md`

**Files:**
- Create: `src/capabilities/prompt.ts`
- Modify: `src/app/conversations.ts`（`instructionsFor` 收口）
- Modify: `src/domain/prompt.ts`（删 `renderEnvironment` / `promptTemplatePath`）
- Modify: `src/domain/prompt-vars.ts`（新增 `session_kind`）
- Modify: `src/prompts/space.md`（改写为唯一内置 prompt）
- Delete: `src/prompts/dm.md` / `src/prompts/group.md`
- Test: `tests/capabilities/prompt.test.ts`、`tests/app/conversations.test.ts`、`tests/domain/prompt.test.ts`、`tests/domain/prompt-vars.test.ts`

**Interfaces:**
- Consumes: `capabilityScopesFor`（Task 3）、`renderTemplate`（`src/domain/prompt.ts`）、`PromptVarContext`（`src/domain/prompt-vars.ts`）、`ensureSpaceConfig` / `builtinSpacePrompt`（P4，`src/domain/space.ts`）
- Produces:
  - `renderPromptChain(scopes: readonly CapabilityScope[], ctx: PromptVarContext): string`（逐段 `renderTemplate`；空段丢弃；`\n\n` 连接；同值重复保留）
  - `sessionKind(ctx: PromptVarContext): "dm" | "group"`（注册为模板变量 `session_kind`）
  - `instructionsFor` 新组成：**prompt 链（空间=内置物化 prompt → 部门 → 项目 → 员工）→ 记忆 → 技能清单**
- **Review Focus #3** 由 `renderPromptChain` 的空段 / 重复 / 顺序 / 渲染用例钉住。
- **删除**：`instructionsFor` 里读空间根 `AGENTS.md` / 项目 `AGENTS.md` 的逻辑；`renderEnvironment` / `promptTemplatePath`；`src/prompts/dm.md` / `group.md`（D5/D32/D33：系统 prompt 已物化进 `space.config.json`）。

- [ ] **Step 1: 写失败测试**

`tests/capabilities/prompt.test.ts`：

```ts
import { expect, test } from "vitest";
import { renderPromptChain } from "../../src/capabilities/prompt.ts";
import { renderTemplate } from "../../src/domain/prompt.ts";
import type { PromptVarContext } from "../../src/domain/prompt-vars.ts";

const ctx: PromptVarContext = { ws: { root: "/office" }, kind: "dm", selfId: "alice", cwd: "/office/work/alice" };

test("按作用域顺序拼接，空段丢弃，段落间 `\\n\\n`", () => {
  const text = renderPromptChain(
    [
      { kind: "space", id: "space", config: { prompt: "空间规矩。" } },
      { kind: "department", id: "eng", config: {} },
      { kind: "agent", id: "alice", config: { prompt: "你是爱丽丝。" } },
    ],
    ctx,
  );
  expect(text).toBe("空间规矩。\n\n你是爱丽丝。");
});

test("每段都过变量渲染；只有空白 → 当空段丢弃", () => {
  const text = renderPromptChain(
    [{ kind: "agent", id: "alice", config: { prompt: "你是 {{agent_id}}，在 {{workdir}} 干活。" } }],
    ctx,
  );
  expect(text).toBe("你是 alice，在 /office/work/alice 干活。");
  expect(renderPromptChain([{ kind: "agent", id: "alice", config: { prompt: "   " } }], ctx)).toBe("");
});

test("同值重复保留（D10 无去重 / 无覆盖）", () => {
  const text = renderPromptChain(
    [
      { kind: "department", id: "eng", config: { prompt: "守规矩。" } },
      { kind: "agent", id: "alice", config: { prompt: "守规矩。" } },
    ],
    ctx,
  );
  expect(text).toBe("守规矩。\n\n守规矩。");
});

test("session_kind 变量：私聊 dm / 群聊 group（内置 prompt 用它区分文案）", () => {
  const groupCtx: PromptVarContext = { ...ctx, kind: "group", projectId: "seo" };
  expect(renderTemplate("当前会话：{{session_kind}}", groupCtx)).toBe("当前会话：group");
  expect(renderTemplate("当前会话：{{session_kind}}", ctx)).toBe("当前会话：dm");
});
```

`tests/app/conversations.test.ts` 追加：

```ts
it("空间 / 项目 AGENTS.md 不再进入 instructions（D5/D33）", () => {
  fs.writeFileSync(path.join(ws.root, "AGENTS.md"), "空间总纲（应被忽略）");
  fs.mkdirSync(path.join(ws.root, "projects", "seo"), { recursive: true });
  fs.writeFileSync(path.join(ws.root, "projects", "seo", "AGENTS.md"), "项目规范（应被忽略）");
  const text = instructionsFor(ws, { kind: "group", project: "seo" }, loadEmployee(ws, "alice"));
  expect(text).not.toContain("空间总纲");
  expect(text).not.toContain("项目规范");
});

it("prompt 链进入 instructions：空间 → 部门 → 项目 → 员工", () => {
  const seedJson = (file: string, value: unknown): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  const root = ws.root;
  seedJson(path.join(root, "openstaffs", "space.config.json"), { prompt: "空间段" });
  seedJson(path.join(root, "agents", "department.config.json"), { prompt: "根部门段" });
  seedJson(path.join(root, "agents", "eng", "department.config.json"), { prompt: "工程部段" });
  seedJson(path.join(root, "agents", "eng", "alice.agent.config.json"), { prompt: "员工段" });
  seedJson(path.join(root, "projects", "seo.project.config.json"), { members: ["alice"], prompt: "项目段" });

  const text = instructionsFor(ws, { kind: "group", project: "seo" }, loadEmployee(ws, "alice"));
  const order = ["空间段", "根部门段", "工程部段", "项目段", "员工段"].map((segment) => text.indexOf(segment));
  expect(order.every((index) => index >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order); // 顺序严格递增
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/capabilities/prompt.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 `src/capabilities/prompt.ts`**

```ts
// src/capabilities/prompt.ts
import { renderTemplate } from "../domain/prompt.ts";
import type { PromptVarContext } from "../domain/prompt-vars.ts";
import type { CapabilityScope } from "./scopes.ts";

/**
 * 累加 + 渲染各作用域的 `prompt`（D12/D10）：
 * 顺序 = 传入顺序（空间 → 部门 → 项目 → 员工）；空段丢弃；同值重复保留；`\n\n` 连接。
 * 变量渲染走统一的一条路径（`renderTemplate`）；未知变量渲染为空串。
 */
export function renderPromptChain(scopes: readonly CapabilityScope[], ctx: PromptVarContext): string {
  const parts: string[] = [];
  for (const scope of scopes) {
    const raw = scope.config.prompt;
    if (typeof raw !== "string" || raw.trim() === "") continue;
    const rendered = renderTemplate(raw, ctx).trim();
    if (rendered !== "") parts.push(rendered);
  }
  return parts.join("\n\n");
}
```

- [ ] **Step 4: 收口 `src/app/conversations.ts` 的 `instructionsFor`**

```ts
import { capabilityScopesFor } from "../capabilities/scopes.ts";
import { renderPromptChain } from "../capabilities/prompt.ts";

/** 会话快照：prompt 链（空间=内置物化 prompt → 部门 → 项目 → 员工）→ 记忆 → 技能清单。 */
export function instructionsFor(
  ws: Workspace,
  relation: Relation,
  speaker: Employee,
  externalSkillDirs: readonly string[] = [],
): string {
  const ctx = promptContextFor(ws, relation, speaker);
  const parts: string[] = [];
  const chain = renderPromptChain(capabilityScopesFor(ws, relation, speaker.id), ctx);
  if (chain !== "") parts.push(chain);
  if (speaker.memory !== "") parts.push(speaker.memory);
  parts.push(renderSkillCatalog(ws, relation, speaker.id, externalSkillDirs));
  return parts.filter((part) => part.trim() !== "").join("\n\n");
}
```

删除 `readTextOrEmpty`、空间根 `AGENTS.md` 读取、项目 `AGENTS.md` 读取、以及 `renderEnvironment` 的 import（若 `readTextOrEmpty` 已无引用）。
**空间段从哪来**：`capabilityScopesFor` 的 space scope 读 `space.config.json.prompt`；该文件由 P4 的 `ensureSpaceConfig` 从 `src/prompts/space.md` 物化（D32）。因此这里**不需要**再单独渲染框架模板。

- [ ] **Step 5: 新增 `session_kind` 变量，并把内置 prompt 收成一份**

`src/domain/prompt-vars.ts`：

```ts
/** 当前会话类型（内置 prompt 用它区分私聊 / 群聊文案）。 */
export function sessionKind(ctx: PromptVarContext): "dm" | "group" {
  return ctx.kind;
}

/** 当前会话的一句话描述（私聊 / 群聊文案不同，避免模板里写条件分支）。 */
export function sessionInfo(ctx: PromptVarContext): string {
  if (ctx.kind === "dm") return `与「${bossName(ctx)}」的私聊`;
  return `项目群聊「${projectName(ctx) ?? ""}」（${ctx.projectId ?? ""}）；成员（${memberCount(ctx)} 人）：${members(ctx).map((m) => m.name).join("、")}`;
}

// promptVariables 里登记（与其它变量同一张表）
export const promptVariables: Record<string, (ctx: PromptVarContext) => unknown> = {
  // …既有条目保持不变…
  session_kind: sessionKind,
  session_info: sessionInfo,
};
```

`tests/domain/prompt-vars.test.ts` 追加：

```ts
it("session_info：私聊一句 / 群聊带项目与成员", () => {
  seedEmployee("alice", "爱丽丝");
  seedProject("demo", ["alice"], "演示项目");
  expect(renderTemplate("{{session_info}}", dmCtx("alice"))).toContain("私聊");
  const group = renderTemplate("{{session_info}}", groupCtx("demo", "alice"));
  expect(group).toContain("演示项目");
  expect(group).toContain("爱丽丝");
});
```

> 上面用的 `seedEmployee` / `seedProject` / `dmCtx` / `groupCtx` 是该测试文件**已有**的夹具；没有就照该文件现有写法造。

改写 `src/prompts/space.md`（把 `dm.md` / `group.md` 的有用内容并入，用 `{{session_info}}` 与既有变量表达差异）：

```md
你是 OpenStaffs（本地 AI 办公室）驱动的员工「{{agent_name}}」（{{agent_id}}）。
当前会话：{{session_info}}。工作目录：{{workdir}}。

消息规范：
- **大内容走文件，聊天只发摘要**：长报告、大段代码 / 日志 / 完整清单 / 表格等通过工作目录里的文件交接，聊天里只给「一句话结论 + 文件路径」。
- **群聊每条消息都以 @ 开头**：`@` 只在消息最开头生效；要让某位成员做事，把 `@成员 id` 写在最前面；发给负责人（`@{{boss_name}}`）写最前面。没写 @、或开头 @ 了但没解析出有效对象时，系统视为发给负责人。
- **非必须不要主动 @ 别人**：@ 同伴 = 派活（真的唤醒对方跑一轮）；被 @ 后直接干活、不要回「收到」；完工回告以派活约定为准。
- **来回两三轮没有收敛就停**：改写文件 + 给负责人一次性小结，别在群里互 @。
- 成员之间没有私聊；协作一律在群里 @。找负责人也可以用 `send_message`（target=boss）。

你只能写自己的工作目录与权限允许的路径；超出范围用 `request_permission` 申请，不要用 bash 绕过。
需要长期记住的经验 / 事实，写进自己的记忆文件 `MEMORY.md`（在工作目录里），保持精简。
```

删除 `src/prompts/dm.md` 与 `src/prompts/group.md`。

Run: `grep -rn "AGENTS\.md" src/prompts` → 期望为空；`ls src/prompts` → 只有 `space.md`。

- [ ] **Step 6: 跑全量 + 提交**

Run: `npm test && npm run typecheck`
Expected: 全绿；`grep -rn "AGENTS\.md" src web` 为空（除本计划文档）；`grep -rn "renderEnvironment\|promptTemplatePath" src` 为空。

```bash
git add src/capabilities/prompt.ts src/app/conversations.ts src/domain/prompt.ts src/domain/prompt-vars.ts src/prompts tests
git commit -m "feat(prompt): prompt 按作用域链累加渲染；内置 prompt 收为 space.md（D5/D32/D33）"
```

---

## Task 5: 项目载体收口 —— 扁平 `projects/<名>.project.config.json`

**Files:**
- Modify: `src/domain/project.ts`（整体重写）
- Modify: `src/domain/access-control.ts`（`parseMembers` 读项目 config）
- Modify: `src/domain/paths.ts`（加 `projectConfigFile`；删 `membersFile` / `projectDir`）
- Test: `tests/domain/project.test.ts`（重写）、`tests/domain/access-control.test.ts`（改夹具）

**Interfaces:**
- Consumes: `loadProjectConfig`（P3，`src/config/load.ts`；返回 `LoadedConfig | undefined`，取 `.fields`）、`ConfigFields`（P3，`src/config/schema.ts`）
- Produces:
  - `projectConfigFile(ws: Workspace, name: ProjectName): string` → `<空间>/projects/<名>.project.config.json`（P3 的 `src/config/naming.ts` 已提供同名函数；P5 复用其落点，不重复实现）
  - `projectExists(ws: Workspace, name: ProjectName): boolean`
  - `loadProject(ws, id): Project`，`Project = { id; alias; members: EmployeeId[]; owner: string[]; prompt?: string }`
  - `listProjects(ws): Project[]`（扫 `projects/*.project.config.json`）
  - `createProject(ws, id, memberIds, alias?): Project`（写扁平 config；**不建目录、不建 `data/`、不建 `members.md`、不建 `AGENTS.md`**）
  - `parseMembers(ws, name): EmployeeId[]`（读 config 的 `members`）
- **删除**：`membersFile`；`projects/<id>/` 目录形态、`data/`、`members.md`、`project.json`、项目 `AGENTS.md`、项目 `permission.json`、项目 `mcp.json`、项目 `skills/`。

- [ ] **Step 1: 写失败测试**

`tests/domain/project.test.ts` 重写为：

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { parseMembers } from "../../src/domain/access-control.ts";
import { createWorkspace } from "../../src/domain/paths.ts";
import { createProject, listProjects, loadProject, projectConfigFile } from "../../src/domain/project.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "oss-proj-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

it("createProject：只写 projects/<名>.project.config.json（无目录 / data / members.md / AGENTS.md）", () => {
  const ws = createWorkspace(root);
  createProject(ws, "yt-001", ["alice", "bob"], "YouTube");
  const file = projectConfigFile(ws, "yt-001");
  expect(fs.existsSync(file)).toBe(true);
  expect(fs.existsSync(path.join(root, "projects", "yt-001"))).toBe(false);
  expect(fs.existsSync(path.join(root, "projects", "yt-001", "members.md"))).toBe(false);
  expect(fs.existsSync(path.join(root, "projects", "yt-001", "AGENTS.md"))).toBe(false);

  const config = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  expect(config["alias"]).toBe("YouTube");
  expect(config["members"]).toEqual(["alice", "bob"]);
  expect(config["permissions"]).toEqual({ write: [], read: ["./"], bash: ["./"] }); // D14 新建默认值
});

it("loadProject / parseMembers 从配置读；缺文件 → 抛 / 空数组", () => {
  const ws = createWorkspace(root);
  createProject(ws, "xhs-01", ["alice"]);
  expect(loadProject(ws, "xhs-01").members).toEqual(["alice"]);
  expect(parseMembers(ws, "xhs-01")).toEqual(["alice"]);
  expect(parseMembers(ws, "missing")).toEqual([]);
  expect(() => loadProject(ws, "missing")).toThrow("项目不存在");
});

it("listProjects：扫 *.project.config.json，按 id 排序；坏 JSON 不崩", () => {
  const ws = createWorkspace(root);
  createProject(ws, "b", []);
  createProject(ws, "a", []);
  fs.writeFileSync(projectConfigFile(ws, "broken"), "{坏");
  expect(listProjects(ws).map((p) => p.id)).toEqual(["a", "b", "broken"]);
});

it("alias 两端空白被 trim；缺省 = id", () => {
  const ws = createWorkspace(root);
  createProject(ws, "p1", [], "  YouTube  ");
  expect(loadProject(ws, "p1").alias).toBe("YouTube");
  createProject(ws, "p2", []);
  expect(loadProject(ws, "p2").alias).toBe("p2");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/domain/project.test.ts`
Expected: FAIL —— `projectConfigFile` / `projectExists` 未定义；`createProject` 仍建目录。

- [ ] **Step 3: 复用 P3 的 `projectConfigFile`（不重复定义）**

> `projectConfigFile(ws, name)` 已由 P3 的 `src/config/naming.ts` 提供（裁定 N4：扁平化 P3 与 P5 都做，**只做一次**，P5 只补 P3 未覆盖的部分）。`src/domain/paths.ts` 本步只**删** `membersFile` / `projectDir`（删前先 `grep -rn "projectDir\|membersFile" src` 确认没有剩余引用；`deleteProjectDir` 之类的旧 helper 一并删）。

- [ ] **Step 4: 实现 `src/domain/project.ts`（整体重写）**

```ts
// src/domain/project.ts
import fs from "node:fs";
import { loadProjectConfig } from "../config/load.ts";        // P3（裁定 B4）
import { projectConfigFile } from "../config/naming.ts";      // P3（裁定 N4）
import { projectsDir, type Workspace } from "./paths.ts";
import type { EmployeeId, ProjectName } from "./types.ts";

/** 复用 P3 的落点（旧调用方从 `domain/project.ts` 取它，保持可用）。 */
export { projectConfigFile };

export type Project = {
  id: ProjectName;
  alias: string;
  members: EmployeeId[];
  /** 群主（可多、可为空；D6）。 */
  owner: string[];
  prompt?: string;
};

function assertValidProjectId(id: string): void {
  const invalid =
    id.trim() === "" || /\s/u.test(id) || id.includes("/") || id.includes("\\") || id.includes("\0") ||
    id === "." || id === ".." || id.startsWith(".");
  if (invalid) throw new Error(`项目 id 不合法: ${JSON.stringify(id)}（不得为空/含空白或路径分隔符/以点开头）`);
}

/** 建群 = 写一份扁平配置（D26：无目录、无 data/、无工作目录）。 */
export function createProject(ws: Workspace, id: ProjectName, memberIds: EmployeeId[], alias?: string): Project {
  assertValidProjectId(id);
  const file = projectConfigFile(ws, id);
  if (fs.existsSync(file)) throw new Error(`项目已存在: ${id}`);
  const displayName = alias === undefined || alias.trim() === "" ? id : alias.trim();
  const config = {
    alias: displayName,
    members: [...memberIds],
    // D14 新建默认值
    permissions: { write: [], read: ["./"], bash: ["./"] },
  };
  fs.mkdirSync(projectsDir(ws), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return { id, alias: displayName, members: [...memberIds], owner: [] };
}

export function projectExists(ws: Workspace, id: ProjectName): boolean {
  return fs.existsSync(projectConfigFile(ws, id));
}

/** 读项目；配置缺失 → 抛「项目不存在」。 */
export function loadProject(ws: Workspace, id: ProjectName): Project {
  const config = loadProjectConfig(ws, id)?.fields;
  if (config === undefined) throw new Error(`项目不存在: ${id}`);
  const alias = config.alias === undefined || config.alias === "" ? id : config.alias;
  return {
    id,
    alias,
    members: [...config.members],
    owner: [...config.owner],
    ...(config.prompt === undefined ? {} : { prompt: config.prompt }),
  };
}

export function listProjects(ws: Workspace): Project[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(projectsDir(ws), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".project.config.json"))
    .map((entry) => entry.name.slice(0, -".project.config.json".length))
    .sort()
    .map((id) => loadProject(ws, id));
}
```

- [ ] **Step 5: 实现 `src/domain/access-control.ts` 的 `parseMembers`**

```ts
// src/domain/access-control.ts
export function parseMembers(ws: Workspace, name: ProjectName): EmployeeId[] {
  try {
    return loadProject(ws, name).members;
  } catch {
    return [];
  }
}
```

`projectsOf` 改为扫 `listProjects(ws)`（不再是目录扫描）。

- [ ] **Step 6: 跑全量 + 提交**

Run: `npm test && npm run typecheck`
Expected: 全绿；`grep -rn "membersFile\|members\.md" src web` 为空（除本计划文档与技能手册——手册在 Task 7 统一改）。

```bash
git add src/domain/paths.ts src/domain/project.ts src/domain/access-control.ts tests/domain
git commit -m "refactor(project): 项目改扁平 project.config.json，成员入配置（D22/D26）"
```

---

## Task 6: 工作目录与环境收口 —— 群聊 cwd = `work/<id>/`；会话链出员工目录

**Files:**
- Modify: `src/app/conversations.ts`（`relationCwd` / `accessFor` / 链文件落点）
- Modify: `src/domain/paths.ts`（删 `conversationIdsFile` / `groupConversationIdsFile`，加链文件 helper；`employeeDir` 按裁定 B1 仍由 P2 保留，本计划**不删**）
- Modify: `src/tools/registry.ts`（`relationCwd` 调用点补 `selfId`）
- Test: `tests/app/conversations.test.ts`、`tests/domain/paths.test.ts`

**Interfaces:**
- Produces:
  - `relationCwd(ws: Workspace, relation: Relation, speakerId: string): string` → **两者都** = `workDir(ws, speakerId)`（D20/D25/D26：项目无工作目录；`workDir` 来自 P2）
  - `dmChainFile(ws, agentId)` / `groupChainFile(ws, project, agentId)` → `stateDir(ws)/chains/*.md`（机器私有；不再落员工目录）
- **Review Focus #4** 由「群聊 cwd = 发言人的 work 目录」用例钉住。

- [ ] **Step 1: 写失败测试**（`tests/app/conversations.test.ts` 追加）

```ts
it("关系工作目录：私聊与群聊都是发言人的 work/<id>/（D20/D25/D26）", () => {
  expect(relationCwd(ws, { kind: "dm", employeeId: "alice" }, "alice")).toBe(path.join(ws.root, "work", "alice"));
  expect(relationCwd(ws, { kind: "group", project: "seo" }, "bob")).toBe(path.join(ws.root, "work", "bob"));
});

it("会话链落在 openstaffs/.data/chains/，不落员工目录", async () => {
  await openDm(ws, harness, "alice");
  const dir = path.join(ws.root, "openstaffs", ".data", "chains");
  expect(fs.existsSync(dir)).toBe(true);
  expect(fs.readdirSync(dir).some((f) => f.includes("alice"))).toBe(true);
  expect(fs.existsSync(path.join(ws.root, "agents", "alice", "conversation_ids.md"))).toBe(false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/app/conversations.test.ts`
Expected: FAIL —— `relationCwd` 目前群聊返回项目目录、且只收 2 个参数；链文件仍在员工目录。

- [ ] **Step 3: 实现（`conversations.ts` + `paths.ts`）**

```ts
// src/domain/paths.ts（追加；删除 conversationIdsFile / groupConversationIdsFile；employeeDir 按裁定 B1 保留不删）
/** 会话链落点（机器私有，随 P4 进 openstaffs/.data/）。 */
export function dmChainFile(ws: Workspace, agentId: string): string {
  return path.join(stateDir(ws), "chains", `dm__${agentId}.md`);
}
export function groupChainFile(ws: Workspace, project: string, agentId: string): string {
  return path.join(stateDir(ws), "chains", `group__${project}__${agentId}.md`);
}
```

```ts
// src/app/conversations.ts
export function relationCwd(ws: Workspace, relation: Relation, speakerId: string): string {
  return workDir(ws, speakerId);
}
function chainFileFor(ws: Workspace, relation: Relation, speakerId: string): string {
  return relation.kind === "dm" ? dmChainFile(ws, speakerId) : groupChainFile(ws, relation.project, speakerId);
}
```

更新所有调用点：`promptContextFor`、`accessFor`、`specFor`、`ensure`、`newSession`、`sessionChains`、`registry.ts` 的 `request_permission`（`relationCwd(ctx.ws, ctx.relation, ctx.selfId)`）。

- [ ] **Step 4: 跑全量 + 提交**

Run: `npm test && npm run typecheck`
Expected: 全绿。

```bash
git add src/app/conversations.ts src/domain/paths.ts src/tools/registry.ts tests
git commit -m "refactor(workdir): 群聊工作目录改为发言人的 work/<id>/；会话链移出员工目录（D20/D25/D26）"
```

---

## Task 7: 旧机制清点删除 + 文档同步 + 全量回归 + 手工冒烟

**Files:**
- Delete: `src/mcp.json`（若 P3 已换 `openstaffs/mcps.json`）
- Modify: `src/skills/openstaffs/SKILL.md`、`src/skills/openstaffs-ops/SKILL.md`、`README.md`、`docs/产品规划.md`
- Modify: `web/render.ts`（空态文案）

- [ ] **Step 1: 删除最后一个旧机制引用**

```bash
grep -rn "AGENTS\.md\|profile\.md\|members\.md\|membersFile\|skillDirsFor" src web
```

把命中的每一处删掉（技能手册里的说明留到 Step 3 改）。确认 Task 4 已删掉 `src/prompts/dm.md` / `group.md`：

```bash
ls src/prompts        # 期望：只有 space.md
```

- [ ] **Step 2: 断言「删干净」**

```bash
grep -rn "AGENTS\.md" src web                                   # 期望：空
grep -rn "profile\.md" src web                                  # 期望：空
grep -rn "members\.md\|membersFile" src web                     # 期望：空
grep -rn "permission\.json\|permissionFiles" src                # 期望：空（P3 已换按工具权限）
grep -rn "projectDir(" src web                                  # 期望：空（P3 已删；employeeDir 按裁定 B1 保留，不再断言它为空）
grep -rn "\.openstaffs" src web                                 # 期望：空（P4 已迁 openstaffs/.data）
grep -rn "skillDirsFor" src web                                 # 期望：空
grep -rn "renderEnvironment\|promptTemplatePath" src            # 期望：空（内置 prompt 收为 space.md）
grep -rn "mcp\.json" src web                                    # 期望：只出现 openstaffs/mcps.json（或空）
```

> `renderInstructions` 不是「待删残留」：它是 `src/domain/employee.ts` 的既有导出（P2 落点，裁定 B1），故不做「期望为空」断言。

任何非空命中都要处理；确实属于 P3/P4 范围且尚未落地的，记录到本任务 Step 4 的偏差说明，不擅自扩大改动。

- [ ] **Step 3: 文档同步（仓库 `AGENTS.md` 同步表，全覆盖）**

1. **`src/skills/openstaffs/SKILL.md`（能力真相源）**：把「员工 = 文件夹 `agents/<id>/`，里面是 `profile.md` / `MEMORY.md` / `skills/`」改成新模型：
   - 人 = `agents/.../<名字>.agent.config.json` 单一文件；展示名 = `alias`；
   - 记忆 = `work/<你>/MEMORY.md`（工作目录**只有 agent 有**；项目无工作目录）；
   - 技能 = 按名引用 `openstaffs/skills/<技能名>/`；
   - 不再有 `AGENTS.md`；引导走各层 `prompt`。
2. **`src/skills/openstaffs-ops/SKILL.md`（运维真相源）**：按新目录结构重写「办公空间全景 / 员工目录 / 项目目录 / 环境段与模板 / 技能 / MCP / 改动生效方式 / 常见故障」——目录结构用 §3 的三段（`agents/` 部门树 + `projects/*.project.config.json` + `work/<id>/` + `openstaffs/{space.config.json,skills/,mcps.json,.data/}`）；权限章节改成「按工具 + attenuation」；**「环境段与模板」章节改为**：内置 prompt 只有一份（框架 `src/prompts/space.md`），新建空间时物化进 `openstaffs/space.config.json`，此后**改 `space.config.json` 即可**（改了要新开会话）；不再有 `src/prompts/dm.md` / `group.md`，也不再有空间 / 项目 `AGENTS.md`。
3. **`README.md`**：重写「Agent」「项目」「配置」章节的落点（最小做法变成写一份 `<名字>.agent.config.json`；项目变成写 `projects/<名>.project.config.json`）。
4. **`docs/产品规划.md`**：更新「未落地的愿景细节」表里的「组织架构 / 员工人格文件 / 技能清单 / 0 号员工」为已落地新形态；更新「空间层命名与落点（已定稿）」表为 `*.config.json` 形态。

Run: `grep -rn "AGENTS\.md\|profile\.md\|members\.md" README.md docs/产品规划.md src/skills` → 期望：只剩对「为什么不再用」的说明性文字（若有）。

- [ ] **Step 4: 全量回归**

```bash
npm test
npm run typecheck
```

Expected: 全绿。（若非绿，逐条修：先看是否夹具仍是老写法，再修改动代码。）

- [ ] **Step 5: 真实链路手工冒烟**

```bash
mkdir -p ~/oss-p5 && cd ~/oss-p5 && git init -q
# 在框架目录启动（另开一个终端）：
npm start -- ~/oss-p5
```

浏览器打开 `http://localhost:4319`，按序验证：

1. **新建空间**：从零启动 → 引导页 → 填供应商密钥与默认模型（写入 `openstaffs/.data/config.json`）；确认 `openstaffs/space.config.json` 已生成且含 `prompt`（D32）。
2. **部门 / 人**：
   ```bash
   mkdir -p ~/oss-p5/agents/eng
   cat > ~/oss-p5/agents/eng/department.config.json <<'EOF'
   { "alias": "工程部", "prompt": "本部门只做工程。" }
   EOF
   cat > ~/oss-p5/agents/eng/alice.agent.config.json <<'EOF'
   { "alias": "爱丽丝", "prompt": "你是爱丽丝（{{agent_id}}），在 {{workdir}} 下工作。", "skills": [] }
   EOF
   ```
   刷新页面 → 侧栏能折叠出「工程部 / 爱丽丝」。
3. **私聊**：进入 alice 私聊，发「把你当前的工作目录路径写进你的记忆 MEMORY.md」，确认：
   - alice 回复中提到的是 `work/alice`（工作目录 = `work/<id>/`）；
   - `ls ~/oss-p5/work/alice/MEMORY.md` 存在且内容被更新；
   - 确认 `~/oss-p5` 下**没有** `agents/alice/` 目录、没有 `AGENTS.md`（`find ~/oss-p5 -name 'AGENTS.md'` 为空）。
4. **群聊**：
   ```bash
   cat > ~/oss-p5/projects/demo.project.config.json <<'EOF'
   { "alias": "演示群", "members": ["alice"], "prompt": "本群目标：写一份周报。" }
   EOF
   # 再建一个人 bob 并按上面写法给一份 config
   ```
   群里勾选 alice 发送 → alice 响应；确认 alice 的群会话里工作目录是 `work/alice`（不是 `projects/demo/`），且 `find ~/oss-p5/projects -type d` 只返回 `projects` 本身。
5. **技能集中**：在 `openstaffs/skills/weekly/SKILL.md` 建一个技能，把 `alice.agent.config.json` 的 `skills` 写成 `["weekly"]` → **新开会话** → 确认环境里出现「可用技能」且指向 `openstaffs/skills/weekly/SKILL.md`。
6. **记忆注入**：重启服务 → 新开会话 → 确认 alice 仍「记得」`MEMORY.md` 里的内容（新会话自动注入）。

冒烟通过后清理：`rm -rf ~/oss-p5`。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "chore(p5): 清点删除旧机制（AGENTS.md/profile.md/members.md 等）；同步四份文档"
```

---

## Self-Review 记录

**1. Spec 覆盖**

| spec 要求 | 落在哪个任务 |
|---|---|
| §3 目录结构（`agents/` 部门树 + `projects/*.project.config.json` + `work/<id>/` + `openstaffs/{space.config.json,skills,mcps.json,.data}`） | Task 2（人）/ Task 5（项目）/ Task 1+6（work）/ Task 3（skills）；`space.config.json` 与 `.data/` 由 P4 |
| §4 统一字段（`prompt`/`skills`/`mcp`/`permissions`/`model`/`head`/`owner`/`members`） | Task 2（员工字段）/ Task 5（项目字段）/ Task 3+4（消费 prompt/skills） |
| §7 合并规则（累加、无覆盖；prompt 换行分割） | Task 4（prompt 链）/ Task 3（skills 累加）；permissions 由 P3 |
| §10 P5 行（config 取代多文件 / prompt 渲染 / 记忆 `work/<id>/MEMORY.md` / 技能库集中 / 不用 AGENTS.md） | Task 1/2/3/4 各一条，Task 7 收口 |
| §12 模块化（capabilities 域；基座只在 harness） | Task 3/4 新建 `src/capabilities/*`，不 import `harness`；Task 7 用 grep 断言 |
| D2 / D5 / D33 | Task 2 / Task 4 / Task 7 |
| D16 / D17（按名引用） | Task 3（skills）；mcp 由 P3 |
| D20 / D25 / D26 / D27 | Task 1 / Task 5 / Task 6 |
| D22（成员入 config） | Task 5 |
| D30（不迁移） | Global Constraints + Task 7 的删除断言 |
| D32（内置 prompt 物化） | Task 4 Step 5（内置 prompt 收为 `src/prompts/space.md`，由 P4 物化进 `space.config.json`，运行时只读空间配置）+ Task 7 手工冒烟第 1 步 |
| D34（强模块化） | Task 3/4 的模块划分 + Task 7 断言 |
| 仓库 `AGENTS.md` 文档同步表（四份） | Task 7 Step 3（硬步骤） |

**2. Placeholder 扫描**：无「TBD / 稍后补 / 类似 Task N」；每个代码步骤都给了可直接抄的代码或精确命令。执行时若 P2/P3 的落点与「跨阶段假设」不同（例如项目配置文件名），只需按名替换 import / 路径常量，**测试意图不变**。

**3. 类型一致**：`CapabilityScope`（Task 3）↔ `renderPromptChain(scopes, ctx)`（Task 4）↔ `skillNamesFrom(scopes)`（Task 3）；`Employee`（Task 2）字段 `prompt/skills/mcp/permissions/memory/workDir` 与 Task 3/4 的消费一致；`EmployeeId` / `Relation` 沿用 `src/domain/types.ts`；`Project`（Task 5）字段 `members/owner/prompt` 与 `parseMembers` / 作用域链一致。

**4. Review Focus 落点**：#1 → Task 2（定义缺失 / 坏 JSON）；#2 → Task 1（记忆缺失 / 幂等补建）；#3 → Task 4（空段 / 重复 / 顺序 / 渲染）；#4 → Task 6（群聊 cwd = `work/<id>/`）；#5 → Task 3（按名解析不到 / 同名）。五项均已有钉住测试。

**5. 刻意留到后续 / 已知偏差**：
- `sessionId` 的会话上下文边界（spec §13）本计划不实现（P1/P2 范围）；
- MCP 的「按名引用 `openstaffs/mcps.json`」若 P3 未落地，P5 不越界改（Task 7 Step 2 记为偏差）；
- **`src/prompts/space.md` 的最终文案**由 P5 定稿（把原 `dm.md` / `group.md` 的信息并进去）；它与 P4 计划里「最小文案」的差异是**有意**的（P4 自评已授权 P5 改写）。
- **P4 与 P5 之间的已建空间**：`space.config.json` 里是 P4 的最小文案；按 D30 不迁移（需要新文案时删掉该文件重启即重新物化）。
- **`head` / `owner` 的字段读取**不在 P5（P2 的组织与负责人），P5 只消费「部门链」与「项目成员」。

**6. 2026-10-19 按跨计划裁定修订**（`2026-10-19-p2-p5-preflight-rulings.md`）
- **B1**：不再假定 P2 删除 `src/domain/employee.ts`；改为「继续使用 `loadEmployee` / `listEmployees` / `employeeDir`（P2 已把它改成 org 薄适配层）」，`renderInstructions` 按 P2 落点（`employee.ts`，`(person) => person.prompt`）保留，Task 7 不再断言其为空。
- **B2**：`findAgent` / `listAgentIds` / `departmentChainDirs` 一律改为 P2 实际接口 `loadPerson` / `listPeople` / `ancestryOf`（人带 `dir` / `departmentPath`，另用 `findPerson`），并同步 Interfaces 与 `http.ts` 用例；补记 P2 新增的 `managedSubtreeOf`。
- **B3**：删掉本计划 Task 1 自建的 `workDir`（与 P2 重复导出），改为 import P2 的 `workDir`；相关 `paths.ts` 实现、测试与断言同步。
- **B4**：五层配置 import 从 `../domain/config.ts` 改为 P3 的 `src/config/*`（`schema.ts` / `load.ts` / `naming.ts`），`src/domain/config.ts` 只留机器私有配置。
- **B5**：File Structure 里 `src/capabilities/scopes.ts` / `skills.ts` 改为「复用（追加导出）、不得重写」；`capabilityScopesFor` 按 P3 的别名方案（`= scopesForOrg`）追加。
- **N3**：`ToolPermissionMap` 的 import 从 `./permissions.ts` 改为 P3 的 `src/config/schema.ts`（或 `src/config/load.ts` 别名）。
- **P1 对齐**：跨阶段假设新增「P1 已落地事实」段（`RoomMessage` 条目键 `store:<seq>`、`mergeRoomMessages` 已删、库实例唯一化在 `main.ts`、`ToolContext` 带 `broadcast`），并声明 P5 不碰 `src/store/`、链文件与 `messagesDbFile` 不冲突。
