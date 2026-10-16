# OpenStaffs 服务端与 Web UI 设计

> 状态：待评审 · 日期：2026-10-16 · 关联：`2026-10-16-openstaffs-architecture-design.md`（架构总纲）、`2026-10-16-openstaffs-permissions-design.md`（写权限）
> 预置：核心引擎、写权限、群聊多会话均已实现并推送（master）。本设计把引擎装成"能用的产品"：本地 HTTP 服务 + 极简 Web UI + 推流 + 发送编排 + 未读 + 冷启动引导。

---

## 1. 背景与目标

引擎层已完工（域/适配/应用），但没有任何"入口"：没有 HTTP 服务、没有 UI、没有配置读取、没有消息推送。本期的目标是**第 1 期 MVP 的可用闭环**：

1. 老板在浏览器里和员工对话：私聊、群聊、`@触发`、广播，**流式呈现**；
2. 发送编排把 `planRouting` 的投递落到各成员会话，**成员并行、互不阻塞**；
3. 未读小红点（老板待办 = IM 面板红点）；
4. 新开会话（私聊整条 / 群聊对某成员）与旧会话只读回看；
5. **冷启动**：配置文件 + 引导页（没有模型就无法对话的现实约束下，先让老板把配置写对）；
6. **所有配置与管理走文件**，UI 只做"消息层"操作（见 D4）。

**核心架构不变**：状态真相源在文件夹；消息真相源 = Pi transcript；群聊 = 每成员一条按需会话。

---

## 2. 决策记录

| # | 决策 | 说明 |
|---|---|---|
| D1 | **范围 = 服务端 + 极简 Web UI** | 一份计划闭环到"能在浏览器里和员工对话"；UI 刻意做薄。 |
| D2 | **房间合并 = 读侧合并** | 消息真相源仍是 Pi transcript；房间视图 = 各成员活跃会话的合并（按 entry id 全局序），老板发言按 `roomMessageId` 去重只显示一次。**不**把消息流水落成项目目录文本文件（保持两层分离铁则）。 |
| D3 | **前端栈 = 零框架 vanilla TS + esbuild** | esbuild 为唯一新增 devDependency；服务端托管构建产物。渲染/归约为纯函数，直接单测。 |
| D4 | **配置零 UI** | 供应商/密钥/员工/项目/技能/档案全部由老板直接操作文件（编辑器/终端）；UI 只保留：只读列表、聊天、发送、新开会话、未读、回看。**砍掉**：Setup 表单、新建员工、拉群表单、档案编辑、技能创建（对应 API 不暴露）。 |
| D5 | **会话即快照（固化）** | 会话创建时把 instructions/model/cwd/技能等一次性固化（创建事务内原子应用）；**会话进行中不重载任何员工文件**；"新开会话" = 重新读取一切。缓存命中从"需维护"变为"结构上不可能失败"：会话内 system prompt 恒定，消息只在 transcript 尾部追加。 |
| D6 | **固化快照清单** | `[公司根 AGENTS.md]` + `[群聊时：项目 AGENTS.md]` + `[员工 AGENTS.md 入口 → profile.md → MEMORY.md]` + `[技能清单：群 skills 在前、员工 skills 在后，同名去重]`；顺序固定，空内容跳过。**修正**：pi-durable 1.3.0 无 AGENTS.md 自动加载（见 §10），根/项目 AGENTS.md 此前不进任何上下文，本期补上。 |
| D7 | **权限判定保持实时** | access 上下文（成员项目、permission.json）每次 attach 重新计算——它是安全判定，不进 prompt、不破坏缓存。 |
| D8 | **未读 watermark 存 `.openstaffs/state.json`** | 每房间一个 `lastSeenEntryId`；机器状态、单写者、原子写；丢失后果仅为"未读重置为 0"。若未来要统一进 SQLite（`node:sqlite` 独立库），接口不变、可切换。 |
| D9 | **消息搜索暂不做** | 后置；不阻塞本期。 |
| D10 | **推流 = SSE + 每条会话 `watchEvents`** | 全局一条 `/api/events` 流，事件带 roomKey；归一化事件不泄漏 Pi 类型。推送泵**绝不 await 慢客户端**（每客户端独立缓冲，delta 可合并/丢弃、权威消息不丢，重连靠重新拉取 + snapshot 补齐）。 |
| D11 | **发送编排 = fire-and-forget** | POST 只等"提交落盘"（毫秒级），不等模型回答；回答经 SSE 实时推。per-key（房间 × 成员）串行队列防"同成员并发 openGroup"竞态；不同 key 完全并行。`requestId` 交给 Pi 的去重键，防重试重复。 |
| D12 | **冷启动 = 文件引导页** | 未配置时前端显示引导（config 文件路径 + 示例 JSON + "保存后重启生效"）；**表单不存在**。员工/项目/技能是运行时读取，改完刷新即生效；config 是进程级，需重启。 |
| D13 | **默认端口 4319**（`config.json` 可改） | 启动根目录 = 进程 cwd（`OPENSTAFFS_ROOT` 环境变量可覆盖）。 |
| D14 | **回看 = 会话链 + 单会话只读** | `GET sessions` 列会话链（每成员一份），点旧会话看其 transcript（只读、不 attach、不合并）。 |
| D15 | **消息不显示时间戳** | EntryRecord 无时间戳；顺序即时间。信息来源为链文件的会话起止时间（回看面板可见）。 |

