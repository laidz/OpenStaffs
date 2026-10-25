# OpenStaffs

完全本地化的「AI 办公室」：**一个配置文件就是一个员工，拉群就是立项，下载就是招募。**

- **人 = 一个配置文件**：`agents/<部门…>/<名字>.agent.config.json` 定义一个人的展示名、模型与人格（`prompt`）；`agents/` 下的**文件夹 = 部门，可任意嵌套**——整棵组织树可版本化、可备份、可整包迁移。各人的工作产物在 `work/<名字>/`。
- **项目 = 群聊**：在 `projects/` 下建一个 `seo.project.config.json`、在 `members` 里写下成员，就是一场多人群聊；每个人的工作产物在各自的 `work/<名字>/`（项目本身没有共享目录）。
- **100% 本地**：服务与数据都在本机；对话内容只会发往你自己配置的模型供应商，密钥不出本机。
- **纯 Web**：浏览器打开 `http://localhost:4319` 即可使用，无需安装桌面应用。

> **四层命名（口径统一）**：**系统**（框架本体）/ **空间**（一个办公空间 = 你启动时指定的运行目录）/ **项目**（群聊）/ **员工**。指目录一律说「办公空间」；`openstaffs/` 放空间声明与能力 / 附属（`space.config.json`、技能、`mcps.json`），机器私有（配置与运行状态）在其下的 `openstaffs/.data/`。

## 快速开始

要求：Node ≥ 22.19（服务端直接用 Node 运行 TypeScript，无需编译）。

1. `npm install`
2. 准备一个**办公空间目录**（运行数据与配置都存这里：`agents/` 人与部门、`projects/` 群聊、`work/` 各人的工作目录、`openstaffs/` 空间声明与技能 / MCP（机器私有的 `openstaffs/.data/` 放配置与运行状态），与框架代码相互独立）：
   ```bash
   mkdir -p ~/MyOffice
   ```
3. （可选）在办公空间目录里创建 `openstaffs/.data/config.json`（见下节；也可以先跳过——首次启动会自动初始化空间，页面会显示引导页）。
4. 启动——**必须指定办公空间目录**，端口可选：
   ```bash
   npm start -- ~/MyOffice
   npm start -- ~/MyOffice 5000        # 端口可选
   # 等价的环境变量写法：OPENSTAFFS_ROOT=~/MyOffice OPENSTAFFS_PORT=5000 npm start
   ```
5. 浏览器打开 `http://localhost:4319`（或你指定的端口）。

> 办公数据与框架代码强制分离：不指定目录会报错退出；把办公空间目录指向框架目录本身也会被拒绝。建议在办公空间目录里单独 `git init`——人与部门配置随之可版本化、可备份、可整包迁移；**记得在空间的 `.gitignore` 里加上 `openstaffs/.data/`**——那里是 API Key 等机器私有明文，别让 `git add -A` 把密钥提交进版本库。（级别命名：系统 / 空间 / 项目 / 员工——指目录一律说「办公空间」。）

（开发自用：`npm test`、`npm run typecheck`、`npm run build:web`。）

## 配置

### 1. 模型（必需）

在办公空间目录下创建 `openstaffs/.data/config.json`：

```json
{
  "providers": { "opencode-go": { "apiKey": "sk-…" } },
  "model": "opencode-go/deepseek-v4.1-flash",
  "thinkingLevel": "high",
  "bossName": "老板",
  "skillPaths": ["~/global-skills"],
  "mcp": { "github": { "token": "ghp_…" } }
}
```

- `providers`：供应商 → 密钥。可选 `opencode-go` / `anthropic` / `openai` / `deepseek` / `google` / `openrouter`（写了名单外的供应商，启动会直接报错）。
- `model`：全局默认模型，格式 `供应商/模型 id`；人没有在自己的配置里单独指定模型时用它兜底。
- `thinkingLevel`：可选，全局默认思考强度。档位由模型决定（候选 `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`）；配置端不校验，但非思考模型（只支持 `off`）、未显式映射的 `xhigh` / `max`、以及非法档，界面都会展示 `null`。人自己配置里的 `thinkingLevel` 优先；改动**新开会话**生效。
- `bossName`：可选，负责人称谓（缺省「老板」；空值自动回落，不可为空）。界面、消息与员工文案都用它。
- `skillPaths`：可选，外部技能目录数组（你的全局技能库）。三种写法：`~/` 开头（或裸 `~`）= 家目录、绝对路径 = 原样、其余 = 相对办公空间目录。算**空间级**技能（所有会话可用），改动**新开会话**生效。**只指向你自己信任的目录**——这里的技能会进入**所有**员工会话的制度提示词（`name` / `description` 注入，正文由员工按需 `read`）。
- `mcp`：可选，MCP server 的凭据（`mcp.<server>.<key>`）。定义文件 `openstaffs/mcps.json` 里只写 `${config.mcp.<server>.<key>}` 引用，不写明文。
- 可只配一家，也可多配几家、按人分配不同模型。
- 配置是进程级的：**改完重启服务才生效**（例外：`bossName` 直读，刷新页面 / 新开会话即生效；`skillPaths`、`model`、`thinkingLevel` 新开会话生效）。建议 `chmod 600 openstaffs/.data/config.json`；密钥只存在本机，不会出现在日志与任何 API 响应里。

