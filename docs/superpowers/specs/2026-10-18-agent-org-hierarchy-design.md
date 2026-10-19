# OpenStaffs 组织架构与统一配置 设计

> 状态：待评审 · 日期：2026-10-18 · 版本：**v3（整合版，含 2026-10-19 讨论）** · 分支：（实现时定）
> 关联：`2026-10-16-openstaffs-architecture-design.md`（**修订** §4.1「员工扁平、组织由群聊表达」与 §非目标「独立组织架构层」）、`2026-10-16-openstaffs-permissions-design.md`（**扩展**权限判定：由"仅写"升级为"按工具"）、`2026-10-17-permission-request-design.md`（授权弹框链路）、`2026-10-17-space-layer-design.md`（**修订**空间目录两分）
> 性质：**破坏性重构**。覆盖：**① 组织架构（部门树 + 负责人）；② 项目负责人；③ 全作用域统一配置；④ 权限升级为"按工具"；⑤ 空间目录合并；⑥ 0 号员工**。

---

## 1. 背景与目标

现状（master）：

- `agents/<id>/` **扁平**；员工 = 一个自包含文件夹（`AGENTS.md` + `profile.md` + `MEMORY.md` + `config.json` + `skills/` + `mcp.json` + `permission.json`）。
- 组织关系**由群聊表达**（架构设计 §4.1 决策）；项目无负责人。
- `prompt / skills / mcp / permissions` 四类能力**各层格式各异、四套机制**（`AGENTS.md` / `skills/` 目录 / `mcp.json` / `permission.json`）。
- 权限**只管控写**（读、bash 全开，未配置化）。
- 空间有**两个近名目录**：`.openstaffs/`（机器私有）与 `openstaffs/`（老板资产）。

本设计要落**七件事**：

1. **组织架构**：文件夹 = 部门（可嵌套），`<名字>.agent.config.json` = 人；部门/项目有**可选负责人**。
2. **项目负责人（群主）**：与部门主管**完全同构**。
3. **统一配置**：四类能力收敛为**同一种格式**，五层（系统/空间/项目/组织/员工）统一，**一套解析器**沿作用域链合并；配置文件统一命名 `*.config.json`。
4. **按工具权限**：写 / 读 / bash / 未来工具，**同一套权限配置**（每工具 = 路径列表）。
5. **空间目录合并**：`.openstaffs/` 并入 `openstaffs/`（机器私有进 `openstaffs/.data/`）。
6. **0 号员工（Staff0）**：首次启动自动创建的空间管家。
7. **会话记录进自有数据库**：脱离基座（Pi）transcript，消息 / 会话归框架。

**一句话**：*文件夹是部门、文件是人；负责人可选、**从本级成员里选**；四类能力一种形状；权限按工具、配置同名同构。*

**非目标：**

- 硬档隔离 / 容器（沿用现有软边界）；
- 群内模式（`@` 前缀块、组队等）的改动。

---

## 2. 决策记录

