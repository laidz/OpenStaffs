# OpenStaffs 架构与基座选型设计

> 状态：待评审 · 日期：2026-10-16 · 基座：Pi（`@earendil-works/pi-durable` / `pi-ai` / `chord`）
> 关联文档：`产品文档.md`（愿景/隐喻/路线图）

---

## 1. 背景与目标

**OpenStaffs** 是一个完全本地化、基于文件系统的"拟人化 AI 企业管理 OS"：文件夹就是员工，Markdown 就是灵魂，拉群就是立项，下载就是招募。产品文档已定下核心骨架：**状态/身份层（文件夹 + Markdown）与交互/协作层（消息）两层分离**，以及铁律"**每个员工只写自己的工作区 + 自己所在的项目文件夹，越界只读**"。

本设计要回答的是**工程落地问题**：这套架构由什么基座承载、如何映射、ACL 如何实现、MVP 做到哪。

**本设计的目标：**

1. 选定并论证**底层 agent 运行时（基座）**，明确"OpenStaffs 拥有什么 / 基座提供什么"的边界；
2. 给出**数据模型映射**（文件夹、群聊、员工 → 基座原语）；
3. 给出**关键流程**（@触发 / 广播 / 员工写文件 / 建群 / 待办）的落地；
4. 定下 **ACL 的 MVP 档位**及演进路径；
5. 圈定 **MVP（产品文档第 1 期）范围**与非目标、风险、待实测清单。

**非目标（本设计不覆盖）：** 云端人才市场、三方创作者生态、自主 Inner Loop、Peer Review（均为第 2/3 期）。

---

## 2. 结论：基座选型

**采用 Pi 作为底层运行时，主力使用 Pi Durable（`@earendil-works/pi-durable`）。**

### 2.1 为什么是 Pi 而不是 OpenCode

| 维度 | OpenCode | Pi | 对 OpenStaffs 的意义 |
|---|---|---|---|
| 集成形态 | 独立 server + SDK（要跨进程/HTTP 驱动） | **进程内 SDK**（`createAgentSession` / `Harness.open`） | 我们能**自己拥有工具层** |
| 权限模型 | 内置"工具名 + 路径 glob"，但 **bash 按命令匹配** | **无内置权限**，工具层完全交给我们 | 工具级 ACL 可做到硬（见 §6） |
| 文件写入限制 | `edit` 路径 glob **可被 bash 绕过** | 同样需要我们自己兜 bash，但**钩子/执行环境都在我们手里** | 见 §6 |
| 轻量/可定制 | 功能齐、体量大 | 极简内核，"primitives not features" | 贴合"OpenStaffs 只做上层规则" |
| 模型厂商 | 绑定 OpenCode 生态 | **model-agnostic**（15+ provider） | 契合"数据主权、不锁厂商" |
| 现成能力 | agent/权限/技能/MCP/会话/多 agent | 见 2.2 | — |

**关键结论**：OpenCode"没有内置权限"曾被当作 Pi 的缺点，实为优点——OpenStaffs 本就要自己拥有"组织/成员/权限/消息"的规则（产品文档 §2.5），Pi 把工具层让给我们，ACL 才能做硬。

### 2.2 Pi Durable 与 OpenStaffs 的映射（近乎一一对应）

| OpenStaffs 需要 | Pi Durable 直接提供 |
|---|---|
| 群聊 / 私聊 | conversation（thread = fork） |
| 员工（人格/记忆/技能） | per-conversation agent：model / instructions / tools / extensions / cwd |
| 只写自己 + 所在项目 | 每条会话自己的工具集 + `beforeTool` 钩子拦截 |
| SKILLS 挂载 | 每条会话"选装" extensions/tools（只存名字） |
| 消息流水 | **transcript**（SQLite 存储后端） |
| 记忆压缩（第 2 期） | compaction 任务（自带，自动 + 手动） |
| 待办/看板 | `defineDoc` documents（与 transcript 同事务提交） |
| 老板在浏览器实时看 | multiplayer：`viewState()` / `watch()` / `watchEvents()` |
| @触发 / 插话 | `submit()` 的 `whenBusy: steer / follow-up` |
| 崩溃重启不丢活 | 每步 checkpoint + `resume()` |
| 员工工作区隔离（硬档） | `env: ({ cwd, conversationId }) => ExecutionEnv`（可"一条会话一个容器"） |

### 2.3 风险隔离原则（必须遵守）

> **OpenStaffs 拥有状态（文件夹），Pi Durable 只当引擎。**

