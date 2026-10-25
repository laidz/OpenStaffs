# 原生记忆能力设计（profile + 索引 + 新鲜度 + 自动遗忘）

> 日期：2026-10-25
> 状态：设计已确认，待实现

## 1. 背景与目标

框架当前只有一种“文件记忆”：把员工工作目录里的一个 Markdown 文件全文塞进系统提示词。它有三个明显问题：全文注入没有边界、没有按需检索、不区分重要度与新鲜度。

本次把记忆做成框架的**原生能力**，不再依赖外部项目，也不引入插件基座：

1. **常驻 profile**：每个员工一份，全文注入，有字节上限。
2. **记忆索引**：普通记忆只注入“标题 + 简介”，正文按需取。
3. **新鲜度刷新**：取用即续期。
4. **自动遗忘**：长期不用的记忆移出索引（数据保留，可取回）。

配置里提供 `memory: true / false` 开关（空间级默认 + 员工级覆盖），暂不做 WebUI。

## 2. 非目标

- 不做 WebUI（查看 / 编辑记忆仍在文件与工具层）。
- 不做跨员工共享、跨员工检索：每个员工只看到自己的记忆。
- 不做向量检索、语义排序。
- 不做“自动总结对话写成记忆”：写什么仍由员工自己决定。
- 不依赖 toolbox 或任何外部 CLI / 服务。
- **不做旧格式兼容与迁移**：新实现只认新目录，历史不作为包袱。

## 3. 数据布局

记忆是**员工的运行时状态**，落在其工作目录，不进定义树 `agents/`：

```
work/<id>/memory/
  profile.md        常驻记忆；纯 Markdown；全文注入；≤ 8192 字节
  <id>.md           普通记忆实体：frontmatter + 正文
  archive/<id>.md   删除归档（人工找回用；框架不读；归档不占用 id，可重新建同名条目）
  .state.json       新鲜度侧车：{ "version": 1, "lastUsed": { "<id>": "<ISO 时间>" } }
  .gitignore        首次写入时创建，内容 ".state.json\n"
```

实体 frontmatter（只支持 `key: value` 子集）：

```
---
id: vip-policy                  # 与文件名主干一致
title: VIP 客户口径              # ≤ 40 字
description: 谈 VIP 时先看这条    # ≤ 80 字，写“是什么 + 什么时候该用”
pinned: false                   # 可选，缺省 false
created: 2026-10-25T10:00:00+08:00
updated: 2026-10-25T10:00:00+08:00
---

正文……
```

约束：

- 不做 `author` 字段：目录即作者。
- 不做 `kind`：profile 由固定文件名 `profile.md` 承担，不进索引、不可被普通记忆工具改。
- 不做 `tags`：搜索覆盖 id / 标题 / 简介即可。
- 文件名主干 = id；id 只允许字母、数字、`-`（中文按字母保留），由标题生成，冲突自动追加 `-2`、`-3`。

## 4. 配置开关

| 层级 | 文件 | 字段 | 语义 |
| --- | --- | --- | --- |
| 空间（默认） | `openstaffs/.data/config.json` | `"memory": true \| false` | 缺省 / 非布尔 → `true` |
| 员工（覆盖） | `<id>.agent.config.json` | `"memory": true \| false` | 缺省 = 跟随空间 |

解析规则：

- 员工级写在统一配置 `parseConfigFields`，非布尔值记一条 issue 并忽略。
- 空间级单独读原始 JSON，不依赖 `providers` / `model` 是否合法（未配置模型时也能判定开关）。
- 解析顺序：员工显式值 → 空间值 → `true`。
- 关闭时：**不注入**、记忆工具统一报“记忆未启用”；已有数据不删，重新打开即恢复。
- 注入随会话快照固化：改开关后需**新开会话**才改变注入（与 prompt / 技能一致）。
- 工具每次调用读当前配置：会话中途关掉开关，工具立即不可用（已注入的内容不再变化）。

## 5. 注入

系统提示词组装顺序不变，记忆插在 prompt 链与技能清单之间：

```
prompt 链（空间 → 部门 → 项目 → 员工） → 记忆 → 技能清单
```

记忆块格式：

```markdown
## 你的记忆

### 常驻 profile（全文）
<profile.md 正文>

### 记忆索引（需要正文时用 memory_get <id>）
- <id> · <标题> — <简介>（剩 87 天）
- [pinned] <id> · <标题> — <简介>
（还有 3 条未展示，用 memory_list 查看）
```

规则：

- 只列**未淘汰**条目；pinned 恒在，排在最前。
- 排序：pinned → 最近使用时间倒序 → 更新时间倒序 → id 升序。
- 上限：40 条、16 KiB（按渲染后的 UTF-8 字节估算；pinned 不计入上限、永不截断）。
- profile 为空 → 不输出 profile 小节；索引为空 → 不输出索引小节；两者都空 → **整块不输出**。
- 空记忆不提示“去设置 profile”，避免给只做一次任务的员工塞噪声；使用方法由技能文档说明。
- 会话创建时**同步读取**并固化进快照；之后改记忆不影响本会话。

## 6. 新鲜度与自动遗忘

- 计时起点：`lastUsed[id]` → 实体 `updated` → `created`。
- 续期（写 `lastUsed`）：`memory_get`、`memory_add`、`memory_update`。
- 不续期：`memory_list`、搜索、注入索引。
- 淘汰判定：非 pinned 且距计时起点 **> 90 天** → 移出注入索引与默认列表。
- 淘汰**不删文件**：数据仍在 `memory/`，`memory_list(include_stale: true)` 可见；`memory_get` 仍可取到，取到即续期并回到索引。
- pinned：永不淘汰、索引置顶；`memory_remove` 前必须先取消置顶（防误删）。
- 阈值 v1 为代码常量并写进运维文档：TTL 90 天、索引 40 条 / 16 KiB、profile 8 KiB、标题 40 字、简介 80 字。

