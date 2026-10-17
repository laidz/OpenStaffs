# OpenStaffs

完全本地化的「AI 办公室」：文件夹就是员工，拉群就是立项。配置、员工 / 项目文件与对话记录都在本机；对话内容会发往你配置的模型供应商。浏览器打开 `http://localhost:4319` 使用。

## 快速开始

要求：Node ≥ 22.19（服务端直接用 Node 运行 TypeScript，无需编译）。

1. `npm install`
2. 准备一个**项目目录**（办公数据根：`agents/` 员工、`projects/` 群聊、`.openstaffs/` 配置与状态都存这里，与框架目录相互独立）：
   `mkdir -p ~/MyOffice`
3. 写配置：在项目目录下创建 `.openstaffs/config.json`（见下节；可先跳过，启动后页面会显示引导页）。
4. 启动——**必须指定项目目录**；端口可选：
   ```bash
   npm start -- ~/MyOffice
   npm start -- ~/MyOffice 5000        # 端口可选
   # 等价的环境变量写法：OPENSTAFFS_ROOT=~/MyOffice OPENSTAFFS_PORT=5000 npm start
   ```
5. 浏览器打开 `http://localhost:4319`（或你指定的端口）。

> 框架与办公数据必须分开：不指定目录会直接报错退出；把项目目录指向框架目录本身也会被拒绝。办公目录可以单独 `git init`，让员工档案 / 记忆可版本化、可备份、可整包迁移。

其它命令：`npm test`（vitest 全量用例）、`npm run typecheck`（tsc --noEmit）、`npm run build:web`（只打包前端）。

## 配置 `.openstaffs/config.json`

```json
{
  "provider": "opencode-go",
  "apiKey": "sk-…",
  "modelId": "deepseek-v4.1-flash",
  "port": 4319,
  "bossName": "老板"
}
```

- `provider` / `apiKey` / `modelId` 三项必填；任一缺失、为空或 JSON 损坏 = **未配置模式**：服务照常启动，页面显示引导页，除 `/api/status` 外所有 API 返回 409。
- `provider` 可选：`opencode-go`、`anthropic`、`openai`、`deepseek`、`google`、`openrouter`。写错会在启动时直接报错退出。
- `port` 可选，默认 `4319`；**优先级：启动参数 / `OPENSTAFFS_PORT` > 本文件的 `port` > 4319**。
- `bossName` 可选：老板的展示名（缺省「老板」），仅用于系统提示词里的 `{{boss_name}}` 变量。
- 配置是进程级：改完要重启服务（Ctrl+C 后重新 `npm start`）。不重启会出现「部分生效」的假象——`/api/status` 与新会话的 `modelId` 是按请求重读文件的，但 provider 工厂与凭据仍是启动时那份；判断配置是否生效，请以重启后为准。员工 / 项目目录是运行时读取，改完刷新页面即生效。
- 项目目录**必须显式指定**（`npm start -- <目录>` 或 `OPENSTAFFS_ROOT`），且不能是框架目录本身。
- 建议 `chmod 600 .openstaffs/config.json`；项目目录里的 `.openstaffs/`、`agents/`、`projects/` 均已随框架仓库的 `.gitignore` 忽略；密钥只存在本机。若想版本化员工数据：在项目目录里单独 `git init`。
- 密钥不会写日志、不会出现在任何 API 响应里（`/api/status` 只回 `provider` / `modelId`）。运行状态也放在 `.openstaffs/`：`state.json`（已读水印）、`state.sqlite`（对话库）。

## 创建员工（`agents/<id>/`）

员工 = `agents/` 下的一个文件夹，**目录名就是员工 id**（`@` 提及用这个 id）。

必需：

```
agents/alice/
└─ AGENTS.md      # 入口：人格与职责（如"你是 alice，负责……"）
```

可选：

```
agents/alice/
├─ AGENTS.md                  # 入口（必需）
├─ profile.md                 # 岗位 / 职责 / 人格
├─ MEMORY.md                  # 长期记忆（员工自己也会更新）
├─ config.json                # 展示名 / 模型覆盖（见下）
├─ skills/<技能名>/SKILL.md    # 技能
└─ permission.json            # 额外写权限（JSON 字符串数组）
```

`config.json` 全部字段可选：

```json
{
  "alias": "爱丽丝",
  "provider": "opencode-go",
  "modelId": "deepseek-v4.1-flash",
  "thinkingLevel": "medium"
}
```

- `alias`：界面展示名（缺省 = 员工 id）。
- `provider` + `modelId`：必须**成对**出现才覆盖全局模型；只写一个等于没写（仍用全局模型）。员工 `config.json` 损坏不影响列表，只是按缺省处理。
- `thinkingLevel`：可选，单独生效。

