# OpenStaffs 员工组织架构（部门树）设计

> 状态：待评审 · 日期：2026-10-18 · 分支：（实现时定）
> 关联：`2026-10-16-openstaffs-architecture-design.md`（§4.1「员工扁平、组织由群聊表达」——本设计**修订**它）、`2026-10-16-openstaffs-permissions-design.md`（写权限判定——本设计**扩展**它）、`2026-10-17-permission-request-design.md`（授权弹框链路）
> 性质：**破坏性重构**（员工定义模型 + 权限模型 + 目录结构）。落地分 3 阶段（§8），可先做 P1。

---

## 1. 背景与目标

现状（master）：

- `agents/<id>/` **扁平**；员工 = 一个自包含文件夹（`AGENTS.md` + `profile.md` + `MEMORY.md` + `config.json` + `skills/` + `mcp.json` + `permission.json`）。
- 组织关系**由群聊表达**（架构设计 §4.1 决策）：部门 = 常设群、任务 = 临时群。
- 写权限 = 自己目录 + 所在项目目录 + `permission.json` 追加。

本设计把组织从「群聊表达」改为**目录层级表达**，并顺带把**员工定义、能力、权限收敛进 JSON**：

1. **文件夹 = 部门（组织节点）**，可任意嵌套；**`<名字>.agent.json` = 一个人**。
2. **管理链条纯结构化**：祖先部门成员 → 后代部门成员（可跨级）；同级（兄弟）互不可写。无需"指定主管"。
3. **能力与权限沿部门链继承**；读**零限制**。

**一句话**：*文件夹是部门，文件是人；管理由结构决定，读全透明。*

**非目标（本设计不覆盖）：**

- 项目 / 群聊的重构（另议，见 §9）；
- 读限制（明确**不做**）；
- 硬档隔离与容器（沿用现有软边界）；
- UI 之外的执行环境改造。

---

## 2. 决策记录

| # | 决策 | 说明 |
|---|---|---|
| D1 | **文件夹 = 部门，文件 = 人** | `<名字>.agent.json` 定义一个人；**id = 文件名主干，全局唯一**（去掉 `.agent.json`） |
| D2 | **人由单一 JSON 定义** | 员工文件夹不再"定义职能"；现 `AGENTS.md` / `profile.md` / `config.json` / `mcp.json` / `permission.json` 并入该 JSON（技能改为**引用**） |
| D3 | **部门身份 = `department.json`** | `{ alias, prompt?, skills?, mcp?, permissions? }`；**无"主管"字段**——不存在"指定主管"这个业务 |
| D4 | **管理链条 = 结构** | 祖先部门成员 → 后代部门成员（**可跨级**）；**同部门成员互为兄弟、互不可写** |
| D5 | **默认写权限 = 两项** | ① 自己工作空间 `work/<自己>/`；② 自己**所有后代部门**的两类文件（`department.json` + `*.agent.json`） |
| D6 | **继承写权限** | 来自**所有祖先部门** `department.json.permissions` 的路径（沿链累积） |
| D7 | **`permissions` 字段 + attenuation** | 两类文件都有 `permissions`；写它时**值 ⊆ 写者自身写权限集（含继承）**——只能给"已有的"或"子集"；逐级可传递 |
| D8 | **读零限制** | 空间内随意读、**跳出空间读外界也行**；**不新增任何读机制**（现有系统本就只管控写） |
| D9 | **能力继承** | 沿部门链：`prompt` **累加**；`skills` **近者优先去重**；`mcp` **同名近者胜**；`permissions` **沿链累积** |
| D10 | **`AGENTS.md` 取消** | 人格由 `prompt` 字段接住，装配会话时由 OpenStaffs 渲染成 instructions；**不再依赖 Pi 祖先链自动加载** |
| D11 | **`org.json` 不需要** | 目录层级即组织；省一份中央文件与漂移源 |
| D12 | **工作树平铺** | `work/<名字>/` 各自独立（含 `memory.md`），与定义树分离；员工只能写自己的 `work/<自己>/` |
| D13 | **单归属** | 一个人只属于其 `.agent.json` 所在的部门，不可多属 |
| D14 | **根部门可选** | `agents/department.json` 缺省即无公司别名；顶层成员 = 直属老板 |
| D15 | **老板最高** | 全可写；现有 `request_permission`（向老板申请）通道保留 |

