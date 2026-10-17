# OpenStaffs 空间层：命名、技能来源与生效时机 设计

> 状态：待评审 · 日期：2026-10-17 · 分支：`feat/batch3-space-layer`
> 关联：`2026-10-16-openstaffs-architecture-design.md`（prompt 装配 / 技能目录 / 事件体系）、`2026-10-17-permission-request-design.md`（技能手册的静态术语映射惯例）
> 需求来源：`TODO.md` 批次 3（含「参考画面」表 A / 表 B / 画面一）。

---

## 1. 背景与目标

四层结构（系统 / 空间 / 项目 / 员工）已经存在，但**名字混用**、**落点不成体系**：

- 根被同时叫「办公目录 / 办公数据根 / 项目目录」——和「项目（群聊）」撞名；
- 最上层被叫「框架内置」——「框架」既是产品名又是级别名；
- 空间级目前没有落点（prompt / skills 只有项目级、员工级、系统级三层）；
- 每类注入各说一套「何时生效」，老板记不住。

本设计的四件事：

1. **命名定稿**：4 个逻辑级别的主名 + 别名，落到手册 / README / UI / 报错文案。
2. **落点定稿**：空间级附属统一收在 `openstaffs/`（可见、可版本化）；项目级、员工级平铺。
3. **技能来源扩展**：补上空间级技能 + `config.json` 的 `skillPaths`（外部技能库）。
4. **生效时机归拢**：把「何时生效」收敛为 3 档机制，与文件放哪儿无关。
5. **MCP 骨架**：只写文档（四层 × `mcp.json` 的约定），实现留给批次 4。

**非目标：**

- 不改 `projects/` 目录名、`project_name` / `project_id` 变量名、内部类型名（`Workspace` 等）；
- 不实现 MCP（只写约定文档）；
- 不做 prompt 模板的运行时覆盖（本轮**删除**该机制，见 §5）；
- 不做技能清单条数上限。

---

## 2. 决策记录

| # | 决策 | 说明 |
|---|---|---|
| D1 | **级别是逻辑级别** | 「系统 / 空间 / 项目 / 员工」描述的是**谁的内容、谁是权威方、改了影响谁**；文件夹只是它的落点。 |
| D2 | **指根一律「办公空间」** | 消灭「办公目录 / 办公数据根 / 项目目录」三种叫法。「项目」只指协作单位（群聊）。 |
| D3 | **「框架内置」→「系统内置」** | 级别名用「系统」，别名「框架 / OpenStaffs 本体」；技能一律说「系统内置技能」。 |
| D4 | **空间级附属收在 `openstaffs/`** | `openstaffs/skills/`、`openstaffs/mcp.json`（未来）。可见目录 = 可版本化、可随空间整包迁移。**不放 `.openstaffs/`**（机器私有、被 gitignore、Finder 里看不见）。 |
| D5 | **根目录只留门面** | `AGENTS.md`、`agents/`、`projects/` 是空间的门面；其余老板资产（技能、MCP）收进 `openstaffs/`。 |
| D6 | **环境段模板不再可覆盖** | 删除 `.openstaffs/prompts/` 覆盖机制。要加规矩写空间 `AGENTS.md`（追加注入、排在环境段之后）；要改环境段本身属系统级（改框架代码）。无存量使用，直接删，不做旧路径兜底。 |
| D7 | **`skillPaths` 路径语法** | 以 `~` 开头 → 家目录；绝对路径 → 原样；其余 → 相对**办公空间根目录**解析。去重、跳过非字符串 / 空串。 |
| D8 | **外部 `skillPaths` 的档位** | 算**空间级**；优先级链插在空间级之后、系统之前。作用域 = **所有会话**（私聊 / 群聊都注入）。 |
| D9 | **不设技能条数上限** | 清单是「名字 + 描述 + 路径」，正常规模开销可忽略；设上限反而造成「技能莫名消失」。 |
| D10 | **`skillPaths` 独立读取** | 与 `bossName` 一样单独读 `config.json`（`readSkillPaths`），不并进 `WorkspaceConfig`——它在「未配置模式」下也应生效，且 `conversations` 不该依赖「已配置」这一条件。 |
| D11 | **`openstaffs/` 不自动创建** | 只读不写：目录不存在则视为没有空间级技能（`listSkills` 本就容忍缺失目录）。迁移由老板自己决定。 |
| D12 | **清单快照语义不变** | 技能清单仍随会话创建固化（新开会话生效）；`SKILL.md` 正文仍按需 `read`、改完即时生效。 |
| D13 | **UI 侧栏标题保持「项目」** | 口语一致性靠手册；侧栏空格有限，不改。 |

---

## 3. 命名与落点（定稿）

**表 A · 逻辑级别**

