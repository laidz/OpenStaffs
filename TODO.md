# TODO

> 整个文档就是任务清单：每条 = 一个任务（标题一行 + 说明若干）。做完才打勾。
>
> **写法约定（重要）**：本文件只写**现状口径**与**还没做的事**。已退役的方案（多目录 `AGENTS.md` / `profile.md` / 四层 `mcp.json` / `permission.json` / `members.md` …）不再在这里出现——要考古去 git 历史与 `docs/superpowers/plans/`。
> 后两节（**踩过的坑** / **已定口径**）比任务本身更该先读：它们是不许再犯、也不许再争的结论。

## 待做

### 产品与体验

- [ ] **Staff0 引导配置（冷启动）**
  说明：没有 API Key 就无法用 LLM，引导本身有冷启动难题。目标是 staff0 首启后引导老板把 `openstaffs/.data/config.json` 填起来（供应商 / 密钥 / 模型），填完能自检并给出下一步。当前 staff0 只能被对话使用，不主动引导。
- [ ] **消息查询：全文 / 时间段**
  说明：现在员工只有 `room_history`（最近 N 条）。消息库（`openstaffs/.data/messages.sqlite`）已有结构化行，缺的是按时间段与关键字的查询能力（工具 + 检索实现），以及是否给 UI。
- [ ] **员工档案 UI 编辑**
  说明：人格 / 记忆 / 技能 / 模型目前只能改文件。目标是在 UI 里看和改，并且改 `*.agent.config.json` 仍走 attenuation（不能变成绕过权限的后门）。
- [ ] **能力雷达图 / 技能证书**
  说明：把员工的 `skills` 与 `mcp` 引用可视化（第 2 期「产品化与深度拟人」的第一条）。
- [ ] **自主推进（Inner Loop）**
  说明：员工拆解目标后自主推进，系统按节拍器自动推进下一步，不用老板每次催。现状只有 `pump`（清未回复的尾巴），没有目标级别的推进。
- [ ] **员工交叉审计（Peer Review）**
  说明：A 产出 → 自动唤醒 B 质检 → A 修正，老板只验收。现状需要老板手动在群里 `@` 质检人。
- [ ] **记忆压缩与自动进化**
  说明：长会话后自动总结经验、更新记忆并向老板汇报。现状是原生记忆靠员工自觉 `memory_*`，没有自动压缩。

### 工程债

- [ ] **`domain/access-control.ts` 名不副实**
  说明：P1 时代的写权限模块，现在只剩 `parseMembers` / `projectsOf`（真权限在 `permissions/*`）。建议并入 `domain/project.ts`，别让人以为权限逻辑还在这。
- [ ] **建群缺少通道**
  说明：删掉 `project.createProject` 后，建群只剩「手写 `projects/<id>.project.config.json`」。若要 UI / staff0 建群，需要重写（含 id 校验 + 默认 permissions 表），不要再留一个只有测试在用的孤儿函数。
- [ ] **拆大文件**
  说明：`web/main.ts`（670 行）与 `src/server/http.ts`（578 行，15 条路由的 if 链 + 端点逻辑内联）是后续加功能的主要摩擦点，建议按房间 / 会话 / 配置分组拆。
- [ ] **补 UI 状态机的测试**
  说明：`web/` 下 api / composer / render / state / sse / markdown 都有测试，唯独最大的 `web/main.ts`（会话切换、新开会话就绪态、排队气泡合并、pin、信息条刷新）没有——最容易回归的地方。
- [ ] **MCP 遗留小风险按需修**
  说明：见「踩过的坑」最后一条的 Minor 清单。

## 踩过的坑（改这块代码前必读）