- 员工的灵魂/记忆/技能的**真相源永远在文件夹**（`profile.md` / `MEMORY.md` / `skills/`），不在基座；
- 基座的 per-conversation agent 配置是**运行期派生**，可从员工文件夹重新生成；
- 在 OpenStaffs 域层与 Pi Durable 之间放一层**薄适配（`HarnessPort`，见 §4）**，使 Pi Durable 的 experimental API 变更不渗透进产品代码。

---

## 3. 分层与所有权

| 层 | 谁拥有 | 内容 |
|---|---|---|
| **产品层** | OpenStaffs 自写 | 组织/文件夹→员工 的翻译、ACL 策略、IM UI、@路由、老板待办 |
| **适配层** | OpenStaffs 自写 | `HarnessPort`：把域操作（起员工、发消息、建群、读消息）翻译成 Pi Durable 调用 |
| **引擎层** | Pi Durable | conversation / transcript、durable task、storage、multiplayer view、compaction |
| **工具层** | Pi Durable + 我们的钩子 | `CodingTools`(read/write/edit/bash) + `beforeTool` 钩子裁决 ACL |
| **状态层（真相源）** | 文件夹 | `AGENTS.md`（员工入口）/ `profile.md` / `MEMORY.md` / `skills/` / `permissions.json` / `data/` / `members.md` |
| **协作层** | 基座 SQLite | 消息 = transcript entries |

**铁则（承自产品文档 §2.1）**：状态只在文件夹，协作只在消息，互不落地到对方。

---

## 4. 数据模型与映射

### 4.1 目录布局（真相源）

```
<公司根>/
├─ .openstaffs/
│  ├─ state.sqlite          # Pi Durable 存储（消息/任务/用量）
│  └─ config.json           # 供应商/模型/端口等运行配置
├─ AGENTS.md                # 公司级总纲 + 老板偏好（Pi 协议：自动加载）
├─ agents/
│  └─ <员工 id>/
│     ├─ AGENTS.md          # 【入口】Pi 协议：引入本员工的记忆/档案/职能
│     ├─ profile.md         # 档案：岗位/职责 + 人格（合并原 SOUL.md）
│     ├─ MEMORY.md          # 长期记忆（拟人核心；我们的约定）
│     ├─ skills/            # 技能（Pi/Agent Skills 标准：<name>/SKILL.md）
│     │  └─ <技能名>/SKILL.md
│     ├─ permissions.json   # 可写范围（默认：自己 + 所在项目）
│     ├─ data/              # 自持工作区
│     └─ children/          # 下级（子部门/职员）
└─ projects/
   └─ <任务名>/
      ├─ AGENTS.md          # 任务规范（Pi 协议：自动加载）
      ├─ data/              # 多方共享工作区
      └─ members.md         # 成员名单 = ACL
```

> **Pi 协议 vs 我们的约定**：`AGENTS.md` / `SYSTEM.md` / `APPEND_SYSTEM.md` 是 **Pi 固定协议**（Pi 从 agent 目录、当前目录及祖先目录自动加载）；技能遵循 **Pi / Agent Skills 标准**（技能 = 含 `SKILL.md` 的目录）。其余 `profile.md` / `MEMORY.md` / `permissions.json` / `members.md` 都是 **OpenStaffs 自己的约定**，由我们读取并渲染，Pi 并不要求。
> **原则：Pi 有协议的，就用协议；没有的，才自造。** 因此不设 `BOSS.md`（并入 `AGENTS.md`）、不设 `SOUL.md`（并入 `profile.md`）、不设 `SKILLS.md`（改用标准 `skills/<name>/SKILL.md`）。

> **员工目录的 `AGENTS.md` 是"入口"（必须）**：它**引入**该员工的记忆（`MEMORY.md`）、档案（`profile.md`）与职能——"要认识一个员工，从它的 `AGENTS.md` 读起"。
> - **技能不由 `AGENTS.md` 引入**：技能是 **Pi 的机制**（Pi 扫描技能目录，自动把每个技能的 name/description 注入系统提示）。我们只需把员工的 `skills/` 目录纳入 Pi 的技能发现路径，**不做二次登记**。
> - 员工在**自己目录内**工作（私活）时，Pi 会**自动加载**这份 `AGENTS.md`（它就在 cwd 及祖先链上）。
> - 员工在**群里发言**时 `cwd` 是项目文件夹，Pi 不会自动加载员工目录的 `AGENTS.md`；此时由 OpenStaffs 的**"员工加载器"以该 `AGENTS.md` 为入口**，按需读取并渲染成 conversation 的 agent 配置。
> - `MEMORY.md` 保留：**记忆是"拟人"的一个有效支点**，与档案分开、独立演化。

