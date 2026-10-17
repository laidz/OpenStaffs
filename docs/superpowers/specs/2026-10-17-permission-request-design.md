# OpenStaffs 授权弹框（request_permission）设计

> 状态：待评审 · 日期：2026-10-17 · 分支：`feat/permission-request`
> 关联：`2026-10-16-openstaffs-permissions-design.md`（写权限判定，本设计只增"申请 → 批准"通道，不改判定规则）、`2026-10-16-openstaffs-architecture-design.md`（工具 / 扩展 / 事件体系）
> 预置：写权限判定、消息触发（@ 前缀块）、SSE / Pump、Web UI 均已实现（master）。本设计新增：授权申请链路（主体）+ 称谓单源化（配套，§8）。

---

## 1. 背景与目标

员工要写自己权限边界之外的路径时，目前只有两条路：被工具层拦截后干等，或由老板手工编辑 `permission.json`。本设计给 agent 一条**申请授权**的通道，并让老板用弹框一键批准：

1. agent 调用 `request_permission`（一组路径 + 简短理由）；
2. 老板在界面右下角的卡片弹框中**整体接受或整体拒绝**；
3. 接受 → 框架把路径写入发起者员工级 `agents/<agentId>/permission.json`，并以消息触发 agent 继续；
4. 拒绝 → 不写任何文件，同样以消息告知。

同时完成**称谓单源化**：agent 与老板的交互对象称谓（缺省「老板」）此前散落在 UI、工具文案、@ 语法、提示词各处，部分写死。本设计统一从 `config.json` 的 `bossName` 消费（§8）。

**非目标：**

- 部分接受 / 部分拒绝（一个请求整体处理；分拆多请求即可绕过）；
- 请求超时 / 自动过期 / 审批审计留痕（处理完即删，不做历史）；
- 硬档隔离与容器（沿用现有软边界，`bash` 仍全开）；
- 技能手册（SKILL.md）的运行时模板渲染（保持静态文件 + 术语映射，见 §8.6）；
- 废弃 `@老板` / `@boss` 写法（永久兼容，见 §8.4）。

---

## 2. 决策记录

| # | 决策 | 说明 |
|---|---|---|
| D1 | **异步消息式** | 工具发起后立即返回，不阻塞 agent；老板点击后框架投递消息（群聊 `@<agentId> 已完成授权`）触发 agent 新一轮。不采用"工具阻塞等待点击"：老板可能长时间不处理，阻塞会让 run 长期挂起，且中断 / 重启语义复杂。 |
| D2 | **写入发起者员工级 `permission.json`** | `agents/<agentId>/permission.json`。不写项目级、不扩散给同群其他成员（最小授权；谁申请批给谁）。 |
| D3 | **请求落盘** | `.openstaffs/permission-requests.json`；服务重启后弹框恢复；处理完即删。符合「状态真相源在文件夹」铁律。 |
| D4 | **弹框 = 右下角卡片堆叠** | 全局可见（跨房间）；多条并存、各自独立处理；不做居中模态、不做单队列。 |
| D5 | **整体接受 / 拒绝** | 一次请求的全部路径作为一个事务；不支持勾选部分路径。 |
| D6 | **`reason` 必填** | 简短理由；异步场景下老板看到弹框时 agent 多半已去干别的，理由是其判断依据。空白 → 工具报错。 |
| D7 | **等待期间不得"越狱"** | 工具返回与 SKILL.md 双重明确：等待期间不得用 `bash`、改权限文件、请他人代写等任何方式绕过拦截去写目标路径。 |
| D8 | **触发消息复用 `sendToRoom`** | 老板形态消息（含红点口径）；群聊 `@<agentId> 已完成授权` / 私聊 `已完成授权`；拒绝同理「已拒绝授权」；不附路径摘要（严格按需求文案）。 |
| D9 | **称谓单源 = `config.bossName`** | 缺省「老板」；缺失 / 空 / 非字符串自动回落（不可为空、不可移除）；prompt 变量 `boss_name` 已存在；各处消费（§8）。 |
| D10 | **@ 解析双认** | `bossNames = [当前称谓, "老板", "boss"]`（去重）：新环境段教 `@<称谓>`，历史会话里学的 `@老板` / `@boss` 永久有效。 |
| D11 | **路径一律存绝对路径** | 工具按会话 cwd `path.resolve` 归一；弹框展示、`permission.json` 写入、判权匹配全用绝对路径，无歧义。 |
| D12 | **重复申请去重** | 同 agentId + 相同路径集合已有 pending → 工具不新建、返回提示。已批准的路径再次出现时不重复追加条目（幂等），仍回「已完成授权」。 |
| D13 | **处理并发防重** | 服务端处理中集合拦截重复点击；第二个同 id 请求按 404 处理。 |
| D14 | **投递失败降级** | 授权写入成功即算完成；消息投递失败仅记日志 + 响应带 `warning`（对齐现有「已 admitted 的投递不因 pump 故障回滚」语义）。写 `permission.json` 失败则返回 500、请求保留。 |
| D15 | **授权结果的消息形态** | `kind: "chat.message"`、`data.author = "boss"`（老板消息），复用现有发送 / 去重 / 未读链路，无新消息类型。 |

