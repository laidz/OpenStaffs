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

本设计要落六件事：

1. **组织架构**：文件夹 = 部门（可嵌套），`<名字>.agent.config.json` = 人；部门/项目有**可选负责人**。
2. **项目负责人（群主）**：与部门主管**完全同构**。
3. **统一配置**：四类能力收敛为**同一种格式**，五层（系统/空间/项目/组织/员工）统一，**一套解析器**沿作用域链合并；配置文件统一命名 `*.config.json`。
4. **按工具权限**：写 / 读 / bash / 未来工具，**同一套权限配置**（每工具 = 路径列表）。
5. **空间目录合并**：`.openstaffs/` 并入 `openstaffs/`（机器私有进 `openstaffs/.data/`）。
6. **0 号员工（Staff0）**：首次启动自动创建的空间管家。

**一句话**：*文件夹是部门、文件是人；负责人可选、只管本级；四类能力一种形状；权限按工具、配置同名同构。*

**非目标：**

- **能力覆盖优先级**（组织链 vs 项目 vs 员工谁赢、prompt 叠加顺序）——**待定**（§7、§11）；
- 硬档隔离 / 容器（沿用现有软边界）；
- 群内模式（`@` 前缀块、组队等）的改动。

---

## 2. 决策记录

| # | 决策 | 说明 |
|---|---|---|
| D1 | **文件夹 = 部门，文件 = 人** | 人 = `<名字>.agent.config.json`；**id = 文件名主干，全局唯一** |
| D2 | **人由单一 config 定义** | 原 `AGENTS.md`/`profile.md`/`config.json`/`mcp.json`/`permission.json` 并入；技能改**引用**；记忆移 `work/<id>/memory.md` |
| D3 | **配置统一命名 `*.config.json`** | `space.config.json` / `project.config.json` / `department.config.json` / `<名字>.agent.config.json`；**内容同构** |
| D4 | **统一字段** | 各层共有 `{ alias?, avatar?, prompt?, skills?, mcp?, permissions? }`；层特有：员工 `model`、部门 `head`、项目 `owner` / `members`、空间无 |
| D5 | **`prompt` = 内联字符串** | **取消所有层级的 `AGENTS.md`**（空间/项目/部门/员工一体） |
| D6 | **负责人可选、可多** | `head`（部门）/ `owner`（项目）为**数组**、可为空；**只能从本级成员里选**；匹配不到即视为无 |
| D7 | **管理权 = 主管制 + 穿透** | 管理者 = 沿祖先链（含自身）最近的、有负责人的部门主管；全链无 → **老板**。主管管其**整棵子树**（部门 + 人，**任意深度**）。不单列"代管"（穿透自然覆盖）。 |
| D8 | **主管不能写自己的配置** | "人不可写自己"的延伸；自己的定义只能由上级主管 / 老板写 |
| D9 | **权限 = 按工具** | `permissions = { write: [...], read: [...], bash: [...], … }`；**每个工具的值 = 路径列表**（`["/"]` = 任意）|
| D10 | **权限算法（每工具一致）** | **默认 ∪ 继承 ∪ 本人**：默认（各工具不同）、祖先部门声明的继承、本人声明；同一套逻辑套用到每个工具 |
| D11 | **`permissions` 写入 = attenuation** | 写 `permissions` 字段时**值 ⊆ 写者自身权限集（含继承）**；逐级收窄、可传递 |
| D12 | **读 = 可配置** | 读与写一样是"路径列表"（旧"读零限制"**作废**）；**默认值待定**（§11） |
| D13 | **MCP = 全局定义 + 按名引用** | server 统一在全局定义，各消费方按 **mcp 名**引用（**与 skills 同构**）；取代"内联定义" |
| D14 | **`skills` = 按名引用** | 引用共享技能库（`openstaffs/skills/` 等），不支持在声明里内联技能正文 |
| D15 | **头像可选** | `avatar?` = 图片路径；缺省**前端**取**名称首字** + **名称派生色**作底色 |
| D16 | **空间目录合并** | `.openstaffs/` + `openstaffs/` → **单一 `openstaffs/`**；机器私有（配置/数据库/状态）进 **`openstaffs/.data/`** |
| D17 | **工作树平铺** | `work/<名字>/` 各自独立（含 `memory.md`），与定义树分离 |
| D18 | **单归属** | 一个人只属于其 config 所在的部门 |
| D19 | **老板最高** | 全可写；`request_permission`（向老板申请）保留；**唯一例外**：Staff0 拿到空间管理权 |
| D20 | **Staff0（0 号员工）** | `agents/staff0.agent.config.json`，**首次启动自动建**；权限 = 写空间根 `./` |

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
├─ projects/                                # 协作：群聊
│  └─ demo/
│     ├─ project.config.json                # 群声明（owner / members / prompt / 能力 / 权限）
│     ├─ data/                              # 共享工作区
│     └─ conversation_ids/
├─ work/                                    # 工作树（平铺）
│  ├─ alice/                                # 工作产出 + memory.md
│  └─ bob/  carol/  dave/  staff0/  …
└─ openstaffs/                              # 空间附属 + 机器私有
   ├─ space.config.json                     # 空间声明（prompt / skills / mcp / permissions）
   ├─ skills/                               # 共享技能库（被按名引用）
   ├─ mcp.json                              # MCP 全局定义（被按名引用）
   └─ .data/                                # 机器私有（gitignore）：config.json（密钥）/ state.sqlite / …