- **前端 live 流式气泡按「成员」清，不按 convId**：正式消息来自库行视图（`toRoomMessage` 的 `convId` 恒为 `"store"`），而流式气泡的键是 Pi 的 convId —— 按 convId 清就是删 `live["store"]`，永远删不掉，消息末尾会留一个截断的残影气泡（看起来像「最后一段内容丢了」）。同理：`run end` 清掉 live 后必须重画 live 区，否则 DOM 里的残影不消失。
- **前端界面状态的真相源只有 State，本地缓存只存「草稿」这类非权威数据**：输入框草稿走 `web/drafts.ts`（`localStorage`，按房间键、空串即删、读写失败静默），因为它不属于服务端状态也不该进 `State`（否则每个按键都要过一次 reduce + 重画）。全量重画（`renderAll`）后必须 `restoreDraft()` 把草稿填回——曾经的毛病是切会话 / 看会话详情回来，没发出去的字全丢。
- **live 气泡的状态行必须常驻、昵称必须取 alias**：曾经状态行只在「工具栈非空」时渲染 —— 工具一结束整行就消失，气泡高度塌陷 → 消息列表肉眼可见地跳；且 `run start` 不建 live（等第一段增量才出气泡），用户看不到「刚开始干活」。现在 `Live.activity` 在 run 期间**恒非空**（思考 / 输出 / 执行工具三态）、`run start` 即出气泡、状态行 CSS 固定行高（`min-height` + 单行省略），昵称取 `state.employees` 的 alias（回落 id），不再把 agent_id 顶在气泡上。**状态行必须反映真实阶段**：模型生成工具调用参数（`toolcall_start`）→「正在准备调用 X…」，真正执行（`tool_execution_start`，带 `argsHint`）→「正在执行 X：<命令/路径>」；只映射 text/thinking 增量会把「生成参数」误标成「正在思考」，而毫秒级工具（read、write、memory_*）的 start/end 一闪就过，视觉上只剩思考。工具栈按名字出栈（并行调用不能用简单弹栈）。
- **Pi 的 submission id 必须传数值**：`abortSubmission` 传字符串会「settle 记录却漏删 inbox 条目」→ 撤回后仍会投递。已在 `src/harness/pi-durable.ts` 注释与测试里锁定。
- **MCP 心跳不能杀在跑的调用**：有工具调用在途时**必须跳过心跳**（曾实测 5.2s 就中断了一次允许 60s 的调用）；重连要「连续 2 次失败」才做，且心跳要防重入。
- **MCP 启动必须整体受超时约束**：`initialize` 与 `tools/list` 都要受 10s 启动超时，分页设上限（50 页）——否则一个卡死的 server 能拖住整个进程启动。
- **MCP 凭据不能回显**：凭据插值进 `command` 时，spawn 失败只能报错误码，不能带出命令原文（会漏明文密钥）。密钥优先放 `env`，写进 `args` 会在 `ps` 里可见。
- **MCP 关闭要覆盖「连接中」**：`close()` 必须等在途 client 收尾，否则 shutdown 后还会变 ready / 留孤儿进程；子进程清理由 SIGTERM → SIGKILL 走进程组。
- **已知未修（Minor，接受现状）**：首次连接失败不自动重试（等重启）；`mcps.json` 非 ENOENT 的读取错误被当作空且不报错；不同 server 名 sanitize 后可能撞工具名（`a-b` 与 `a_b`）；工具名无 64 字符上限；工具输出无大小上限；stdout 行缓冲无上限；管理器 `errors()` 无界增长。

## 已定口径（别再重复争论）

- **开发阶段**：破坏性更新可接受；不为老格式 / 老配置写兼容，不留历史包袱。零引用即删，不留「以后可能用得上」的孤儿代码。
- **四类 `*.config.json` 同构**（space / department / project / agent），只有一套解析器 `src/config/*`；`prompt` / `skills` / `mcp` 一律**累加**；`permissions` 只在**项目 + 员工**两层累加。
- **MCP 定义只有全局单份** `openstaffs/mcps.json`，各层用 `mcp: ["<名字>"]` 按名引用；server 名只允许字母 / 数字 / `_` / `-`，名字本身就是工具前缀与凭据键。
- **生效时机只有 3 档**：启动初始化 = 重启；会话装配 = 新开会话（快照是刻意的：保护 provider prompt cache、保证会话可复现）；运行中按需读取 = 即时。逐项归属见 `openstaffs-ops` 技能，别在别处另立一套说法。
- **权限按工具 → 路径**：`attenuation` 只把 `write` 卡在有效集内；`bash` 是**软边界、不是沙箱**；`*.agent.config.json` 是硬保护（只有 staff0 与授权流程能写）。
- **房间视图读自有消息库**（`openstaffs/.data/messages.sqlite`），不读各成员 transcript；transcript 只服务「某条会话的原文」端点。
- **文档即契约**：能力变更同步 `src/skills/openstaffs/SKILL.md`、运维变更同步 `openstaffs-ops/SKILL.md`、上手同步 `README.md`、路线图同步 `docs/产品规划.md`（表见 `AGENTS.md`）。

## 已完成（历史，不再展开）

- 批次 1 体验：pin 即红点、气泡工具栏（复制 Markdown 原文 / pin）。
- 批次 2 会话语义：`新开会话` 延后到首条消息投递才建会话；排队中可见、可单条撤回。
- 批次 3 空间层：层级命名统一、技能来源扩展（空间级 + 外部 `skillPaths`）、生效时机整理。
- 批次 4 MCP：连接 / 心跳 / 重连 / 工具注册（配置形态后来收敛为全局单份 `mcps.json`）。
- 输入框草稿：按房间键（`dm:` / `group:`）存 `localStorage`，切会话 / 进会话详情 / 全量重画后自动填回（纯 UI 缓存，不进 State、不上服务端）。
- 批次 5 会话信息：模型 / 思考强度 / 上下文用量展示；思考强度可配到全局与员工。
- 其后：统一配置（四类 config 同构）、组织树 + 主管穿透、按工具权限 + 异步授权流程、原生记忆、definition model、自有消息库、系统级 prompt 由框架自持、staff0 空间管家。
- 2026-10-26：清掉 12 个零引用导出与旧格式残留（见 `git log`）。
