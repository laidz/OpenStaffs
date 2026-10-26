# 系统级 Prompt 由框架自持设计

> 日期：2026-10-26
> 状态：设计已确认，待实现

## 1. 背景与目标

当前唯一的系统级 prompt 是 `src/prompts/space.md`，新建空间时由 `ensureSpaceConfig` **物化**（复制）进 `openstaffs/space.config.json` 的 `prompt` 字段。此后运行时只读工作区配置，框架文件不再参与。

这带来一个结构性问题：**框架升级改了 prompt，已有工作区永远拿不到**。老板也不知道哪些内容该改、哪些是系统的。

本次把系统级 prompt 收回框架自持：

1. 系统级 prompt 模板放在框架 `src/prompts/` 下，由代码维护；
2. 进程启动（`npm start`）时一次性读入内存，运行期不再读盘；
3. 每次**新开会话**用内存模板 + 当前工作区数据渲染；
4. 重启后新会话即拿到升级后的模板；已存在的会话保持自己的快照，不热更新（允许输入缓存失效）；
5. 工作区配置里的 `prompt` 只保留为**用户自定义层**，不再承载系统文案。

## 2. 非目标

- 不做老工作区兼容或迁移。旧 `space.config.json` 里的物化副本按新标准视为普通用户内容，框架不识别、不清空、不提示。
- 不做运行期热更新：模板只在进程启动时读取。
- 不新增 WebUI 编辑入口。
- 不改变用户 prompt 链的累加语义（空间 → 部门（根 → 叶）→ 项目 → 员工，无覆盖）。

## 3. 现状与影响面

| 位置 | 现状 | 本次变更 |
| --- | --- | --- |
| `src/prompts/space.md` | 唯一内置 prompt，含环境、私聊/群聊差异、记忆提示 | 删除，拆成四个模板 |
| `src/domain/space.ts` | `builtinSpacePrompt` / `SPACE_PROMPT_TEMPLATE` / `newSpaceConfig()` 物化 | 删除读取与物化，`newSpaceConfig()` 返回 `{}` |
| `src/app/conversations.ts` | `instructionsFor` = prompt 链 → 记忆 → 技能 | 改为系统段 → 用户链 → 记忆 → 技能 |
| `src/domain/prompt-vars.ts` | `workdir` / `group_rules` 变量 | 改名 `private_dir`；删除 `group_rules` |
| `src/config/schema.ts` | `prompt` 字段四层通用 | 不变（空间层默认空） |
| 文档 | 描述 prompt 物化与旧空间升级 | 按新标准重写 |

## 4. 模板

四个文件放在 `src/prompts/`，`{{...}}` 由 `renderTemplate` 按现有变量机制渲染。变量不新增；`{{workdir}}` 统一改名为 `{{private_dir}}`，取值仍是当前会话工作目录（`PromptVarContext.cwd`）。代码里的 `paths.workDir` 等领域概念不改名。

### 4.1 `environment.md`（恒注入）

```text
你运行在 OpenStaffs（本地 AI 办公室）里，是员工「{{agent_name}}」（{{agent_id}}）。
你的私人目录：{{private_dir}}，只有你自己使用；它由系统分配，不随项目变化。

**负责人最高**：办公空间的负责人（`{{boss_name}}`，你的负责人）拥有最高权威；需要拍板、资源或权限时先请示，不要绕过权限闸门。

消息规范：
- **大内容走文件，聊天只发摘要**：长报告、大段代码 / 日志 / 完整清单 / 表格等通过私人目录里的文件交接，聊天里只给「一句话结论 + 文件路径」；一条消息应当几行内一眼看完。
- **来回两三轮没有收敛就停**：改写文件 + 给负责人一次性小结，别在群里互 @。

你只能写自己的私人目录与权限允许的路径；超出范围用 `request_permission` 申请，不要用 bash 绕过。
```

### 4.2 `dm.md`（仅私聊）

```text
你正在和负责人「{{boss_name}}」进行 1 对 1 私聊；这段对话只有你们两人能看到。需要拍板、资源或汇报时直接说。
```

### 4.3 `group.md`（仅群聊，群规则内联）

```text
你正在项目群聊「{{project_name}}」（{{project_id}}）里和大家沟通。群里有 {{member_count}} 人：{{members}}；负责人「{{boss_name}}」也在群里。

群聊规则：
- **每条消息都以 @ 开头**：`@` 只在消息最开头生效（正文中 / 结尾出现的 @ 只是文字，不会触发任何人）；要让某位成员做事，把 `@成员 id` 写在最前面（可多个）；发给负责人（`@{{boss_name}}`，`@老板` / `@boss` 是它的别名）写最前面。你收到的每条群消息都是指名发给你的；没写 @、或开头 @ 了但没解析出有效对象时，系统视为发给负责人。
- **非必须不要主动 @ 别人**：@ 同伴 = 派活（真的唤醒对方跑一轮，有成本）；寒暄、感谢等都不需要 @。被 @ 后直接干活、不要回「收到」；完工回告以派活约定为准（要对方完成后回告，就在同一条消息里写明）。
- **派活一次说完**：背景、目标、产出要求写进同一条消息；不要「@同伴 在吗」「@同伴 再问下……」式挤牙膏——每一条都是一轮唤醒。
- 成员之间没有私聊；协作一律在群里 @。找负责人也可以用 `send_message`（target=boss）。
```

`groupRules` 函数与 `group_rules` 变量删除；群规则不再走变量门控，私聊根本不渲染 `group.md`。