---

## 3. 授权请求模型与存储

```ts
type PermissionRequest = {
  id: string;         // "pr_" + randomUUID()
  agentId: string;    // 发起者（= 授权受益者）
  roomKey: string;    // 来源房间：dm:<员工id> | group:<项目id>（投递消息用）
  paths: string[];    // 绝对路径，已归一 + 去重（≥1 条）
  reason: string;     // 简短理由（非空）
  createdAt: string;  // ISO 8601
};
```

**存储文件**：`.openstaffs/permission-requests.json`

```json
{ "requests": [ { "id": "pr_…", "agentId": "alice", "roomKey": "group:demo", "paths": ["/abs/a"], "reason": "…", "createdAt": "2026-10-17T02:00:00.000Z" } ] }
```

- 语义与 `state.json` 对齐：缺失 / 坏 JSON / 坏条目 → 安全降级（空列表 / 跳过坏条目），不崩溃；
- **原子写**（`.tmp` + `rename`，同 `src/app/unread.ts` 的 `writeSeen`）；
- **内存单例 store**（`src/domain/permission-requests.ts`）：启动时 load 一次；`add` / `remove` 同步改内存并落盘（`fs` 同步调用，进程内无交错）；落盘失败不阻断主流程（内存态为准，记日志）；
- 列表顺序约定：**新的在前**（`createdAt` 降序；SSE 新请求插入头部）。GET 接口与服务端广播同此口径。

---

## 4. 工具 `request_permission`

### 4.1 参数

| 参数 | 必填 | 说明 |
|---|---|---|
| `paths` | ✓ | `string[]`，≥1 条；目录或文件均可；相对路径按**当前会话 cwd** 解析为绝对路径 |
| `reason` | ✓ | 简短理由（一两句），弹框展示给老板 |

### 4.2 行为

1. **归一**：`paths` 逐条 trim → 丢空串 → `path.resolve(cwd, p)` → 去重（保序）。
   - 空结果 → 工具错误：`paths 不能为空：至少给出一个要申请的路径。`
2. **理由校验**：trim 后为空 → 工具错误：`reason 不能为空：用一两句话说明为什么要这些路径（会展示给「<称谓>」）。`
3. **重复检查**：同 `agentId` 且路径集合相同（集合比较）已有 pending → 返回：
   `已有相同的授权请求在等待「<称谓>」处理（N 个地址），请勿重复发起。`（不新建）
4. **新建**：`store.add` → 落盘 → `hub.broadcast({ type: "permission.request", request })` → 返回：

   ```
   已向「<称谓>」发起授权请求（2 个地址）：
   - /abs/path/a
   - /abs/path/b
   等待处理：请勿重复发起，也不要尝试写入这些路径或用其他方式绕过拦截；处理后你会收到新消息。
   ```

### 4.3 接入方式

- `ToolContext` 增加授权请求依赖（store 读 / 写与广播回调），由 `src/tools/extension.ts` 从装配处注入；registry 保持纯逻辑、可单测。
- 称谓在工具运行时读取（`readBossName(ctx.ws)`），**tool description 用中性词「负责人」**（静态字符串，不做工具工厂）。
- **异步认知三层同步**（agent 必须知道这是异步申请）：
  1. SKILL.md 新增小节（§8.6 文档同步）；
  2. 工具 description：明确"异步：立即返回；批准后会收到新消息；等待期间不要重复发起、不要尝试写入"；
  3. 工具返回文案：见 4.2 第 4 步。