| # | 决策 | 说明 |
|---|---|---|
| D1 | **文件夹 = 部门，文件 = 人** | 人 = `<名字>.agent.config.json`；**id = 文件名主干，全局唯一** |
| D2 | **人由单一 config 定义** | 原 `AGENTS.md`/`profile.md`/`config.json`/`mcp.json`/`permission.json` 并入；技能改**引用**；记忆移 `work/<id>/MEMORY.md` |
| D3 | **配置统一命名 `*.config.json`** | `space.config.json` / `project.config.json` / `department.config.json` / `<名字>.agent.config.json`；**内容同构** |
| D4 | **统一字段** | 各层共有 `{ alias?, avatar?, prompt?, skills?, mcp?, permissions? }`；层特有：员工 `model`、部门 `head`、项目 `owner` / `members`、空间无 |
| D5 | **`prompt` = 内联字符串** | **取消所有层级的 `AGENTS.md`**（空间/项目/部门/员工一体） |
| D6 | **负责人可选、可多** | `head`（部门）/ `owner`（项目）为**数组**、可为空；**只能从本级成员里选**；匹配不到即视为无 |
| D7 | **管理权 = 主管制 + 穿透** | 管理者 = 沿祖先链（含自身）最近的、有负责人的部门主管；全链无 → **老板**。主管管其**整棵子树**（部门 + 人，**任意深度**）。不单列"代管"（穿透自然覆盖）。 |
| D8 | **主管不能写自己的配置** | "人不可写自己"的延伸；自己的定义只能由上级主管 / 老板写 |
| D9 | **权限 = 按工具** | `permissions = { write, read, bash, … }`；每个工具的值 = **路径列表**（`["/"]` = 任意）|
| D10 | **合并 = 累加，不做覆盖** | 所有能力 / 权限一律**累加**、**接受同值重复**，**无优先级 / 覆盖逻辑** |
| D11 | **权限累加路线（落盘）** | `project.config.json` + `agent.config.json`；工作目录与主管写权走**运行时**（D13）|
| D12 | **能力累加路线** | `space` + `department`（从上到下递归）+ `project` + `agent`；`skills`/`mcp` 归全局定义、**不撞名**；`prompt` 累加（换行分割）|
| D13 | **运行时权限（非显性，不落盘）** | ① agent 自己的工作目录（所有工具）；② **主管对管理子树的写权**；均由**运行时**授予，不写进 config |
| D14 | **新建默认值** | agent：`write:[]`、`read:["./"]`、`bash:["./"]`；**新工具默认空**；新建项目同理 |
| D15 | **`permissions` 写入 = attenuation** | 写 `permissions` 时**值 ⊆ 写者自身该工具权限集（含继承）**；逐级收窄、可传递 |
| D16 | **MCP = 全局定义 + 按名引用** | 定义在 **`openstaffs/mcps.json`**；消费方按 **mcp 名**引用；取代"内联定义" |
| D17 | **`skills` = 按名引用** | 解析到 **`openstaffs/skills/<技能名>/`**；不内联技能正文 |
| D18 | **头像可选** | `avatar?` = 图片路径；缺省**前端**取**名称首字** + **名称派生色**作底色 |
| D19 | **空间目录合并** | `.openstaffs/` + `openstaffs/` → **单一 `openstaffs/`**；机器私有（全局 `config.json`、数据库、状态）进 **`openstaffs/.data/`** |
| D20 | **工作树平铺** | `work/<名字>/` 各自独立（含 `MEMORY.md`），与定义树分离 |
| D21 | **单归属** | 一个人只属于其 config 所在的部门 |
| D22 | **项目成员名单放 config** | `project.config.json.members`（不用 `members.md`）|
| D23 | **老板最高** | 全可写；`request_permission`（向老板申请）保留；**唯一例外**：Staff0 拿到空间管理权 |
| D24 | **Staff0（0 号员工）** | `agents/staff0.agent.config.json`，**首次启动自动建**；权限 = 写空间根 `./` |
| D25 | **项目无工作目录** | 项目**没有**工作目录概念；需要共享目录时，由**人或项目主管**用项目的 `prompt` + `permissions` 按需定义 |
| D26 | **项目 = 扁平配置文件** | `projects/<名字>.project.config.json`（与 agent 同构的扁平文件）；无 `data/` |
| D27 | **agent 工作目录默认发 `MEMORY.md`** | 工作目录**仅 agent 有**；默认给它一个 `MEMORY.md`，其余内容 agent 自由发挥 |
| D28 | **权限是一套逻辑（与工具语义无关）** | 对框架而言工具的**实际语义无关**；`permissions` 只是一张"**工具名 → 路径列表**"的表，**同一套逻辑**（默认空 / attenuation / 运行时授权）套到所有工具，含未来新增 |
| D29 | **会话记录进自有数据库** | **重构级**：消息 / 会话记录由 OpenStaffs **自有数据库**保存，**不再依赖基座（Pi）的 transcript**。收益：① 基座**弱相关**（可移植性↑）；② 项目（群）会话**无需去重 / 合并**（一条投递 = 一条记录）。**修订**架构设计「消息 = transcript entry（唯一真相）」|
| D30 | **落库 = run 结束后一条** | 流式 delta **不落库**；一次 run 结束落**一条**记录；**中途崩溃不处理**（该 run 丢弃）。**不做迁移**（允许破坏性更新）|
| D31 | **会话真相当属框架** | 会话 / 消息存 **`openstaffs/.data/`（SQLite）**；**不保留**基座 transcript；基座弱化为"**发消息的工具**"，聊天能力收归框架、**唯一权威** |
| D32 | **内置 prompt 物化进空间配置** | 新建空间（启动时**无 `space.config.json`**）→ 把**内置 prompt 注入 `space.config.json`**；此后**运行时无关**（不再依赖框架模板）|
| D33 | **不使用 AGENTS.md** | **彻底不管 AGENTS.md**（`pi-durable 1.3.0` 也无自动加载，已核实）。所有引导走各 config 的 `prompt` 字段（如 `project.config.json.prompt` 自去引导）|
| D34 | **强模块化** | 本次重构抽象量大（**工具 / 权限 / `*.config.json` / 组织 / 会话存储**），实现须**强模块化**：每能力一个独立模块、清晰接口、可独立测试与替换（见 §12）|