## 7. 工具契约

6 个原生工具，统一在 `src/tools/memory.ts` 定义，由注册表汇总；只操作 `work/<自己>/memory/`，不新增权限表。开关关闭时统一返回“记忆未启用”。

| 工具 | 参数 | 行为与返回 |
| --- | --- | --- |
| `memory_list` | `query?`, `include_stale?` | 列索引（id、标题、简介、pinned、剩余天数）。`query` 大小写不敏感匹配 id / 标题 / 简介；默认只列未淘汰。空 → “（暂无记忆）”。不续期。 |
| `memory_get` | `id` | 返回正文（带标题与简介首行）；命中即续期，淘汰条目也取得到并复活。找不到 → 报错。 |
| `memory_add` | `title`, `description`, `body`, `pinned?` | 校验标题 / 简介长度与正文非空，按标题生成 id（与现存条目冲突时追加序号），写文件并续期。返回新 id。 |
| `memory_update` | `id`, `title?`, `description?`, `body?`, `append?`, `pinned?` | 至少一个变更项；`body` 与 `append` 互斥；不传的字段保持原值；更新 `updated` 并续期。无变更 → 报错。 |
| `memory_remove` | `id` | 归档到 `archive/`（同名已存在则加时间戳后缀）；pinned 先取消置顶。 |
| `memory_profile` | `action: "show" \| "set"`, `body?` | `show` 返回 profile 正文或“（还没有 profile）”；`set` 整体重写，正文非空且 ≤ 8192 字节，无追加语义。 |

工具描述里必须写清“什么时候用”，让模型无需读技能也能正确选择。

## 8. 模块与接缝

新增：

```
src/domain/memory/types.ts        MemMeta / MemEntity / MemEntry / 阈值常量
src/domain/memory/frontmatter.ts  解析 / 序列化 / 校验 / slug / 时间戳
src/domain/memory/store.ts        路径、扫描、查找、创建、更新、归档、状态侧车
src/domain/memory/view.ts         新鲜度判定、索引构建、注入文本渲染
src/tools/memory.ts               6 个 ToolDef
```

改动：

- `src/domain/paths.ts`：移除旧的记忆文件路径函数。
- `src/domain/employee.ts`：移除旧记忆字段与建文件逻辑；新增 `memoryEnabled`（员工 → 空间 → true）。
- `src/config/schema.ts`：`ConfigFields.memory?: boolean`，布尔校验。
- `src/domain/config.ts`：新增空间级开关读取（只读原始 JSON）。
- `src/app/conversations.ts`：去掉旧建文件与旧注入；`instructionsFor` 增加记忆块。
- `src/tools/registry.ts`：汇总 `memoryTools`。
- `src/prompts/space.md`：把“写记忆文件”改成“用记忆工具”。

## 9. 失败处理与边界

- 目录不存在 / 无权限：注入跳过（不报错），工具写入时报明确错误。
- 实体解析失败（frontmatter 坏 / id 不一致 / 超长）：跳过该文件，不影响其他条目与会话。
- `.state.json` 损坏：按空状态处理（全部按 `updated` 计时）。
- 写入用“临时文件 + rename”原子替换；文件操作全部同步，单进程内不会出现读到半截文件。
- id 校验：拒绝空、`.`、`..`、含 `/` `\` 或控制字符；`memory_get/update/remove` 的 id 必须与文件名主干一致。
- 索引超限只影响注入，不影响 `memory_list` 全量展示。

## 10. 文档同步（仓库约定，全覆盖）

- `src/skills/openstaffs/SKILL.md`：员工能力真相源——profile / 索引 / 新鲜度 / 遗忘规则与工具用法。
- `src/skills/openstaffs-ops/SKILL.md`：目录结构、开关层级、阈值常量、注入快照语义、排障（坏文件、淘汰、归档）。
- `README.md`：员工目录说明与配置示例（`memory` 开关），移除旧记忆描述。
- `docs/产品规划.md`：把记忆能力更新为已落地的 profile + 索引 + 遗忘；自动总结 / 自动进化仍留在后续阶段。

## 11. 测试

- 域单测：frontmatter 往返、标题生成 id 与冲突、长度校验、profile 字节上限、状态损坏降级、淘汰边界（正好 90 天不淘汰、91 天淘汰）、pinned 不淘汰、归档命名。
- 视图单测：排序（pinned / 最近使用）、条数与字节截断、空记忆不产出、注入文本格式。
- 工具单测：6 个工具的正常路径与错误路径、开关关闭、淘汰条目 get 复活、pinned 删除拦截。
- 会话单测：开关开 / 关、profile 与索引注入位置、快照固化（会话创建后改记忆不影响本会话）。
- 配置单测：员工覆盖全局、非布尔值忽略、空间配置缺省为 true。
- 清理旧的记忆文件路径 / 员工字段相关断言。

## 12. 风险

- **直改文件绕过新鲜度**：员工仍有自己工作目录的写权限，可直接改 `memory/*.md`。靠技能文档禁止，不做硬拦截（与既有 ACL 边界一致）。
- **索引上限导致“记忆变没”**：超出上限的条目只不进注入，`memory_list` 仍可查；文档写明。
- **pinned 无限增长**：pinned 不受条数 / 字节上限约束，可能挤占上下文；文档要求只 pin 真正长期重要的条目。
