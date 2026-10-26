# 会话标题：自动命名 + 手动改名（设计）

日期：2026-10-26

## 意图与为什么

现在「会话」在 UI 里只能靠 **成员 + 时间** 辨认（历史列表显示 `张三 · 2026-10-26 15:32`），老板回看历史时无法一眼认出「这场对话是关于什么的」。本功能给每条会话引入**标题**，并给标题两个来源：新的会话由命名 agent 自动命名，老板可随时手动改名。

## 目标

- 每条会话都有标题（永不为空），并覆盖全部 UI：聊天顶部、会话信息条、历史列表、会话详情。
- 新会话的**第一条用户消息**同时发给命名 agent，由它给出标题；失败不重试，保留时间缺省标题。
- 老板可在上述位置手动改名，手动结果不会被飞行中的自动命名覆盖。
- 命名 agent 的模型在**空间配置**里指定；未指定则自动命名不可用（手动改名不受影响）。
  > 变更（2026-10-26，老板口径）：**取消「必须是非思考模型」的限制**——`namingModel` 可指向任意模型，按模型默认思考行为调用；保留的闸门只有「引用格式合法 + 模型目录可解析」。

## 非目标

- 不做「标题作为模型上下文的一部分」（标题纯展示，注入会污染 prompt cache）。
- 不给员工提供改标题的工具（`send_message` / 工具侧不动）。
- 不做命名重试、批量重命名、按标题搜索。
- 不为旧的 `messages.sqlite` 做数据迁移（开发阶段：旧库不再读取）。

## 反目标（技术上能跑但算失败）

- 命名阻塞首条消息投递 / 员工回复（用户感知到延迟）。
- 命名失败留下空标题或抛出影响发送流程的异常。
- 自动命名覆盖老板手动改过的标题。

## 已定决策（老板拍板）

| 决策 | 结论 |
| --- | --- |
| 命名怎么跑 | **直接调模型**（`Models.completeSimple`），不新开 Pi 会话：无残留会话、无 access/cwd 需求、易测。「只加载一个 prompt」= 只注入 `src/prompts/naming.md`，环境 / 私聊群聊前缀 / 记忆 / 技能一个都不注入 |
| 标题存哪 | **DB**，不塞进会话链 `conversation_ids.md`（那是会话状态机，标题是展示元数据） |
| 库 | 沿用现有自有库，文件改名 `messages.sqlite` → `openstaffs.sqlite`（与 Pi 基座库 `state.sqlite` 区分）；不新开库、不迁移旧数据 |
| UI 覆盖 | 各处：聊天顶部、会话信息条、历史列表、会话详情 |
| 业务流程 | 新建会话**立即**用当前时间命名（fallback）；命名 agent 成功后用**会话重命名 API** 改名。两条路同一个写入通道，兜底完备 |
| 表名 | `sessions`（不是 `session_titles`）：后续会话级业务（其它元数据）可扩展 |

## 关键设计

### 1. 存储（`src/store/messages.ts`，库文件改名）

表名 **`sessions`**（不是 `session_titles`）：这张表是「自有库里的会话元数据」，标题只是它现在的第一列业务，后续会话级字段（模型、首个用户意图、归档标记……）直接加列。

```sql
CREATE TABLE IF NOT EXISTS sessions (
  conv_id      TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  title_source TEXT NOT NULL,    -- 'fallback' | 'auto' | 'manual'
  updated_at   TEXT NOT NULL
);
```

`MessageStore` 新增三个方法（同一个库、同一份 handle）：

- `sessionOf(convId): SessionMeta | undefined`
- `sessionsOf(convIds: string[]): Map<string, SessionMeta>`（列表批量取，避免 N 次查询）
- `rename(convId, title, source: "auto" | "manual" | "fallback")`：`manual` 恒覆盖；`auto` / `fallback` 只在**不存在**或现存 `title_source = 'fallback'` 时覆盖（条件写在同一条 UPSERT 里，保证原子）。

`title_source` 的语义就是覆盖规则的唯一依据：

| source | 谁写入 | 能被谁覆盖 |
| --- | --- | --- |
| `fallback` | 会话创建瞬间（时间标题） | auto / manual / fallback |
| `auto` | 命名 agent 成功返回 | manual |
| `manual` | 老板手动改名 | 只有 manual |

路径函数：`paths.ts` 的 `messagesDbFile` → `officeDbFile`，文件名 `openstaffs.sqlite`；`openMessageStore` 语义扩为「自有库」，保留函数名 `openMessageStore`（改动最小；文件头注释说明它含消息与标题两张表）。

### 2. 空间配置：命名模型

`openstaffs/space.config.json` 新增扁平字段（统一解析器加一个可选字段，仅空间层有意义）：

```json
{ "namingModel": "opencode-go/deepseek-v4.1-flash" }
```

