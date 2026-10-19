# 空间目录合并 + Staff0（P4）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把机器私有目录从 `.openstaffs/` 并入 `openstaffs/.data/`（D19），并新增启动流程：新建空间时物化 `openstaffs/space.config.json`（D32），首次启动自动创建 `agents/staff0.agent.config.json`（D24 / §8）。

**Architecture:** 路径搬迁是**一个函数**的语义变更——`src/domain/paths.ts` 的 `stateDir(ws)` 由 `<root>/.openstaffs` 改为 `<root>/openstaffs/.data`；配置 / 状态 / 权限请求 / 消息库 / 基座 sqlite **全部经由 `stateDir`**，因此跟着一起搬，`messagesDbFile(ws) = path.join(stateDir(ws), "messages.sqlite")` 的语义不变（P1 约束）。启动探测拆成三个**自有域模块**：`space.ts`（空间声明 `space.config.json` 的物化）、`staff0.ts`（0 号员工定义与创建）、`server/bootstrap.ts`（启动装配 `.openstaffs/`→`openstaffs/.data/` 的探测编排）。**Pi 基座不出现在任何新模块里**（D34）。

**Tech Stack:** Node ≥ 22.19（本机 24.x）、ESM、`npm start` 直接跑 TS（**strip-only**：不用参数属性、不用 `enum`、不用装饰器）、Vitest、TypeScript `tsc --noEmit`。

**Spec:** `docs/superpowers/specs/2026-10-18-agent-org-hierarchy-design.md`（§3 目录结构、§4 统一字段、§8 Staff0、§10 P4 行、§12 模块化边界、D19/D24/D30/D32/D34）

## Global Constraints

- Node ≥ 22.19，ESM，`strict` + `noUncheckedIndexedAccess`；`npm start` = `node src/server/main.ts`，**strip-only TS**：不得用参数属性（`constructor(private x)`）、不得用 `enum`、不得用装饰器。
- **不新增任何依赖**（含测试依赖）。
- **D30：不做迁移**（允许破坏性更新）。不写迁移脚本、不读旧 `.openstaffs/`、不做兼容回退。
- **D34 强模块化**：基座（Pi）**只出现在 `harness`**；路径 / 存储 / 配置 / 空间声明均为**自有域模块**。本计划新增模块一律不 import `harness`。
- **P1 接口约束（硬）**：`messagesDbFile(ws) = path.join(stateDir(ws), "messages.sqlite")`（P1 已实现）。本次把 `stateDir` 迁到 `openstaffs/.data/` **不得改 `messagesDbFile` 的拼接方式或返回语义**；必须有一条测试钉住「迁移后消息库落在 `openstaffs/.data/messages.sqlite`」。
- **P4 边界**：只做「路径搬迁 + 启动探测/引导 + Staff0 自动创建 + `.gitignore`」。**不做**：部门树与负责人（P2）、统一 config 解析器与按工具权限（P3）、`.agent.config.json` 全面取代多文件 / `prompt` 渲染 / `work/<id>/MEMORY.md`（P5）。
- **口径**：指目录一律「办公空间」；机器私有目录一律写 `openstaffs/.data/`，全文不得再有 `.openstaffs/`。
- **TDD**：每任务**先写失败测试** → 跑失败 → 实现 → 跑通过 → 提交。提交信息用**简体中文祈使句**。
- **分支约定（仓库 `AGENTS.md`）**：按 spec §10 顺序 **P2 → P3 → P4 → P5**，P4 **在 P3 之后续做**：P1/P2/P3 均已在各自本地分支上完成并 `merge --squash` 合回 `master` 后**删除**（`feat/message-store` / `feat/unified-config` 均已不存在）。P4 **新建本地开发分支 `feat/space-dir-merge`**（自 P3 合并后的 `master`）；完成后 `merge --squash` 收敛为一条提交合回 master 并删除该分支。**开发分支不 push 到远程**。
- **文档同步是硬要求**：运维真相源 `src/skills/openstaffs-ops/SKILL.md` **必须**更新；`src/skills/openstaffs/SKILL.md`、`README.md`、`docs/产品规划.md`、仓库 `AGENTS.md` 按需同步（见 Task 6）。

## Review Focus

以下失败模式最易伤人，每条在其归属任务的测试里钉住：

1. **旧 `.openstaffs/` 残留**：`stateDir` 改了，但某处仍硬编码 `.openstaffs`（曾见 `src/server/main.ts` 的 sqlitePath）→ 配置 / 库写进旧目录，表现为「改了配置不生效」「消息历史莫名其妙消失」。→ Task 1 的 `grep` 断言。
2. **`messagesDbFile` 语义被搬迁改坏**：搬迁时若顺手改拼接方式，消息库会落到别处，且 P1 的库与 P4 的 `stateDir` 脱钩。→ Task 1 的 `messagesDbFile` 断言。
3. **`.gitignore` 口径错**：把整个 `openstaffs/` 忽略掉，会让 `space.config.json` / `skills/` / `mcps.json` 这些**空间资产无法版本化、不能随空间整包迁移**（spec §3）。只有 `openstaffs/.data/` 该被忽略。→ Task 1 的 `git check-ignore` 断言。
4. **新空间判定误伤老板内容**：`space.config.json` **已存在**（含老板手改内容）、或目录存在但文件为空 / 坏 JSON 时，不得覆盖、不得重复物化。→ Task 3 / Task 4。
5. **Staff0 不幂等**：重复启动覆盖老板改过的 `staff0.agent.config.json`。→ Task 2 / Task 4。
6. **不可写空间目录把启动打死**：空间目录只读 / root 路径其实是个文件时，启动流程应打印中文告警并继续，而不是抛未捕获异常退出。→ Task 4。

---

## File Structure

**新建**
- `src/prompts/space.md` — 框架内置的**空间 prompt**（系统作用域；D32 物化源）。
- `src/domain/space.ts` — 空间声明 `space.config.json`：路径、内置 prompt 读取、新建空间物化（`ensureSpaceConfig`）。
- `src/domain/staff0.ts` — 0 号员工：`STAFF0_ID`、`staff0File`、`staff0Config`、`ensureStaff0`。
- `src/server/bootstrap.ts` — 启动探测装配：`ensureSpace(ws)`（编排 `space.ts` + `staff0.ts`，逐项兜错）。
- `tests/domain/space.test.ts`、`tests/domain/staff0.test.ts`、`tests/server/bootstrap.test.ts`。

