# TODO

> 整个文档就是任务清单：每条 = 一个任务（标题一行 + 说明若干）。做完才打勾。

## 批次 1 · 体验：pin 与气泡工具栏

- [x] **群聊红点逻辑优化（已读 → pin）**

  说明：现状是「打开房间即整房间已读」——每房间一个水位（单调不倒退），左侧红点 = 未读消息数。所以人在群里就自动已读、密集交流容易丢信息，也看不出红点对应哪条消息。改造方向：换成逐条 pin 标记。
  - pin 的语义：加图钉 = 给自己留提醒（不是「已读」概念，也不代表发给谁）。
  - 左侧列表的红点 = 已 pin 的消息数（没 pin 的不统计；自己发的消息没 pin，自然不计入）；私聊同样实现。
  - 存储要换：现在的已读是 .openstaffs/state.json 里的每房间水位（seen[房间] = 最大已见 entryId，单调不倒退），表达不了逐条状态 → 改成逐条 pin 状态（放哪、是否显性待定）。
  - 界面表现与入口见下一条「聊天气泡工具栏」。

- [x] **聊天气泡工具栏：复制、pin**

  说明：鼠标移到气泡上时出现工具栏（复制 / pin）；pin 是上面那条「红点逻辑」的逐条标记入口（唯一的 pin 入口）。
  - 范围：所有消息都能 pin、也都能复制——发给老板的、成员互聊的、老板自己发的，一视同仁。
  - 复制：复制该条消息的 Markdown 原文（不是渲染结果、也不是纯文本）——方便把员工产出直接贴到别处继续用。
  - pin：pin 了的气泡淡红底 + 图钉图标；再点一次取消，回到默认样式。未 pin 的消息保持默认样式。
  - 落点：web/ 的渲染与状态 + 后端 pin 状态存储与接口（见上一条「存储要换」）。

## 批次 2 · 会话语义：新开会话与待发队列

- [x] **群聊「新开会话」业务优化**

  说明：点「新开会话」仅做 UI 变化（不落盘、不建会话）；用户发出第一条消息，才算真正「新建会话」。
  - 收益：① 避免空内容会话创建；② 「新开会话」按钮前那个突兀、看不懂的下拉框可以移除了。

  **落地（2026-10-17）**：按钮只置「下一条消息开启新会话」标志（高亮 + 输入框上方提示，再点取消）；发送时带 `newSession`，**投递那一刻**才建会话——私聊 = 该员工，群聊 = 这条消息 @ 到的每个成员。成员下拉框已移除；`POST /api/rooms/{room}/new-session` 端点已删除（语义并入发送；员工侧 `new_session` 工具不动）。撤回 / 中断掉这条排队消息 → 不产生会话。

- [x] **排队中的消息要可见、可删除**

  说明：现在老板点发送后，若该员工正在跑（同成员的消息在排队），消息只是进了队列，UI 上什么都不显示——看起来「消息消失了」，等真正投递后又冒出来。要求：排队中的消息在消息区展示，并且能单条移除。

  - 展示：待发消息以「排队中」状态显示在消息区（灰／半透明 + 排队标识），按投递顺序排列；投递后原地变成正常气泡。
  - 移除：可单条删除——从队列里撤掉、不投递给员工（不是中断正在跑的任务）。
  - 落点：src/app/send.ts 的 KeyedQueue 现在只是 promise 串行链、没有条目句柄 → 要给待办条目加 id 与取消能力；http.ts 发送端点与 pump.ts（群回复 @ 触发的投递共用同一队列）；前端 web/ 展示排队态；SSE 需新增「入队／出队」事件。
  - 关联：中止（interrupt）时 harness.abort 会撤回排队未开始的输入——「移除我这一条」与「中止整个房间」语义要分清。

  **落地（2026-10-17）**：真正的排队在 **Pi 的 submission inbox**（durable），`KeyedQueue` 只串行 admission（不等待）——所以句柄与取消落在 **Pi 的 submission id** 上：`HarnessPort.submit()` 返回回执 `{id, status}`，新增 `withdrawSubmission()`（Pi `abortSubmission`）。
  - 新模块 `src/app/outbox.ts`（进程内待发表，只索引「谁在排队」）+ `GET /messages` 带 `queued` + SSE `room.queued` / `room.dequeued` + `POST /api/rooms/{room}/queue/cancel`（按 `roomMessageId` 撤掉该条所有没开始的投递；已开始的回 409）。
  - 前端：`#messages-part` 里按「消息」粒度合并出灰底「排队中」气泡（等待成员 + 撤回）；已有真气泡时只把「排队中：<成员>」贴上去，避免同一句话两个气泡；出队后兜底重拉房间补齐真气泡。
  - Pi 坑：`abortSubmission` 必须传**数值** submission id（字符串会 settle 记录却漏删 inbox 条目 → 撤回后仍会投递）；已在 `pi-durable.ts` 注释与测试锁定。