- `ConfigFields` 加 `namingModel?: string`；`parseConfigFields` 用 `text()` 解析，非字符串忽略（记 issue）。非空间层写了也解析但**不使用**。
- 校验分两处：
  - **启动时**（`main.ts` 建 namer 时）：模型引用格式非法 / 供应商未配置 / 模型目录查不到 / `getSupportedThinkingLevels` 不等于 `["off"]` → **自动命名不可用**，`console.warn` 一条点名原因。
  - **调用时**同样的闸门再判一次（配置直读，重启才生效，但代码路径不重复解析）。
- 「非思考」的判定：模型不支持思考档（`reasoning !== true`，等价于 pi-ai `getSupportedThinkingLevels` 只返回 `off`）。实现上按模型对象的 `reasoning` / `thinkingLevelMap` 推（不走模型目录查询，便于单测喂假模型）。目录查不到 = fail closed（不可用），宁可没有自动标题也不乱花钱。

### 3. 命名 agent

- Prompt：`src/prompts/naming.md`（框架自持；与现有模板同一处，`npm start` 时读入内存）。正文只讲「给这场对话起个标题」+ 输出格式约束，不做变量渲染。
- 模块：`src/app/naming.ts`

  ```ts
  export type Namer = (firstMessage: string) => Promise<string | undefined>;
  export function createNamer(opts: { models: Models; namingModel?: string }): Namer | undefined;
  ```

  返回 `undefined` = 自动命名不可用（未配置 / 校验不过）。
- 调用：`models.completeSimple(model, { system: namingPrompt, messages: [{ role: "user", content: firstMessage }] })`，无工具、无 thinking、无技能。首条消息截断到 **500 字**再喂（省 token，标题只需要个「说什么」）。
- 输出清洗（`cleanTitle`）：
  1. 取第一行（按 `\n` 切，取第一条非空）；
  2. 去掉行首 `标题：` / `title:` 前缀，去掉包裹的 `「」` `""` `''` `《》`；
  3. 折叠连续空白为单个空格；
  4. 去掉结尾的句号 / 逗号；
  5. 截断到 **20 个字符**（按字符而非字节，超出加 `…`）；
  6. 结果为空 → 视为失败。
- 失败面（都算失败，不重试、只留 fallback 标题 + 一条 `console.warn`）：超时（**20s**）、抛错、非 `stop` 结束（如被截断 / 出错）、清洗后为空。

### 4. 业务流程：先有时间标题，成功后走重命名

**唯一写入通道 = 会话重命名 API**（应用层 `renameSession`，见「5. HTTP API」）：会话创建与自动命名都走它，手动改名也走它。这样「兜底完备」：任何时刻都有一份可用的标题，命名只是后续的一次改名。

统一入口放 `src/app/sessions.ts`（新文件，未来会话级业务都往这里长）：

```ts
fallbackTitle(now: Date): string                  // 'MM-DD HH:mm'
renameSession(deps, convId, title, source): SessionMeta   // 写库 + 广播 SSE
nameNewSession(deps, convId, firstMessage): void  // 后台命名 → renameSession(..., 'auto')
```

- `conversations.ts`：`ensure` / `newSession` 的返回值从 `convId: string` 改为 `{ convId, created: boolean }`（`created` = 这次真的新建了会话；`attach` 成功复用 → `false`）。8 处调用点各自取 `.convId`。
- `send.ts` 的 `sendToRoom`：投递完（`harness.submit` 之后）若 `created === true`：
  1. **立刻**用 `renameSession` 写时间标题（`source = 'fallback'`，如 `10-26 15:32`，服务器本地时区）并广播——UI 从第一眼就有名字；
  2. 若有 namer：并发触发命名（**不 await**，不进入投递的关键路径）；命名成功后同样调 `renameSession(..., 'auto')`（条件 UPSERT 天然不覆盖 manual），失败则什么都不做——时间标题就是兜底。
- 群聊一条消息 @ 多个人 → 各自 `created` 各自命名（并发，互不影响）。
- 员工触发的会话（`triggerFromGroupReply` 的 @ 提及、员工 `send_message`、`new_session` 工具）**不命名**：需求只覆盖「新会话用户发起的第一条信息」。
- 队列 / 撤回语义不变：撤回发生在投递前就还没建会话，自然没有标题。

### 5. HTTP API

| 端点 | 改动 |
| --- | --- |
| `GET /api/rooms/:key/sessions` | 每行加 `title` / `titleSource`（`titlesOf` 批量取） |
| `GET /api/rooms/:key/sessions/info` | 每项加 `title` |
| `GET /api/employees/:id/sessions` | 每项加 `title` |
| `GET /api/employees/:id/sessions/:convId/context` | 加 `title` |
| `PATCH /api/rooms/:key/sessions/:convId/title` | 新增：body `{ title }`。校验：房间存在、`findSessionOwner` 认这个 convId、`title.trim()` 非空且 ≤ 40 字 → `renameSession(..., 'manual')` → 广播 SSE `session.title` → `{ title, source: "manual" }` |

错误：空 / 超长 → 400；convId 不属于该房间 → 404。