### 4.2 域模型 → Pi Durable 原语

| 域概念 | 基座原语 | 说明 |
|---|---|---|
| 员工 | 一个目录，**入口 = `AGENTS.md`** | 员工加载器以 `AGENTS.md` 为入口，引入记忆/档案/职能，渲染成 conversation 的 agent 配置 |
| 老板 | conversation 的 **User 一方**（人类） | **无 agent**；有"职责"范围，员工据职责给老板派活（人工任务 / 审核 / 授权） |
| 私聊 | **一条 conversation（单一持续，累加）** | agent 固定为该员工；`cwd` = 公司根；不新建，长度靠 compaction 压缩 |
| 群聊（`projects/<任务>/`） | **一条 conversation（"房间"）** | 房间日志天然 = transcript；`cwd` = 项目文件夹 |
| 发言（某员工在房间说话） | 切 agent + `submit` | 见 §5.1 |
| 消息 | transcript entry（`pi.user`/`pi.assistant`/`pi.tool-result`） | **唯一真相**（决策 B） |
| 员工灵魂/记忆 | `configure({ instructions })` | 员工加载器由入口 `AGENTS.md` 引入 `profile.md` / `MEMORY.md` 后渲染；文件夹是真相源 |
| 员工技能 | Pi 原生技能发现（`skills/<name>/SKILL.md`） | **纯 Pi 机制，不经 `AGENTS.md`**；只需把员工 `skills/` 纳入 Pi 的技能发现路径 |
| 成员制 ACL | `members.md` + `beforeTool` 钩子 | 见 §6 |
| 老板待办 | `viewState()` 派生的**未读标记** | **IM 面板上的小红点，不是独立面板** |

> **`cwd`（工作目录）**：Pi 的术语。一条 conversation 的 agent 有一个 `cwd`，决定 ①资源发现（`AGENTS.md`/技能/配置从哪找）、②上下文加载（`cwd` 及祖先链上的 `AGENTS.md` 自动加载）、③工具相对路径的基准。
> - **`cwd` 只决定"默认站在哪"，不决定"能写哪些"**；能写哪些由 ACL（自己目录 + 所在项目）判定。二者分工不同，不冲突。
> - 私聊 `cwd` = 公司根；群聊 `cwd` = `projects/<任务>/`（即**群聊的"共享工作区"**）。
> - 老板**无 agent**，他只是 conversation 里的 **User 一方**（即普通 chat 里的用户本人）。

### 4.3 "一个关系 = 一条 conversation"的取舍（决策记录）

**统一规则：一个"关系" = 一条 conversation，持续累加**——私聊（老板 ↔ 员工）与群聊（`projects/<任务>/`）皆然。

- **私聊**：一条 conversation，永久累加；员工记得与老板的**全部历史**（像长期同事）。长度由 Pi 的 compaction 自动压缩。**不新建会话**；员工"主动发起"也只是在这条私聊里发一条。
- **群聊**：一条 room conversation，员工发言时**切换 agent 配置**（`configure`）再 `submit`。
  - 优点：房间日志就是一条 transcript（贴合"聊天记录在 SQLite / 唯一真相"）；`@触发` = 切发言者，语义直白；UI 渲染简单。
  - 代价：每次切换员工会变更 system prompt → provider 提示缓存命中下降。MVP 阶段可接受。
- **备选（已考虑，未采用）**：
  - 群聊 = 每成员一条 conversation + 房间流为合并视图。优点：每员工缓存稳定、上下文天然隔离。代价：房间流是"合并派生"而非单一真相；跨员工可见需把他人消息镜像进各会话，复杂度高。
  - 私聊每次新建会话。代价：破坏连续性、与"拟人"和"一人一窗口"的 IM 直觉相悖。
  - （可选增强）Pi Durable 的 `fork` 可支持"主会话 + 派生话题线程"，保留但 MVP 不做。

> 员工的**持久记忆在文件夹**（`MEMORY.md`），不在 conversation 里；conversation 只承载"这条关系当下的对话上下文"。这正好实现两层分离。

---

## 5. 关键流程

### 5.1 @触发（定向）

1. 老板在房间发 `@alice 做X`
2. 路由层解析 `@alice` → 定位到该员工定义
3. 员工加载器以 `agents/alice/AGENTS.md` 为入口渲染 agent 配置 → `configure(roomConv, { model, tools, instructions })`
4. `roomConv.submit({ type: "input", content: "做X", entry: { kind: "chat.mention", data: { author: "boss", target: "alice" } } })`
5. `wait()` → 回答写入房间 transcript → `viewState/watch` 推给 Web UI

### 5.2 不 @（广播）