## 批次 3 · 空间层：命名、技能来源、生效时机

- [ ] **层级命名统一（含涉及的地方更新）**

  说明：现在是 4 层，但名字混用——根被叫「办公目录／办公数据根／项目目录」，最上层被叫「框架内置」。定稿：
  - 系统（系统内置）= src/prompts/、src/skills/
  - 空间（办公空间）= 办公空间根下的 AGENTS.md、prompts/、skills/
  - 项目（群聊）= projects/{项目}/
  - 员工 = agents/{员工}/
  - 要做：这 4 个名字写进手册／README／UI／报错文案；指根一律「办公空间」，中间层一律「项目（群聊）」，「框架内置技能」→「系统内置技能」。
  - 涉及：src/server/startup.ts（3 处报错文案）、web/render.ts（左侧栏「项目」）、README.md、docs/产品规划.md、src/skills/openstaffs*/SKILL.md。
  - 不动：projects/ 目录名、project_name／project_id 变量、内部类型名（Workspace 等）。
  - 一并写进文档——空间内文件夹定位：
    - .openstaffs/（隐藏）= 机器私有：含密钥的 config.json、运行时 state.sqlite、state.json；不放要版本化／随员工整包迁移的老板资产。
    - 其余凡老板手写的一律显性：AGENTS.md、agents/、projects/、skills/、prompts/。
    - 模板覆盖从 .openstaffs/prompts/ 移到 办公空间根/prompts/{dm,group}.md（老板手写、要版本化 → 必须显性）。无存量使用（现有办公空间没有 prompts/ 目录），直接换路径，不做旧路径兜底读。
  - 目标形态见「参考画面」（在批次 4 末尾）。

- [ ] **config.json 新增 skillPaths 项**

  说明：值为引用的外部 skills 目录（用户通常已有一大堆全局技能，各种 agent 工具都在引用），实现全局技能注入。
  - 与下面「技能来源扩展」合并实施。

- [ ] **技能来源扩展：空间级技能 + 外部 skillPaths**（与上面 skillPaths 条合并实施）

  说明：给技能补上「空间级」这一层，并支持引用外部技能目录。
  - 空间级落点 = 办公空间根/skills/：与 agents/{员工}/skills/、projects/{项目}/skills/ 形成三处同名对称，好找好说；不放 .openstaffs/（会被 gitignore、Finder 里看不见 → 能力包无法版本化、不能随员工整包迁移）。
  - config.json 新增 skillPaths：引用外部技能目录（老板的全局技能库，多个 agent 工具共用）。空间级 = 老板的地盘，员工写不进去。
  - 优先级链：项目 → 员工 → 空间 → 系统（同名先出现者胜；外部 skillPaths 算空间级，插入位置待定）。
  - 生效：技能清单随会话快照（新开会话生效）；SKILL.md 正文按需 read，改完即时生效。
  - 代码落点：src/app/conversations.ts 的 skillDirsFor()、src/domain/config.ts（读 skillPaths）、src/domain/skills.ts（支持外部路径）。
  - 待定细节：skillPaths 路径语法（绝对路径／相对办公空间根）、作用域（是否所有会话都注入）、清单条数上限。
  - 目标形态见「参考画面」（在批次 4 末尾）。

