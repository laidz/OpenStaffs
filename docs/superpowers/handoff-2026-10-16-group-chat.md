# 第三份工作交接（群聊协作增强期）

> **状态：已归档（2026-10-17）**——本文描述的「群聊协作增强」三个任务均已完成并合入 master；实际落地方式与当时设想的对照，见各任务下的「✅ 落地」注记。本文保留为历史交接记录，勿再按 §5 行动。
>
> 本文写作时的定位是一段**可直接粘贴给下一个 session 的交接 prompt**。你（下一个 session）没有前面的对话上下文，先读本文档与"必读"清单。

**工作目录**：`/Users/laidezhong/Desktop/OpenStaffs`（Mac mini M2，macOS 26；Node ≥ 22.19）
**你的任务**：完成三个"群聊协作增强"任务（见 §2）。仓库已完成两期（核心引擎 + 服务端/UI），master 干净、150/150 测试绿、已推送 `github`。

## 0. 流程（按 superpowers 走）

1. `brainstorming`：先与用户确认设计——**任务 1 与任务 2 强耦合，建议进同一份 spec**；任务 3 独立小改（但措辞与 1/2 的结果相关，建议一起定稿）。
2. 写 spec 到 `docs/superpowers/specs/` → 用户审 → `writing-plans` 出计划 → 用户审并选执行方式（默认 `executing-plans` inline；也可 subagent 逐任务）。
3. 逐任务 TDD → 收尾派 fresh-context 复审 → 修 Critical/Important → squash 回 master → push。

**动手前必须与用户确认**（§2 已标"待定"）：① 员工 @ 的**防循环策略**；② 聊天记录注入的**增量口径与注入形态**（影响体验与 token 成本）。

## 1. 背景与现状（已锁定，不要重新讨论）

- OpenStaffs：本地 AI 办公室。**状态真相源在文件夹；消息真相源 = Pi transcript**；群聊 = **每成员一条独立会话、按需创建**；cwd：私聊 `agents/<id>/`、群聊 `projects/<id>/`。
- **@ 触发现状**：**只有老板**的消息经 `planRouting` 路由（~~`@谁谁接`；不 @ 广播全员~~）——**（2026-10-17 已过时：广播取消、无 @ 即 400；且 @ 只在正文开头前缀块生效；界面端为勾选式定向）**；**员工回复里的 @ 完全不解析、不触发**。
- **成员上下文现状**：各成员会话**互相看不到对方的发言**（独立 transcript）；`members.md` 只用于服务端路由、从不注入员工上下文。老板的指令对"被触发的成员"可见（广播时每人一份副本）；成员回复只在各自会话。
- **会话快照**：instructions 在**会话创建时固化**（根 AGENTS.md → 项目 AGENTS.md → 员工 AGENTS.md/profile/MEMORY → 技能清单）；会话中改文件不生效，新开会话生效。
- 启动（框架与办公数据强制分离）：`npm start -- <项目目录> [端口]`；端口优先级 启动参数/`OPENSTAFFS_PORT` > config.json > 4319。
- **关键实测事实**（省得重查）：
  - Node strip-only：代码**不得用参数属性 / enum / namespace**（`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`）。
  - Pi 事件：assistant/user 落盘走 `message_end`；`watchEvents` 要求数值 ConversationId（适配层已处理）；`SystemMessage.content` 恒空、内容在 `sections`。
  - **entryId 全局单调**（SQLite 单表分配）——跨会话合并排序与"水位增量"都基于它（见 `src/app/rooms.ts`）。
  - `submit` 支持自定义 entry `{kind, data}`（如 `chat.message` + `data.author`）与 `requestId` 去重。
  - pump 的 watch 回调**必须整体自保**（listener 抛错会被 Pi 静默终结订阅）。
  - 合并视图去重：boss 广播消息按 `data.roomMessageId` 取最小 entryId；显示层按 kind 过滤合成条目（`pi.compaction`/`pi.reset` 等）。

## 2. 三个任务

### 任务 1：支持群里 @ 其他成员

- **现状**：见上——员工 @ 无解析、无触发。
- **目标**：员工在群聊回复里写 `@bob`（群成员 id）→ 触发 bob——把内容投递到 bob 的群会话，语义与老板 @ 一致。
- **待定（brainstorming 定）**：
  - **防循环（必答）**：A@B → B@A 会死循环。候选：① 员工触发的投递**不再解析 @**（深度=1，最简、物理切断，推荐）；② 限层数（如 3 层）+ 轮次预算；③ 冷却。代价要跟用户说清。
  - **触发点**：员工回复落盘事件（`HarnessEvent.message` / `ServerEvent.room.message`）后解析其文本？pump 是纯推流，建议新编排点（复用 `src/app/send.ts` 的 `KeyedQueue` 串行）。
  - **投递内容与标注**：原回复全文（含 @）？来源标注怎么写（配合任务 2 的"明示谁说的"）。
  - **显示**：转发副本在老板合并视图的去重（复用 `roomMessageId` 思路或新 kind 标记）。
- **代码位置**：`src/domain/mention.ts`（parseMentions）、`src/app/routing.ts`（planRouting）、`src/app/send.ts`（sendToRoom/KeyedQueue）、`src/server/pump.ts`（落盘事件）、`src/app/rooms.ts`（显示去重）。
- **✅ 落地（2026-10-17 核对）**：实际以 `send_message` 工具实现——员工用 `member:<成员id>` 在**当前群**触发成员（即 @他）；员工回复里的**文本 `@` 不解析、不触发**（不走"文本解析"路线，天然无死循环）。防循环：本版本不做代码级限制，靠系统提示词与 `openstaffs` 技能的「@ 他人的节制」约束。代码：`src/tools/registry.ts`（send_message）、`src/app/conversations.ts`（openGroup）；提交 `9e917c3`。

