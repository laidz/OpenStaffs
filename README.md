# OpenStaffs

完全本地化的「AI 办公室」：**文件夹就是员工，拉群就是立项，下载就是招募。**

- **员工 = 文件夹**：人格、记忆、技能都在 `agents/<员工 id>/` 里，自包含——可版本化、可备份、可整包迁移。
- **项目 = 群聊**：在 `projects/<项目 id>/` 建一个文件夹、写下成员名单，就是一场多人群聊 + 一个共享工作区。
- **100% 本地**：服务与数据都在本机；对话内容只会发往你自己配置的模型供应商，密钥不出本机。
- **纯 Web**：浏览器打开 `http://localhost:4319` 即可使用，无需安装桌面应用。

## 快速开始

要求：Node ≥ 22.19（服务端直接用 Node 运行 TypeScript，无需编译）。

1. `npm install`
2. 准备一个**项目目录**（办公数据根：`agents/` 员工、`projects/` 群聊、`.openstaffs/` 配置都存这里，与框架目录相互独立）：
   ```bash
   mkdir -p ~/MyOffice
   ```
3. 在项目目录里创建 `.openstaffs/config.json`（见下节；也可以先跳过——启动后页面会显示引导页）。
4. 启动——**必须指定项目目录**，端口可选：
   ```bash
   npm start -- ~/MyOffice
   npm start -- ~/MyOffice 5000        # 端口可选
   # 等价的环境变量写法：OPENSTAFFS_ROOT=~/MyOffice OPENSTAFFS_PORT=5000 npm start
   ```
5. 浏览器打开 `http://localhost:4319`（或你指定的端口）。

> 办公数据与框架代码强制分离：不指定目录会报错退出；把项目目录指向框架目录本身也会被拒绝。建议在项目目录里单独 `git init`——员工档案与记忆随之可版本化、可备份、可整包迁移。

（开发自用：`npm test`、`npm run typecheck`、`npm run build:web`。）

## 配置

### 1. 模型（必需）

在项目目录下创建 `.openstaffs/config.json`：

```json
{
  "providers": { "opencode-go": { "apiKey": "sk-…" } },
  "model": "opencode-go/deepseek-v4.1-flash",
  "bossName": "老板"
}
```

- `providers`：供应商 → 密钥。可选 `opencode-go` / `anthropic` / `openai` / `deepseek` / `google` / `openrouter`（写了名单外的供应商，启动会直接报错）。
- `model`：全局默认模型，格式 `供应商/模型 id`；员工没有单独指定模型时用它兜底。
- `bossName`：可选，负责人称谓（缺省「老板」；空值自动回落，不可为空）。界面、消息与员工文案都用它。
- 可只配一家，也可多配几家、按员工分配不同模型。
- 配置是进程级的：**改完重启服务才生效**（例外：`bossName` 直读，刷新页面 / 新开会话即生效）。建议 `chmod 600 .openstaffs/config.json`；密钥只存在本机，不会出现在日志与任何 API 响应里。

### 2. Agent（员工）

员工 = `agents/` 下的一个文件夹，**目录名就是员工 id**。最小做法：

```bash
mkdir -p agents/alice
cat > agents/alice/AGENTS.md <<'EOF'
你是 alice，负责前端开发。用中文汇报。
EOF
```

刷新页面，alice 出现在左侧栏；进入她的私聊即可对话。她的回复会按 Markdown 排版展示（标题、列表、代码块、表格都支持）；你发出的消息保持原样。

她的展示名、岗位档案、长期记忆、技能都可以继续完善——需要什么直接问她：她能自己动手的会自己动手，动不了的会告诉你怎么做。

### 3. 项目（群聊）

项目 = `projects/` 下的一个文件夹，同时就是一场群聊。最小做法：

```bash
mkdir -p projects/demo
cat > projects/demo/members.md <<'EOF'
# 成员
- alice
EOF
```

刷新页面，demo 出现在左侧栏。群聊里在输入框上方**勾选成员**（可多选）后发送——勾选即以 `@成员id` 写进消息开头，只有被勾选的成员响应；没勾选（或只有 @ 没有正文）发不出去（不再有「不 @ 就广播」）。群成员之间也会互相 `@` 协作（写在回复最前面即触发）；发给你的消息以 `@老板` 开头——侧栏小红点只统计这类待你处理的消息。项目目录里的 `data/` 是共享工作区（约定：产物放这里）。

> 更多细节（权限、技能、定制环境段、排障……）都在你员工的技能里——办公室开起来之后，直接问你的员工即可。