**修改**
- `src/domain/paths.ts` — `stateDir` → `openstaffs/.data`；新增 `STATE_DIR_NAME`。
- `.gitignore` — 去 `.openstaffs/`、加 `openstaffs/.data/`（保留 `*.sqlite` 兜底）。
- `src/server/main.ts` — sqlitePath 改走 `stateDir`；启动调用 `ensureSpace`；未配置 / 端口报错文案改路径。
- `web/render.ts` — 引导页路径与说明改 `openstaffs/.data/`。
- `src/server/http.ts` — 409「尚未配置」文案改路径。
- `src/domain/mcp.ts`、`src/domain/permission-requests.ts`、`src/tools/registry.ts` — 报错 / 注释里的 `.openstaffs` 改路径。
- `tests/domain/paths.test.ts` — 新增 `stateDir` / `messagesDbFile` 断言。
- `tests/web/render.test.ts` — 引导页路径断言。
- **回归清扫（Task 1）**：以 `grep -rl '\.openstaffs' tests` 的实际命中为准（P3 后为 18 个测试文件：`tests/domain/{config,prompt-vars,prompt,mcp,permission-requests}.test.ts`、`tests/harness/{pi-durable,access-extension,mcp-harness,mcp-manager}.test.ts`、`tests/app/{conversations,rooms}.test.ts`、`tests/server/{sse,http,pump-trigger,pump,main-bad-store}.test.ts`、`tests/tools/{registry,extension}.test.ts`）—— 所有 `.openstaffs` 夹具改 `openstaffs/.data`。
- **文档（Task 6）**：`src/skills/openstaffs-ops/SKILL.md`（必改）、`src/skills/openstaffs/SKILL.md`、`README.md`、`docs/产品规划.md`、`AGENTS.md`。

**删除**
- 无源文件删除。`openstaffs/` 与 `.openstaffs/` 的实际数据目录由用户自行处理（D30：不做迁移）。

---

## 跨阶段假设（P1 / P2 / P3 / P5）

本计划按 spec 的**目标形态**写，同时明确它对并行阶段的依赖；假设不成立时的处理如下：

| 阶段 | 本计划假设它提供 | 若假设不成立 |
|---|---|---|
| **P1（消息自有库）** | `src/domain/paths.ts` 导出 `messagesDbFile(ws) = path.join(stateDir(ws), "messages.sqlite")`（**已落地事实**，本计划已按此写、确认无误）；且库实例已**唯一化**——生产路径由 `src/server/main.ts` 创建并注入（`Deps.store` / `ServerDeps.store` 必填）。 | `stateDir` 迁移**不依赖** `messagesDbFile` 是否存在；Task 1 的第 5 步（补 `messagesDbFile` 断言）在 P1 落地后执行即可。若 P1 把 `messagesDbFile` 写在别的模块，只需把该断言的 import 改到实际模块，不改实现。**另：`stateDir` 迁移不得改 `messagesDbFile` 的拼接语义（Task 1 Step 5 双断言保留）**；本计划的 `bootstrap` / 启动探测**若涉及开库，一律复用 P1 的单实例，绝不另开库实例**（`ensureSpace` 本身不碰库）。 |
| **P2（组织 + 负责人）** | `agents/` 的部门树 + `<名字>.agent.config.json` 发现与解析：`agents/staff0.agent.config.json` 会被当作一个**人**发现 | 未落地时：`listEmployees` 只扫 `agents/` 下的**目录**，新写的 `staff0.agent.config.json`（扁平**文件**）在 UI 中**不可见**——这是**预期**：P4 只负责把文件建出来，发现/解析归 P2。Task 2 的验收以**文件内容**为准，不以 UI 为准。 |
| **P3（统一配置 + 按工具权限）** | `space.config.json` / `*.agent.config.json` 的**统一解析器**；`permissions` = `{ 工具名: 路径列表 }`；`prompt` / `alias` / `model` 字段名按 §4 | 未落地时：`space.config.json` / `staff0.agent.config.json` 只是**被物化的文件**，暂无消费者（运行时无关，符合 D32「此后运行时无关」）。字段名固定按 spec §4 写死；若 P3 定稿的键名有出入，以 P3 为准调整 `staff0Config()` / `newSpaceConfig()` 的**唯一**常量，不改测试意图。Task 3 的 `space.ts` 逻辑简单（探测 + 物化），P3 可将其整体收编进 `src/domain/config.ts`。 |
| **P5（定义模型落地）** | `prompt` 渲染进会话；agent 工作目录 = `work/<id>/`（含 `MEMORY.md`）；彻底不用 `AGENTS.md` | 未落地时：Staff0 / 空间配置里的 `prompt` **不会被渲染**（渲染属 P5）；P4 **不创建** `work/` 目录（那是 P5 的落点）。 |

> 一句话：**P4 把「文件与目录」摆成 spec 的目标形态，把「谁来读」留给 P2/P3/P5。**

---

## Task 1: 路径搬迁 —— `stateDir` → `openstaffs/.data/`（含 `.gitignore` 与全量测试夹具回归）

**Files:**
- Modify: `src/domain/paths.ts`
- Modify: `src/server/main.ts`（仅 `sqlitePath` 一行）
- Modify: `.gitignore`
- Modify: `tests/domain/paths.test.ts`
- Modify（机械清扫 `.openstaffs` → `openstaffs/.data`；**以 `grep -rl '\.openstaffs' tests` 的实际命中为准**，P3 落地后的命中集为）：`tests/domain/config.test.ts`、`tests/domain/prompt-vars.test.ts`、`tests/domain/prompt.test.ts`、`tests/domain/mcp.test.ts`、`tests/domain/permission-requests.test.ts`、`tests/harness/pi-durable.test.ts`、`tests/harness/access-extension.test.ts`、`tests/harness/mcp-harness.test.ts`、`tests/harness/mcp-manager.test.ts`、`tests/app/conversations.test.ts`、`tests/app/rooms.test.ts`、`tests/server/sse.test.ts`、`tests/server/http.test.ts`、`tests/server/pump-trigger.test.ts`、`tests/server/pump.test.ts`、`tests/server/main-bad-store.test.ts`、`tests/tools/registry.test.ts`、`tests/tools/extension.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `paths.ts`：`export const SPACE_DIR_NAME = "openstaffs"`（不变）、`export const STATE_DIR_NAME = ".data"`（新）、`stateDir(ws: Workspace): string`（**语义变更** → `<root>/openstaffs/.data`）、`spaceDir` / `spaceSkillsDir`（不变）。
  - 由 `stateDir` 派生的全部文件路径自动改落点：`configFile` / `requestsFile` / `pinsFile` / `messagesDbFile` / `main.ts` 的 `state.sqlite`。

- [ ] **Step 1: 写失败测试（`tests/domain/paths.test.ts`）**

在该文件 `describe` 内追加：

```ts
  it("机器私有目录 = openstaffs/.data（D19：目录合并）", () => {
    expect(stateDir(ws)).toBe(path.join("/tmp/company", "openstaffs", ".data"));
    expect(spaceDir(ws)).toBe(path.join("/tmp/company", "openstaffs"));
    expect(spaceSkillsDir(ws)).toBe(path.join("/tmp/company", "openstaffs", "skills"));
  });
```

顶部 import 补 `spaceDir`、`spaceSkillsDir`、`stateDir`（`messagesDbFile` 在 Step 5 再补），并按 B1 裁定保留 `employeeDir`（P2 将其保留为薄适配层）；`workDir` 与 `conversationIdsFile` 已被 P2/P3 用例引用，**保留**：

```ts
import {
  agentsDir, conversationIdsFile, createWorkspace, employeeDir, groupConversationIdsFile,
  messagesDbFile, spaceDir, spaceSkillsDir, stateDir, workDir,
} from "../../src/domain/paths.ts";
```

> **注意（跨计划裁定 N1）**：**不要**把 `membersFile` / `projectDir` 加进 import —— 二者已随 **P3（项目扁平化）退场**并**已删除**；`employeeDir` 按 B1 由 P2 **保留**，故可加。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/domain/paths.test.ts`
Expected: FAIL —— `stateDir(ws)` 仍是 `/tmp/company/.openstaffs`。

