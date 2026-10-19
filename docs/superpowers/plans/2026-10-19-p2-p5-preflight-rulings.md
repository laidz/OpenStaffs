# P2–P5 执行前裁定（跨计划一致性复核结论）

> 状态：**执行 P2–P5 前必须逐条落实** · 日期：2026-10-19
> 来源：P2–P5 四份计划是在同一工作树里**并行**撰写的（彼此看不到对方），因此存在跨计划的命名/删除冲突。本文件是对这些冲突的裁定，**优先于**各计划正文里的字面写法。
> 权威顺序：spec（`2026-10-18-agent-org-hierarchy-design.md`）> 本文件 > 各阶段计划正文。
> 关联计划：`2026-10-19-org-hierarchy.md`（P2）、`2026-10-19-unified-config.md`（P3）、`2026-10-19-space-dir-merge.md`（P4）、`2026-10-19-definition-model.md`（P5）。
> **执行顺序**：P2 → P3 → P4 → P5（spec §10）；P1 已完成（`feat/message-store`，见下文「P1 已落地事实」）。

---

## 一、P1 已落地事实（P2–P5 不得与之冲突）

- `src/store/`：`openMessageStore(file)`、`MessageStore`（`append` / `listByRoom` / `close`）、`StoredMessage`、`BOSS_PARTICIPANT` / `SYSTEM_PARTICIPANT`、`roomKeyOfMessage`、`messagesDbFile(ws) = path.join(stateDir(ws), "messages.sqlite")`。
- `src/app/message-row.ts`：`stripLeadingMentions(text)`、`parseAgentReply(raw, memberIds, bossNames)`。
- **房间消息键**：`RoomMessage` 的 `convId = "store"`、`entryId = String(seq)`（`toRoomMessage(stored, bossName, ws)`）；**pin 存储键随之改口径**（旧 `convId:entryId` pin 失效，D30 允许）。`web/` 未改键机制。
- **读路径全归自有库**：`GET /rooms/<room>/messages`、`POST /pin` 校验、`GET .../pins`、`room_history` 工具；`mergeRoomMessages` **已删除**。`GET .../sessions/<convId>/messages`（某条会话原文）仍走 transcript（`roomMessagesOfTranscript`）。
- **写路径「谁写谁广播」**：老板发送（`sendToRoom` → http 层广播）、`permission-flow`、`registry.send_message`（`boss` / `member:<id>` / `project:<id>`）、`Pump` 的 assistant 分支。**pump 不再回显 user 角色条目**。
- **库实例**：生产路径唯一，由 `src/server/main.ts` 创建并注入 `Pump`（`Deps.store` 必填）与 `ServerDeps.store`（必填）；退出时 `close()`。`room_history` / `send_message` 自开实例（`openMessageStore` + `finally close()`）。
- `ToolContext` 已带 `broadcast`（`src/tools/extension.ts`，`main.ts` 注入 hub）。
- 已知遗留（P1 记录在案，非缺陷）：`openMessageStore` **不创建父目录**（调用方须先 `mkdirSync(stateDir(ws), {recursive:true})`）；`seq` 由 `MAX(seq)+1` 派生、无 UNIQUE 约束；`sessionId` 列已建未填；`vitest.config.ts` 是 `node:sqlite` 的测试解析 shim（勿删）。

---

## 二、阻断级冲突（执行前裁定）