### 2. 空间能力（可选）

在办公空间的 `openstaffs/space.config.json` 里，给全体会话加总纲 / 默认技能与 MCP：

> 新建空间时框架已自动物化一份**内置空间总纲**（写进本文件的 `prompt` 字段）——这也是空间总纲的唯一来源：想改直接改这个 `prompt`（改完**新开会话**生效），不必（也不能）改框架文件。
>
> **旧空间升级提示**：已存在 `space.config.json` 的空间不会自动迁移总纲。**P5 之前建的空间如需新版空间总纲，请删除 `openstaffs/space.config.json` 后重启**（框架会重新物化一份内置总纲；删前先备份你手改过的内容）。

```json
{
  "prompt": "汇报用中文、简短；先给结论。",
  "skills": ["report"],
  "mcp": ["github"]
}
```

- `prompt`：空间总纲，注入**所有**会话（与部门 / 项目 / 员工的 `prompt` 一起按空间 → 部门 → 项目 → 员工累加）。
- `skills`：技能**名**数组，到 `openstaffs/skills/<技能名>/` 解析（累加；系统内置技能恒在）。
- `mcp`：MCP server **名**数组，到 `openstaffs/mcps.json` 解析（累加）。
- `permissions`：按工具 → 路径列表（可选）；**只有项目 / 员工两层进权限路线**（见「4. 项目」与「3. Agent」）。

### 3. Agent（员工）

**人 = 一个配置文件** `agents/<部门…>/<名字>.agent.config.json`（**文件名的骨干就是员工 id**，全局唯一）；`agents/` 下的**文件夹 = 部门，可任意嵌套**。最小做法：

```bash
mkdir -p agents/eng
cat > agents/eng/alice.agent.config.json <<'EOF'
{ "alias": "爱丽丝", "model": "opencode-go/deepseek-v4.1-flash", "prompt": "你是 alice，负责前端开发。用中文汇报。" }
EOF
```

刷新页面，alice 出现在左侧栏（**员工按部门折叠成树，点部门名展开 / 收起**）；进入她的私聊即可对话。她的回复会按 Markdown 排版展示（标题、列表、代码块、表格都支持）；你发出的消息保持原样。

员工行右侧的 **▤** 打开「会话上下文」（只读）：Tab 列出该员工所有活跃会话（私聊 + 各群，运行中的带点），选中后可查看系统提示词、完整模型上下文（含工具调用与结果）、模型 / 思考强度 / 上下文用量。用于查阅与调试，不会触发模型。运行中带点实时变化；Tab 列表会自动补全新会话；正文不自动替换，有新内容时顶部出现「有新内容」按钮，点它或「刷新」重取。

- `prompt`：她的人格与职责（会话创建时注入）；`alias`：展示名（缺省 = 文件名主干）；`model` / `thinkingLevel`：可选，覆盖全局默认模型与思考强度。
- `skills` / `mcp`：可选，技能名 / MCP server 名数组（累加；见「空间能力」与「MCP server」两节）。
- `memory`：可选，是否启用原生记忆（缺省 `true`；空间 `openstaffs/.data/config.json` 里也有一个同名总开关，员工配置优先）。关闭后该员工不注入记忆、`memory_*` 工具不可用，已有数据保留。
- `permissions`：可选，**按工具 → 路径列表**。缺省 `{ "write": [], "read": ["./"], "bash": ["./"] }`；相对路径相对**本文件所在目录**（即她所在部门目录）。员工配置**只能由你（或框架的授权流程）写**——员工自己（含主管）写不了 `*.agent.config.json`。
- 部门可写 `department.config.json` 声明展示名与负责人：`{ "alias": "工程部", "head": ["alice"] }`——`head` 只能写**本级直属成员**（写子部门成员 / 写错 id 视为无）；负责人对自己所在部门的**整棵子树**有写权限（穿透），但其中的 `*.agent.config.json` 仍在硬保护内（写不了）——**主管当前没有直接写下级定义的通道**，改下级定义请由你写或走授权流程。你写配置一律通过 `write` 工具（受 attenuation 校验）；`bash` 写配置会被拦。
- 她的**工作目录**是 `work/<她的 id>/`（示例里即 `work/alice/`，私聊与群聊的会话都落这里）；原生记忆在 `work/<她的 id>/memory/`，由 `memory_*` 工具维护，新会话自动注入 profile 与索引。同一员工可以在多个房间**并行**工作；`work/` 下写已存在文件前必须先 `read`（框架强制，`bash` 除外）。`alias` 刷新页面即生效，`prompt` / `model` / `thinkingLevel` / `skills` / `mcp` / `memory` 要**新开会话**生效，`permissions` 每轮写校验即时读。