- [ ] **注入生效时机统一（整理 + 优化）**

  说明：每类注入各说一套「何时生效」，老板记不住；其实只由 3 种机制决定，跟文件放哪儿无关。

  现状真相（3 档）：
  - 启动初始化 → 要重启：config.json 的供应商／密钥／端口、MCP server 注册。
  - 会话装配时注入（进 instructions，快照）→ 要新开会话：prompt 全部（环境段模板、空间／项目／员工 AGENTS.md、profile.md、MEMORY.md）、skills 清单、员工 model。
  - 运行中按需读取 → 即时：SKILL.md 正文（read 时读）、permission.json（每次写校验）、members.md（@ 路由与成员校验）；alias／bossName 显示则刷新页面即见。
  - 假象来源：config.json 里改全局 model，新开会话就会显示新模型名，但供应商凭据还是启动时那份 → 一律以重启后为准。

  优化方向：
  - 手册只讲一条机制规则（启动=重启／注入=快照／按需读=实时），每个配置文件与目录旁标注属于哪档，不再让老板背表。
  - 写清「快照」是刻意的（保护 provider prompt cache、会话可复现），不是 bug。
  - UI 给提示：改了需新开会话的文件后，界面提示「需新开会话生效」（可选）。
  - 与第 3 条「新开会话业务优化」衔接：若按钮只做 UI 变化、第一条消息才真建会话，要明确「何时算生效」。

  涉及：src/skills/openstaffs-ops/SKILL.md（改动生效方式表）、README.md、web/（可选提示）。

- [ ] **MCP 骨架：只写文档，不实现**

  说明：把「4 层 × mcp.json」的约定写进手册与文档，让实现在批次 4 有据可依。本任务只动文档。
  - 每层一个 mcp.json：系统 = src/mcp.json；空间 = 办公空间根/mcp.json；项目 = projects/{项目}/mcp.json；员工 = agents/{员工}/mcp.json。
  - 合并规则：同名 server 窄者胜（项目 → 员工 → 空间 → 系统），不同名的都挂上。
  - 凭据：一律引用 .openstaffs/config.json，mcp.json 里不写明文。
  - 生效档位：启动注册（属三档机制里的「重启」档）。
  - 落点：src/skills/openstaffs-ops/SKILL.md（目录树 + 生效方式表）、docs/产品规划.md、参考画面（文末「MCP 细则」）。

## 批次 4 · MCP 实现

- [ ] **MCP 四层一致（实现）**

  说明：按批次 3 定下的骨架，把 4 层 mcp.json 真正接起来。风险性质与批次 3 不同——这是接外部进程、扩大工具面（员工可自挂 server = 本地任意进程执行面），需要独立的验收标准与一次安全审阅。
  - 解析与合并：读 4 层 mcp.json，按同名窄者胜合并成会话级 server 集。
  - 凭据：从 .openstaffs/config.json 取，按骨架定的引用语法解析；缺失时明确报错，不静默降级。
  - 生命周期：启动／健康／超时／崩溃重连；连不上不能拖死会话启动。
  - 工具注册：接进 pi-durable registry（工具多时走 deferred + tool_search），按会话过滤出可用 server。
  - 生效：新增／改动 server 要重启进程。
  - 验收要有：连不上、卡死、工具名冲突、凭据缺失、员工自挂 server 的边界，各一条。
  - 落点：src/harness/pi-durable.ts（注册）、src/domain/config.ts（凭据）、新的 mcp 模块、测试与手册。

### 参考画面

供批次 3（层级命名）与批次 4（MCP）对齐术语用；做文档更新时按这两张表写。

#### 画面一 · 空间目录

| 路径 | 层 | 放什么 | 谁写 |
| --- | --- | --- | --- |
| AGENTS.md | 空间 | 空间总纲（prompt） | 老板 |
| agents/ | 员工 | 员工能力包：AGENTS.md + profile.md + MEMORY.md + skills/ + mcp.json | 各员工本人 |
| projects/ | 项目 | 项目（群聊）：members.md + AGENTS.md + skills/ + mcp.json | 群成员 |
| skills/ | 空间 | 空间技能（本次新增） | 老板 |
| prompts/ | 空间 | 环境段模板覆盖：dm.md、group.md | 老板 |
| mcp.json | 空间 | 本空间挂载的 MCP server（未来） | 老板 |
| .openstaffs/ | — | 机器私有：config.json（含密钥）、state.sqlite、state.json | 程序读写；老板改配置 |

#### 画面二 · 4 层 × 3 类注入