写权限（固定规则）：员工始终可写自己的目录，以及它所在的所有项目目录；`permission.json` 用于额外放行其它路径（例如 `["../bob/data/", "/tmp/shared"]`，相对路径相对该文件所在目录）。`permission.json` 本身不可被员工改写。

技能：`skills/<技能名>/SKILL.md`，头部 YAML frontmatter 提供 `name` / `description`（`name` 缺省 = 目录名）：

```markdown
---
name: weekly-report
description: 按公司模板生成周报
---

（正文：技能步骤 / 模板 / 参考）
```

员工技能只对该员工自己的会话生效；想让一群成员共享同一技能，请放进**项目目录**的 `skills/`（见下节「创建项目 / 群聊」）。

工作区根部的 `AGENTS.md`（可选）会作为总纲注入所有会话。

## 创建项目 / 群聊（`projects/<id>/`）

一个项目 = `projects/` 下的一个文件夹，同时就是一场群聊（目录名 = 项目 id）。

必需：

```
projects/demo/
└─ members.md     # 成员名单
```

`members.md` 每行一个成员 id；`- alice`、`* alice` 或光写 `alice` 都行，`#` 开头的行是注释：

```markdown
# 成员
- alice
- bob
```

可选：

```
projects/demo/
├─ members.md                 # 成员名单（必需）
├─ AGENTS.md                  # 项目级任务规范（群聊会话快照时注入）
├─ project.json               # { "alias": "展示名" }，缺省 = 目录名
├─ skills/<技能名>/SKILL.md    # 项目级技能（同名时优先于员工技能）
├─ permission.json            # 项目级额外写权限
└─ data/                      # 共享工作区（约定：产物放这里；会话默认工作目录是项目目录本身）
```

项目不需要预建会话：第一条发给某成员的消息会按需为它创建会话。群聊会话的默认工作目录就是项目目录本身（`data/` 只是约定放产物的子目录，不会被自动设为 cwd）。

**项目公用技能**：`projects/<项目 id>/skills/<技能名>/SKILL.md`——放进这里，该群**全体成员**的群聊会话都会注入这份技能清单（项目技能 + 各自员工技能合并，**同名时项目优先**）；技能在**会话创建时固化**，新增 / 修改后要「新开会话」才生效。示例：

```
projects/demo/
└─ skills/
   └─ weekly-report/
      └─ SKILL.md    # name / description 写法与员工技能相同
```

## 系统提示词（框架环境段）

每个会话创建时，框架会在 `instructions` **最前**注入一段「环境段」（私聊 / 群聊各一套模板），让员工知道自己的身份、当前会话与工作目录（群聊再带上成员）。

- **模板**：框架内置 `src/prompts/dm.md`（私聊）、`src/prompts/group.md`（群聊）；可在**项目目录**里用 `.openstaffs/prompts/dm.md` / `group.md` 覆盖（覆盖优先）。模板读不到 / 为空 → 不注入环境段。
- **变量**：模板里写 `{{变量}}`，支持多级路径（`{{members.0.name}}`、`{{members[0].name}}`）；未知变量 / 越界下标 → 空串。非标量渲染：数组用「、」连接，对象取 `name`（缺省 `id`）。
- **变量一览**（集中在 `src/domain/prompt-vars.ts`；加变量 = 加一个导出函数 + 在注册表 `promptVariables` 登记一行）：

  | 变量 | 含义 |
  | --- | --- |
  | `agent_name` | 员工展示名（alias，缺省 = id） |
  | `agent_id` | 员工 id（目录名） |
  | `boss_name` | 老板展示名（`config.json` 的 `bossName`，缺省「老板」） |
  | `workdir` | 会话工作目录（私聊 = 员工目录；群聊 = 项目目录） |
  | `project_name` | 项目展示名（群聊；私聊为空） |
  | `project_id` | 项目 id（群聊；私聊为空） |
  | `members` | 群成员数组（`{id,name}`；直出用「、」连接） |
  | `member_count` | 群成员数 |

- 环境段同样在**会话创建时固化**：改模板后要「新开会话」才生效。

## 使用