---

## 5. 服务端 API、SSE 与处理编排

### 5.1 REST

| 方法 / 路径 | 说明 |
|---|---|
| `GET /api/permission-requests` | `{ requests: PermissionRequestView[] }`（`createdAt` 降序）。`PermissionRequestView = PermissionRequest + { agentName }`（服务端解析 alias，失败回落 id）。初始化 / SSE 重连后全量拉取。 |
| `POST /api/permission-requests/:id/resolve` | body `{ "decision": "accept" \| "reject" }`。200 `{ ok: true, warning?: string }`；id 未知 / 已处理 → 404；decision 非法 → 400；写 `permission.json` 失败 → 500（请求保留）。 |

- 未配置模式（无有效 config）→ 409（沿现有约定）；
- 同 id 并发以「处理中集合」防重（见 §5.3），第二个请求按 404 处理（D13）。

### 5.2 SSE 事件（`src/server/sse.ts`）

```ts
| { type: "permission.request"; request: PermissionRequestView }   // 新请求（全量）
| { type: "permission.resolved"; id: string }                      // 已处理（其余标签页移除卡片）
```

### 5.3 处理编排（`src/app/permission-flow.ts`）

```ts
resolvePermissionRequest(deps, id, decision): Promise<{ ok: true; warning?: string }>
```

流程（accept / reject 仅差写文件一步）：

1. 校验：`store.get(id)` 不存在（或已在处理中集合）→ 抛 NotFound（→ 404）；加入处理中集合（`finally` 移除）；
2. **accept**：`appendPermissionPaths(<agents/agentId/permission.json>, request.paths)`（§7.1）；
3. **投递**：`parseRoomKey(request.roomKey)` → `sendToRoom(ws, harness, relation, text, { queue, defaults, requestId: "permission:" + id })`
   - `text`：群聊 `@<agentId> 已完成授权` / 私聊 `已完成授权`；reject 同理文案「已拒绝授权」；
   - 投递的会话用 `pump.register(delivery…)`（best-effort，同现有 messages POST 口径）；
   - 投递失败：不抛错，`warning: "授权已完成，但通知消息投递失败（详见服务端日志）"`；
4. `store.remove(id)`（内存 + 落盘）→ `hub.broadcast({ type: "permission.resolved", id })`。

### 5.4 装配（`src/server/main.ts`）

- 创建 store（load 一次）→ 注入 tools 扩展（新建请求的 add + 广播）与 HTTP（GET / resolve）；
- `SseHub` 已有，直接复用。

---

## 6. 前端 UI（右下角卡片堆叠）

### 6.1 状态与数据流

- `web/state.ts`：`State` 增加 `permissionRequests: PermissionRequestView[]`；
  - UiEvent：`{ type: "permissions"; list }`（全量替换）、`sse` 事件的 `permission.request`（头部插入，按 id 去重）/ `permission.resolved`（按 id 移除）；
  - 处理中 / 错误提示是纯前端附加字段（如 `busy` / `error`），不进后端契约；
- `web/api.ts`：`permissionRequests()`、`resolvePermissionRequest(id, decision)`；
- `web/main.ts`：
  - 初始化 / `refreshAll`（SSE 重连回调）时全量拉取；
  - `renderDynamic` 处理两个新 SSE 事件 → 只重建卡片容器；
  - 点「接受 / 拒绝」→ 本地标记处理中（按钮禁用）→ POST → 成功移除卡片（SSE resolved 幂等兜底）；失败：卡片内红字错误、保留可重试；响应带 `warning` 时 alert 提示一次。

### 6.2 卡片渲染（`web/render.ts`）

固定右下角容器（`#perm-cards`，`position: fixed`），纵向堆叠、**新请求在上**；每条卡片：

```
┌ 授权请求 ──────────────────┐
│ 发起人：爱丽丝（alice）       │
│ 来自：群聊「demo」/ 私聊      │   ← 由 state.projects / employees 推导
│ 理由：整理品牌素材需要写入共享目录 │
│ 地址：                      │
│  /Users/shared/brand/a      │   ← 等宽字体；多条目限高滚动
│  /Users/shared/brand/b      │
│ [接受] [拒绝]               │   ← 处理中禁用；失败红字在其下
└────────────────────────────┘
```