---

## 3. 目录结构

```
<办公空间>/
├─ agents/                        # 定义树（文件夹 = 部门；可任意嵌套）
│  ├─ department.json             # 根部门（可选）：公司别名 / 通用 prompt / 能力 / 权限
│  └─ eng/                        # 部门「工程」
│     ├─ department.json          # 部门通用身份与能力
│     ├─ alice.agent.json         # 人：alice（隶属 eng）
│     ├─ dave.agent.json          # 人：dave（alice 的兄弟）
│     └─ platform/                # 子部门「平台」
│        ├─ department.json
│        ├─ bob.agent.json
│        └─ carol.agent.json
├─ work/                          # 工作树（平铺、各自独立）
│  ├─ alice/                      # 工作产出 + memory.md
│  ├─ bob/  carol/  dave/
└─ openstaffs/
   └─ skills/                     # 共享技能库（被 JSON 引用）
```

- 定义树：**只有 `department.json`（部门）与 `<名字>.agent.json`（人）两类文件**；其余一律是子部门文件夹。
- 工作树：每个员工一个平铺目录，名字与 id 一致。

---

## 4. 两份 JSON 的字段

| 文件 | 字段 | 含义 |
|---|---|---|
| `department.json` | `alias` | 部门展示名 |
| | `prompt?` | 部门通用提示词（向后代累加） |
| | `skills?` | 部门通用技能（名称数组，引用共享技能库） |
| | `mcp?` | 部门通用 MCP server（内联） |
| | `permissions?` | 部门通用写权限（后代继承） |
| `<名字>.agent.json` | `alias?` | 展示名（缺省 = id） |
| | `model` | `供应商/模型 id`（原 `config.json`） |
| | `prompt?` | 本人员工的提示词（原 `AGENTS.md` / `profile.md` 的内容） |
| | `skills?` | 本人技能（引用） |
| | `mcp?` | 本人 MCP（内联） |
| | `permissions?` | 本人额外写权限 |

> 记忆（`MEMORY.md`）**不进 JSON**：记忆是热写文件，移到 `work/<id>/memory.md`（JSON 不适合热写）。

---

## 5. 权限模型（写）

**员工 A 的写权限集 = 默认两项 ∪ 继承：**

1. **默认**：① `work/<A>/`（自己工作空间）；② A 的**所有后代部门**的 `department.json` 与 `*.agent.json`（可跨级）。
2. **继承**：所有**祖先部门** `department.json.permissions` 的路径（沿链累积）。
3. **本人额外**：`A.agent.json.permissions` 的路径。

**硬规则：**

- **人不可写任何 `*.agent.json`（含自己的）**——这是防止"自授权"的唯一防线。
- **`permissions` 字段写入 = attenuation**：任何人写 `department.json.permissions` 或 `*.agent.json.permissions` 时，**值 ⊆ 写者当时的写权限集（含继承）**。上级只能把"自己已有的"或"子集"授予下级；逐级收窄、可传递。
- **读**：零限制（D8）。

**与现有机制的关系：**

- 现有员工级 `agents/<id>/permission.json` → 迁移为 `agent.json.permissions`。
- 现有 `request_permission`（员工申请 → 老板弹框批准 → 框架代写）**保留**：框架写入属"老板级"特权写，不受 attenuation 限制。新增能力：**祖先部门成员可直接写下代两类文件的 `permissions`**（受 attenuation）。
- 项目级 `projects/<id>/permission.json` **本设计不动**（项目属协作层，另议）。

---

## 6. 能力装配：新增「组织链」维度

现有四层：`系统 → 空间 → 项目 → 员工`。本设计在「员工」之上插入**组织链**（部门链，根→叶），形成五层。