| 层 | 位置 | prompt | skills | MCP |
| --- | --- | --- | --- | --- |
| 系统 | src/ | prompts/{dm,group}.md（兜底模板） | skills/ | mcp.json（未来） |
| 空间 | 办公空间根/ | AGENTS.md + prompts/*.md | skills/ + config.skillPaths | mcp.json（未来） |
| 项目 | projects/{项目}/ | AGENTS.md（项目规范） | skills/ | mcp.json（未来） |
| 员工 | agents/{员工}/ | AGENTS.md + profile.md + MEMORY.md | skills/ | mcp.json（未来） |

三类机制不同，别混：
- **prompt = 叠加**：四段全注入，宽→窄：环境段 → 空间总纲 → 项目规范 → 员工档案。
- **skills = 去重**：合成一份清单，越窄越优先：项目 → 员工 → 空间 → 系统。
- **MCP = 注册**：不进 prompt 文本，是工具注册；四层一致——每层一个 mcp.json，同名 server 窄者胜（项目 → 员工 → 空间 → 系统），不同名的都挂上。

MCP 细则（骨架随批次 3 写进文档；实现见批次 4）：
- 凭据：不允许明文写在 mcp.json。密钥统一放 .openstaffs/config.json（机器私有、不进版本库、权限 600），mcp.json 只引用凭据名（语法与键名待定，如 ${config.mcp.<server>.<key>}）。
- 权限：员工级 mcp.json 在员工写权限内，允许员工自己挂 server（能力自扩，不在写权限层拦）；但凭据在 config.json（老板独占）→ 员工挂的 server 若需密钥，得请老板把凭据加进 config.json。
- 生效：新增／改动 server 要重启进程才注册；某层是否生效随会话装配（新开会话）。

生效时机：prompt 与 skills 清单 = 新开会话；skills 正文 = 改完即时生效；MCP = 新增 server 要重启（见 MCP 细则）。

第四层术语：定「员工」（手册／UI／工具文案都在用）；「职员」只作口语，不进文档。

## 批次 5 · 会话信息与模型配置

- [ ] **会话信息展示：模型／供应商／上下文用量**

  说明：UI 上显示当前会话的模型与供应商（model 字段全值，如 provider/modelId）、以及上下文大小与使用比（如「200K，20%」）。
  - 口径：显示该会话**实际在用**的值——model 与思考强度都是会话创建时固化的快照，不是配置文件的现值（与「生效时机」口径一致）。
  - 数据来源（已核实）：pi-durable 有 per-conversation 用量记账（pi.usage）与 compaction 的 contextWindow／reserveTokens；pi-ai 的模型目录带 contextWindow。需要后端新增接口／SSE，把「会话 → model 全值 + 已用上下文 + 模型窗口」给前端。
  - 落点：src/harness（读会话 agent.model 与 usage）、src/server（新接口或事件）、web/（信息条）。

- [ ] **思考强度可配置：补齐到所有能配模型的地方**

  说明：现状是**只有员工级能配**——agents/{员工}/config.json 的 thinkingLevel（employee.ts 解析 → conversations.ts 装配 → 传给 pi 会话）；运维手册只露出一行「thinkingLevel｜思考级别（可选）」，没写取值范围。
  - 缺的：全局 config.json 没有（WorkspaceConfig 只有 providers／model／port）；新开会话默认值没有（SessionDefaults 只有 model）；UI 没有入口。
  - 取值范围：**不能写死**。档位候选是 off／minimal／low／medium／high／xhigh／max，但每个模型只支持其中一部分（pi-ai 的 Model 带 thinkingLevelMap：缺键用供应商默认、null 表示该档不支持），不同供应商能不能翻译出某个档也不一样（响应里另有 providerThinkingLevel 是供应商原生档）。
  - 因此：UI 与校验都要**按所选模型动态取可用档位**（从模型目录读 thinkingLevelMap）；手册不列固定清单，只写「档位由模型决定，UI 会列出可选项」。
  - 现状有个口子：员工级配的 thinkingLevel 直接透传（未校验），配了模型不支持的档会怎样（供应商拒绝？静默忽略？）要先确认再定校验策略。
  - 优先级与兜底：思考强度是跟 model 走同一套层级（员工 > 全局），还是各自独立？先定清楚再实现；现有行为是 model 非法时 thinkingLevel 仍保留。
  - 落点：src/domain/config.ts、src/domain/types.ts、src/app/conversations.ts、web/、src/skills/openstaffs-ops/SKILL.md。

## 备注

- 在途／进行中：批次 1 已开工；feat/permission-request 上还有未提交的授权卡片 UI 改动（7 个文件）。其余批次开工时从 master 切分支。
- MCP 四层一致（每层一个 mcp.json）已定形：骨架随批次 3 写进文档，实现见批次 4。