- 一切文本 `escapeHtml`；
- 卡片**不展示称谓**（无需），标题固定「授权请求」；
- 样式进 `web/styles.css`（与现有风格一致：白底、圆角、细边框、`#1677ff` 主按钮、红字错误）。

### 6.3 集成点

- 无房间时（未选任何房间）也要显示卡片（全局容器挂在 layout 外层，不依赖当前房间）；
- 「历史」等只读视图期间同样可见（容器独立于聊天面板内容）。

---

## 7. 错误与边界

### 7.1 `appendPermissionPaths(file, paths)`（`src/domain/permissions.ts` 新增）

- 读现有路径（`readPermissionPaths`）→ 合并去重（保序，新路径追加）→ `mkdir -p`（父目录）→ 原子写（`.tmp` + `rename`），JSON 数组、2 空格缩进、末尾换行（对齐现有文件风格）；
- **坏文件保护**：文件存在但无法解析 / 非数组 / 含非字符串元素 → 先复制为 `<file>.bak`，再以「新数组」覆盖（坏文件本就不生效，覆盖不改变安全性；`.bak` 留痕）；
- 空 `paths` → 不写（调用方已校验）；
- 已存在的条目（含 `paths` 归一后相同）不重复追加（D12）。

### 7.2 其他边界

- **写盘失败**（接受时）：500，请求保留，卡片显示错误、可重试；
- **拒绝**：绝不触碰任何文件；
- **双标签页同时点**：第二个 404；UI 收到 404 即当作已处理移除卡片；
- **重启**：store 从盘恢复；agent 会话链持久，处理照常投递到其活跃会话；
- **accept 时发起者目录已不存在**：404（请求保留，可点「拒绝」清除；不复活目录）；**投递时的坏链**（openDm/openGroup 抛错）→ 按 D14 降级（warning、请求移除）；
- **中断**：无特殊处理（异步模式下与现有中断语义正交）；
- **启动竞态**：工具调用（add）与 resolve 都在同一进程内存单例上串行读写，无文件锁问题。

---

## 8. 称谓单源化（bossName）

### 8.1 单源定义

- `config.json` 的 `bossName`：缺省「老板」；**缺失 / 空串 / 纯空白 / 非字符串 / 坏 JSON → 回落「老板」**（现有 `readBossName` 已具备，语义升级为"不可为空、不可移除"：系统永远有一个有效称谓，无「关闭」档）；
- prompt 变量 `boss_name` 已存在（`src/domain/prompt-vars.ts`）——环境段消费，不再改机制。

### 8.2 环境段模板（`src/prompts/dm.md` / `group.md`）

- 措辞修订（消除"老板「老板」"式重复，统一用「负责人」做角色词）：

  - `dm.md`：`当前会话：与「{{boss_name}}」（你的负责人）的私聊。工作目录：{{workdir}}。`
  - `group.md`：`…「{{boss_name}}」（你的负责人）是每个群的天然成员（不在成员名单里列出）…`
  - `group.md` 规则段：`发给负责人（请示 / 汇报）：把 `@{{boss_name}}` 写在最前面（`@老板`、`@boss` 同样有效）——负责人会看到，并计入待办红点。…会被系统当作发给负责人（自动补 `@{{boss_name}}`）。`
  - `group.md` 末行：`…找负责人也可以用 send_message（target=boss）。`

- 环境段在会话创建时固化；老会话保持旧文案，`@老板` 双认保证行为不变（§8.4）。

### 8.3 UI 显示

- `GET /api/status` 增加 `bossName` 字段（未配置模式也返回，读不到配置即「老板」）；
- `web/state.ts` 存 `bossName`；`web/render.ts` 老板消息的发言人名、`web/main.ts` 历史视图渲染均消费之（`messageHtml` / `messagesHtml` 加参数）。

### 8.4 @ 解析双认（`mention.ts` → `routing.ts` → 消费点）