---

## 3. 目录结构

```
<办公空间>/
├─ agents/                                  # 组织：文件夹 = 部门（可任意嵌套）
│  ├─ department.config.json                # 根部门（可选）
│  ├─ staff0.agent.config.json              # 0 号员工（首席管家，根下、无部门）
│  └─ eng/
│     ├─ department.config.json             # 部门声明（含可选 head）
│     ├─ alice.agent.config.json            # 人
│     ├─ dave.agent.config.json
│     └─ platform/
│        ├─ department.config.json
│        ├─ bob.agent.config.json
│        └─ carol.agent.config.json
├─ projects/                                # 协作：群聊（**扁平配置，无工作目录**）
│  └─ seo.project.config.json               # 群声明（owner / members / prompt / 能力 / 权限）
├─ work/                                    # 工作目录（**仅 agent 有**）
│  ├─ alice/                                # 默认发 MEMORY.md，其余内容 agent 自由发挥
│  └─ bob/  carol/  dave/  staff0/  …
└─ openstaffs/                              # 空间附属 + 机器私有
   ├─ space.config.json                     # 空间声明（prompt / skills / mcp / permissions）
   ├─ skills/<技能名>/                       # 共享技能库（按名引用）
   ├─ mcps.json                             # MCP 全局定义（按名引用）
   └─ .data/                                # 机器私有（gitignore）：config.json（密钥）/ state.sqlite / …
```

- 定义树：**只有 `department.config.json`（部门）与 `<名字>.agent.config.json`（人）两类文件**；其余是子部门文件夹。
- 根下仅有门面：`agents/`、`projects/`、`work/`、`openstaffs/`（不使用 `AGENTS.md`）。
- **系统作用域**：框架内置（`src/`），非用户编辑；**新建空间时把内置 prompt 物化进 `space.config.json`**（D32），此后运行时无关。

---

## 4. 统一配置：文件与字段

**同一形状**，五层通用：

| 字段 | 类型 | 系统 | 空间 | 项目 | 部门 | 员工 |
|---|---|---|---|---|---|---|
| `alias?` | string | — | 空间名 | 群名 | 部门名 | 展示名（缺省 id） |
| `avatar?` | string(path) | — | — | ✔ | ✔ | ✔ |
| `prompt?` | string（内联） | ✔ | ✔ | ✔ | ✔ | ✔ |
| `skills?` | string[]（名） | ✔ | ✔ | ✔ | ✔ | ✔ |
| `mcp?` | string[]（名） | ✔ | ✔ | ✔ | ✔ | ✔ |
| `permissions?` | 按工具 → 路径列表 | ✔ | ✔ | ✔ | ✔ | ✔ |
| `model?` | `供应商/模型 id` | — | — | — | — | ✔（覆盖全局默认） |
| `head?` | string[]（本级成员） | — | — | — | ✔ | — |
| `owner?` | string[]（本群成员） | — | — | ✔ | — | — |
| `members?` | string[] | — | — | ✔ | — | — |