对全体成员**依次**（同一条 conversation 是串行的）执行"切 agent + submit"，各成员各自理解后行动，回答依次落在房间。

### 5.3 员工写文件（走工具层）

任何 `write`/`edit`/`bash` 工具调用都会先过 `beforeTool` 钩子 → 按"只写自己 + 所在项目"裁决（§6）。

### 5.4 建群 = 立项

在 `projects/` 下建同名文件夹（`AGENTS.md` + `data/` + `members.md`）→ 建对应 room conversation（`cwd` = 该文件夹）→ 成员写入 `members.md`。

### 5.5 老板待办 = IM 上的小红点

老板待办**不是独立面板**，而是 **IM 面板上的小红点（未读标记）**，由 `viewState()` 派生。来源：

- **群聊**：`@老板`（或自定义别名，如 `@Boss`）的消息
- **私聊**：员工对老板消息的回复，或员工**主动发起**的消息（主动发起 = 就在既有的那条私聊里发一条，**不新建会话**）

> 不建独立 TODO 文件，也不建独立面板。

### 5.6 首次配置（冷启动）

- **冷启动的现实约束**（产品文档已标注）：没有可用模型时无法进行任何 LLM 对话。
- 因此 **MVP 的首次运行**由一个**非对话的表单**完成：写入供应商与密钥到 `.openstaffs/config.json`；可选**种子免费模型**（如 OpenCode Go 的免费档）使首次对话开箱可用，但不得作为唯一依赖。
- **0 号员工（Staff0，对话式引导）本期不做**，移到第 2 期；届时才接管"拟人化"入职引导、招募与环境检查。

---

## 6. ACL 设计

### 6.1 铁律

> 每个员工只写：① `agents/<自己>/`；② 自己"在成员名单里"的 `projects/<任务>/`。越界一律只读。老板是唯一例外。

### 6.2 MVP：轻档（软边界）+ 预留硬档插槽

**机制**：`beforeTool` 钩子拦截每次工具调用。

| 工具 | 裁决方式 | 强度 |
|---|---|---|
| `write` / `edit` | 目标路径解析后比对允许 glob（`agents/<自己>/**` + 所在 `projects/**`） | **硬**（探针 A 已证实） |
| `codemode` 脚本 | 脚本内调用走 `executeTool`，同样过钩子（`call.parent` 可辨来源） | 可管 |
| 自定义 / MCP 工具 | 同样过钩子 | 可管 |
| `bash` | 命令白名单 + 路径启发式；retain 只读命令 | **尽力而为，可绕** |

**廉价加固**：默认不给 bash，或仅给只读命令（`cat`/`ls`/`grep`/`git status`）；白名单优先于黑名单；只挂员工必需的 skill/MCP。

**诚实的边界（Pi 官方安全文档原话）**：工作目录不是安全边界，无法阻止命令访问进程可达的其他路径。**轻档能防"误操作/顺手越界"，防不住"提示注入/敌对员工"。**

### 6.3 演进：硬档（真边界，第 3 期前必须）

Pi Durable 的 `env` 就是插槽：**每条 conversation 的工具调用都跑在我们为它构建的执行环境里**，可"一条会话一个容器"。届时 **alice 的容器只挂载 `agents/alice/` + 她所在的 `projects/*/`**，别人的目录根本不 mount——bash 物理上够不着。

分级（承 Pi 安全文档）：独立 OS 用户（中）→ 每 conversation 容器/VM（强，通常最优）。

**触发条件**：产品路线第 3 期"**下载第三方员工 = 招募**"上线时，员工变为不可信，硬档从"可选"变为"必需"。

> 产品文档"权限用文件系统/运行时天然表达"：**轻档 = 运行时的软表达，硬档 = 文件系统的硬表达**。

---

## 7. 本地服务与 UI 推流

- **本地 HTTP 服务**（Node）：提供 API + 静态资源；浏览器访问 `http://localhost:<port>`。
- **推流**：服务端对每条 conversation 订阅 Pi Durable 的 `watch()`（Chord 操作流），经 **WebSocket/SSE** 转发给浏览器；或对偏好"编码 agent 风格事件"的客户端用 `watchEvents()`。
- **UI（MVP）**：左侧员工/项目列表，右侧聊天主窗口；点击员工头像 → 以"员工档案"形式查看/编辑 `profile.md` / `MEMORY.md`（直接读写文件夹）。
- **多客户端**：Pi Durable 的 multiplayer 语义天然支持"晚加入/重连从当前视图开始、可 steer 在跑的会话"。

---

## 8. 技术选型