- [ ] **Step 3: 实现 `src/domain/paths.ts`（**最小改动，不重写整个文件**）**

> **P3 落地后的事实**：`src/domain/paths.ts` 已不止 `stateDir` / `SPACE_DIR_NAME`——它还导出 `agentsDir` / `projectsDir` / `employeeDir` / `conversationIdsFile` / `groupConversationIdsFile` / `spaceDir` / `spaceSkillsDir` / `messagesDbFile` / `WORK_DIR_NAME` / `workDir`。**只改两处，保留其余全部导出与注释。**

1. 在现有 `export const SPACE_DIR_NAME = "openstaffs";` 之前新增一个常量：

```ts
/** 机器私有子目录名（`openstaffs/.data/`）：密钥配置、数据库、运行状态（D19；gitignore）。 */
export const STATE_DIR_NAME = ".data";
```

2. 把现有 `stateDir` 改为复用两个常量（函数体只换这一行）：

```ts
/** 机器私有目录：`openstaffs/.data/`（配置 / 状态 / 库都落这里；D19）。 */
export function stateDir(ws: Workspace): string {
  return path.join(ws.root, SPACE_DIR_NAME, STATE_DIR_NAME);
}
```

**注意**：`spaceDir` / `spaceSkillsDir` / `employeeDir` / `workDir` 等**保持原样不动**；`messagesDbFile` **不动**——继续 `path.join(stateDir(ws), "messages.sqlite")`（P1 硬约束）。

- [ ] **Step 4: 跑路径测试确认通过**

Run: `npx vitest run tests/domain/paths.test.ts`
Expected: PASS。

- [ ] **Step 5: 补 P1 接口回归断言（需 P1 的 `messagesDbFile` 已落地）**

在 `tests/domain/paths.test.ts` 追加（import 补 `messagesDbFile`）：

```ts
  it("消息库随 stateDir 搬迁：落在 openstaffs/.data/messages.sqlite（不改拼接语义）", () => {
    expect(messagesDbFile(ws)).toBe(path.join("/tmp/company", "openstaffs", ".data", "messages.sqlite"));
    expect(messagesDbFile(ws)).toBe(path.join(stateDir(ws), "messages.sqlite"));
  });
```

Run: `npx vitest run tests/domain/paths.test.ts`
Expected: PASS。

> **P1 已合入**（`messagesDbFile` 已在 `src/domain/paths.ts` 导出），本步**必做**，不留 TODO。

- [ ] **Step 6: 跑全量测试，确认回归面**

Run: `npm test`
Expected: **大量失败**——所有把夹具写在 `<root>/.openstaffs/...` 的测试都读不到新落点（`configFile` / `pinsFile` / `requestsFile` 已迁到 `openstaffs/.data/`）。这一步是**预期的红**，用来确认影响面。

- [ ] **Step 7: 实现 `src/server/main.ts` 的 sqlitePath**

把：

```ts
        sqlitePath: path.join(root, ".openstaffs", "state.sqlite"),
```

改为：

```ts
        sqlitePath: path.join(stateDir(ws), "state.sqlite"),
```

并补 import：

```ts
import { createWorkspace, stateDir } from "../domain/paths.ts";
```

> **P3 落地后的事实**：`src/server/main.ts` **已经** `import { createWorkspace, messagesDbFile, stateDir } from "../domain/paths.ts";`（第 4 行），**无需再补 import**；本步只改 `sqlitePath` 这一行。

- [ ] **Step 8: 清扫测试夹具（机械替换）**

```bash
# 统一把测试里的 `.openstaffs` 词元替换为 `openstaffs/.data`
# （覆盖 path.join 的各变量名（root / wsRoot / office…）、模板串、注释与用例标题；
#   `path.join(root, "openstaffs/.data", "x")` 在 POSIX 下与两段写法等价）
grep -rl '\.openstaffs' tests | xargs sed -i '' 's#\.openstaffs#openstaffs/.data#g'
# 残留检查（只查 tests；src/web 的文案与注释归 Task 5，src/skills 与 README/AGENTS 归 Task 6）
grep -rn '\.openstaffs' tests || echo "OK: tests 无 .openstaffs 残留"
```

Expected: 残留检查**无输出**（`src/` 下的文案与注释仍可能有 `.openstaffs`，那是 Task 5 的范围，此处不管）。

- [ ] **Step 9: 跑全量测试确认通过**

Run: `npm test && npm run typecheck`
Expected: 全绿。若仍有失败，逐个看是否漏扫（多半是 `path.join(root, ".openstaffs")` 之外的写法，如字符串拼接）。

- [ ] **Step 10: 改 `.gitignore`**

```gitignore
node_modules/
openstaffs/.data/
*.sqlite
.DS_Store
.superpowers/
public/
agents/
projects/
```

**理由（写清）：** `openstaffs/` 的**其余内容**（`space.config.json`、`skills/`、`mcps.json`）是**空间资产**，必须可版本化、可随空间整包迁移（spec §3），因此**只忽略机器私有的 `openstaffs/.data/`**，绝不忽略整个 `openstaffs/`；`*.sqlite` 保留作为兜底。原 `.openstaffs/` 一条删除（D19 合并后不再使用）。

- [ ] **Step 11: 验证 `.gitignore` 口径**

```bash
# 应输出（被忽略）：openstaffs/.data/config.json
git check-ignore -v openstaffs/.data/config.json
# 应无输出（不被忽略）：空间声明的三个资产
git check-ignore -v openstaffs/space.config.json openstaffs/skills/x/SKILL.md openstaffs/mcps.json || true
```

Expected: 第一条命中 `openstaffs/.data/`；第二条**无输出**（说明空间资产仍纳入版本管理）。

- [ ] **Step 12: 提交**

```bash
git add src/domain/paths.ts src/server/main.ts .gitignore tests/
git commit -m "refactor(paths): 空间目录合并——stateDir 迁至 openstaffs/.data/（含测试夹具与 .gitignore）"
```

---

## Task 2: Staff0 定义与首次创建（`src/domain/staff0.ts`）

**Files:**
- Create: `src/domain/staff0.ts`
- Test: `tests/domain/staff0.test.ts`

**Interfaces:**
- Consumes: `agentsDir(ws)`（`src/domain/paths.ts`）、`type Workspace`
- Produces:
  - `export const STAFF0_ID = "staff0"`
  - `export type Staff0Config = { alias: string; prompt: string; permissions: { write: string[]; read: string[]; bash: string[] } }`
  - `staff0File(ws: Workspace): string` → `<root>/agents/staff0.agent.config.json`
  - `staff0Config(): Staff0Config`
  - `ensureStaff0(ws: Workspace): "created" | "exists"`

- [ ] **Step 1: 写失败测试**

