# OpenStaffs 写权限（permission.json）设计

> 状态：待评审 · 日期：2026-10-16 · 关联：`2026-10-16-openstaffs-architecture-design.md`（本文件修订其 §6.2 的 ACL 档位与 §4.2 的 cwd 语义）
> 预置：核心引擎已实现（已并入 master）；本设计只改 ACL 的"写"判定

---

## 1. 背景与目标

核心引擎当前把写权限**写死在代码**里（`src/domain/access-control.ts` 的 `isWriteAllowed`）：只允许写 `agents/<自己>/` 与自己在 `members.md` 里的 `projects/<任务>/`；且对以 `agents/`/`projects/` 开头的相对路径做了"按工作区根解析"的硬化。

本设计把写权限从代码提升为**文件夹里的显式授权**：每个 cwd 下一个 `permission.json`，由老板手工维护；判定时在基线之上**做加法**。目标：

1. 授权落盘、可读可编辑（符合铁律"状态真相源在文件夹"）；
2. 授权粒度到文件/目录，支持子目录、`../`、绝对路径；
3. **只加不减**、无 deny 方向——认定规则的扩展，不引入"禁止"语义的复杂度；
4. 不崩溃：缺文件/坏文件一律安全降级（退回基线）。

**非目标（本设计不覆盖）：** 读权限拦截（读保持不拦）、**`bash` 的越界防护**（`bash` 全开，可绕写 ACL，硬档到第 3 期容器）、硬档隔离/容器（architecture spec §6.3，第 3 期）、符号链接防护（软边界，architecture spec §6.2 已承认）。

---

## 2. 决策记录

| # | 决策 | 说明 |
|---|---|---|
| D1 | **群聊会话模型不变** | 一条"房间"conversation，按发言人轮换 agent（architecture spec §4.3）。不改日志/UI 模型。 |
| D2 | **`permission.json` 仅管"写"** | 读不拦（维持现状）。 |
| D3 | **只加不减（无 deny）** | 基线永远生效；`permission.json` 只在其上补充允许区域。 |
| D4 | **内容是 JSON 数组，元素为路径字符串** | **不引入正则**。元素是相对（相对该文件所在目录）或绝对路径。 |
| D5 | **目录条目含其全部下级** | `./dir/`（或 `dir`）表示 `dir` 及其下所有内容都允许。 |
| D6 | **不限定工作区根** | `permission.json` 可授权到工作区根之外的绝对位置；该文件视为老板手写的可信授权。 |
| D7 | **相对目标 path 按会话 cwd 解析** | 与工具真实落点一致。**移除**旧的 `agents/`/`projects/` 前缀硬化。 |
| D8 | **`bash` 全开** | 移除钩子里的 bash 拦截；接受 bash 可绕过写 ACL（MVP 软边界，硬档到第 3 期容器）。 |
| D9 | **写任何 `permission.json` 一律拒绝** | 该文件由老板维护；防止员工经 `write`/`edit` 自写授权文件**持久提权**（`bash` 越界属已接受的软边界，另论）。 |

---

## 3. 文件位置与内容

每个 cwd 下一个 `permission.json`：

- 员工目录：`agents/<员工 id>/permission.json`
- 项目目录：`projects/<任务名>/permission.json`

内容 = JSON 数组，元素为**路径字符串**（无正则）：

```json
["./data/reports/", "../shared/", "/Users/laidezhong/Shared/office/"]
```

- 相对条目：相对**该 `permission.json` 所在目录**解析（支持 `../`）。
- 绝对条目：原样使用。
- 不是数组 / 非法 JSON / 含非字符串元素 → 整份忽略（见 §6）。

> cwd 与 `permission.json` 的关系：私聊 cwd = `agents/<自己>/`，其下的 `permission.json` 即该员工的授权；群聊 cwd = `projects/<任务>/`，其下的 `permission.json` 即该项目的授权。

---

## 4. 匹配规则（先归一为绝对路径，再判"相等或在其下"）

对一次写操作的目标路径 `path`（来自工具的路径参数）：

1. **目标归一**：`path` 为相对 → 按**会话 cwd** 解析；得绝对路径并规范化，记 `target`。
2. **条目归一**：对每个条目 `entry`——
   - 绝对条目 → 直接绝对化；
   - 相对条目 → `path.resolve(permissionDir, entry)` 消解 `../` 得绝对路径（`permissionDir` = 该 `permission.json` 所在目录）；
   - 规范化后记 `base`。
3. **判定（目录含其下级）**：`target === base`，**或** `target` 在 `base` 之下（即以 `base + 路径分隔符` 为前缀），即该条目命中。
4. **放行**：`target` 命中任一有效 `permission.json` 的任一条目即放行。