| 项 | 选型 | 理由 |
|---|---|---|
| 语言/运行时 | TypeScript / Node ≥ 22.19（本机 v24） | Pi 生态是 TS；与基座同进程 |
| 基座 | `@earendil-works/pi-durable` + `pi-ai` + `chord` | §2 |
| 存储 | SQLite（`storage/sqlite/node`，WAL） | crash 后一致；长时程首选 |
| 状态 | 本地文件系统 | 真相源 |
| 默认模型供应商 | OpenCode Go（可换任意兼容 provider） | 已验证客户端；`opencode-go` provider 内置 |
| 服务端 | Node HTTP + WS/SSE | 纯本地、Web |
| 前端 | Web（React 或等价） | 纯浏览器，无桌面端 |

---

## 9. MVP 范围与非目标

**范围内（对齐产品文档第 1 期）：**

1. 极简工作台 UI（员工/项目列表 + 聊天窗口）
2. 首次配置（**非对话**表单：供应商 + 密钥；可选种子免费模型）
3. 职场 IM 与记忆闭环：私聊 / 群聊（`projects/<任务>/` + `members.md`）/ `@触发` / 广播 / SQLite 消息流水 / 老板待办小红点
4. 员工档案可视读取与编辑（`profile.md` / `MEMORY.md`），可为员工创建/挂载技能（标准 `skills/<name>/SKILL.md`）

**非目标（本期不做）：** **0 号员工（Staff0，对话式引导）**、自主 Inner Loop、Peer Review、记忆压缩与自动进化、MCP 生态、人才市场、硬档 ACL。

---

## 10. 风险与开放问题

| 风险 | 影响 | 缓解 |
|---|---|---|
| Pi Durable **experimental**，API 可能变 | 升级可能破坏 | `HarnessPort` 薄适配隔离；锁定版本 |
| 轻档 ACL 是软边界 | 拦不住 bash 越界/注入 | MVP 仅用于可信员工；第 3 期前切硬档 |
| 冷启动无模型无法对话 | 首次配置须先有可用模型 | 首次运行用非对话表单写入供应商/密钥；可选种子免费模型 |
| 群聊单会话切 agent → 提示缓存命中下降 | token 成本上升 | MVP 可接受；必要时转"每成员一会话"备选 |
| 供应商用量/费率 | 成本 | 默认选便宜档；`usage` 按 conversation 可观测 |

**开放问题：**

- 老板的**"职责"**如何建模与存储（供 agent 判断何时该给老板派活：人工任务 / 审核 / 授权）？
  - 已定：老板**无 agent**、是 conversation 的 **User 一方**、**有职责**；细节（职责的字段 / 渲染 / 触发规则）待细化。

> 原"房间 `cwd` 语义"一问已澄清：`cwd` 只管默认路径基准，能写哪些由 ACL 判定，二者分工不同（见 §4.2）。

---

## 11. 待实测清单（spike 未覆盖）

- [ ] `SKILLS`（标准 `skills/<name>/SKILL.md`）：Pi 原生发现/挂载，以及如何按"员工 / 项目"作用域隔离
- [ ] `MCP`：`createMcpExtension` 连接与 per-conversation 暴露（1.0 内置）
- [ ] `codemode`：脚本调用是否被 `beforeTool` 钩子可靠裁决
- [ ] **硬档隔离**：自定义 `ExecutionEnv`（容器）验证 bash 越界被物理阻断
- [ ] `watch()` → WebSocket 浏览器推流的端到端

---

## 附录 A：探针证据（2026-10-16）

**探针 A · Pi coding agent SDK**（`@earendil-works/pi-coding-agent@1.3.0`）

- ✅ 进程内 `createAgentSession()` 连通 OpenCode Go / `deepseek-v4.1-flash`，工具调用与事件流正常
- ✅ `write/edit` 路径级 ACL 生效：`agents/alice/note.md` 放行；`agents/bob/evil.md` 被 `tool_call` 钩子拦下（文件未生成）
- ❌ `bash` 绕过：`echo pwn > agents/bob/evil2.md` 成功越界写入

**探针 B · Pi Durable**（`@earendil-works/pi-durable@1.3.0`）

- ✅ SQLite 打开 durable harness，根会话 submit/`wait` 正常回答
- ✅ 两条 conversation（群聊 + 私聊）并行 submit 均正常
- ✅ `viewState` 结构视图：`entries` + `docs=[pi.agent, pi.live, pi.inbox, pi.provider, pi.usage]`，usage 按模型计费
- ✅ 持久化：关闭后 sqlite 135KB，重开 root id 一致、entries 一致

> 探针代码为一次性验证产物，未纳入仓库。