```ts
// tests/domain/staff0.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createWorkspace, type Workspace } from "../../src/domain/paths.ts";
import { ensureStaff0, STAFF0_ID, staff0Config, staff0File } from "../../src/domain/staff0.ts";

let root: string;
let ws: Workspace;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "os-staff0-"));
  ws = createWorkspace(root);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test("staff0Config：spec §4 统一字段；权限 = 空间根（`..`，相对 agents/）；无 model（用全局默认）", () => {
  const config = staff0Config();
  expect(STAFF0_ID).toBe("staff0");
  expect(config.alias).not.toBe("");
  // P3 的 permissions 路径相对**配置文件所在目录**解析（staff0 = `agents/`）→ 空间根 = `..`（裁定 R-P4-1）
  expect(config.permissions).toEqual({ write: [".."], read: [".."], bash: [".."] });
  expect(config).not.toHaveProperty("model");
});

test("staff0 的权限路径解析出来就是空间根（spec §8「写空间根 ./」= 整个空间，而非 agents/）", () => {
  const [first] = staff0Config().permissions.write;
  expect(path.resolve(path.join(root, "agents"), first!)).toBe(root);
});

test("staff0File：落点在 agents/staff0.agent.config.json（根下、无部门）", () => {
  expect(staff0File(ws)).toBe(path.join(root, "agents", "staff0.agent.config.json"));
});

test("ensureStaff0：不存在则创建（内容 = staff0Config）；已存在不覆盖", () => {
  expect(ensureStaff0(ws)).toBe("created");
  const file = staff0File(ws);
  expect(fs.existsSync(file)).toBe(true);
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(staff0Config());

  fs.writeFileSync(file, JSON.stringify({ alias: "老板改过的管家" }));
  expect(ensureStaff0(ws)).toBe("exists");
  expect(JSON.parse(fs.readFileSync(file, "utf8")).alias).toBe("老板改过的管家");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/domain/staff0.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 `src/domain/staff0.ts`**

```ts
import fs from "node:fs";
import path from "node:path";
import { agentsDir, type Workspace } from "./paths.ts";

/** 0 号员工 id（空间管家；根下、无部门；spec §8）。 */
export const STAFF0_ID = "staff0";

/** Staff0 定义：spec §4 统一字段（员工层）。权限 = 空间根（§8）——「空间级附属 = 老板地盘」的有意例外。 */
export type Staff0Config = {
  alias: string;
  prompt: string;
  permissions: { write: string[]; read: string[]; bash: string[] };
};

/** 内置的管家 prompt（可被老板改写；不在框架更新时自动覆盖）。 */
const STAFF0_PROMPT =
  "你是本办公空间的 0 号员工（首席管家）。你对空间根（整个办公空间）有写权限，负责空间级事务；协作、产物与记忆的通用约定见空间总纲。";

export function staff0File(ws: Workspace): string {
  return path.join(agentsDir(ws), `${STAFF0_ID}.agent.config.json`);
}

/**
 * Staff0 的初始定义（无 `model` → 运行时用全局默认模型兜底）。
 * 权限路径相对**配置文件所在目录**（`agents/`）解析 → 空间根 = `..`（裁定 R-P4-1；不用绝对路径，保持配置可整包迁移）。
 */
export function staff0Config(): Staff0Config {
  return {
    alias: "首席管家",
    prompt: STAFF0_PROMPT,
    permissions: { write: [".."], read: [".."], bash: [".."] },
  };
}

/**
 * 首次启动探测（spec §8）：`agents/staff0.agent.config.json` 不存在则自动创建。
 * 幂等——已存在一律不覆盖（老板可能改过）。
 */
export function ensureStaff0(ws: Workspace): "created" | "exists" {
  const file = staff0File(ws);
  if (fs.existsSync(file)) return "exists";
  fs.mkdirSync(agentsDir(ws), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(staff0Config(), null, 2)}\n`);
  return "created";
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/domain/staff0.test.ts && npm run typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/domain/staff0.ts tests/domain/staff0.test.ts
git commit -m "feat(staff0): 新增 0 号员工定义与首次启动自动创建"
```

---

## Task 3: 新建空间物化 `space.config.json`（D32）

**Files:**
- Create: `src/prompts/space.md`
- Create: `src/domain/space.ts`
- Test: `tests/domain/space.test.ts`

**Interfaces:**
- Consumes: `spaceDir(ws)`（`src/domain/paths.ts`）、`type Workspace`
- Produces:
  - `export const SPACE_PROMPT_TEMPLATE: string`（指向 `src/prompts/space.md` 的绝对路径）
  - `spaceConfigFile(ws: Workspace): string` → `<root>/openstaffs/space.config.json`（**re-export** P3 `src/config/naming.ts` 的同名实现，本模块**不重复定义**）
  - `builtinSpacePrompt(): string`（读内置 prompt 并 trim；缺失 → `""`，不抛）
  - `newSpaceConfig(): { prompt: string }`
  - `ensureSpaceConfig(ws: Workspace): "created" | "exists"`

- [ ] **Step 1: 创建内置空间 prompt 文件**

```md
<!-- src/prompts/space.md -->
你是本办公空间的一员。你的岗位、记忆与技能都在你自己的定义文件与工作目录里；按需读取技能、在自己的权限范围内工作。

- **负责人最高**：办公空间的负责人（老板）拥有最高权威；称谓以环境段与界面为准。需要资源或权限时先申请，不要绕过权限闸门。
- **协作走消息**：需要同事配合时，用 `send_message` 在群聊里 @ 对方，或私聊老板；非必要不要主动 @ 别人。
- **产物落文件**：大块内容写进工作目录的 `data/`，聊天里只发一句话结论与文件路径。
- **记忆**：需要长期记住的经验 / 事实，写进自己的记忆文件。
```

- [ ] **Step 2: 写失败测试**

```ts
// tests/domain/space.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createWorkspace, type Workspace } from "../../src/domain/paths.ts";
import { builtinSpacePrompt, ensureSpaceConfig, newSpaceConfig, spaceConfigFile } from "../../src/domain/space.ts";
// 说明（跨计划裁定 N2）：`spaceConfigFile` 由 `src/domain/space.ts` re-export 自 P3 的 `src/config/naming.ts`，
// 本测试引用的是**同一实现**（re-export），不存在第二份定义。

let root: string;
let ws: Workspace;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "os-space-"));
  ws = createWorkspace(root);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test("内置空间 prompt 非空（框架自带的系统级 prompt）", () => {
  expect(builtinSpacePrompt().trim().length).toBeGreaterThan(0);
  expect(newSpaceConfig().prompt).toBe(builtinSpacePrompt());
});

test("spaceConfigFile：落点 openstaffs/space.config.json（可见、可版本化）", () => {
  expect(spaceConfigFile(ws)).toBe(path.join(root, "openstaffs", "space.config.json"));
});

test("ensureSpaceConfig：缺失则物化内置 prompt；已存在不覆盖（含空文件 / 坏 JSON）", () => {
  expect(ensureSpaceConfig(ws)).toBe("created");
  const file = spaceConfigFile(ws);
  expect(JSON.parse(fs.readFileSync(file, "utf8")).prompt).toBe(builtinSpacePrompt());

  fs.writeFileSync(file, JSON.stringify({ prompt: "老板改过的总纲" }));
  expect(ensureSpaceConfig(ws)).toBe("exists");
  expect(JSON.parse(fs.readFileSync(file, "utf8")).prompt).toBe("老板改过的总纲");

  fs.writeFileSync(file, "");
  expect(ensureSpaceConfig(ws)).toBe("exists");
  expect(fs.readFileSync(file, "utf8")).toBe("");
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run tests/domain/space.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 4: 实现 `src/domain/space.ts`**

```ts
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spaceDir, type Workspace } from "./paths.ts";