| 级别 | 常用别名 | 是什么 | 逻辑上包含 | 权威方 | 改动代价 |
| --- | --- | --- | --- | --- | --- |
| 系统 | 框架、OpenStaffs 本体 | OpenStaffs 框架本身 | 内置模板、内置技能、内置工具 | 框架作者 | 改代码／升级框架 |
| 空间 | 办公空间、空间、办公室、运行实例 | 一个运行实例 + 指定的运行目录 | 该目录下全部 agents、projects 及其附属 | 老板 | 改文件即可 |
| 项目 | 群聊、群 | 空间内一个协作单位 | 项目成员 + 共享工作区 | 群成员 | 改文件即可 |
| 员工 | agent、职员、同事 | 空间内一个 Agent | 人格／记忆／技能／权限 | 本人（+老板） | 改文件即可 |

**表 B · 各级别内容的落点**

| 级别 | prompt（规范） | skills（能力） | MCP（外部能力） |
| --- | --- | --- | --- |
| 系统 | `src/prompts/` | `src/skills/` | `src/mcp.json`（未来） |
| 空间 | 空间根 `AGENTS.md` | `openstaffs/skills/` | `openstaffs/mcp.json`（未来） |
| 项目 | `projects/{项目}/AGENTS.md` | `projects/{项目}/skills/` | `projects/{项目}/mcp.json`（未来） |
| 员工 | `agents/{员工}/AGENTS.md` + `profile.md` + `MEMORY.md` | `agents/{员工}/skills/` | `agents/{员工}/mcp.json`（未来） |

**画面一 · 空间目录**

| 路径 | 级别 | 放什么 | 谁写 |
| --- | --- | --- | --- |
| `AGENTS.md` | 空间 | 空间总纲（prompt） | 老板 |
| `agents/` | 员工 | 每个 agent 的家（平铺）：`AGENTS.md + profile.md + MEMORY.md + skills/ + mcp.json` | 各员工本人 |
| `projects/` | 项目 | 每个项目（群聊）的家（平铺）：`members.md + AGENTS.md + skills/ + mcp.json` | 群成员 |
| `openstaffs/` | 空间 | 老板的能力与附属：`skills/`、`mcp.json` | 老板 |
| `.openstaffs/` | — | 机器私有：`config.json`（含密钥）、`state.sqlite`、`state.json` | 程序读写；老板改配置 |

别名只用于口语理解；文档正文一律用主名。

---

## 4. 三类机制的形态（别混）

- **prompt = 叠加**：四段全注入，宽 → 窄：环境段 → 空间总纲 → 项目规范 → 员工档案。
- **skills = 去重**：合成一份清单，越窄越优先：项目 → 员工 → 空间（`openstaffs/skills/` → 外部 `skillPaths`）→ 系统。
- **MCP = 注册**：不进 prompt 文本，是工具注册；每层一个 `mcp.json`，同名 server 窄者胜。

---

## 5. 环境段：不再可覆盖

- 现状：`promptTemplatePath(ws, kind)` 会先看 `.openstaffs/prompts/<kind>.md`，存在则覆盖系统模板。
- 改为：**只留系统内置**。签名简化为 `promptTemplatePath(kind)`（不再需要 `ws`，顺带从类型上断掉「空间能覆盖」的可能）。
- 要加规矩 → 写空间根 `AGENTS.md`（本就追加注入、排在环境段之后）；要改环境段本身 → 改框架代码（系统级）。
- 无存量使用，不保留兼容读；`renderEnvironment` 的「空模板 → 空段」守卫保留。

---

## 6. 技能来源：空间级 + 外部 `skillPaths`

**目录层**（`skillDirsFor`，越窄越优先）：

```
项目 → 员工 → 空间（openstaffs/skills/） → 外部（config.skillPaths，按书写顺序） → 系统
```

同名技能先出现者胜（`listSkills` 现有语义，不动）。

**新增路径辅助**（`src/domain/paths.ts`）：

```ts
export const SPACE_DIR_NAME = "openstaffs";
export function spaceDir(ws: Workspace): string;      // <空间根>/openstaffs
export function spaceSkillsDir(ws: Workspace): string; // <空间根>/openstaffs/skills
```

**新增配置读取**（`src/domain/config.ts`）：

```ts
/** 外部技能目录：config.json 的 skillPaths；~ 开头按家目录、绝对路径原样、其余相对办公空间根；去重、坏条目跳过。 */
export function readSkillPaths(ws: Workspace): string[];
```

- 文件缺失 / 坏 JSON / 非数组 / 全空 → `[]`（不崩、不报错）。
- 只解析、不校验目录是否存在（`listSkills` 本就容忍缺失目录）——路径写错表现为「技能没出现」，属可接受。

**接进装配**（`src/app/conversations.ts`）：

```ts
export function skillDirsFor(ws, relation, speaker, externalSkillDirs: readonly string[] = []): string[];
export function instructionsFor(ws, relation, speaker, externalSkillDirs: readonly string[] = []): string;
```

- 默认参数 `[]`，保持既有调用与测试可用；
- `specFor`（唯一的会话创建漏斗）里读一次 `readSkillPaths(ws)` 并传入 → 清单随会话快照固化（D12）。

---

## 7. 生效时机：3 档机制