**载体**：

| 作用域 | 文件 |
|---|---|
| 系统 | 框架内置（`src/`）；**新建空间时物化进 `space.config.json`**（D32） |
| 空间 | `openstaffs/space.config.json` |
| 项目 | `projects/<名字>.project.config.json`（扁平） |
| 部门 | `<部门>/department.config.json` |
| 员工 | `<部门>/<名字>.agent.config.json` |

> 机器私有（`providers`/密钥/`port`/全局默认 `model`）不进这些声明，走 **`openstaffs/.data/config.json`**（D19）。

---

## 5. 负责人与管理权

**负责人（可选，可多）**

- 部门 `department.config.json.head`；项目 `project.config.json.owner`。**数组**、可为空；**只能选本级成员**；匹配不到即**无**。
- 主管**不能写自己的配置**（D8）。

**管理权（D7，主管制 + 穿透）**

> 对任一部门 / 人 **X**：沿 X 的祖先链（含其自身所在部门）向上找**最近的、有 `head` 的部门** D；**D 的主管**即 X 的管理者。全链无 → **老板**。管理者的权限覆盖其所在部门的**整棵子树**（部门 + 人，**任意深度**）。

- 主管可管到**孙级及更深**（穿透）；**同级（兄弟）互不可管**。
- "上级代管"不是单独规则，而是穿透的**自然结果**。
- 项目层同理：群主管**整个群**（成员 + 群声明）；无群主 → 老板。

---

## 6. 权限模型（按工具，累加式）

**形态**（D9）：`permissions` 是**按工具分组**的对象，每个工具的值 = **路径列表**：

```json
"permissions": { "write": ["."], "read": ["/"], "bash": ["/"] }
```

**累加路线**（D11，**落盘**）：`project.config.json` + `agent.config.json`——**累加**，接受同值重复，不做覆盖。
> `space` / `department` **不进**配置权限路线（"默认不补"）；工作目录与主管写权走**运行时**（下）。

**运行时授权（非显性，D13）**：① agent 自己的工作目录 → **所有工具**由**运行时自动授予**；② **主管对管理子树的写权**。均不写进任何 config。

**新建默认值**（D14）：`write: []`、`read: ["./"]`、`bash: ["./"]`；**新工具默认空**；新建项目同理。

**硬规则：**

- **人不可写任何 `<名字>.agent.config.json`（含自己的）**——防自授权（主管的写入是"写下级"）。
- **`permissions` 写入 = attenuation**（D15/D28）：写任何层的 `permissions` 时，**每个工具的值 ⊆ 写者该工具的有效集（含继承）**。**全管**——对所有工具一视同仁，**与工具实际语义无关**（写/读/bash/未来工具都是同一套逻辑；未知工具按默认空）。
- **读**：与写同机制的路径列表（D9）。

**与现有机制的关系：**

- 现有员工级 `permission.json` → `permissions`；现有项目级 `permission.json` → 项目声明 `permissions`。
- `request_permission`（员工申请 → 老板批准 → 框架代写）**保留**；框架/老板写入不受 attenuation 限制。新增：**主管/群主可直接写下级的 `permissions`**（受 attenuation）。

---

## 7. 合并规则（累加，无覆盖）

**总原则**（D10）：所有能力 / 权限一律**累加**、**接受同值重复**，**不做覆盖 / 优先级**。

| 类别 | 累加路线 |
|---|---|
| `permissions`（落盘） | `project.config.json` + `agent.config.json` |
| `permissions`（**运行时**，不落盘） | agent 自己的工作目录（所有工具）+ **主管对管理子树的写权**（D13）|
| `skills` / `mcp` | `space` + `department`（从上到下递归）+ `project` + `agent` |
| `prompt` | `space` + `department`（从上到下递归）+ `project` + `agent` |

