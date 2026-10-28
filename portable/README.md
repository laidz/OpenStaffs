# portable/ —— 从 OpenStaffs 里带走的资产

OpenStaffs 已归档（2026-10-28）。这个目录是**跨平台仍然可用**的部分：不是代码，是
**约定、协议和手册**——换到 Claude Code / Codex / 任何多 agent 平台都能直接用或稍作改写。

## 目录

| 路径 | 是什么 | 为什么值得带走 |
|---|---|---|
| `skills/openstaffs/SKILL.md` | 员工视角的**能力与协作手册**（写权限边界、私聊/群聊规则、工具、产出约定、记忆用法） | 这是"员工该怎么干活"的完整行为规范，本身就是一份高质量 system prompt 素材 |
| `skills/openstaffs-ops/SKILL.md` | **运维参考**（办公空间全景、配置字段、生效时机、权限、MCP、故障对照） | 439 行踩坑记录，几乎每条都是真实故障的结论 |
| `prompts/group.md` | 群聊协作的**硬规则**（@ 写在开头、拆条、谁拉起谁汇报、不 @ 老板） | 直接放进任何群聊场景的 system prompt |
| `prompts/environment.md` | 员工身份 + 私人目录 + 消息规范 | 多 agent 的最小身份模板 |
| `prompts/dm.md` / `memory.md` / `naming.md` | 私聊语境 / 记忆用法 / 会话自动命名 | 命名那段可直接复用到任何"给对话起标题"的功能 |
| `design/01-org-tree-and-permissions.md` | 文件夹=部门、按工具×路径授权、运行时授予、定义硬保护 | 多 agent 治理层最难的一部分，结论可直接照搬 |
| `design/02-meeting-protocol.md` | 群聊协议 + 防互 @ 死循环 + 最小可运行子集 | **最值钱的一份**，与平台无关 |
| `design/03-session-and-message-model.md` | 会议/会话/消息三层对象、单点解析、输入侧语义、模型退化护栏 | 会话与并发 bug 的防坑清单 |
| `design/04-config-cascade.md` | 四层同构配置、累加规则、三档生效时机、密钥分层 | "改了配置不生效"这类问题的根治方案 |

每份 `design/*.md` 开头都写了它提炼自哪份原始 spec（原文仍在 `docs/superpowers/`）。

## 怎么复用到别的平台

**Claude Code**
- `prompts/*.md` → 拼进 `CLAUDE.md` 或对应 subagent 的描述；
- 技能 → 放 `~/.claude/skills/<name>/SKILL.md`（格式本来就是 Agent Skills 标准，`name` + `description` 头可直接用）；
- 组织树 → 一个 repo 内 `agents/<部门>/<名字>.md`，每份就是一个 subagent 定义；
- **权限那张表没有直接对应物**：改成 sandbox / allowlist 配置，或干脆用 git worktree 隔离 + 只给它自己那个目录。

**Codex**
- 规则 → `AGENTS.md`（分层放 `AGENTS.md` 天然近似"累加"：根目录 + 子目录）；
- 团队 → `config.toml` 里的 subagent 定义；
- 会话/会议概念由平台托管，`design/03` 里能抄的是**输入侧语义**（排队、撤回、单点解析）。

**自建之前先读 `design/02` 和 `design/03`**——这两份是"看起来能用、实际立刻翻车"的地方。
