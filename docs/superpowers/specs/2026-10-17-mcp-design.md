# MCP 四层一致：实现设计

> 状态：待评审 · 日期：2026-10-17 · 分支：`feat/batch4-mcp`
> 关联：`2026-10-17-space-layer-design.md`（四层命名、落点与 MCP 骨架）、`TODO.md` 批次 4
> 需求来源：`TODO.md` 批次 4「MCP 四层一致（实现）」

---

## 1. 背景与目标

批次 3 已定下 MCP 的骨架：四层各一个 `mcp.json`，同名 server 窄者胜，凭据统一放 `.openstaffs/config.json`，注册属「启动」档。批次 4 把它真正接起来。

目标：

1. 读取并合并四层 `mcp.json`，按会话（私聊 / 群聊 + 发言员工）得到可用 server 集。
2. 用 stdio 连接 MCP server，注册其工具，接进 Pi Durable registry。
3. 凭据只从 `.openstaffs/config.json` 取，缺失时明确报错，不静默降级。
4. 做完整的进程生命周期：启动、健康检查、超时、崩溃重连、退出清理；任何 server 故障都不拖死会话启动。
5. 为连接失败、卡死、工具名冲突、凭据缺失、员工自挂 server 建立验收测试，并做一次安全审阅。

**非目标：**

- 不做 HTTP / SSE transport、OAuth、resources / prompts / sampling / roots。
- 不做 MCP 的 UI 管理界面、运行时热重载、按会话独立进程。
- 不做沙箱隔离：MCP server 是本地进程，拥有与 OpenStaffs 进程同级的本机能力。
- 不改变批次 3 的落点与命名。

---

## 2. 决策记录

| # | 决策 | 说明 |
|---|---|---|
| M1 | **仓库内最小 stdio 客户端** | 不引 `@modelcontextprotocol/sdk`；只实现 `initialize`、`notifications/initialized`、`tools/list`、`tools/call`、`ping`，协议版本 `2024-11-05`。 |
| M2 | **`mcpServers` 为唯一顶层结构** | 与主流 MCP 配置一致：`{"mcpServers": {"<name>": {...}}}`；每层一个文件，平铺 server。 |
| M3 | **合并顺序：系统 → 空间 → 员工 → 项目** | 后者窄者胜；不同名全部保留。群聊含项目层，私聊不含。 |
| M4 | **凭据语法定稿** | `${config.mcp.<server>.<key>}`；值来自 `.openstaffs/config.json` 的 `mcp.<server>.<key>`。只替换这一种占位符，其它 `${...}` 原样保留。 |
| M5 | **配置错误只废掉该 server** | 坏 JSON、缺 `command`、凭据缺失等记明确日志并跳过该 server；不使整个服务启动失败，也不回落到更宽层的同名定义。 |
| M6 | **每个 server 一个扩展** | 扩展名 `mcp:<scope>:<server>`；工具名 `mcp__<server>__<tool>`。MCP 扩展不默认选中，会话创建时按合并结果 `extensions.add`。 |
| M7 | **工具清单在启动时固化** | 启动连接成功后 `tools/list` 一次；重连只恢复调用能力，不刷新清单。新增 / 改工具仍需重启，符合「MCP 注册属启动档」。 |
| M8 | **MCP 工具总数超过 20 时全部 deferred** | 同时安装并默认选中 `tool_search`；否则工具直接可见。阈值是常量，不开放配置。 |
| M9 | **子进程环境最小化** | 只继承 `PATH`、`HOME`、`USER`、`LOGNAME`、`SHELL`、`TMPDIR`、`TMP`、`TEMP`、`LANG`、`LC_ALL`、`TZ`，再加 `mcp.json` 的 `env`；不整包继承主进程环境。 |
| M10 | **工具调用不自动重试** | 断线时先尝试重连，再执行本次调用；调用已发出后失败不重试（避免副作用重复）。 |
| M11 | **只做 stdio** | 配置里出现 `url` / `transport` 等字段按未知字段忽略；不猜测 HTTP 语义。 |

---

## 3. 配置格式