// 空间声明文件的路径口径由 P3 的 src/config/naming.ts 唯一定义（P3 Task 1，按序在前）；
// 本模块只 re-export，绝不重复实现（跨计划裁定 N2）。
export { spaceConfigFile } from "../config/naming.ts";

/** 框架内置的空间 prompt（系统作用域；本文件在 src/domain → src/prompts/space.md）。 */
export const SPACE_PROMPT_TEMPLATE = fileURLToPath(new URL("../prompts/space.md", import.meta.url));

/** 读内置空间 prompt；缺失 → 空串（不崩）。 */
export function builtinSpacePrompt(): string {
  try {
    return fs.readFileSync(SPACE_PROMPT_TEMPLATE, "utf8").trim();
  } catch {
    return "";
  }
}

/** 新建空间的初始声明：把内置 prompt 物化进来（D32）。 */
export function newSpaceConfig(): { prompt: string } {
  return { prompt: builtinSpacePrompt() };
}

/**
 * 首次启动探测（D32）：`space.config.json` 不存在 → 物化内置 prompt（此后运行时无关）。
 * 幂等——已存在一律不覆盖（含老板手改内容、空文件、坏 JSON）。
 */
export function ensureSpaceConfig(ws: Workspace): "created" | "exists" {
  const file = spaceConfigFile(ws);
  if (fs.existsSync(file)) return "exists";
  fs.mkdirSync(spaceDir(ws), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(newSpaceConfig(), null, 2)}\n`);
  return "created";
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/domain/space.test.ts && npm run typecheck`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/prompts/space.md src/domain/space.ts tests/domain/space.test.ts
git commit -m "feat(space): 新建空间物化 space.config.json（内置 prompt，D32）"
```

---

## Task 4: 启动装配 —— `ensureSpace` 与 main 接线（启动探测）

**Files:**
- Create: `src/server/bootstrap.ts`
- Modify: `src/server/main.ts`
- Test: `tests/server/bootstrap.test.ts`

**Interfaces:**
- Consumes: `ensureSpaceConfig`（Task 3）、`ensureStaff0`（Task 2）、`spaceConfigFile` / `staff0File`、`type Workspace`
- Produces:
  - `export type EnsureStatus = "created" | "exists" | "failed"`
  - `export type BootstrapResult = { newSpace: boolean; spaceConfig: EnsureStatus; staff0: EnsureStatus }`
  - `ensureSpace(ws: Workspace): BootstrapResult`（**不抛**：单项失败记 `"failed"` 并继续）

- [ ] **Step 1: 写失败测试**

```ts
// tests/server/bootstrap.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { spaceConfigFile } from "../../src/domain/space.ts";
import { staff0File, staff0Config } from "../../src/domain/staff0.ts";
import { ensureSpace } from "../../src/server/bootstrap.ts";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "os-boot-")); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test("首次启动：新建空间物化 space.config.json + 自动建 Staff0", () => {
  const ws = createWorkspace(root);
  const result = ensureSpace(ws);
  expect(result).toEqual({ newSpace: true, spaceConfig: "created", staff0: "created" });
  expect(JSON.parse(fs.readFileSync(spaceConfigFile(ws), "utf8")).prompt.length).toBeGreaterThan(0);
  expect(JSON.parse(fs.readFileSync(staff0File(ws), "utf8"))).toEqual(staff0Config());
});

test("再次启动：幂等，不覆盖老板内容", () => {
  const ws = createWorkspace(root);
  ensureSpace(ws);
  fs.writeFileSync(spaceConfigFile(ws), JSON.stringify({ prompt: "老板改过" }));
  const result = ensureSpace(ws);
  expect(result).toEqual({ newSpace: false, spaceConfig: "exists", staff0: "exists" });
  expect(JSON.parse(fs.readFileSync(spaceConfigFile(ws), "utf8")).prompt).toBe("老板改过");
});