| 机制 | 何时生效 | 属于这档的东西 |
| --- | --- | --- |
| 启动初始化 | **重启服务** | `config.json` 的供应商 / 密钥 / 端口；MCP server 注册 |
| 会话装配（进 instructions，快照） | **新开会话** | 环境段模板、空间 / 项目 / 员工 `AGENTS.md`、`profile.md`、`MEMORY.md`、技能清单、员工 `model` / `thinkingLevel` |
| 运行中按需读取 | **即时** | `SKILL.md` 正文（`read` 时读）、`permission.json`（每次写校验）、`members.md`（@ 路由与成员校验） |
| 直读展示 | **刷新页面** | `bossName`、员工 `alias` |

- **「快照」是刻意的**：保护 provider 的 prompt cache，并让会话可复现——不是 bug。
- **假象要写清**：`config.json` 改全局 `model` 后，新开会话就会显示新模型名，但供应商凭据还是启动时那份 → 一律以重启后为准。
- 手册只讲这条机制规则，每个配置文件 / 目录旁标注属于哪档，不再让老板背表。

---

## 8. MCP 骨架（只写文档，不实现）

- 每层一个 `mcp.json`：系统 = `src/mcp.json`；空间 = `openstaffs/mcp.json`；项目 = `projects/{项目}/mcp.json`；员工 = `agents/{员工}/mcp.json`（项目级、员工级平铺，不套 `openstaffs/`）。
- 合并：同名 server 窄者胜（项目 → 员工 → 空间 → 系统），不同名的都挂上。
- 凭据：不允许明文写进 `mcp.json`；密钥统一放 `.openstaffs/config.json`，`mcp.json` 只引用凭据名（语法与键名待批次 4 定，示例 `${config.mcp.<server>.<key>}`）。
- 权限：员工级 `mcp.json` 在员工写权限内（能力自扩，不在写权限层拦）；但凭据在老板独占的 `config.json` → 员工挂的 server 若需密钥，得请老板把凭据加进去。
- 生效：新增 / 改动 server 要**重启**才注册；某层是否生效随会话装配（新开会话）。

---

## 9. 涉及文件

**代码**

| 文件 | 改动 |
| --- | --- |
| `src/domain/paths.ts` | 新增 `SPACE_DIR_NAME` / `spaceDir` / `spaceSkillsDir` |
| `src/domain/config.ts` | 新增 `readSkillPaths` |
| `src/domain/prompt.ts` | `promptTemplatePath(kind)`：删覆盖机制；注释改「系统内置」 |
| `src/domain/skills.ts` | 注释改「系统内置技能」 |
| `src/app/conversations.ts` | `skillDirsFor` / `instructionsFor` 接外部目录；`specFor` 传 `readSkillPaths` |
| `src/server/startup.ts` | 3 处报错文案 + JSDoc 改「办公空间」 |
| `web/render.ts` | 不动（D13） |

**测试**

| 文件 | 改动 |
| --- | --- |
| `tests/domain/prompt.test.ts` | 删覆盖用例；`promptTemplatePath(kind)` 新签名 |
| `tests/app/conversations.test.ts` | 删覆盖用例；技能链含空间级 + 外部路径的用例 |
| `tests/domain/config.test.ts` | `readSkillPaths` 用例（三种路径写法、坏条目、去重、坏 JSON） |
| `tests/server/startup.test.ts` | 报错文案断言改「办公空间」 |

**文档**

| 文件 | 改动 |
| --- | --- |
| `src/skills/openstaffs-ops/SKILL.md` | 全景（加 `openstaffs/`、删 `.openstaffs/prompts/`）、级别定义表、技能来源、生效时机 3 档、MCP 骨架 |
| `src/skills/openstaffs/SKILL.md` | 「框架内置」→「系统内置」；空间级技能说法一致 |
| `README.md` | 命名统一（办公空间）、`skillPaths` 配置、`openstaffs/` 目录 |
| `docs/产品规划.md` | 命名与落点归档 |
| `AGENTS.md`（框架仓库） | 「项目目录」→「办公空间」 |
| `TODO.md` | 批次 3 勾选与「落地」注记 |

---

## 10. 验收标准

1. `npm test` / `npm run typecheck` / `npm run build:web` 全绿。
2. 启动报错文案里不再出现「办公目录 / 办公数据根 / 项目目录」；一律「办公空间」。
3. `.openstaffs/prompts/` 覆盖机制完全消失：`prompt.ts` 之外无引用，测试无覆盖用例。
4. `readSkillPaths`：`~/x`、`/abs/x`、`rel/x`（相对空间根）三种写法均解析为绝对路径且去重；坏 JSON / 非数组 / 空串条目安全跳过。
5. 技能链顺序断言：`项目 → 员工 → openstaffs/skills/ → skillPaths… → 系统`；同名先出现者胜。
6. `instructionsFor` 注入外部技能：`skillPaths` 指向的目录里的技能出现在清单里（私聊与群聊都注入）。
7. 手册与 README 中不再出现「框架内置技能」；`openstaffs/` 在目录全景里；级别定义表在册；生效时机为 3 档机制表述。