- 服务端消费点统一传 `bossNames = unique([readBossName(ws), "老板", "boss"])`：
  - `src/app/send.ts`：`sendToRoom`（老板发送）与 `triggerFromGroupReply`（成员回复触发）内部读 config 后传参；
  - `src/app/rooms.ts`：`normalizeChatMessage` / `mergeRoomMessages`（bossDirected 判定 + fallback 显示）——**bossName 由调用方传入**（本文件不 import node 模块，保持 bundle 安全）；
  - `src/app/routing.ts`：`planRouting(text, memberIds, bossNames?)` 透传（默认参数保持 `["老板","boss"]`，浏览器 bundle 行为不变）；
- **显示 fallback**（员工回复没写有效 @ 时补前缀）：由写死的 `@老板` 改为 `@<当前称谓>`（rooms.ts，称谓由调用方传入）；
- **冲突优先级**：员工 id 命中优先于 boss 名（沿用现有实现）；`@<称谓>` 若与某员工 id 同名，仍是该员工被触发（老板侧语义不受影响）；
- **不动的部分**：前端 `web/composer.ts` 的勾选 / 门禁只关心成员，无需变更（老板不 @ 自己）。

### 8.5 工具文案

- `room_history` 的 `speakerName`：boss → 当前称谓（`ctx.ws` 读取）；
- `send_message`：description 用中性词「负责人」；返回文案 `已发给「<称谓>」（会显示在其待办里）。`；
- `request_permission`：§4 已定（description 中性、返回消费称谓）。

### 8.6 静态文档（技能手册）

- `src/skills/openstaffs/SKILL.md`：
  - 「你是谁、在哪工作」末尾加映射句：`本手册中的「老板」= 你的负责人（办公室所有者）。负责人可自定义称谓（如「掌柜」），以环境段给出的为准；汇报时用 `@<环境段给出的称谓>`（`@老板`、`@boss` 亦有效）。`
  - 「可用工具」新增 `request_permission` 条目；
  - 新增「申请额外写权限（`request_permission`，异步）」小节（措辞与 §4 一致，含 D7"不得越狱"硬约束）。
- `src/skills/openstaffs-ops/SKILL.md`：
  - 相同映射句（总原则附近）；
  - `permission.json` 章节说明"老板通过授权弹框批准后，框架会代写员工的 `permission.json`"；
  - config 表更新 `bossName` 描述（缺省、不可为空 / 移除）；
  - 「员工目录」表与故障对照表补授权相关条目。
- `README.md`：config 示例与字段表补 `bossName`（如无则加）。

---

## 9. 实现落点（文件清单）

| 类型 | 文件 | 说明 |
|---|---|---|
| 新增 | `src/domain/permission-requests.ts` | 请求类型 + store（load / add / remove / list、原子落盘、降级） |
| 新增 | `src/app/permission-flow.ts` | `resolvePermissionRequest` 编排（写文件 → 投递 → store → 广播） |
| 新增 | `tests/domain/permission-requests.test.ts`、`tests/app/permission-flow.test.ts` | 见 §10 |
| 修改 | `src/domain/permissions.ts` | `appendPermissionPaths` |
| 修改 | `src/domain/mention.ts`、`src/app/routing.ts` | bossNames 参数化透传（纯参数，bundle 安全） |
| 修改 | `src/app/send.ts`、`src/app/rooms.ts`、`src/server/pump.ts` | 称谓消费 + 双认传参 + fallback |
| 修改 | `src/tools/registry.ts`、`src/tools/extension.ts` | 新工具 + 依赖注入 + 文案 |
| 修改 | `src/harness/access-extension.ts` | 拦截提示追加"可申请授权"（中性措辞，不引入称谓依赖） |
| 修改 | `src/server/http.ts`、`src/server/sse.ts`、`src/server/main.ts` | 端点 / 事件 / 装配 / status.bossName |
| 修改 | `web/api.ts`、`web/state.ts`、`web/render.ts`、`web/main.ts`、`web/styles.css` | 卡片 UI + bossName 显示 |
| 修改 | `src/prompts/dm.md`、`src/prompts/group.md` | 措辞与 @ 语法文案 |
| 修改 | `src/skills/openstaffs/SKILL.md`、`src/skills/openstaffs-ops/SKILL.md`、`README.md` | 文档同步（§8.6） |

---

## 10. 测试计划（TDD）

