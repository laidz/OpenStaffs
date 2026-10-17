# OpenStaffs — 仓库开发约定

OpenStaffs 是本机上的「AI 办公室」框架（Node ≥ 22.19，直接用 Node 运行 TypeScript，无需编译）。

- 框架代码：`src/`、`web/`、`tests/`；入口 `npm start -- <项目目录> [端口]`。
- 办公数据（`agents/`、`projects/`、`.openstaffs/`）在用户另行指定的**项目目录**里，与框架分离。
- 架构与决策：`docs/superpowers/specs/`；实现计划与执行日志：`docs/superpowers/plans/`；产品规划：`docs/产品规划.md`；手动验收：`docs/手动验收清单.md`。

## 约定：变更必须同步更新文档（全覆盖）

**任何变更都要同步更新下表对应的文档；拿不准时宁可都更新：**

| 变更类型 | 必须同步更新 |
| --- | --- |
| 员工可用能力（工具 / 协作机制 / 会话行为） | `src/skills/openstaffs/SKILL.md`（能力真相源） |
| 运维知识（配置文件 / 目录结构 / 权限规则 / 模板变量 / 排障） | `src/skills/openstaffs-ops/SKILL.md`（运维真相源） |
| 上手路径与项目介绍（安装 / 简单配置 / 介绍） | `README.md` |
| 产品愿景与路线图 | `docs/产品规划.md` |

**原因**：员工（运行时 agent）对 OpenStaffs 的认知必须始终**完备**——能力变了而手册没变，员工会"不知道自己能做什么"，表现为漏用工具、行为退化；运维知识变了而参考没变，员工会给出错误指引；上手文档过时，老板会卡在第一步。

相关位置：

- 技能目录注入（Agent Skills 标准）：`src/domain/skills.ts`；
- 系统提示词 / 环境段：`src/domain/prompt.ts`、`src/domain/prompt-vars.ts`、`src/prompts/`；
- 会话装配（技能来源顺序、环境段拼接）：`src/app/conversations.ts`。