---

## 3. 总体架构

### 3.1 进程模型与启动

单进程 Node 服务，无外部依赖：

```
npm start
  → 构建 web/ → public/（esbuild）
  → 读 .openstaffs/config.json（缺失/无效 = 未配置模式）
  → 未配置：仅 /api/status 与静态资源可用，其余 409
  → 已配置：构造 models → Harness.open(SQLite) → resume()（durable 任务恢复）
  → 扫描并订阅全部活跃会话 → HTTP listen
```

- 运行：`node --experimental-strip-types src/server/main.ts`（Node ≥ 22.19；本机 v24 原生支持的类型剥离）。
- 端口占用等启动错误：打印原因、退出（提示改 config）。

### 3.2 模块清单

| 路径 | 类型 | 职责 |
|---|---|---|
| `src/domain/config.ts` | 新增 | `.openstaffs/config.json` 读写/校验/默认值；员工模型兜底解析 |
| `src/app/rooms.ts` | 新增 | 房间归一化与合并（纯函数）：`mergeRoomMessages`、`countUnread` |
| `src/app/send.ts` | 新增 | 发送编排：`planRouting` → deliveries → per-key 队列 → `startSession/submit` |
| `src/app/unread.ts` | 改造 | entryId watermark 版未读（替代 slice 索引）；`state.json` 的 seen 读写 |
| `src/app/conversations.ts` | 改造 | 快照清单渲染（D6）；`startSession/attach` 拆分；`accessFor`；默认模型兜底 |
| `src/harness/port.ts` | 改造 | 接口演进（§4.1） |
| `src/harness/pi-durable.ts` | 改造 | 实现新接口（创建即固化、submit 不等待、watchEvents 桥） |
| `src/server/main.ts` | 新增 | 入口与启动序列 |
| `src/server/http.ts` | 新增 | 路由 + API 处理器 + 静态文件（依赖注入，便于测试） |
| `src/server/sse.ts` | 新增 | SSE 客户端管理、广播、背压策略 |
| `src/server/pump.ts` | 新增 | 订阅各活跃会话 `watchEvents` → 归一化 → SSE；订阅表（convId → roomKey/成员） |
| `web/*` | 新增 | 前端源码（vanilla TS）：`index.html`、`styles.css`、`main.ts`、`state.ts`、`render.ts`、`api.ts`、`sse.ts` |
| `scripts/build-web.mjs` | 新增 | esbuild 打包 + 拷贝静态资源到 `public/` |
| `README.md` | 新增 | **手动配置指南**（交付物）：config 格式、员工/项目目录最小集、启动与验收 |

---

## 4. HarnessPort 演进（会话即快照）

### 4.1 接口