| 能力 | 现有规则 | 融入组织链（**建议**，细节见 §9） |
|---|---|---|
| `prompt` | 叠加（环境段 → 空间 → 项目 → 员工） | 环境段 → 空间 → 项目 → **组织链（根→叶）** → 员工 |
| `skills` | 去重（项目 → 员工 → 空间 → 系统） | **员工 > 组织链（近→远）> 项目 > 空间 > 系统**（近者优先） |
| `mcp` | 注册（同名窄者胜；项目 → 员工 → 空间 → 系统） | 同名**近者胜**：员工 > 组织链（近→远）> 项目 > 空间 > 系统 |

**技能来源**：`agents/*/skills/` 不再存在；技能库统一放 `openstaffs/skills/`（或任意处），JSON 按名引用（具体引用语法见 §9）。

---

## 7. 对既有决策与文档的修订

| 位置 | 现状 | 改为 |
|---|---|---|
| `2026-10-16-...-architecture-design.md` §4.1 | 「员工扁平、组织由群聊表达（决策）」 | **修订**：组织由**目录层级**表达；群聊只表达"协作" |
| 同上 §非目标 | 「独立组织架构层」列为非目标 | **移出**（本设计落地它） |
| 同上 §4.1 注 / §4.2 表 | 员工目录 `AGENTS.md` 为入口、引入 profile/MEMORY | **修订**：入口改为 `agent.json`；`prompt` 渲染 instructions |
| `docs/产品规划.md` §未落地 | 「组织架构：`agents/` 部门树（`children/`）」标记为未实现 | **更新**为已落地（新形态） |
| `README.md` | 员工 = 文件夹（AGENTS.md…） | 按新结构重写「Agent」「项目」相关章节 |
| `src/skills/openstaffs/SKILL.md` | 员工可用能力（真相源） | 补：部门/人、管理链条、能力继承、attenuation |
| `src/skills/openstaffs-ops/SKILL.md` | 运维（目录结构 / 权限规则） | 按新结构重写目录结构与权限章节 |

---

## 8. 分阶段落地

按**风险递增**分 3 阶段，每阶段独立验收；**建议先做 P1**。

| 阶段 | 范围 | 关键点 |
|---|---|---|
| **P1 结构与权限** | `agents/` 支持部门嵌套；`department.json` / `<名字>.agent.json` 的**发现与解析**（人先支持 `alias`/`model`/`prompt` 最小字段）；管理链条写权限；侧栏**可折叠树** UI | 先把"部门 + 人"的**结构与权限**跑通，内容模型（技能/MCP/权限/记忆迁移）留给 P2/P3 |
| **P2 `agent.json` 定义模型** | `agent.json` 单一 JSON 取代多文件；`prompt` 渲染 instructions；记忆迁到 `work/<id>/memory.md` | 破坏性：需迁移工具（现有员工目录 → 新结构） |
| **P3 能力与权限内联** | `skills` 引用化（技能库移 `openstaffs/`）；`mcp` 内联；`permissions` 内联 + attenuation 落地 | 五层装配改造；`request_permission` 与 attenuation 并存 |

**迁移**：P2/P3 需一次性迁移脚本 + 兼容期（或一次性切换，不做双读）。

---

## 9. 待定 / 风险

- **能力层与「项目」层的优先级**（§6）：`skills` / `mcp` 与项目层的先后未定，仅给建议值；实现前需定稿。
- **技能引用语法**：`skills: ["名字"]` 的解析源（`openstaffs/skills/`？系统内置？外部 `skillPaths`？）待定。
- **`mcp` 内联形态**：内联 server 定义 vs 按名引用空间 `mcp.json`，待定。
- **项目 / 群聊**：本次**不动**；用户已有新想法，可能引发**整体重构**——本设计的组织模型应设计为**与项目解耦**，便于后续替换。
- **`department.json.permissions` 与项目的交互**：部门权限是否可覆盖项目路径（"不管项目"的边界）待定。
- **UI**：树形态（折叠、排序、徽标）细节待定。
- **`AGENTS.md` 移除的兼容**：Pi 祖先链自动加载消失，需确认"私活"场景 instructions 注入路径覆盖完整。