- 左侧栏列出全部员工与项目（列表为空时显示创建提示）；点一项进入房间。
- 私聊：只对该员工。群聊：`@员工id`（写目录名，不是 alias）定向、可 @ 多个，不 @ 则广播给全体成员；`@老板`（或 `@boss`）不会触发任何人，只 @ 老板的消息等于没发。
- 输入框：Enter 发送，Shift+Enter 换行；`@` 提及是手写文本，无自动补全。
- 消息是异步的：发送后员工各自开工，界面显示流式文本、忙碌点与工具活动；发送请求本身不阻塞，可以立刻再发一条。
- 未读：有员工发言未读的房间显示红点；打开房间即标记已读（每房间一个水印，老板自己的发言不计未读）。
- 会话快照：会话创建时固化员工档案 / 记忆 / 技能 / 模型，**会话进行中改这些文件不生效**；要生效就新开会话。
- 房间头部：「新开会话」结束当前会话、按新档案重新开始（群聊需先在成员下拉框里选人，会话是按成员各自一条的）；「历史」只读回看旧会话（成员 + 开始时间 + 是否进行中）。

## 手动验收清单

按顺序做一遍即可覆盖主要功能：

1. **未配置启动**：项目目录里不建 `.openstaffs/config.json` → `npm start -- <项目目录>` → 浏览器打开首页显示引导页（工作区根、config 路径、示例 JSON）；`curl http://localhost:4319/api/status` 里 `configured` 为 `false`、`root` 等于你指定的项目目录，其它 `/api/*` 返回 409。不带目录参数直接 `npm start` → 报错退出并提示用法。
2. **配置生效**：按上节写好 `config.json` → 重启服务 → 引导页消失；没有员工时左侧显示「还没有员工：在 agents/ 下创建目录并写 AGENTS.md」。
3. **建员工**：创建 `agents/alice/AGENTS.md`（可加 `config.json` 设 alias）→ 刷新页面 → 左侧出现该员工（设了 alias 就显示 alias，如「爱丽丝」）。
4. **私聊对话**：进入 alice 的私聊发一条 → 看到流式回复；不等它答完立刻再发一条，前一条继续生成且不阻塞后一条。
5. **建项目**：创建 `projects/demo/members.md`（含 alice）→ 刷新 → 左侧项目区出现 demo。
6. **@ 定向与广播**：群聊里 `@alice 你好` → 只有 alice 回复；发一条不 @ 的消息 → 全体成员各自回复。
7. **未读红点**：员工在自己没看的房间回复 → 该房间出现红点；打开房间红点消失；切走、让员工再回一条 → 红点再现。
8. **新开会话与历史**：点「新开会话」→ 当前视线清空；点「历史」能看到旧会话并只读回看。
9. **快照语义**：改 `agents/alice/profile.md` → 当前会话的回复不受影响；新开会话后再发消息 → 新档案生效。
10. **密钥不外泄**：任何 API 响应都不含 `apiKey`；`/api/status` 只含 `configured` / `root` / `port` / `provider` / `modelId`。

## 常见问题

- **启动报「必须指定项目目录」**：漏了目录参数——`npm start` 与目录之间要有 `--`（`npm start -- ~/MyOffice`）；也可以写 `OPENSTAFFS_ROOT=~/MyOffice npm start`。报「项目目录不能是框架目录本身」时换一个独立目录存放办公数据。
- **指定端口**：`npm start -- ~/MyOffice 5000`，或 `OPENSTAFFS_PORT=5000`；优先级为 启动参数 > 环境变量 > `config.json` 的 `port` > 4319。
- **端口被占用**：改 `config.json` 的 `port`（或启动参数传端口）后重启。
- **员工回复失败（聊天里出现红色错误气泡）**：检查 `apiKey` 与 `modelId`；错误原文会显示在气泡里。失败要等 provider 重试 / 超时后才会浮出来，可能超过一分钟——这期间看起来只是「一直在生成」。
- **改了 config 不生效**：配置是进程级的，必须重启服务；员工 / 项目文件才是刷新即生效。
- **技能 / 档案 / 记忆改了没反应**：会话创建时已固化 → 新开会话才生效。
- **群聊发送报「群还没有成员」**：`members.md` 不存在、为空或只有注释（解析不出任何成员行）——补上成员 id 即可。
- **群聊发送报「员工不存在: xxx」（HTTP 500）**：`members.md` 里的某个 id 不是任何员工目录名——核对拼写（要用目录名，不是 alias）。
- **@ 没定向成功**：`@` 后面必须写员工 id（目录名），alias 不参与识别——写成 alias 或写错名字会按广播处理；只 @ 老板则谁都不触发，界面提示「未触发任何成员」。
- **想清空某人的上下文**：不要删目录——用「新开会话」；旧会话仍可在「历史」里回看。
- **房间消息未做分页**：`GET /api/rooms/<roomKey>/messages` 每次返回该房间全部活跃会话的完整合并视图（含历史面板），房间消息很多时首屏会变大。