```ts
export type InputMeta = {
  kind?: string;            // 默认 pi.user；编排传 "chat.message"
  data?: JsonValue;         // { author: "boss", roomMessageId } 等
  requestId?: string;       // Pi 去重键（会话内作用域）
};

export type AgentEvent =    // 归一化事件（不泄漏 Pi 类型）
  | { type: "delta"; convId: string; channel: "text" | "thinking"; delta: string }
  | { type: "message"; convId: string; message: ChatMessage }  // 发言落盘（含完整内容，pump 无需二次读取）
  | { type: "run"; convId: string; phase: "start" | "end" }
  | { type: "tool"; convId: string; name: string; phase: "start" | "end" }
  | { type: "failed"; convId: string; message: string };

export interface HarnessPort {
  open(): Promise<void>;
  close(): Promise<void>;
  /** 新建会话：spec 在创建事务内原子固化（快照）。返回 convId。 */
  startSession(spec: ConversationSpec): Promise<string>;
  /** 读回既有会话并注册 access（绝不重配置）；不存在返回 false。 */
  attach(convId: string, access: AccessContext): Promise<boolean>;
  /** 提交输入，不等待回答（admission 完成即返回）。 */
  submit(convId: string, text: string, meta?: InputMeta): Promise<void>;
  /** 订阅归一化事件；返回退订函数。 */
  watch(convId: string, listener: (event: AgentEvent) => void): Promise<() => Promise<void>>;
  /** 阻塞发送（保留：测试与非流式场景）。 */
  send(convId: string, text: string): Promise<ChatMessage>;
  transcript(convId: string): Promise<ChatMessage[]>;
}
```

- `ChatMessage` 扩展为 `{ id, role, text, kind?, data? }`（合并去重需要 `kind/data`）。
- **移除** `ensureActive/attach(key, convId, spec)` 旧语义（重配置路径）。key→convId 的映射完全由应用层链文件管理（会话链是真相）；harness 层不再持有 key 映射。
- 固化实现：`createConversation({ ownership: {kind:"ownerless"}, agent: { model, instructions, cwd, thinkingLevel } })`——"Applied in the creating commit"（d.ts 原文），一个事务完成创建+配置。
- `submit` 实现：`conv.submit({ type: "input", content: text, entry: meta?.entry, requestId: meta?.requestId })`；不 wait。
- `watch` 实现：`watchEvents(harness, convId, ctx)`；把 `message_update` 的 text/thinking delta、发言落盘、`run_start/end`、`tool_execution_start/end`、失败事件映射为归一化事件（**具体事件形状以 d.ts/实测为准**，映射保持在适配层内）。

### 4.2 固化快照清单（instructionsFor）

```
[root AGENTS.md]                     公司总纲/红线/全局要求（文件缺失则跳过）
[项目 AGENTS.md]                      仅群聊；任务规范
[员工 AGENTS.md → profile.md → MEMORY.md]   员工的入口、档案、记忆
[技能清单]                            群 skills 在前 + 员工 skills 在后，同名去重；
                                     只注入 name + description（现有 renderSkills）
```

- 渲染时机：**仅 `startSession`（含新开会话）**。attach / 日常对话一律不重读文件。
- 员工仍可用 `read` 工具主动读取自己的文件（读不拦）——"想拿最新记忆"的逃生门。
- 员工/项目文件在会话中变更的生效点 = 下一次新开会话。

### 4.3 应用层 ensure（改造后）

```ts
// 打开关系当前活跃会话（不创建则不产生任何会话）：
active = activeSession(chainFile)
if (active && await harness.attach(active.id, accessFor(ws, relation, speaker)))
  return active.id                       // 快路径：只注册 access
convId = await harness.startSession(specFor(ws, relation, speaker))  // 慢路径：渲染快照
startNewSession(chainFile, convId, now)
return convId
```

- `accessFor`：只计算 `AccessContext`（root/cwd/selfId/memberProjects/permissionFiles），实时读 `members.md`，不读 profile/记忆。
- `specFor`：渲染快照（D6）+ 模型（员工 config.json 未填 provider/modelId 时**兜底全局默认**，见 `config.ts`）。
- **只读 API 不创建会话**：从未聊过的房间返回空消息；会话在"第一次发消息 / 新开会话"时才创建（按需创建原则不变）。

---

## 5. 应用层

### 5.1 发送编排（`app/send.ts`）

```
sendToRoom(ws, harness, relation, text, requestId):
  1. 私聊：deliveries = [{ to: employeeId, body: 原文 }]（直接投递，不解析 @）
     群聊：memberIds = parseMembers(members.md)
           群成员为空 → 抛错（API 400："群还没有成员"）
           planRouting(text, memberIds) → { deliveries }
  2. roomMessageId = 服务端生成（如 `rm_<随机>`）
  3. 对每个 delivery（并行）：
       queue.run(key(relation, memberId), async () => {
         convId = await ensure(ws, harness, relation, memberId)   // attach 或创建
         await harness.submit(convId, body, {
           kind: "chat.message",
           data: { author: "boss", roomMessageId },
           requestId,
         })
       })
  4. 全部提交完成后返回 { roomMessageId, deliveries: [{ memberId, convId }] }
```