### 3.1 `mcp.json`

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${config.mcp.github.token}"
      },
      "cwd": ".",
      "timeoutMs": 60000
    }
  }
}
```

字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `command` | 是 | 可执行文件；含 `/` 时按 `cwd` 解析，否则走 `PATH`。不经过 shell。 |
| `args` | 否 | 字符串数组。 |
| `env` | 否 | 字符串到字符串的 map；覆盖继承的环境变量。 |
| `cwd` | 否 | 工作目录；相对路径相对 **该 `mcp.json` 所在目录**；缺省 = 该目录。 |
| `timeoutMs` | 否 | 单次请求（含 `tools/call`）超时；缺省 60000。正整数。 |

未知字段忽略。`mcpServers` 缺失 / 非对象 → 该文件视为空（坏 JSON 仍报错）。

### 3.2 落点

| 级别 | 文件 | 何时读取 |
| --- | --- | --- |
| 系统 | `src/mcp.json` | 启动 |
| 空间 | `<办公空间>/openstaffs/mcp.json` | 启动 |
| 员工 | `<办公空间>/agents/{员工}/mcp.json` | 启动 |
| 项目 | `<办公空间>/projects/{项目}/mcp.json` | 启动 |

文件不存在 = 该层没有 server（不报错）。系统级文件随仓库提供空模板 `{"mcpServers":{}}`。

### 3.3 凭据

`.openstaffs/config.json`：

```json
{
  "providers": { "opencode-go": { "apiKey": "..." } },
  "model": "opencode-go/...",
  "mcp": {
    "github": { "token": "ghp_..." }
  }
}
```

- 独立读取（像 `skillPaths` / `bossName`），不并进 `WorkspaceConfig`；未配置模式下也能读。
- `mcp` 缺失 / 坏 JSON / 非对象 / 值非字符串 → 该项视为缺失。
- 占位符必须被解析成非空字符串；缺失时该 server 报错并跳过，错误信息包含 server 名与凭据键名，**不包含其它凭据值**。
- 占位符可出现在 `command`、`args`、`env`、`cwd` 的字符串值里。
- 日志永不打印解析后的字符串；`args` 里的明文密钥会出现在进程参数中（`ps` 可见），手册明确要求用 `env`。

---

## 4. 架构

```
src/domain/mcp.ts            解析四层 mcp.json、凭据插值、合并与按会话解析
src/domain/config.ts         readMcpCredentials(ws)
src/harness/mcp-client.ts    最小 stdio JSON-RPC 客户端
src/harness/mcp-manager.ts   快照、连接、心跳、重连、扩展生成、按会话选择
src/harness/mcp-extension.ts MCP 工具 → Pi Extension
src/harness/pi-durable.ts    安装 MCP 扩展；按 ConversationSpec 选择扩展
src/app/conversations.ts     会话快照写入 mcpExtensions
src/server/main.ts           启动 MCP 管理器、生命周期、把管理器注入各调用点
```

### 4.1 数据流

1. 进程启动：`McpManager.start()` 读取四层文件（快照）+ 凭据，逐 server 并行连接、`tools/list`。
2. 管理器为每个有工具的 server 生成一个 `Extension`，并给出 `extensionsFor(relation, speakerId)`：按四层合并结果返回扩展名。
3. 创建 harness 时：MCP 扩展全部 `install`，但 `HarnessSettings.extensions` 固定为「CodingTools + access + OpenStaffs 工具（+ 必要时 tool_search）」——MCP 不在默认集合里。
4. 新开会话：`specFor` 调 `extensionsFor` 写入 `ConversationSpec.mcpExtensions`；harness 以 `agent.extensions = { add: [...] }` 固化到会话。
5. 工具调用：扩展 → 管理器 → 客户端 → MCP server；结果映射回 Pi 的 `output` / `isError`。

### 4.2 合并与解析

`McpSource` 按固定顺序构建：

```
system → space → employee:<id>（全部员工，按 id 排序）→ project:<id>（全部项目，按 id 排序）
```

某个会话的解析：

- 私聊：`system + space + employee:<当前发言员工>`；
- 群聊：`system + space + employee:<当前发言员工> + project:<当前项目>`。

按上述宽 → 窄顺序赋值到 `Map<serverName, definition>`，同名后者覆盖。项目层在群里最窄，因此同名时项目胜；私聊没有项目层。

**坏定义遮蔽**：某窄层文件里声明了同名 server 但配置非法（含凭据缺失），该名字标记为 invalid，不回落到宽层；会话解析时排除，启动日志已给出原因。

### 4.3 工具注册

- 扩展名：`mcp:<scopeKey>:<server>`，`scopeKey` 为 `system` / `space` / `employee:<id>` / `project:<id>`。
- 工具名：`mcp__<server>__<tool>`；`server` / `tool` 中非 `[A-Za-z0-9_-]` 字符替换为 `_`。
- 同一个 server 内 sanitize 后重名：先出现者胜，其余跳过；管理器记日志。
- 跨 server 由前缀天然隔离；同名 server 跨层只会在不同会话里各选一个扩展，不会同时选中。
- `parameters` 使用 MCP 的 `inputSchema`（要求 `type: "object"`）；缺失或非对象 schema → 空对象 schema。
- 返回值：`text` 原样；`image` 映射为 Pi 图片内容；其它块以 JSON 文本呈现；无内容时输出 `structuredContent` 或「（无输出）」；MCP 的 `isError` 透传。
- 工具总数 > 20：全部 `deferred: true`，并让 harness 安装且默认选中 `createToolSearchExtension()`。

### 4.4 进程生命周期

| 阶段 | 行为 |
| --- | --- |
| 启动 | 并行启动全部有效 server；`initialize` 与 `tools/list` 都受 10s 连接超时约束；失败只记日志，`start()` 仍返回。 |
| 初始化 | 发送 `initialize`（protocolVersion `2024-11-05`、clientInfo `openstaffs`），再发 `notifications/initialized`。 |
| 健康 | 就绪后每 30s `ping`，超时 5s；有工具调用在途时跳过本次心跳；连续 2 次失败才重连。 |
| 崩溃 | `exit` 后按 1s、2s、4s、8s、16s 退避重连，最多 5 次；成功后重置计数。 |
| 断线调用 | 工具调用前若未就绪，先尝试一次连接（并发去重）；仍失败则返回明确错误，不执行调用。 |
| 退出 | SIGTERM 进程组 → 2s 后 SIGKILL；清理心跳与重连定时器。 |
| 超时 | 单次 JSON-RPC 请求按 `timeoutMs` 拒绝；挂起的 promise 全部带超时清理，不泄漏。 |

连接失败、卡死、进程不存在都只影响该 server；`McpManager.start()` 不会抛错，会话启动不等待任何重连。

### 4.5 注册与快照语义

- MCP 扩展在启动时安装一次，工具清单此后固定。
- 新增 / 修改 server 或工具：重启进程；已有会话不会自动获得新扩展（扩展选择已在会话里固化）。
- 新开会话时按当时的四层快照选择扩展；某员工新挂的 server 只影响**该员工自己的新会话**，不会影响其他员工。
- 会话创建后，即使别的层新增同名 server，已创建会话不变。

---

## 5. 错误处理

| 场景 | 表现 |
| --- | --- |
| `mcp.json` 坏 JSON | 启动日志：文件路径 + 解析错误；该层按空处理。 |
| server 配置非法 | 日志：server 名 + 字段原因；跳过该 server，并遮蔽宽层同名定义。 |
| 凭据缺失 | 日志：server 名 + `${config.mcp.<server>.<key>}`；跳过该 server。 |
| 连接超时 / 进程不存在 | 日志：server 名 + 错误码（不回显解析后的 command，避免凭据进入日志）；不注册工具，`start()` 返回；`errors()` 可读取。 |
| 连接后 `tools/list` 失败 | 日志；该 server 无工具、不注册扩展；启动阶段失败等重启，重连阶段失败继续退避。 |
| `tools/list` 分页异常 | 超过 50 页即报错，避免无限请求。 |
| 关闭发生在连接窗口 | `close()` 等待在途连接收尾，并关掉在途 client；关闭后不得再变为 ready。 |
| 工具调用超时 / 进程退出 | 工具结果 `isError: true`，文本包含 server 名与原因；不自动重试。 |
| 重连次数耗尽 | 日志：放弃重连，需重启服务。 |
| 同一 server 内工具重名 | 日志；保留第一个，跳过后续。 |

所有错误文案使用中文；错误文本不得包含凭据值或完整环境变量。

---

## 6. 安全审阅要点

1. **任意进程执行面**：员工可写自己的 `mcp.json`，等于可让服务启动任意本地命令。这是批次 3 已定的能力自扩边界，不在写权限层拦；手册必须明确写出风险。
2. **凭据隔离**：凭据只来自老板独占的 `.openstaffs/config.json`；员工挂带密钥的 server 必须请老板加凭据。日志与错误不泄漏凭据。
3. **环境最小化**：不把主进程的 provider 密钥、代理变量等整包传给 MCP server；仅白名单变量 + 显式 `env`。
4. **无 shell**：`spawn(command, args, { shell: false })`，避免参数注入变成 shell 注入。
5. **进程组清理**：POSIX 下 detached 启动，退出时按进程组杀，避免 npx 等中间进程残留。
6. **调用不重试**：避免非幂等外部副作用因断线重试执行两次。
7. **快照边界**：MCP 配置只影响新会话；避免运行中的会话被静默换掉工具面。

---

## 7. 测试设计

### 7.1 单元测试

`tests/domain/mcp.test.ts`

- 四层解析：有效配置、缺字段、坏 JSON、`mcpServers` 非对象、`args` 非字符串。
- 合并：系统 < 空间 < 员工 < 项目；同名窄者胜；不同名全保留；私聊不含项目层。
- 坏定义遮蔽：窄层同名非法时不回落到宽层。
- 凭据插值：`env` / `args` / `cwd` / `command`；缺失凭据报错；其它 `${...}` 保持原样。
- `cwd` 相对 `mcp.json` 目录解析。
- `readMcpCredentials`：正常、缺 `mcp`、坏 JSON、非字符串值。

`tests/harness/mcp-client.test.ts`（fixture：`tests/fixtures/mcp-server.mjs`）

- 正常启动、`tools/list`、`tools/call`（文本 / 图片 / `isError`）。
- 分页 `tools/list`（fixture 支持 cursor）。
- 连接卡死：`connectTimeoutMs` 到点拒绝，进程被清理。
- 请求超时：slow 工具按 `timeoutMs` 拒绝。
- 退出后挂起请求被拒绝、`close()` 幂等。

`tests/harness/mcp-extension.test.ts`

- 工具名前缀与非法字符替换。
- 同 server 重名去重。
- 结果映射（text / image / 空 / isError）与异常转 `isError`。
- `deferred` 标记。

`tests/harness/mcp-manager.test.ts`

- 正常启动生成扩展、`extensionsFor` 私聊 / 群聊差异。
- 凭据缺失：错误可见、server 不注册、`start()` 不抛。
- 命令不存在 / 连接卡死：`start()` 在超时内返回，不拖死。
- 崩溃重连：fixture 首次启动即退出、第二次正常；等待恢复后可调用。
- 超过 20 个工具：全部 deferred 且 `needsToolSearch()` 为 true。
- 同 server 工具名冲突：只保留一个。
- 员工自挂 server 只进入该员工的扩展列表，不影响其他员工。

### 7.2 集成测试

`tests/harness/mcp-harness.test.ts`

- 用 fixture server + faux provider：创建带 `mcpExtensions` 的会话，模型发起 `mcp__fixture__echo` 工具调用，fixture 落文件证明真的执行；回复正常结束。
- 同一 harness 创建不带该扩展的会话，工具不可用（或不在 agent 的 tools 中），验证会话级过滤。

### 7.3 回归

- `npm test`、`npm run typecheck`、`npm run build:web` 全绿。
- 既有 `pi-durable` / `tools/extension` / `conversations` 测试不改语义通过（新增参数均为可选）。

---

## 8. 涉及文件

**代码**

| 文件 | 改动 |
| --- | --- |
| `src/domain/mcp.ts` | 新增：配置解析、凭据插值、四层快照、合并、按会话解析、扩展命名 |
| `src/domain/config.ts` | 新增 `readMcpCredentials` |
| `src/harness/mcp-client.ts` | 新增：stdio JSON-RPC 客户端 |
| `src/harness/mcp-manager.ts` | 新增：连接 / 心跳 / 重连 / 扩展 / 会话选择 |
| `src/harness/mcp-extension.ts` | 新增：MCP 工具 → Pi 扩展 |
| `src/harness/pi-durable.ts` | 安装 MCP 扩展；`settings.extensions` 固定默认集；按 spec 选择扩展；tool_search |
| `src/harness/port.ts` | `ConversationSpec.mcpExtensions?: readonly string[]` |
| `src/app/conversations.ts` | `specFor` / `openDm` / `openGroup` / `newSession` 接 `McpSessionResolver` |
| `src/app/send.ts` | 发送 / 群回复触发透传 resolver |
| `src/app/permission-flow.ts` | 授权结果投递透传 resolver |
| `src/tools/extension.ts` | 工具上下文透传 resolver |
| `src/tools/registry.ts` | 新建会话时透传 resolver |
| `src/server/pump.ts` | 群回复触发透传 resolver |
| `src/server/http.ts` | 发送 / 授权端点透传 resolver |
| `src/server/main.ts` | 创建、启动、关闭 MCP 管理器；优雅退出 |
| `src/mcp.json` | 新增空模板 |

**测试**

| 文件 | 改动 |
| --- | --- |
| `tests/fixtures/mcp-server.mjs` | 新增：可配置的 stdio fixture server |
| `tests/domain/mcp.test.ts` | 新增 |
| `tests/harness/mcp-client.test.ts` | 新增 |
| `tests/harness/mcp-extension.test.ts` | 新增 |
| `tests/harness/mcp-manager.test.ts` | 新增 |
| `tests/harness/mcp-harness.test.ts` | 新增 |
| `tests/domain/config.test.ts` | 新增 `readMcpCredentials` 用例 |

**文档**

| 文件 | 改动 |
| --- | --- |
| `src/skills/openstaffs-ops/SKILL.md` | MCP 从骨架改为实现：配置格式、凭据语法、合并、生命周期、安全风险、生效时机 |
| `src/skills/openstaffs/SKILL.md` | 员工能力：MCP 工具命名、自挂 server、凭据边界、重启 / 新会话 |
| `README.md` | 空间目录与 MCP 配置说明 |
| `docs/产品规划.md` | MCP 从「未来 / 未实现」更新为已实现 |
| `TODO.md` | 批次 4 勾选 + 落地注记 |
| 本文件 | 设计定稿 |

---

## 9. 验收标准

1. 四层 `mcp.json` 能解析合并；同名 server 在群聊按项目 > 员工 > 空间 > 系统胜出，私聊无项目层。
2. `.openstaffs/config.json` 的 `mcp` 凭据可被 `${config.mcp.<server>.<key>}` 引用；缺失时日志明确报错，server 被跳过，服务继续启动。
3. MCP server 卡死 / 命令不存在 / 崩溃时，`start()` 和会话创建不被拖死；崩溃后能自动重连并恢复工具调用。
4. 工具注册为 `mcp__<server>__<tool>`；工具总数 > 20 时 deferred + `tool_search`；同 server 重名只保留一个。
5. 员工级 `mcp.json` 只影响该员工的新会话；不会泄漏到其他员工或其他项目的会话。
6. 新增 / 修改 server 需要重启；已创建会话的扩展选择不被改变。
7. fixture server 的端到端集成测试通过（真实 `tools/list` + `tools/call`）。
8. `npm test` / `npm run typecheck` / `npm run build:web` 全绿；完成一次安全审阅并按结论修正。