| 测试 | 覆盖 |
|---|---|
| `tests/domain/permission-requests.test.ts`（新） | store：load 空 / 坏文件降级、add / remove 落盘往返、原子写（无残留 .tmp）、列表顺序（新在前）、同路径集合去重判定 |
| `tests/domain/permissions.test.ts`（补） | `appendPermissionPaths`：追加新条目、已有条目去重、保留原有条目、坏文件 → `.bak` + 覆盖、父目录创建、空 paths 不写 |
| `tests/domain/mention.test.ts`、`tests/app/routing.test.ts`（补） | bossNames 传参双认；自定义称谓命中 BOSS_ID；默认参数行为不变 |
| `tests/app/send.test.ts`（补） | 老板发送 `@<称谓>` 双认；触发消息 requestId 去重 |
| `tests/app/rooms.test.ts`（补） | fallback 前缀用传入称谓；bossDirected 双认 |
| `tests/app/permission-flow.test.ts`（新） | accept：写文件 + 投递文本（群聊带 @ / 私聊不带）+ store 移除 + 广播；reject：不写文件 + 文案；未知 id → NotFound；并发防重；写盘失败 → 抛错且请求保留；投递失败 → warning |
| `tests/tools/registry.test.ts`（补） | `request_permission`：成功（归一 / 去重 / 广播回调 / 返回文案含称谓）、相对路径按 cwd 解析、reason 空报错、paths 空报错、重复请求不新建；`send_message` / `room_history` 称谓文案 |
| `tests/server/http.test.ts`（补） | GET 列表（降序、agentName）、POST resolve 200 / 400 / 404、未配置 409、status 带 bossName |
| `tests/server/sse.test.ts`（补） | 新事件类型序列化 / 广播 |
| `tests/web/state.test.ts`、`tests/web/render.test.ts`（补） | pending 增删 / 去重、卡片 HTML（转义、理由、来源、按钮）、bossName 显示 |
| `tests/harness/access-extension.test.ts`（补） | 拦截提示含"可申请授权" |
| `tests/web/bundle.test.ts`（回归） | routing / mention 的改动不引入 node 依赖（bundle 仍可构建） |

---

## 11. 手动验收场景

| # | 场景 | 预期 |
|---|---|---|
| 16 | **授权弹框（接受）** | 私聊让 alice 写越界路径 → 被拦且提示可申请；alice 调 `request_permission`（带理由）→ 右下角出现卡片（发起人 / 理由 / 绝对路径）；点「接受」→ `agents/alice/permission.json` 出现该路径、alice 收到「已完成授权」后继续写入成功 |
| 17 | **授权弹框（拒绝）** | 再来一次 → 点「拒绝」→ 无文件写入；alice 收到「已拒绝授权」；再次写仍被拦 |
| 18 | **群里多弹框** | 两名成员分别申请 → 两张卡片堆叠、各自处理；批准消息以 `@<该成员> 已完成授权` 开头出现在群里、只触发该成员 |
| 19 | **重启保留** | 申请后不处理 → 重启服务 → 刷新页面 → 卡片仍在，可正常处理 |
| 20 | **称谓自定义** | `config` 写 `"bossName": "掌柜"` → `bossName` 直读配置——**刷新页面 / 新开会话即生效（无需重启）**；界面发言人名 / 环境段 / 工具返回文案显示「掌柜」（**授权卡片本身不展示称谓**）；成员回复 `@掌柜` 计入待办红点；`@老板` 仍有效；`bossName` 置空 → 回落「老板」 |
| 21 | **异步认知** | 观察 alice 发起申请后的行为：不再反复尝试写入、不重复发起；等待期间继续做其他工作或结束本轮；批准后以新一轮继续 |

---

## 12. 与既有 spec 的关系

- **权限 spec（2026-10-16）**：写判定（`isWriteAllowed` / `matchesPermission`）与基线规则**完全不变**；新增的只是"申请 → 批准 → 框架代写发起者 `permission.json`"通道。框架代写属框架行为（不经 agent 工具层拦截），`permission.json` 本体仍禁止 agent 写（D9 该 spec）。
- **架构 spec（2026-10-16）**：新增工具、REST 端点与 SSE 事件三个契约扩展；消息 / 触发 / 未读机制沿用，无修订。
- **群聊 @ 规则（`docs/handoff-2026-10-16-group-chat.md` 相关实现）**：前缀块语义、bossDirected 口径不变；`bossNames` 扩为双认（§8.4）。