- `skills` / `mcp` 已归**全局定义**（按名引用）→ **不会撞名**，累加即可。
- `prompt` **累加**即可（**做好换行分割**）。

> 已定：`space` / `department` **不进**配置权限路线（"默认不补"）；主管的管理写权改由**运行时**授予。
> 引用解析：`skills` → **`openstaffs/skills/<技能名>/`**；`mcp` → **`openstaffs/mcps.json`**。

---

## 8. 0 号员工（Staff0，首席管家）

- **非框架改动**——新增一个**启动流程**：首次启动时判断 `agents/staff0.agent.config.json` **是否存在**，不存在则自动创建。
- **落点**：`agents/staff0.agent.config.json`（根下；人都是扁平**文件**，Staff0 无部门）。
- **权限**：**写空间根 `./`**（整个空间）——"空间管理员"。
- **直属老板**；无单独 `model` 时用全局默认。
- **注**：这是对"空间级附属 = 老板地盘、员工写不进"的**有意例外**（管家是那个例外）。

---

## 9. 对既有决策与文档的修订

| 位置 | 现状 | 改为 |
|---|---|---|
| `2026-10-16-...-architecture-design.md` §4.1 | 「员工扁平、组织由群聊表达（决策）」 | **修订**：组织由**目录层级 + 负责人**表达；群聊只管协作 |
| 同上 §非目标 | 「独立组织架构层」列为非目标 | **移出** |
| 同上 §4.1 注 / §4.2 表 | 员工目录 `AGENTS.md` 为入口、引入 profile/MEMORY | **修订**：入口改为 `.agent.config.json`；`prompt` 渲染 instructions |
| 同上「**消息 = transcript entry（唯一真相）**」 | 消息真相在基座 transcript | **修订**（D29）：消息 / 会话由 **OpenStaffs 自有数据库**保存；基座只负责"跑" |
| `2026-10-16-openstaffs-permissions-design.md` | 写权限（`permission.json`，仅写） | **扩展**：按工具权限、声明内联、attenuation |
| `2026-10-17-space-layer-design.md` | 空间目录两分（`.openstaffs/` + `openstaffs/`） | **修订**：合并为 `openstaffs/`（机器私有进 `openstaffs/.data/`） |
| `docs/产品规划.md` §未落地 | 「组织架构：`agents/` 部门树」未实现 | **更新**为已落地（新形态）；Staff0 落地 |
| `README.md` | 员工 = 文件夹（AGENTS.md…） | 按新结构重写「Agent」「项目」「配置」章节 |
| `src/skills/openstaffs/SKILL.md` | 员工可用能力（真相源） | 补：部门/人、负责人、穿透、按工具权限、统一配置、Staff0 |
| `src/skills/openstaffs-ops/SKILL.md` | 运维（目录 / 权限规则） | 按新结构重写目录结构与权限章节 |

---

## 10. 分阶段落地

按**风险递增**分阶段，各阶段独立验收；**建议先做 P1**。

| 阶段 | 范围 | 关键点 |
|---|---|---|
| **P1 会话记录进自有数据库** | 消息 / 会话记录自存（**脱离基座 transcript**）；群会话 = **单条流**，去掉去重 / 合并 | 架构级；先做，后续都受益 |
| **P2 组织 + 负责人 + 权限骨架** | `agents/` 部门嵌套；`department.config.json` / `<名字>.agent.config.json` 发现与解析（人先支持 `alias`/`model`/`prompt`）；`head` 与穿透管理权；侧栏**可折叠树** | 先把"部门 + 人 + 负责人"的结构与权限跑通 |
| **P3 配置统一 + 按工具权限** | 四类能力统一为 `*.config.json`（空间/项目/部门/员工）；**一套解析器**；权限升级为**按工具路径列表** | 去掉旧机制的格式分叉 |
| **P4 空间目录合并 + Staff0** | `.openstaffs/` → `openstaffs/.data/`；路径解析、启动探测、引导页、`.gitignore`；首次启动自动建 Staff0 | 影响面广，需回归 |
| **P5 定义模型落地** | `.agent.config.json` 全面取代多文件；`prompt` 渲染；记忆放 `work/<id>/MEMORY.md`；技能库集中；不使用 `AGENTS.md` | 破坏性更新（**不做迁移**，D30）|