- **私聊不解析 @**（私聊 = 天然 @ 一个人；`@老板` 等文本原样送达，不会被剥除或丢投递）。
- **群聊 deliveries 为空**（例如只 @ 了老板、且无其他目标）：不报错，返回 `202 + deliveries: []`，前端提示"未触发任何成员"；该消息不落盘（不存在于任何 transcript）。这是唯一"消息不落盘"的分支，行为明确可测。

- **per-key 队列**：`KeyedQueue.run(key, fn)`——同 key 串行、不同 key 并行；key = `dm:<id>` 或 `group:<project>:<member>`。修掉"同成员并发创建会话"的竞态（服务层责任，已记录）。
- **并行性**：POST 只等全部 admission 落盘；模型回答并行在途，经 SSE 推送。
- `requestId`：客户端 UUID；Pi 以会话为作用域去重（重试不产生重复输入）。

### 5.2 房间合并视图（`app/rooms.ts`，纯函数）

```ts
type RoomMessage = {
  convId: string; entryId: string;      // 复合键 <convId>:<entryId>
  roomKey: string;                      // dm:<id> | group:<id>
  speaker: { kind: "boss" } | { kind: "employee"; id: string; alias?: string };
  text: string;
  roomMessageId?: string;               // boss 消息去重键
};

mergeRoomMessages(relations): RoomMessage[]
```

- 输入：各成员**活跃会话**的 transcript（`activeSession` 读链文件 + `harness.transcript`）。
- 排序：`entryId` 数值升序（全局分配序）。
- 去重：boss 发言（`kind === "chat.message"` 且 `data.author === "boss"`）按 `roomMessageId` 取**最小 entryId** 的那份显示；其余丢弃。
- speaker 推断：boss 由 entry 元数据；员工 = 会话归属（合并时已知）。
- 只读不创建：会话不存在 → 该成员无贡献（不触发生成）。
- **稳定性**：新消息的 entryId 恒大于已有 → 追加只在尾部，历史不重排（配合 D5 的"追加式"承诺）。
- 前端 reducer 同样按 `roomMessageId` / 复合键幂等去重（GET 与 SSE 交错不重复；reducer 规则 = "已见过则丢弃，不动已有位置"）。

### 5.3 未读（`app/unread.ts` 重写）

- `.openstaffs/state.json`：`{ "seen": { "<roomKey>": <lastSeenEntryId> } }`（原子写：临时文件 + rename）。
- 未读 = 合并视图中 `entryId > watermark` 且 `speaker` 为员工的条数（boss 自己的发言不计）。
- `POST /api/rooms/:key/read`：watermark 推至该房间当前最大 entryId。
- 前端时机：打开房间即标记已读；当前房间收到新消息且窗口可见 → 防抖标记；`visibilitychange` 聚焦时对当前房间再次标记。
- 服务端在消息落盘/标记已读后重算并向 SSE 推 `room.unread`。

### 5.4 会话回看

- `GET /api/rooms/:key/sessions`：私聊 = 单链；群聊 = 每成员一条链（`SessionRow[]`）。
- `GET /api/rooms/:key/sessions/:convId/messages`：单会话归一化消息（只读、不 attach、不合并；speaker 从链归属推断）。

### 5.5 默认模型兜底

- 全局 `.openstaffs/config.json`：`{ provider, apiKey, modelId, port }`。
- 员工 `agents/<id>/config.json`：`{ alias?, provider?, modelId?, thinkingLevel? }`。
- **兜底规则**：provider/modelId 必须成对——员工任一缺失则 provider+modelId **整体**用全局；thinkingLevel 独立（员工有则用员工的，没有则交给 Pi 默认）。
- 校验：全局 provider 必须是 pi-ai 内置 provider id 之一（README 列主要选项，以 `@earendil-works/pi-ai/dist/providers/*` 为准）。

---

## 6. 服务端