> 注：`path.resolve` 只做路径归一（`.`/`..`/分隔符），不访问文件系统。`./dir/`、`dir`、`dir/` 三者等价（都表示 `dir` 及其下级）。大小写敏感（字符串比较）。

---

## 5. 有效写权限 = 基线 ∪ agent 文件 ∪ 项目文件

**基线（永远生效，与文件是否存在无关）：**

- `<root>/agents/<自己>/**`
- 自己所属项目的 `<root>/projects/<任务>/**`（"所属"由 `members.md` 决定）

**私聊**（cwd = `agents/<自己>/`）：
`基线` ＋ `agents/<自己>/permission.json`

**群聊**（cwd = `projects/<任务>/`）：
`基线` ＋ `projects/<任务>/permission.json` ＋ `agents/<自己>/permission.json`

判定 = 命中上述任一集合即放行。

---

## 6. 错误与边界（一律不崩溃）

- `permission.json` 缺失 / 非法 JSON / 非数组 / 含非字符串元素 → **跳过该文件**（不影响基线，天然从严）。
- 空串/纯空白条目 → 跳过。
- 目标 `path` 为空串 → 拒绝。
- 基线永远生效；即使所有 `permission.json` 都缺失/损坏，基线仍可写自己 + 成员项目。
- 读：不拦。`bash`：全开（可绕写 ACL，MVP 软边界）。
- 写**任何** `permission.json` → 拒绝（老板维护；防自写提权）。
- 符号链接：不处理（软边界）。

---

## 7. 实现落点

**新增 `src/domain/permissions.ts`**（纯域层，不 import 基座）：

- `readPermissionPaths(file: string): string[]` — 读文件、JSON 解析、校验为非空字符串数组；任何失败返回 `[]`。
- `matchesPermission(paths: string[], permissionDir: string, targetAbs: string): boolean` — 见 §4 的归一 + "相等或在其下"判定。
- `isWriteAllowedByPermission(files: string[], targetAbs: string): boolean` — 任一文件命中即 true。

**修改 `src/domain/access-control.ts`**：

- `AccessContext` 增加 `permissionFiles: string[]`（移除前缀硬化逻辑）。
- `isWriteAllowed(ctx, targetPath)` 重写为：目标按 `ctx.cwd` 解析为绝对 → 若 basename 为 `permission.json` 直接拒绝 → ① 基线（`<root>/agents/<self>/**`、成员项目 `<root>/projects/<task>/**`）② 任一 `ctx.permissionFiles` 命中 → 放行；否则拒绝。

**`src/harness/access-extension.ts`**：**移除对 `bash` 的拦截**（`bash` 全开）；`write`/`edit` 仍走 `isWriteAllowed`。

**`src/app/conversations.ts` 的 `specFor`**：计算 `permissionFiles`——
- 私聊：`[<agents/自己>/permission.json]`
- 群聊：`[<projects/任务>/permission.json, <agents/自己>/permission.json]`

---

## 8. 测试

- 新增 `tests/domain/permissions.test.ts`：数组解析；非法 JSON / 非数组 / 非字符串元素 → `[]`；相对条目、绝对条目、`../` 归一；目录条目含其下级（`./dir/` 命中 `dir/a/b`）；相等命中（文件条目）；边界外不命中；大小写敏感；空条目跳过。
- 改 `tests/domain/access-control.test.ts`：**删除**"`agents/bob/x.md` 视为越界"的旧断言（新模型下按 cwd 落项目内 → 放行）；新增"绝对路径写别人目录 → 拒绝""`permission.json` 授权 → 放行""损坏文件 → 退回基线"。
- 改 `tests/harness/access-extension.test.ts`：恶意写改用**绝对路径**指向 bob 目录（真正的越界）→ 断言被拦；再验证经 `permission.json` 授权后可写；**移除**任何"bash 被拦"的预期。
- 补一条 `bash` 放行的测试：模型发起 `bash` 调用（如 `echo`）→ 断言命令执行、未被拦。
- 改 `tests/app/conversations.test.ts`：断言私聊/群聊算出的 `permissionFiles` 正确。

---

## 9. 与既有 spec 的关系

- 修订 architecture spec **§6.2**：写权限由"成员制 + 只写自己/成员项目"扩展为"基线 ∪ `permission.json` 加法"；**`bash` 由"MVP 默认禁用"改为"全开"**（可绕写 ACL，属软边界）。
- 澄清 architecture spec **§4.2** 的 cwd 语义：相对目标 path 一律按会话 cwd 解析（与工具落点一致），不再对 `agents/`/`projects/` 前缀做根相对特判。
- 其余（§6.1 铁律、§6.3 硬档、读不拦）不变。
