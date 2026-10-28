# 配置同构与生效时机（可迁移的设计结论）

> 提炼自 `docs/superpowers/plans/2026-10-19-unified-config.md`、
> `docs/superpowers/plans/2026-10-19-definition-model.md` 与 `src/skills/openstaffs-ops/SKILL.md`。

## 1. 四层同构：一套形状，一套解析器

空间 / 部门 / 项目 / 员工**四层用同一种配置文件形状**（`*.config.json`），只有一套解析器：

| 级别 | 落点 | 可写字段 |
|---|---|---|
| 空间 | `openstaffs/space.config.json` | `prompt` / `skills` / `mcp` / `permissions` / `namingModel` |
| 部门 | `agents/**/department.config.json` | `alias` / `head` / `prompt` / `skills` / `mcp` |
| 项目（群） | `projects/<id>.project.config.json` | `alias` / `members` / `owner` / `prompt` / `skills` / `mcp` / `permissions` |
| 员工 | `agents/**/<名字>.agent.config.json` | `alias` / `prompt` / `skills` / `mcp` / `permissions` / `model` / `thinkingLevel` |

## 2. 一律累加，没有覆盖、没有优先级

`prompt` / `skills` / `mcp` 沿 `系统 → 空间 → 部门链 → 项目 → 员工` **累加**；
`permissions` 只在**项目 + 员工**两层累加。

为什么坚持累加：**覆盖规则一旦存在，就永远在解释"为什么这个字段没生效"**。
累加不好用的时候，正确答案是拆分而不是加优先级。

## 3. 生效时机只有三档（写进文档，别再另立说法）

| 档 | 时机 | 典型内容 |
|---|---|---|
| 启动初始化 | **重启** | provider 密钥、MCP server 定义、空间初始化 |
| 会话装配 | **新开会话** | `prompt` / `skills` / `mcp` / `model` / `thinkingLevel` / 记忆快照 |
| 按需即时读取 | **每轮** | `permissions`（每轮写校验时现读） |

**会话装配做成快照是刻意的**：保护 provider 的 prompt cache，也保证一条会话可复现。
代价是"改了配置没效果"——所以每个字段必须能查到它属于哪一档。

## 4. 密钥与机器私有数据单独一层

- 可版本化、可随空间整包迁移的：`space.config.json`、`skills/`、`mcps.json`。
- **机器私有、永不进版本库**：`openstaffs/.data/`（API Key 明文配置 + 运行时 SQLite）。
- MCP 凭据只放全局一份 `config.json`，`mcps.json` 里写 `${config.mcp.<server>.<key>}` 引用——**定义文件里永不出现明文**。
- 密钥优先走 `env`，写进 `args` 会出现在 `ps` 里；spawn 失败只报错误码，不能回显命令原文。

## 5. 文档即契约（这条比配置本身更重要）

能力变了必须同步员工手册，运维知识变了必须同步运维参考，上手变了同步 README。
原因：**员工对自身能力的认知来自手册**——能力变了手册没变，员工会"不知道自己能做什么"，表现为漏用工具、行为退化。这不是文档强迫症，是运行时正确性问题。