### 6.1 API 表

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/status` | `{ configured, root, port, provider?, modelId? }`；**永不回显 apiKey** |
| GET | `/api/employees` | `[{ id, alias?, model }]`（`model` = 兜底后的解析结果） |
| GET | `/api/projects` | `[{ id, alias, members: [{id, alias?}] }]` |
| GET | `/api/rooms/:key/messages?limit=200` | `{ roomKey, messages: RoomMessage[] }`（合并后视线；只读不创建会话） |
| POST | `/api/rooms/:key/messages` | `{ text, requestId }` → `202 { roomMessageId, deliveries: [{ memberId, convId }] }` |
| POST | `/api/rooms/:key/new-session` | 群聊带 `{ memberId }`（必须在 members.md 内，否则 400）→ `{ convId }`；旧会话保留 |
| GET | `/api/rooms/:key/sessions` | `{ chains: [{ memberId, rows: SessionRow[] }] }`（私聊 = 单链） |
| GET | `/api/rooms/:key/sessions/:convId/messages` | `{ convId, memberId, messages }`（只读；convId 不属于该房间 → 404） |
| POST | `/api/rooms/:key/read` | 标记已读（watermark 推进）→ `{ ok }` |
| GET | `/api/unread` | `{ total, rooms: { [roomKey]: count } }`（未读的**唯一**读入口） |
| GET | `/api/events` | **SSE** 全局事件流 |
| GET | `/`/静态 | 托管 `public/`（`index.html` 默认文档） |

- roomKey 形如 `dm:<employeeId>` / `group:<projectId>`（URL path 中冒号合法）。
- 未配置（无有效 config）时：除 `/api/status` 与静态资源外一律 `409`。
- 错误：统一 JSON `{ error: string }`；400（空文本/群无成员/memberId 非法/校验失败）、404（员工/项目/房间/convId 不存在）、409（未配置）。

### 6.2 SSE 事件模型

| 事件 | 载荷 | 来源 |
|---|---|---|
| `room.message` | `{ roomKey, message: RoomMessage }` | 发言落盘（user/assistant entry）；**权威**，前端按复合键/roomMessageId 幂等合并 |
| `room.delta` | `{ roomKey, convId, memberId, channel: "text"\|"thinking", delta }` | 生成中的流式增量（临时气泡） |
| `room.activity` | `{ roomKey, convId, memberId, kind: "run"\|"tool", name?, phase: "start"\|"end" }` | 忙碌点与工具活动指示（瞬态近似） |
| `room.failed` | `{ roomKey, convId, memberId, message }` | 生成失败/无模型等（显示给老板） |
| `room.unread` | `{ roomKey, count }` | 未读重算 |

- 生成完成信号 = 该会话的 `room.message`（assistant entry 落盘）；前端据此把对应 live 气泡替换为正式消息。**落盘的精确事件形状（`message_end` / `entry_appended`）以实现实测为准**。
- 断线重连：前端重连后重新 `GET` 当前房间消息 + 列表；不做事件级断点续传。SSE 由浏览器 `EventSource` 自动重连。

### 6.3 推送泵（`server/pump.ts`）

- 订阅集合：所有"活跃会话"——启动时扫描全部私聊链 + 全部项目成员链的 `activeSession`；新建/打开的会话由 API 层在拿到 convId 后调用 `pump.register(convId, roomKey, memberId)`（**幂等**；发送响应与 new-session 响应都携带 convId，注册点统一在 API 层）。
- **新开会话时订阅切换**：退订旧会话、订阅新会话。旧会话若仍在生成，完成后落盘（回看可见），但不再推流（房间视线只含活跃会话，前后端一致）。
- 订阅表记录 `convId → { roomKey, memberId }`，事件据此标注并广播。
- **背压纪律**：每个 SSE 客户端独立发送队列；写 socket 不阻塞泵；慢客户端对 `room.delta` 允许合并/丢弃（`room.message` 等权威事件不丢，重连补齐）。客户端断开即清理。

### 6.4 静态文件与安全

- 仅伺服 `public/` 下文件；路径规范化防穿越；只读。
- apiKey 不落日志、不过 API（`state.json`/`config.json` 都是本地文件）；`config.json` 写入时 `0600`。

---

## 7. 配置与冷启动

### 7.1 `.openstaffs/config.json`

```json
{
  "provider": "opencode-go",
  "apiKey": "sk-…",
  "modelId": "deepseek-v4.1-flash",
  "port": 4319
}
```

- 读取容错：缺失/坏 JSON/字段缺失 → "未配置"模式（不崩溃）。
- key 注入 Pi：优先用 pi-ai 的 credential 机制（credential store / auth 覆盖，**以 d.ts 为准**）；最坏允许设置进程环境变量（仅内存、不落日志）。
- `port` 缺省 4319；`OPENSTAFFS_ROOT` 覆盖工作区根（默认进程 cwd）。

### 7.2 引导页（未配置时）

- 显示：工作区根路径、config 文件完整路径、示例 JSON、"保存后重启服务（Ctrl+C 后重新 npm start）"。
- 无表单（D4）；无员工的空列表同样显示"如何创建员工"的指引文案（指向 README）。

### 7.3 手动配置指南（`README.md`，交付物）

- `.openstaffs/config.json` 写法与可用 provider（内置列表节选）。
- 员工目录最小集：`agents/<id>/`（`AGENTS.md` 必需入口；`config.json` 可选；`profile.md`/`MEMORY.md`/`skills/` 可选）。
- 项目目录：`projects/<id>/`（`members.md` 必需；`project.json`/`AGENTS.md` 可选）。
- 启动、访问 `http://localhost:4319`、常见问题（端口占用/密钥未配/技能不生效→新开会话）。