| # | 冲突 | 涉及 | 裁定 |
|---|---|---|---|
| B1 | **`src/domain/employee.ts` 删除 vs 被依赖**：P2 Task 6 Step 4 删除 `employee.ts` 与 `paths.employeeDir`，并要求全仓 `grep loadEmployee` 为空；但 P3（自称 `loadEmployee(...).dir` 是硬依赖；Task 7 `roomExists` 用 `employeeDir`；Task 8 用 `employeeDir`）、P5（Task 1/2 用 `loadEmployee` / `employeeDir` / `renderInstructions`）都继续消费它 | P2 / P3 / P5 | **P2 保留 `src/domain/employee.ts` 作为薄适配层**（内部转 `org` 模块），收回「删除 + grep 为空」那一步；P2 只需改掉它的**实现来源**，不改调用方。后续若要彻底删，由 P5 收口并在那时统一改调用方。 |
| B2 | **`org` 模块接口名/字段名三方不一致**：P2 Task 2 实际导出 `findPerson` / `listPeople` / `loadPerson` / `ancestryOf` / `managedDirsOf` / `managedDepartmentsOf`（人带 `dir`、`departmentPath`）；P3 假设 `managedSubtreeOf(ws,id) -> {departmentDirs, agentDirs}`；P5 假设 `findAgent` / `listAgentIds` / `departmentChainDirs`（人带 `departmentDir`） | P2 / P3 / P5 | **以 P2 的实际签名为准**（执行 P2 时以代码为准并把签名记进执行日志）。P2 侧**补一个** `managedSubtreeOf(ws, id): { departmentDirs: string[]; agentDirs: string[] }` 适配器（P3 需要）；P5 把 `findAgent`/`listAgentIds`/`departmentChainDirs` 一律改名为 P2 的 `loadPerson`/`listPeople`/`ancestryOf`，字段用 P2 的 `dir` / `departmentPath`。 |
| B3 | **工作目录函数三处重复**：P2 Task 3 建 `paths.workDir(ws,id)`；P3 Task 7 又建 `employeeWorkDir(ws,id)`；P5 Task 1 再建 `workDir(ws,id)`（与 P2 重复导出） | P2 / P3 / P5 | **统一为 P2 的 `workDir(ws, id)` 单份实现**（`src/domain/paths.ts`）。P3 的 `employeeWorkDir` 与 P5 的 `workDir` 定义**删除**，改为 import。 |
| B4 | **五层 config 模块路径不一致**：P3 落在 `src/config/*`（`schema.ts` / `naming.ts` / `load.ts` / `write.ts`）；P2 的跨阶段假设与 P5 Task 4 却写 `from "../domain/config.ts"` 取 `readProjectConfig` / `readSpaceConfig` / `CapabilityConfig`（现有 `domain/config.ts` 是机器私有配置，无这些导出） | P2 / P3 / P5 | **统一为 `src/config/`**（P3 的方案）。`src/domain/config.ts` 保持机器私有配置职责（`readConfig` / `readBossName` / `bossNamesFor` 等）。P5/P2 的 import 路径改为 `src/config/*`。 |
| B5 | **`src/capabilities/scopes.ts` / `skills.ts` 被两份计划都标 Create**：P3 与 P5 的 File Structure 都新建；P3 已声明「P5 不得重写它们」 | P3 / P5 | **P3 先建，P5 复用/追加**（P5 改「复用」并只追加 P5 需要的导出，`capabilityScopesFor` 按 P3 的别名方案加）。P5 执行时先读 P3 的落地代码。 |

## 三、需注意（按序处理即可）

- **N1**：P4 Task 1 在 `tests/domain/paths.test.ts` 的 import 里补 `employeeDir, membersFile, projectDir` —— `membersFile` / `projectDir` 会随 P3 的项目扁平化**删除**，但 `employeeDir` 按 **B1 裁定保留**。**执行 P4 时只补 `employeeDir`，不要补 `membersFile` / `projectDir`**（P4 计划已按此更正）。
- **N2**：`spaceConfigFile` 两处定义 —— P3 Task 1 在 `src/config/naming.ts`；P4 Task 3 在 `src/domain/space.ts`。按序 P3 在前 → **由 P4 re-export P3 的定义**（不重复实现）。
- **N3**：P5 Task 2 从 `./permissions.ts` import `ToolPermissionMap` —— P3 已删除 `src/domain/permissions.ts`。**P5 改 import** 到 `src/config/schema.ts`（或 P3 提供的别名位置）。
- **N4**：`src/domain/project.ts` 扁平化 P3 Task 7 与 P5 Task 5 都做（P5 有「若 P3 未做」退让）→ **执行时确认只做一次**，P5 只做 P3 未覆盖的部分。
- **N5**：P4 计划分支说明写「从 master（P1 后）新开分支」，与 spec §10 的 P2→P3→P4 顺序不符，而 P4 的假设表又依赖 P2/P3 → **P4 从 P3 之后续做**，分支说明按此修正。

## 四、已核对确认无矛盾的点

- P4 对 `messagesDbFile = path.join(stateDir(ws), "messages.sqlite")` 的硬约束与 P1 一致（`stateDir` 搬迁不改拼接语义；Task 1 Step 5 有双断言）。
- P2–P5 没有任何计划调用 `mergeRoomMessages`、也没有另开库实例覆盖写入、也没有把房间条目键当成 `convId:entryId`；P2 的「房间键 `dm:<id>` / `group:<项目>`」是**会话/房间** id，与 P1 的条目键 `store:<seq>` 不冲突。
- P4 与 P5 对 `src/prompts/space.md` 的处置互相授权、一致（P4 建最小文案，P5 改写为唯一内置 prompt）。
- 员工级 `skills/` / `mcp.json`：P2 移除扫描，P3/P5 只按名解析 `openstaffs/skills` 与 `openstaffs/mcps.json`，无计划重新扫员工目录。
- `spaceConfigFile` / `builtinSpacePrompt` / `ensureSpaceConfig`：P4 定义、P5 消费，命名一致（仅 N2 的双份问题）。
- P3 的旧机制退场 grep 守卫与已合并的 P1 不冲突。

## 五、执行前建议（流程）

1. 每阶段开工前，先按本文件把该阶段的计划**改到与裁定一致**（改文档，不是改代码），再按 `superpowers:subagent-driven-development` 逐任务执行。
2. 每个阶段一个 SDD 工作区（`.superpowers/sdd/<计划文件名>/progress.md`），ledger 首行写计划路径。
3. 本文件是**已裁定**的结论：执行时若发现新的跨计划冲突，**按 spec 裁定并记进 ledger**，然后回填到本文件。