test("空间目录不可写（root 其实是文件）→ 不抛，逐项记 failed", () => {
  const rootFile = path.join(root, "not-a-dir");
  fs.writeFileSync(rootFile, "x");
  const ws = createWorkspace(rootFile);
  expect(() => ensureSpace(ws)).not.toThrow();
  const result = ensureSpace(ws);
  expect(result.spaceConfig).toBe("failed");
  expect(result.staff0).toBe("failed");
  expect(result.newSpace).toBe(false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/server/bootstrap.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 `src/server/bootstrap.ts`**

```ts
import type { Workspace } from "../domain/paths.ts";
import { ensureSpaceConfig } from "../domain/space.ts";
import { ensureStaff0 } from "../domain/staff0.ts";

export type EnsureStatus = "created" | "exists" | "failed";

export type BootstrapResult = {
  /** 本次是否新建了空间（以 space.config.json 的物化为准，D32）。 */
  newSpace: boolean;
  spaceConfig: EnsureStatus;
  staff0: EnsureStatus;
};

/** 逐项兜错：单项失败（只读目录等）记 failed，不打断启动。 */
function attempt(run: () => "created" | "exists"): EnsureStatus {
  try {
    return run();
  } catch {
    return "failed";
  }
}

/**
 * 启动探测（P4）：新建空间物化 `space.config.json`（D32）+ 首次启动自动建 Staff0（§8）。
 * 幂等、不覆盖、不抛（失败项记 `"failed"`）。
 */
export function ensureSpace(ws: Workspace): BootstrapResult {
  const spaceConfig = attempt(() => ensureSpaceConfig(ws));
  const staff0 = attempt(() => ensureStaff0(ws));
  return { newSpace: spaceConfig === "created", spaceConfig, staff0 };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/server/bootstrap.test.ts`
Expected: PASS（3 passed）。

- [ ] **Step 5: 接线进 `src/server/main.ts`**

在 `const ws = createWorkspace(root);` 之后、`const getConfig = ...` 之前插入：

```ts
  const bootstrap = ensureSpace(ws);
  if (bootstrap.newSpace) console.log(`[openstaffs] 新建空间：已生成 ${spaceConfigFile(ws)}`);
  if (bootstrap.staff0 === "created") console.log(`[openstaffs] 已创建 0 号员工：${staff0File(ws)}`);
  if (bootstrap.spaceConfig === "failed" || bootstrap.staff0 === "failed") {
    console.error("[openstaffs] 空间初始化未完成（空间目录可能不可写）：请检查目录权限后重启");
  }
```

补 import：

```ts
import { ensureSpace } from "./bootstrap.ts";
import { spaceConfigFile } from "../domain/space.ts";
import { staff0File } from "../domain/staff0.ts";
```

- [ ] **Step 6: 跑测试与类型检查确认通过**

Run: `npx vitest run tests/server/bootstrap.test.ts tests/domain/space.test.ts tests/domain/staff0.test.ts && npm run typecheck`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add src/server/bootstrap.ts src/server/main.ts tests/server/bootstrap.test.ts
git commit -m "feat(server): 启动装配 ensureSpace——新建空间探测 + 首次启动自动建 Staff0"
```

---

## Task 5: 引导页与报错文案改指 `openstaffs/.data/`

**Files:**
- Modify: `web/render.ts`（`setupPage`）
- Modify: `src/server/http.ts`（409 文案）
- Modify: `src/server/main.ts`（未配置 / 端口报错文案）
- Modify: `src/domain/mcp.ts`（缺凭据文案）
- Modify: `src/domain/permission-requests.ts`（注释）
- Modify: `src/tools/registry.ts`（`room_history` 的注释里提到 `.openstaffs`，P3 遗留；改口径）
- Test: `tests/web/render.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: 用户可见文案与新落点一致（无代码接口）

- [ ] **Step 1: 写失败测试**

在 `tests/web/render.test.ts` 的 `describe("渲染", …)` 内追加：

```ts
  it("引导页指向 openstaffs/.data/config.json（不再是 .openstaffs）", () => {
    const html = setupPage("/office", 4319);
    expect(html).toContain("/office/openstaffs/.data/config.json");
    expect(html).toContain("openstaffs/space.config.json");
    expect(html).toContain("agents/staff0.agent.config.json");
    expect(html).not.toContain(".openstaffs");
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/web/render.test.ts -t "引导页"`
Expected: FAIL —— 引导页仍写 `.openstaffs/config.json`。

- [ ] **Step 3: 改 `web/render.ts` 的 `setupPage`（**最小改动**，只动两处；其余段落保持原样）**

现有 `setupPage` 里改这两行：

```ts
      <p>请创建/编辑下面这个文件（若目录不存在请先创建 <code>openstaffs/.data/</code>），填入供应商密钥与默认模型（可配多个供应商）：</p>
      <pre>${escapeHtml(root)}/openstaffs/.data/config.json</pre>
```

并把结尾的提示段（原 `<p class="hint">员工与项目不需要在这里配置：…</p>`）替换为：

```ts
      <p class="hint">首次启动已自动初始化空间：<code>openstaffs/space.config.json</code>（空间总纲）与 <code>agents/staff0.agent.config.json</code>（0 号员工）。员工与项目不需要在这里配置（详见 README.md）。</p>
```

> **不要**改「可选 provider … 员工可在自己的 `agents/&lt;部门…&gt;/&lt;名字&gt;.agent.config.json` 里用 `model` 覆盖…」那一长段——`tests/web/render.test.ts:36` 依赖它里面的 `agents/&lt;部门…&gt;/&lt;名字&gt;.agent.config.json` 断言（保留可减少无谓改动）。

- [ ] **Step 4: 改用户可见文案（逐处精确替换）**

`src/server/http.ts`：

```ts
            json(res, 409, { error: "尚未配置：请编辑 openstaffs/.data/config.json 后重启服务" });
```

`src/server/main.ts`（两处；import 补 `configFile`：`import { DEFAULT_PORT, configFile, readConfig } from "../domain/config.ts";`）：

```ts
    console.log(`[openstaffs] 未配置：请编辑 ${configFile(ws)} 后重启服务`);
```

```ts
    console.error(`[openstaffs] 无法监听端口 ${port}：${error.message}（可在 openstaffs/.data/config.json 修改 port）`);
```

`src/domain/mcp.ts`：

```ts
    errors.push(`缺少凭据：\${config.mcp.${missing}}（请在 openstaffs/.data/config.json 的 mcp.${missing} 配置）`);
```

`src/domain/permission-requests.ts`（注释）：

```ts
/** 一条待处理的授权申请（落盘于 openstaffs/.data/permission-requests.json）。 */
```

`src/tools/registry.ts`（`room_history` 的注释，P3 遗留的 `.openstaffs`）：

```ts
    // `openstaffs/.data` 从未创建时也要能读：openMessageStore 现在自建父目录（此处 mkdir 幂等保留）、
```

- [ ] **Step 5: 跑测试确认通过 + 残留检查**

Run: `npx vitest run tests/web/render.test.ts && npm run typecheck`
Expected: PASS。

```bash
grep -rn '\.openstaffs' src web || echo "OK: 生产代码无 .openstaffs 残留"
```

Expected: **无输出**（仅 `README.md` / `AGENTS.md` / `src/skills/*.md` 允许残留，由 Task 6 处理）。

- [ ] **Step 6: 提交**

```bash
git add web/render.ts src/server/http.ts src/server/main.ts src/domain/mcp.ts src/domain/permission-requests.ts src/tools/registry.ts tests/web/render.test.ts
git commit -m "refactor(ui): 引导页与报错文案改指 openstaffs/.data/"
```

---

## Task 6: 文档同步 + 全量回归

**Files:**
- Modify: `src/skills/openstaffs-ops/SKILL.md`（**运维真相源，必改**）
- Modify: `src/skills/openstaffs/SKILL.md`
- Modify: `README.md`
- Modify: `docs/产品规划.md`
- Modify: `AGENTS.md`（仓库约定）

**Interfaces:**
- Consumes: Task 1–5 的路径与文案
- Produces: 无代码接口（口径同步）

- [ ] **Step 1: `src/skills/openstaffs-ops/SKILL.md`——目录树与全景**

> **P3 落地后的事实**：该文件的「办公空间全景」已经按 P3 形态写全（含 `agents/` 部门树、`projects/<项目 id>.project.config.json`、`work/<名字>/`、`openstaffs/{space.config.json,skills,mcps.json}`，以及 `.openstaffs/` 一节）。**不要再套用旧的「两行片段」**；只做两步：把机器私有目录并入 `openstaffs/.data/`，并补 Staff0。

(a) 在 `agents/` 目录树块里补一行 staff0（在 `│  ├─ <名字>.agent.config.json   # 人（根部门直属…）` 一带补）：

```
│  ├─ staff0.agent.config.json   # 0 号员工「首席管家」（首次启动自动创建；权限 = 空间根）
```

(b) 把结尾的 `openstaffs/` 与 `.openstaffs/` 两节改为合并形态：

```
├─ openstaffs/                   # 空间附属 + 机器私有（可见的部分可版本化、随空间整包迁移）
│  ├─ space.config.json          # 空间声明（prompt / skills / mcp / permissions；新建空间时物化）
│  ├─ skills/<技能名>/SKILL.md   # 共享技能库（各层 config 按名引用）
│  ├─ mcps.json                  # MCP 全局定义（各层 config 按名引用）
│  └─ .data/                     # 机器私有（gitignore；老板维护，你只读）
│     ├─ config.json             # 全局配置：providers / model / thinkingLevel / port / bossName / skillPaths / mcp
│     ├─ chains/group-<项目>/<人>.md # 群会话链（机器维护）
│     ├─ state.json              # 老板的 pin 标记（机器维护，不要手改）
│     ├─ permission-requests.json # 待处理授权请求（机器维护，处理完即删）
│     ├─ messages.sqlite         # 消息真相库：房间消息流水（机器维护，不要手改）
│     └─ state.sqlite            # 基座会话库：某条会话的原文与模型上下文（机器维护，不要手改）
```

(c) 删除下方引注里「机器私有的 `.openstaffs/` 计划并入 `openstaffs/.data/`…**P4 落地后**才改落点——**现状仍按上面的 `.openstaffs/` 读**」那段（已落地），保留「根下只有门面 `agents/`、`projects/`、`work/`、`openstaffs/` 四项」与 `AGENTS.md` / `profile.md` 已退出运行时的说明。

- [ ] **Step 2: 同文件——全文路径口径替换**

```bash
# 目录树已在 Step 1 手动并好；剩余正文 / 表格里的 `.openstaffs` 词元统一替换为 `openstaffs/.data`
grep -rl '\.openstaffs' src/skills/openstaffs-ops/SKILL.md | xargs sed -i '' 's#\.openstaffs#openstaffs/.data#g'
grep -n '\.openstaffs' src/skills/openstaffs-ops/SKILL.md || echo "OK: 运维手册无 .openstaffs 残留"
```

Expected: `OK`。若仍有残留，逐条手改（尤其是「全局配置」小节标题与「常见故障对照」表）。
> 说明：`s#\.openstaffs#openstaffs/.data#g` 不会误伤已经正确的 `openstaffs/.data`（后者不含 `.openstaffs` 子串）。

- [ ] **Step 3: 同文件——补 Staff0 与空间声明**

在「级别定义」之后新增一节：

```md
## 空间初始化与 0 号员工

- **目录已合并**：机器私有不再是独立隐藏目录，统一收在 `openstaffs/.data/`（含全局配置、pin 状态、授权请求、基座会话库、消息自有库）。`openstaffs/` 的其余内容（`space.config.json`、`skills/`、`mcps.json`）属空间资产，可版本化、随空间整包迁移。
- **新建空间**：启动时若没有 `openstaffs/space.config.json`，框架会把**内置空间 prompt** 物化进去（此后运行时无关，可自由改写）。判断只看文件是否存在——已存在（含空文件 / 坏 JSON）一律不覆盖。
- **0 号员工（首席管家）**：首次启动若没有 `agents/staff0.agent.config.json`，框架自动创建。它对**空间根（整个办公空间）有写权限**（「空间级附属 = 老板地盘」的有意例外；配置里写作相对路径 `..`——P3 的权限路径相对配置文件所在目录 `agents/` 解析），直属老板；未配 `model` 时用全局默认。
- **不做迁移**：从旧目录 `.openstaffs/` 不再读取（破坏性更新）；老板需要的话自行搬迁数据。
```

- [ ] **Step 4: `src/skills/openstaffs/SKILL.md`——凭据路径与 Staff0**

把该文件里 `.openstaffs/config.json`（P3 落地后约在第 91 行）改为 `openstaffs/.data/config.json`（该行已按 P3 写作 `mcps.json`，**只改路径**）：

```md
- **不要把密钥写进 `mcps.json`**：凭据统一由老板放进 `openstaffs/.data/config.json`，你写 `${config.mcp.<server>.<key>}` 引用；缺凭据时找老板补。密钥尽量放 `env`，写进 `args` 会出现在 `ps` 里。
```

并在「@ 他人的节制」段落之后补一句（Staff0 属空间级事务）：

```md
- **0 号员工（首席管家）**：空间里有一个管家（id `staff0`），写权限覆盖空间根（整个办公空间），负责空间级事务；需要整体性调整（跨部门、空间级配置）时可找它。
```

- [ ] **Step 5: `README.md`——路径与初始化说明**

```bash
grep -rl '\.openstaffs' README.md | xargs sed -i '' 's#\.openstaffs#openstaffs/.data#g'
grep -n '\.openstaffs' README.md || echo "OK: README 无 .openstaffs 残留"
```

再手改「四层命名」注与「快速开始」第 2、3 步（`openstaffs/` 放**空间声明与技能 / MCP**；机器私有是 `openstaffs/.data/`），并把第 3 步改为：

```md
3. （可选）在办公空间目录里创建 `openstaffs/.data/config.json`（见下节；也可以先跳过——首次启动会自动初始化空间，页面会显示引导页）。
```

- [ ] **Step 6: `docs/产品规划.md`——命名与落点表**

> P3 落地后，空间落点行**已正确**（`openstaffs/space.config.json` / `skills/` / `mcps.json`）。本步只需把「两分说明」那条里的 `.openstaffs/` 改为 `openstaffs/.data/`：

```md
- 空间附属统一收在 `openstaffs/`（`space.config.json`、`skills/`、`mcps.json`；可版本化、随空间整包迁移）；机器私有（密钥配置与运行状态）收在其下的 `openstaffs/.data/`。
```

- [ ] **Step 7: `AGENTS.md`（仓库约定）第 6 行**

```md
- 办公数据（`agents/`、`projects/`、`openstaffs/`，含机器私有的 `openstaffs/.data/`）在用户另行指定的**办公空间目录**里，与框架分离。
```

- [ ] **Step 8: 全量回归**

Run: `npm test && npm run typecheck`

```bash
grep -rn '\.openstaffs' src web tests README.md AGENTS.md src/skills || echo "OK: 全仓无 .openstaffs 残留"
```

Expected: 测试与类型检查全绿；`grep` 无输出（`docs/` 下的历史 spec / plan 允许保留，属历史记录）。

- [ ] **Step 9: 端到端冒烟（本地，手工）**

```bash
rm -rf /tmp/osp-p4 && mkdir -p /tmp/osp-p4
# 未配置模式启动：应打印「新建空间」与「已创建 0 号员工」，页面显示引导页（指向 openstaffs/.data/config.json）
npm start -- /tmp/osp-p4
# 另开一个终端检查落点
ls /tmp/osp-p4/openstaffs/space.config.json /tmp/osp-p4/agents/staff0.agent.config.json
cat /tmp/osp-p4/openstaffs/space.config.json
```

Expected: 两个文件都被创建；`space.config.json` 含内置 prompt；引导页显示新路径。停服后**再次启动**不得覆盖（文件 mtime 不变）。

- [ ] **Step 10: 提交**

```bash
git add src/skills/openstaffs-ops/SKILL.md src/skills/openstaffs/SKILL.md README.md docs/产品规划.md AGENTS.md
git commit -m "docs: 同步空间目录合并与 Staff0（运维/能力手册、README、产品规划、仓库约定）"
```

---

## Self-Review 记录

- **Spec 覆盖**：
  - D19 / §10 P4 行「`.openstaffs/` → `openstaffs/.data/`；路径解析」→ Task 1（`stateDir` + `main.ts` sqlitePath + 全量夹具回归）。
  - 「`.gitignore`」→ Task 1 Step 10/11（只忽略 `openstaffs/.data/`，空间资产仍纳入版本管理）。
  - D24 / §8「首次启动自动建 Staff0；权限 = 写空间根 `./`；直属老板；无 model 用全局默认」→ Task 2（定义与幂等创建）+ Task 4（启动接线）。
  - D32「新建空间物化内置 prompt 进 `space.config.json`」→ Task 3 + Task 4。
  - 「启动探测、引导页」→ Task 4（`ensureSpace`）+ Task 5（引导页 / 报错文案）。
  - §12 / D34「强模块化、Pi 只在 harness」→ 新模块 `space.ts` / `staff0.ts` / `bootstrap.ts` 均为自有域，**不 import `harness`**。
  - D30「不做迁移」→ Global Constraints + Task 6 Step 3 明示不读旧 `.openstaffs/`。
  - 仓库 `AGENTS.md` 文档同步表 → Task 6（运维手册必改 + 能力手册 / README / 产品规划 / 仓库约定）。
- **接口一致**：`ensureSpaceConfig` / `ensureStaff0`（Task 2/3）→ `ensureSpace`（Task 4）；`spaceConfigFile` / `staff0File` 在 Task 3/4/5 同名同义；`EnsureStatus`（Task 4）与两个 `ensure*` 的返回类型相容（`"created" | "exists"` ⊆ `EnsureStatus`）。
- **P1 约束**：`messagesDbFile` **未改**；Task 1 Step 5 用两条断言钉住「落在 `openstaffs/.data/messages.sqlite`」且「= `path.join(stateDir(ws), "messages.sqlite")`」。
- **占位符**：无 TBD / TODO；所有代码块为可抄的完整实现。
- **刻意留到后续**：`space.md` / `STAFF0_PROMPT` 的**文案**是 P4 自定的最小内容，P3（配置渲染）/ P5（prompt 渲染）可改写；Staff0 与 `space.config.json` 的**读取**归 P3，**UI 可见性**归 P2。
- **风险**：`src/skills/openstaffs-ops/SKILL.md` 与 `README.md` 会被 P2/P3/P5 同时改写——按仓库约定「大任务本地分支 + squash 合并」，合并时按各自口径人工解决冲突；本计划只保证**路径口径**与 **Staff0 / space.config.json** 的正确。

**2026-10-19 按跨计划裁定修订（对照 `2026-10-19-p2-p5-preflight-rulings.md`）**：

- **N5**：Global Constraints 分支约定与「交付说明 · 执行前置」改为「P4 在 P3 之后续做，沿用同一本地分支 `feat/message-store`，不新开分支、不 push」。
- **N1**：Task 1 Step 1 的 import 只补 `employeeDir`（B1 保留），并加说明：`membersFile` / `projectDir` 已随 P3 扁平化退场，**不加入** import。
- **N2**：Task 3 删除 `src/domain/space.ts` 内 `spaceConfigFile` 的重复实现，改为 `export { spaceConfigFile } from "../config/naming.ts"`（re-export P3 Task 1 定义）；Interfaces 与 `space.test.ts` 同步注明引用**同一实现**。
- **P1 事实对齐**：跨阶段假设表的 P1 行确认 `messagesDbFile(ws) = path.join(stateDir(ws), "messages.sqlite")` 无误、保留迁移双断言，并补「库实例由 `main.ts` 唯一化注入，`ensureSpace` 不碰库、不另开实例」。

**2026-10-19 P4 执行前对齐（对照 P3 实际落地 + 本次控制者裁定）**：

- **分支（修订 N5 的字面写法）**：`feat/message-store`（P1 用）与 `feat/unified-config`（P3 用）**均已 squash 合回 master 并删除**，不存在；P4 **新建本地分支 `feat/space-dir-merge`**（自 P3 合并后的 `master`），完成后 squash 回 master 并删分支、不 push。见裁定 **R-P4-0**。
- **Task 1 Step 3**：`paths.ts` 已被 P2/P3 扩写（含 `workDir` / `messagesDbFile` / `groupConversationIdsFile` 等）；改为**最小改动**（只加 `STATE_DIR_NAME`、只换 `stateDir` 函数体一行），不重写整个文件。
- **Task 1 Step 1 / Step 5 / Step 7 / Step 8**：`paths.test.ts` 的现有 import 补齐到真实集合；`messagesDbFile` 断言标记为必做（P1 已合入）；`main.ts` 的 `stateDir` import 已在位（只改 `sqlitePath`）；测试夹具清扫改为统一的词元替换 `s#\.openstaffs#openstaffs/.data#g`（覆盖各变量名、模板串、注释与用例标题），并把命中清单更新为 P3 后的 18 个测试文件。
- **Task 2（裁定 R-P4-1）**：P3 的 `permissions` 路径**相对配置文件所在目录**解析（`resolvePermissionTable(table, baseDir)`，员工配置 `baseDir = speaker.dir`）→ staff0 的 `./` 会解析成 `agents/`，**不是** spec §8 要求的「空间根（整个空间）」。故 staff0 的权限改为相对路径 **`..`**（`{ write: [".."], read: [".."], bash: [".."] }`），并补一条「解析后 = 空间根」的断言；不用绝对路径（保持配置可整包迁移）。
- **Task 5**：补 `src/tools/registry.ts`（P3 遗留的 `.openstaffs` 注释）为改动目标。
- **Task 6 Step 1/2/6**：`openstaffs-ops/SKILL.md` 的目录树已是 P3 形态（含 `mcps.json`、`chains/`、`messages.sqlite`）——改为「并入 `openstaffs/.data/` + 补 Staff0 + 删『P4 落地后』引注」；口径替换同样用词元替换；`docs/产品规划.md` 只改「两分说明」一条。

---

## 交付说明（写给执行者）

- 本计划只交付**一个文件**：`docs/superpowers/plans/2026-10-19-space-dir-merge.md`；不含代码改动。
- **执行前置**：P1/P2/P3 已完成（按 spec §10 顺序，P4 在 P3 之后续做）；**新建本地开发分支 `feat/space-dir-merge`**（自 P3 合并后的 `master`），不 push 远程；完成后 `merge --squash` 回 `master` 并删除该分支。
- **执行顺序**：Task 1 → 2 → 3 → 4 → 5 → 6（严格串行；Task 2/3 独立但都在 Task 4 之前）。
- **验收**：每任务独立跑测试、独立提交；Task 6 收尾做全量回归与端到端冒烟。
- **Spec 歧义（执行时留意）**：
  1. spec 未写明**内置空间 prompt 的具体文案**，也未指明它是否等于「系统作用域 prompt」——本计划新增 `src/prompts/space.md` 作为物化源，内容最小化；若 P3/P5 另定，以它们为准。
  2. P4 行里的「`.gitignore`」只点名框架仓库这一份；**空间目录自己的 `.gitignore` 不会由框架自动生成**——本计划按「框架仓库 `.gitignore` + 文档口径」落地并经 `git check-ignore` 验证，未引入空间 `.gitignore` 生成器。若产品要求自动生成，属新增需求。
  3. Staff0 的 `prompt` 与 `alias`（「首席管家」）spec 未给值，本计划自定最小文案；字段名严格按 §4，未新增字段（特别是不写 `model`，以触发「无 model 用全局默认」）。
  4. `stateDir` 名称保留（语义已变为 `openstaffs/.data`），以免大范围改名；未来可平滑重命名为 `dataDir`。