她的展示名与人格（`prompt`）都可以继续完善——需要什么直接问她：她能自己动手的会自己动手，动不了的会告诉你怎么做。

### 4. 项目（群聊）

项目 = `projects/` 下的一个**声明文件** `<项目 id>.project.config.json`，同时就是一场群聊。最小做法：

```bash
cat > projects/demo.project.config.json <<'EOF'
{ "alias": "演示群", "members": ["alice"] }
EOF
```

刷新页面，demo 出现在左侧栏。群聊里在输入框上方**勾选成员**（可多选）后发送——勾选即以 `@成员id` 写进消息开头，只有被勾选的成员响应；没勾选（或只有 @ 没有正文）发不出去（不再有「不 @ 就广播」）。群成员之间也会互相 `@` 协作（写在回复最前面即触发）；发给你的消息以 `@老板` 开头——**把鼠标移到气泡上**会出现工具栏：`复制`（复制该条 Markdown 原文）与 `📌`（加图钉）；**侧栏红点 = 你 pin 过的消息数**（打开房间、有人发言都不会自动亮/灭红点）。

- `members`：成员 id 数组（只列员工，id = `<名字>.agent.config.json` 的文件名主干；老板是每个群的天然成员，不用写）。为空 → 发送报「群还没有成员」；写不存在的 id → 报「员工不存在」。
- `alias`：群展示名；`owner`：群主名单（声明式字段，暂未消费）；`prompt` / `skills` / `mcp` / `permissions`：群级能力与权限（累加；`permissions` 与员工层相加）。
- 项目**没有共享目录**：每个成员的会话工作目录都是各自的 `work/<名字>/`；要共享产物就写进各自工作目录、在群里发路径。

> **会话语义**：`新开会话` = 「下一条消息开启新会话」——按钮只置就绪态（不落盘、不建会话），你发出的第一条消息投递时才真正建会话（空点不产生空会话、撤回也不建）；员工在跑时消息先**排队**，在消息区显示为灰底「排队中」气泡，可**单条撤回**（只撤还没开始投递的；停止正在跑的任务用 `中断`）。

> **会话信息条**：聊天标题下方显示当前房间每条活跃会话**实际在用**的模型全值（`供应商/模型 id`）、思考强度、已用上下文 / 模型窗口与占比（如「12.8K / 128K，10%」）。这些是会话创建时的快照（改配置后要新开会话才变）；模型不支持的思考档（非思考模型、未映射的 `xhigh` / `max`、非法档）展示 `null`。上下文用量是已提交上下文的估算：新会话在首轮回复前可能显示 0，首轮后按模型回报更新。

### 5. MCP server（可选）

**定义只有一份**：`openstaffs/mcps.json`；各层 `*.config.json` 用 `mcp: ["<server 名>"]` **按名引用**（空间 → 部门 → 项目 → 员工累加）。

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${config.mcp.github.token}" }
    }
  }
}
```

- server 名就是 `mcpServers` 的 key，直接用于工具名、扩展名与凭据引用；只允许字母、数字、`_`、`-`（不能含点号或空白）。
- 按名引用后**累加**（写了未定义的名字会被跳过，不影响会话）；旧的多层 `mcp.json`（系统 `src/mcp.json` / 空间 / 项目 / 员工）**已全部退役**。
- 凭据优先放 `env`；写进 `args` 会出现在进程参数里（`ps` 可见）。凭据由你写进 `openstaffs/.data/config.json` 的 `mcp`。
- **新增 / 修改 server 需要重启服务**；server 只进入之后**新建**的会话。
- 员工不能自己定义 server：需要新 server 请改 `openstaffs/mcps.json`，再在相应层 config 的 `mcp` 里按名引用。
- 工具名形如 `mcp__<server>__<tool>`；工具太多时员工先用 `tool_search` 搜索。

> 更多细节（按工具的权限、技能、空间规矩（`space.config.json` 的 `prompt`）、排障……）都在你员工的技能里——办公室开起来之后，直接问你的员工即可。