### 4.4 `memory.md`（仅记忆开启时注入）

```text
## 使用记忆

你可以用记忆工具维护长期信息：`memory_profile` 写每次新会话都全文注入的身份 / 职责 / 硬规则，`memory_add` 存普通记忆，`memory_get` 按 id 取正文，`memory_list` 查看索引，`memory_update` / `memory_remove` 维护。只记长期有用的事实与结论，保持精简，别把流水账塞进去。
```

动态内容（profile 全文 + 记忆索引）仍由 `renderMemoryBlock` 生成，紧跟在说明之后；其自带「## 你的记忆」标题，不塞进模板变量。记忆关闭（`memoryEnabled=false`）时，说明模板与动态块整段不出现。

## 5. 装配

新模块 `src/capabilities/system-prompt.ts`：

- 模块顶层一次性读取四个模板（进程启动即固化内存）；读失败返回空串，不抛。
- `renderSystemPrompt(ctx: PromptVarContext): string`
  - `environment` +（`ctx.kind === "dm"` ? `dm` : `group`）；
  - 逐段渲染、trim、丢空段、`\n\n` 连接。
- `renderMemoryPrompt(ctx: PromptVarContext, enabled: boolean): string`
  - `enabled === false` → `""`；
  - 否则「`memory.md` 渲染结果 + `renderMemoryBlock(ctx.ws, ctx.selfId)`」，空块只留说明。

`instructionsFor` 新顺序：

```text
系统段（环境 + 私聊/群聊前缀）
→ 用户 prompt 链（空间 → 部门 → 项目 → 员工；空间默认空）
→ 记忆段（仅开启时）
→ 技能目录（恒含系统内置）
```

沿用现有的空段过滤与 `\n\n` 连接。

## 6. 生效时机与缓存

- 进程启动时模板进内存；每次新开会话用「内存模板 + 当前工作区数据」渲染。
- 升级框架后重启：新会话拿到新模板；已存在会话保持自己的 instructions 快照，不迁移、不热更新。
- 用户各层 `prompt` 的生效时机不变（新开会话生效）。
- 技能目录与 MCP 选择维持现状：新开会话时读取一次。

## 7. 工作区初始化

- `newSpaceConfig()` 返回 `{}`。
- `ensureSpaceConfig` 首次启动只写 `{}\n`，不再读取框架文件；幂等、不覆盖。
- 删除 `SPACE_PROMPT_TEMPLATE`、`builtinSpacePrompt`、`src/prompts/space.md`。
- `space.config.json` 的 `prompt` 字段仍可写，作为用户自定义空间层参与链；默认不存在。

## 8. 错误处理

- 模板缺失 / 读失败 → 该段为空，不拖垮建会话；由测试保证四个文件存在且非空。
- `renderTemplate` 未知变量 → 空串（沿用现状）。
- 记忆渲染的坏文件跳过、索引截断等行为不变。
- `private_dir` 变量取值失败 → 空串（沿用 `renderTemplate` 兜底）。

## 9. 测试

新增 `tests/capabilities/system-prompt.test.ts`：

- 私聊渲染含私聊前缀、不含「群聊规则」/「每条消息都以 @ 开头」/「派活一次说完」。
- 群聊渲染含项目名、项目 id、成员、负责人、@ 规则、派活规则。
- 环境段恒含 OpenStaffs、员工名 / id、私人目录路径、负责人权威、权限边界。
- 记忆段含 `memory_profile` / `memory_add` / `memory_get` / `memory_list`；`enabled=false` → 空串；无 profile / 索引时只留说明。
- 四个模板文件都存在且非空。

调整：

- `tests/app/conversations.test.ts`：断言装配顺序为「系统段 → 空间自定义段 → 部门 → 项目 → 员工 → 记忆 → 技能」；空间默认无 prompt；私聊不含群聊段。
- `tests/capabilities/prompt.test.ts`：删除依赖 `builtinSpacePrompt` 的门控用例，保留 `renderPromptChain` 的累加 / 渲染用例；群规则断言迁到 `system-prompt.test.ts`。
- `tests/domain/space.test.ts`：`newSpaceConfig()` 为空、首次启动写 `{}`。

验证命令：`npm test`、`npm run typecheck`。

## 10. 文档同步

- `src/skills/openstaffs-ops/SKILL.md`：重写「内置 prompt 只有一份 / 物化」段——系统 prompt 由框架自持（`src/prompts/{environment,dm,group,memory}.md`），启动固化、新会话生效；空间 `prompt` 是可选用户自定义层。
- `src/skills/openstaffs/SKILL.md`：更新「会话创建时系统提示词由各层 prompt 累加」的描述为「系统段 + 各层 prompt + 记忆 + 技能」；工作目录称呼按需改为「私人目录」。
- `README.md`：删除空间总纲物化说明与「旧空间升级提示」；空间 `prompt` 描述为可选自定义层。
- `docs/产品规划.md`：更新「系统」一行的归属表与累加描述。
- 本 spec。

## 11. 风险与取舍

- **缓存失效**：模板变更只在重启后的新会话生效。这是明确接受的取舍。
- **两份 prompt 语义并存**：系统段固定 + 空间自定义层。老板若把旧物化副本留在 `space.config.json`，会出现重复内容；不做检测与清理，由老板自行删除。
- **变量改名**：`workdir` → `private_dir` 会让旧用户自定义 prompt 里的 `{{workdir}}` 渲染为空串。按「不留包袱」原则接受，不保留别名。