### 6. SSE

新增事件 `{ type: "session.title", roomKey, convId, title }`：`renameSession` 写入成功后统一广播（手动、自动、fallback 三条来源同一条路径），当前房间的标题原地刷新，不用刷新页面。SSE 广播需要 roomKey —— 由 `findSessionOwner` + 关系反推，或由调用方传入（`sendToRoom` 已知关系，HTTP 已知房间）。

### 7. UI（`web/`）

- **State**：`sessions`（信息条数据）与历史列表行都带 `title`；`dispatch({ type: "title", convId, title })` 原地更新，`renderAll()` 保位置。
- **聊天顶部**（`chatHtml`）：私聊在房间名后追加会话标题 chip（`<button class="session-title" data-rename-conv>`）；群聊没有「唯一当前会话」，chip 不显示（标题在信息条里逐条显示，避免误导）。
- **会话信息条**（`sessionInfoHtml`）：每条活跃会话最前面显示标题（群聊保留了成员名：`标题 · 成员 · 模型 …`），标题可点击改名。
- **历史列表**（`openHistory`）：每行 = `标题 · 成员 · 时间（进行中）` + 「改名」按钮。
- **会话详情**（`contextBodyHtml`）：头部第一行 = `标题 · 关系 · convId · 时间` + 「改名」按钮。
- **改名交互**：点击标题 → 原地换成 `<input>`（预填当前标题，选中全文），Enter 保存 / Esc 取消 / 失焦保存；保存走 PATCH，成功后按返回值更新 State；失败弹一条 `hint` 文本，输入框保持原样（不丢输入）。四处共用同一个「标题编辑器」小工具函数。

## 生效方式（沿用既有 3 档）

- `namingModel`：**重启服务**后生效（与 `model` / `providers` 同档）。
- 命名 prompt：**重启后**生效（模板在启动时读入内存）。
- 库 / 表：启动时 `CREATE TABLE IF NOT EXISTS`，无需迁移。

## 文档同步（`AGENTS.md` 的表格逐条办）

- `src/skills/openstaffs-ops/SKILL.md`：`space.config.json` 字段表加 `namingModel`（含「必须是非思考模型 / 未指定则自动命名不可用 / 重启生效」）；`openstaffs/.data/` 目录说明把 `messages.sqlite` 改为 `openstaffs.sqlite`（含 `session_titles` 表）；`space.config.json` 里 `model` 只在员工层有意义的说明旁边补 `namingModel` 是空间层例外。
- `src/skills/openstaffs/SKILL.md`：员工可见能力那节补「会话标题」——标题由系统自动生成、老板可改；员工**不能**改标题（没有工具、也不该猜）。
- `TODO.md`：待做区移除完成后不再出现的条目 / 在「已定口径」补一条「标题存自有库、与会话链分离」；`README.md` 与 `docs/产品规划.md` 如提及自助能力则同步（预计仅 README 的目录说明一处）。

## 测试

- `tests/store/`：`sessions` 建表、三种 `title_source` 的覆盖规则（auto 不覆盖 manual、manual 恒覆盖、fallback 被 auto 覆盖）。
- `tests/app/naming.test.ts`：`cleanTitle` 各清洗规则；`createNamer` 在「未配置 / 非法引用 / 模型目录查不到 / 支持思考档」四种情况下返回 `undefined`；正常返回标题；超时 / 抛错 / 空结果 → `undefined`（用假 `Models`，不打网络）。
- `tests/app/send.test.ts`：新会话 → created + fallback 标题 + 命名被调用一次；复用既有会话 → 不命名；命名失败 → 标题仍是 fallback；手动改名后命名结果不覆盖。群聊 @ 两人 → 两次命名。
- `tests/server/http.test.ts`：PATCH 端点 200 / 400（空、超长）/ 404（convId 不属于房间）；四个 GET 带上标题。
- `tests/app/conversations.test.ts`：`created` 标志（首次 true、之后 attach 复用 false、`newSession` 恒 true）。
- `tests/web/`：标题在顶部 / 信息条 / 历史 / 详情四处渲染；改名控件交互（Enter / Esc / 失败保留输入）。

## 风险与取舍

- **`sessions` 表会长期存在**：表名泛化后不要往里塞可推导的冗余（比如模型名、成员），只放「会话级、不可推导、需要保留」的事实。

- **旧库不读**：实跑空间的 `messages.sqlite` 改名后历史消息清空（旧文件留在 `.data/` 不自动删）。开发阶段接受；老板需要保留就手动 rename 文件。
- **命名多一次模型调用**：每条新会话一次（首条消息 ≤ 500 字 + 20 字输出）。非思考小模型成本可忽略。
- **时间标题与本地区时**：fallback 用服务器本地时区，与 UI 展示的 `localDateTime` 一致。
- **群聊顶部不显示标题**：群聊房间没有单一当前会话，硬塞一个会误导；标题逐条显示在信息条。