```

- 定义树：**只有 `department.config.json`（部门）与 `<名字>.agent.config.json`（人）两类文件**；其余是子部门文件夹。
- 根下仅有门面：`agents/`、`projects/`、`work/`、`openstaffs/`（`AGENTS.md` 取消）。
- 系统作用域声明由框架内置（`src/`），非用户编辑。

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
| `model?` | `供应商/模型 id` | — | 全局默认（落点待定 §11） | — | — | ✔（覆盖） |
| `head?` | string[]（本级成员） | — | — | — | ✔ | — |
| `owner?` | string[]（本群成员） | — | — | ✔ | — | — |
| `members?` | string[] | — | — | ✔ | — | — |

**载体**：

| 作用域 | 文件 |
|---|---|
| 系统 | 框架内置（`src/`） |
| 空间 | `openstaffs/space.config.json` |
| 项目 | `projects/<id>/project.config.json` |
| 部门 | `<部门>/department.config.json` |
| 员工 | `<部门>/<名字>.agent.config.json` |

> 机器私有（`providers`/密钥/`port`/全局默认 `model`）不进这些声明，走 `openstaffs/.data/config.json`（**待定**，§11）。

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

## 6. 权限模型（按工具）

**形态**（D9）：`permissions` 是**按工具分组**的对象，每个工具的值是**路径列表**：

```json
"permissions": {
  "write": ["."],
  "read":  ["/"],
  "bash":  ["/"]
}
```

**算法（D10，每个工具各算一份）**：该工具的有效集 = **默认 ∪ 继承 ∪ 本人**：

- **默认**（各工具不同）：写 = 自己的工作空间 `work/<自己>/` + （作为管理者时）管理子树内的配置；读、bash 的默认**待定**（§11）。
- **继承**：祖先部门声明里**同工具**的路径列表（沿链累积）。
- **本人**：`<名字>.agent.config.json.permissions[工具]`。

**硬规则**：

- **人不可写任何 `<名字>.agent.config.json`（含自己的）**——防自授权（主管的写入是"写下级"）。
- **`permissions` 写入 = attenuation**（D11）：写任何层的 `permissions` 时，**每个工具的值 ⊆ 写者该工具的有效集（含继承）**。
- **读**：与写同机制的路径列表（D12）。

**与现有机制的关系**：

- 现有员工级 `permission.json` → `permissions`；现有项目级 `permission.json` → 项目声明 `permissions`。
- `request_permission`（员工申请 → 老板批准 → 框架代写）**保留**；框架/老板写入不受 attenuation 限制。新增：**主管/群主可直接写下级的 `permissions`**（受 attenuation）。

---

## 7. 作用域链与能力合并

**作用域链（会话装配时，从外到内）：**

```
系统 → 空间 → 项目（若在群里） → 组织链（该发言人的部门链，根→叶） → 员工
```

**各能力的合并语义（草案）：**

| 能力 | 目标规则 |
|---|---|
| `prompt` | 沿链**全部叠加**（顺序待定） |
| `skills` | 去重，**近者优先**（优先级待定） |
| `mcp` | 同名**近者胜**（优先级待定） |
| `permissions` | 每工具**累积**（受 attenuation 约束） |

> **⚠️ 待定（用户明确暂缓）**：**能力覆盖优先级**——`prompt` 叠加顺序、`skills`/`mcp` 里「组织链 vs 项目 vs 员工」谁赢——**不在本设计内定**，实现前另行讨论。

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
| **P1 组织 + 负责人 + 权限骨架** | `agents/` 部门嵌套；`department.config.json` / `<名字>.agent.config.json` 发现与解析（人先支持 `alias`/`model`/`prompt`）；`head` 与穿透管理权；侧栏**可折叠树** | 先把"部门 + 人 + 负责人"的结构与权限跑通 |
| **P2 配置统一 + 按工具权限** | 四类能力统一为 `*.config.json`（空间/项目/部门/员工）；**一套解析器**；权限升级为**按工具路径列表** | 去掉旧机制的格式分叉 |
| **P3 空间目录合并 + Staff0** | `.openstaffs/` → `openstaffs/.data/`；路径解析、启动探测、引导页、`.gitignore`；首次启动自动建 Staff0 | 影响面广，需回归 |
| **P4 定义模型迁移** | `.agent.config.json` 全面取代多文件；`prompt` 渲染；记忆迁 `work/<id>/memory.md`；技能库集中；`AGENTS.md` 取消 | 破坏性：需迁移工具 + 兼容期 |

---

## 11. 待定 / 风险

- **能力覆盖优先级**（§7）：`prompt` 叠加顺序、`skills`/`mcp` 的层级胜负——**用户明确暂缓**，实现前定。
- **各工具的默认值**（§6）：写默认已定（工作空间 + 子树）；**读、bash 的默认未定**（读的旧"零限制"作废）。
- **attenuation 是否对每个工具都生效**：还是只对写。
- **未来新工具如何登记**：工具列表从哪来、`permissions` 的合法键集合。
- **`openstaffs/.data/config.json`**：全局配置（`providers`/密钥/`model`/`port`）是否进 `.data/`（**倾向是**，最安全）。
- **项目成员名单存哪**：`project.config.json` 的 `members` 字段 vs 保留 `members.md`。
- **`skills`/`mcp` 引用语法**：按名解析到哪个库；是否支持路径 / 外部 `skillPaths`。
- **系统作用域声明**：框架内置 prompt 模板如何并入"统一配置"（是否引入 `src/` 下的声明文件）。
- **`AGENTS.md` 移除的兼容**：Pi 祖先链自动加载消失，需确认"私活"场景 instructions 注入路径覆盖完整。
- **迁移**：P4 需一次性迁移脚本；不做双读。
- **项目 / 群聊**：本设计只加了"群主 + 统一配置"，群内模式未动；组织模型已与项目解耦，便于替换。