---

## 11. 待定 / 风险

- **项目 / 群聊**：本设计只加了"群主 + 统一配置"，群内模式（`@`、组队等）未动。

> **已定/闭环**：能力与权限一律**累加**（无优先级）、各工具默认值、**attenuation 全工具统一**、`skills` → `openstaffs/skills/<技能名>/`、`mcp` → `openstaffs/mcps.json`、成员放 `project.config.json`、全局配置进 `.data/`、新工具默认空、**会话记录进自有库**（`openstaffs/.data/`，组会话无需去重合并）、**落库 = run 结束一条**、**不做迁移**、**内置 prompt 物化进 `space.config.json`**、**不使用 AGENTS.md**（引导走 `prompt` 字段）。

---

## 12. 模块化边界（实现原则，D34）

本次重构抽象量大，**必须强模块化**：每个能力一个独立模块、清晰接口、可独立测试与替换。

| 模块 | 职责 | 主要依赖 |
|---|---|---|
| **config** | 加载 / 校验 / 命名解析 `*.config.json`（五层）+ `openstaffs/.data/config.json` | 无（纯域） |
| **org** | 部门树、负责人（head/owner）、管理权（穿透） | config |
| **permissions** | 按工具权限：默认 / 继承 / 运行时 / **attenuation** | config、org |
| **capabilities** | 作用域链装配：`prompt` / `skills` / `mcp` **累加** | config、org |
| **store** | 会话 / 消息自有库（SQLite，`openstaffs/.data/`） | 无 |
| **tools** | 工具注册 / 执行 / 权限闸门 | permissions |
| **harness** | 基座适配（Pi）：发消息、驱动 agent 循环 | tools、store |
| **ui / server** | HTTP / SSE / 渲染 | 上述 |

**原则**：基座（Pi）**只出现在 `harness` 一个模块**；换基座**只动它**。权限 / 配置 / 组织 / 会话存储均为**自有、与基座无关**的域模块。

---

## 13. 消息表 schema（自持会话库）

| 字段 | 说明 |
|---|---|
| `id` | 主键 |
| `seq` | **单调序号**（稳定排序）|
| `sendTime` | 时间戳（**只落库**；喂模型时**不带时间**，按 `seq` 顺序即可）|
| `projectId` | 群聊 = 项目 id；**私聊 = null**（`type` 由它推出，**不单存**）|
| `fromId` | **参与者 id**：agent id，或保留 id `"__boss"` / `"__system"`（前缀 `__`）|
| `toIds` | **参与者 id 列表**（**可含** `"__boss"` / `"__system"`）|
| `text` | 内容（**剥离头部 `@` 块**）|
| `sessionId?` | 属于哪条会话（上下文连续 / "新开会话"边界）|

- **老板与系统都是"参与者"**：用**保留 id**（`"__boss"` / `"__system"`，前缀 `__` 防与 agent 名冲突）出现在 `fromId` / `toIds`；**不单列** `isToBoss` / `isFromBoss`（皆为**派生布尔**，存了只是冗余与漂移源）。需**保留这些 id**、禁止 agent 占用。
- **一次投递 = 一条记录**：老板一句话 @ 多人 = **1 行**（`toIds=[a,b,c]`）；老的 `roomMessageId` 去重键**废除**。
- **时间戳**：DB **保留**（展示 / 查询用）；**发给大模型的上下文不带时间**，按 `seq` 顺序列出即可。
- **`text` 剥离头部 `@`**（已定）：`@` 只作**输入约定**（LLM 照旧写、解析成 `toIds` 后**剥离**）；展示 / 喂模型时由 `toIds` **重建头**。正文中 / 尾部的 `@` 是文字，**不动**（沿用"只认前缀块"）。