---

## 8. 前端

### 8.1 构建

- `scripts/build-web.mjs`：esbuild 打包 `web/main.ts` → `public/app.js`（ESM、bundle）+ 拷贝 `index.html`/`styles.css`。
- `public/` 进 `.gitignore`。`npm start` 前自动构建。

### 8.2 视图与状态归约

视图状态机（`web/state.ts` 纯函数）：

```ts
type State = {
  configured: boolean;
  employees: EmployeeSummary[];     // { id, alias?, model }（列表响应）+ 前端 join unread/busy
  projects: ProjectSummary[];       // { id, alias, members }（列表响应）+ 前端 join unread/busy
  roomKey?: string;                 // 当前打开的房间
  messages: RoomMessage[];          // 当前房间（GET 合并结果 + SSE 增量）
  live: Record<string, Live>;       // convId → { text, thinking, tools[] } 生成中
  unread: Record<string, number>;
  panel?: "history";                // 回看面板
};

reduce(state, event): State          // 事件应用（幂等去重、delta 缓冲、unread 更新）
```

- 视图：**引导页**（未配置）/ **主界面**（左栏：员工列表 + 项目列表 + 红点/忙碌点；右栏：聊天）/ **回看面板**（成员 → 会话链 → 只读消息）。
- 员工列表为空时显示"如何创建员工"指引（指向 README 文案）。
- 点击员工/项目 → 进入房间（GET 合并消息 + POST read）；头部：房间名、成员（群聊）、忙碌、`新开会话`（群聊带成员选择）、`历史`。
- 发送：Enter 发送；POST 期间禁用输入（防重）；流式生成中**不**禁用（Pi 排队语义，允许继续发）；`@提及`为手写文本（无自动补全）。
- 流式渲染：`room.delta` 仅局部更新 live 气泡（textContent）；`room.message` 到达时 append/替换（局部 DOM）；其余区域低频全量重渲。

### 8.3 聊天渲染要点

- boss 气泡右侧（`speaker.kind === "boss"`）、员工左侧带头像（首字母）与别名。
- live 气泡：员工正在生成（可显示工具活动小字："alice 正在执行 write…"）；`room.failed` 显示为错误气泡。
- 历史不重排：只 append（D2/D5 的追加式承诺在前端同样成立）。

---

## 9. 测试策略

全走 vitest；模型侧用 `faux` provider（不需要 API key）：