### 任务 2：群聊天记录对全体成员可见（@某人时带上新增记录、明示谁说的）

- **现状**：成员间互不可见（见上）。
- **目标**：给某成员投递（@ 触发）时，把它**没见过的群聊新增记录**一并带上，**标注发言人**（老板 / 各成员 id 或 alias）。
- **待定（brainstorming 定）**：
  - **增量水位**：建议 = 该成员会话里的**最大 entryId**，取房间合并视图（`mergeRoomMessages`）中 `> 水位` 的消息——天然包含老板的定向消息（用户要求"所有成员可见"）。新成员/新会话水位=0：要不要限"最近 N 条"防历史轰炸？
  - **注入形态**：作为触发消息的**上下文前缀块**（如 `[群聊记录]\n老板：…\n爱丽丝：…\n[结束]\n@bob 请评审`）还是逐条独立 entry？前者简单直观；后者 transcript 语义干净但显示去重要小心。
  - **落盘与显示**：转发记录若落盘成 entry，别让老板合并视图重复显示（参考既有 kind 过滤策略）。
  - **缓存**：只在会话尾部追加，不要动前文。
- **代码位置**：`src/app/rooms.ts`（mergeRoomMessages/全局序）、`src/app/conversations.ts`（roomTranscripts）、`src/app/send.ts`、`src/harness/pi-durable.ts`（submit entry 机制）。
- **✅ 落地（2026-10-17 核对）**：实际以 `room_history` 工具实现——成员**按需主动**读取某个房间的聊天记录（`room` 缺省 = 当前房间，也可传 `dm:<员工id>` / `group:<项目id>`；含发言人），而非"触发投递时自动注入增量前缀"。代码：`src/tools/registry.ts`（room_history）、`src/app/rooms.ts`（mergeRoomMessages）；提交 `9e917c3`。

### 任务 3：环境告知

- 在 `instructionsFor` 快照**最前**加框架生成的"环境段"（会话创建时固化；约 100 token）。**草案已与用户定**：
  - 群聊（`@alice` 在「演示项目」，成员 alice、bob）：
    ```markdown
    你由 OpenStaffs（本地 AI 办公室）驱动，是员工「爱丽丝」（alice）。
    当前会话：项目群聊「演示项目」；群成员：爱丽丝（alice）、Bob（bob）。
    工作目录：/…/projects/demo——协作产出写在这里（约定 data/ 放成果）。
    你与其他成员各自独立对话、互相看不到对方会话；要让别人知道的内容请落到工作区文件。
    群里只有老板用「@成员id」点名触发；你的回复会显示给老板。
    ```
  - 私聊：
    ```markdown
    你由 OpenStaffs（本地 AI 办公室）驱动，是员工「爱丽丝」（alice）。
    当前会话：与老板的私聊。工作目录：/…/agents/alice（你的工作区）。
    ```
- **注意**：任务 1/2 落地后，末两句事实会变（成员之间可见、成员可互相 @）——所以任务 3 的**措辞应与 1/2 的 spec 一次定稿**（建议在 1/2 spec 之后做，或并入同一 spec 的最后一节）。
- **代码位置**：`src/app/conversations.ts` 的 `instructionsFor`、`tests/app/conversations.test.ts`、README/spec 同步。
- **✅ 落地（2026-10-17 核对）**：环境段已实现——模板 `src/prompts/dm.md`（私聊）/ `group.md`（群聊）；变量集中在 `src/domain/prompt-vars.ts`（`agent_name`、`agent_id`、`boss_name`、`workdir`、`project_name`、`project_id`、`members`、`member_count`）；可用项目目录的 `.openstaffs/prompts/` 覆盖；会话创建时固化。成员间"互不可见 + 用 `send_message` 触发"的事实已同步进模板措辞。提交 `a6b6c48`。

## 3. 必读（按顺序）

1. `docs/superpowers/specs/2026-10-16-openstaffs-architecture-design.md`（架构总纲；§4.3 群聊=每成员一条会话、§5.1/5.2 @触发/广播）
2. `docs/superpowers/specs/2026-10-16-openstaffs-server-ui-design.md`（D1–D15；§5.1 发送编排、§5.2 合并视图、§6.2 SSE 事件）
3. `docs/superpowers/plans/2026-10-16-openstaffs-server-ui.md` 的**执行日志**（Ruling 汇总 + 关键实测事实 + 已知偏差）
4. `README.md`
5. 源码：`src/app/send.ts`、`src/app/routing.ts`、`src/app/rooms.ts`、`src/app/conversations.ts`、`src/server/pump.ts`、`src/domain/mention.ts`

## 4. 纪律

- 验证：`npm test && npm run typecheck`（写作时基线 150/150；功能演进后以当前为准——现为 191/191）。
- git：本地分支开发、**不 push 分支**；完成后 **squash 一条**回 master；**不要 git pull**；远程名是 `github`（HTTPS 凭据：`git -c credential.helper='!f() { echo username=laidz; echo password=$(gh auth token); }; f' push github master`）。
- 改动行为后跑一遍手动验收（`docs/手动验收清单.md`，原 README 清单）；文档同步遵循仓库 `AGENTS.md` 的全覆盖矩阵（能力→`openstaffs` 技能；运维→`openstaffs-ops` 技能；上手→`README.md`；愿景→`docs/产品规划.md`）。
- **动手前先问用户**：任务 1 防循环策略、任务 2 增量/注入形态（这两个直接决定体验与成本）。

## 5. 现在开始

> *（本节为写作时的启动指令；三个任务均已完成，本文已归档。）*

先读文档，再 `brainstorming`，与用户确认三个任务的设计（尤其两处"待定"），然后写 spec。