| 层 | 文件 | 覆盖 |
|---|---|---|
| domain | `tests/domain/config.test.ts` | 读取容错、默认端口、0600 写入、员工模型兜底 |
| app | `tests/app/rooms.test.ts` | 合并排序、boss 去重（最小 entryId）、unread 计数、空房间、幂等 |
| app | `tests/app/send.test.ts` | routing→deliveries、私聊直投（原文不剥 @）、群聊 @老板 → 空 deliveries + 202、per-key 串行（同 key 并发顺序执行）、异 key 并行、空成员群拒绝、requestId 透传 |
| app | `tests/app/conversations.test.ts`（改） | 快照清单（根/项目/员工/技能顺序与去重）、startSession/attach 拆分、新开会话、默认模型兜底 |
| harness | `tests/harness/pi-durable.test.ts`（改） | 创建即固化（创建事务内 agent 配置）、attach 不重配置、submit+watch 事件流、transcript 带 kind/data |
| server | `tests/server/http.test.ts` | 真起服务 + fetch：status→employees→projects→发消息→房间消息→新开会话→回看→read→unread；409 未配置 |
| server | `tests/server/sse.test.ts` | 连接与事件序列；**并行性 E2E**：两成员生成交叠、POST 与生成解耦（长跑成员不阻塞他人） |
| web | `tests/web/state.test.ts` | reducer：去重、delta 缓冲、unread、live 清理 |

**手动验收清单**（README 收录）：无 config 引导页 → 写 config 重启 → 建 `agents/alice/` → 刷新见列表 → 私聊流式对话 → 建 `projects/demo/`（members 含 alice）→ 群聊广播与 `@alice` → 未读红点与已读 → 新开会话（旧会话回看）→ 改 profile.md 后旧会话不生效、新开会话生效。

---

## 10. 与既有 spec 的关系（修正点）

1. **修正架构 spec §4.1**：`AGENTS.md`/`SYSTEM.md`/`APPEND_SYSTEM.md` 的"Pi 自动加载"实为 pi-coding-agent 的行为；**pi-durable 1.3.0 无此机制**（全包 grep 仅测试文件提及；现有实现也正是自己渲染员工入口，佐证）。instructions 完全由 OpenStaffs 渲染 → 快照清单（本设计 §4.2）为唯一注入点。
2. **落地架构 spec §7**：推流确定为 SSE + `watchEvents`；事件模型见 §6.2。
3. **修正架构 spec §5.6**：首次配置表单 → **非对话的文件引导**（D4/D12）；"没有模型无法对话"的约束由"引导页 + 手工填 config"覆盖。
4. **落地架构 spec §5.7**："旧会话保留可回看"由 §5.4 回看接口与面板覆盖。
5. **细化架构 spec §4.2**："老板待办 = viewState 派生未读"落地为 entryId watermark（D8）；旧 `unreadForBoss` slice 方案废弃。
6. **对齐架构 spec §6**：权限判定保持实时（D7），不受快照固化影响。
7. **架构 spec §9 MVP 范围内**：极简工作台（列表 + 聊天）、配置文件化、IM 闭环（私聊/群聊/@/广播/未读）、新开会话在期内；"员工档案可视编辑、技能创建 UI"**后置**（D4 配置零 UI 的推论）。

---

## 11. 非目标（本期不做）

- 消息搜索（时间段/关键字）；管理面 UI（员工/项目/档案/技能/alias 表单）；员工与项目删除。
- steer 插话 / 拒收语义（发送一律排队）；会话级断点续传（重连 = 重拉 + snapshot）。
- 消息时间戳显示；模型热切换（改 config 重启、改员工 config 新开会话生效）。
- Staff0、独立组织架构层、Inner Loop、Peer Review、MCP 生态、硬档 ACL/容器。
- 老板"职责"建模（架构 spec 开放问题，维持开放）。

## 12. 风险与开放问题

| 风险 | 影响 | 缓解 |
|---|---|---|
| pi-ai 的 apiKey 注入路径未实测 | 配置读入后无法认证 | 实现时以 d.ts 为准（credential store / auth 覆盖）；兜底进程环境变量注入（仅内存） |
| `watchEvents` 事件形状细节（落盘信号/失败枚举） | 归一化映射偏差 | 映射集中在适配层，以实测微调；测试用 faux 固化行为 |
| Node 类型剥离的版本差异（22.19 需 flag） | `npm start` 兼容性 | 启动脚本按实测选 `--experimental-strip-types`；README 注明 Node ≥ 22.19 |
| SSE 慢客户端/大量会话 | 推送积压 | 背压纪律（§6.3）：独立缓冲、delta 可合并、权威事件重连补齐 |
| 群聊页面成员增多时消息量 | 首屏加载慢 | `limit` 参数 + 前端只渲染窗口；后续可加懒加载 |
