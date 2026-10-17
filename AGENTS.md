# OpenStaffs — 仓库开发约定

OpenStaffs 是本机上的「AI 办公室」框架（Node ≥ 22.19，直接用 Node 运行 TypeScript，无需编译）。

- 框架代码：`src/`、`web/`、`tests/`；入口 `npm start -- <项目目录> [端口]`。
- 办公数据（`agents/`、`projects/`、`.openstaffs/`）在用户另行指定的**项目目录**里，与框架分离。
- 架构与决策：`docs/superpowers/specs/`；实现计划与执行日志：`docs/superpowers/plans/`；产品愿景：`产品文档.md`。

## 约定：新增能力必须同步更新

**每新增一个能力（工具 / 机制 / 会话行为），必须同步更新以下两处：**

1. **员工侧能力手册** —— `src/skills/openstaffs/SKILL.md`
   （随每个会话注入的「基础技能」，是员工认知自身能力的**真相源**）；
2. **用户文档** —— `README.md`。

**原因**：员工（运行时 agent）对 OpenStaffs 能力的暴露必须始终**完备**——能力变了而手册没变，员工就会"不知道自己能做什么"，表现为漏用工具、行为退化。

相关位置：

- 技能目录注入（Agent Skills 标准）：`src/domain/skills.ts`；
- 系统提示词 / 环境段：`src/domain/prompt.ts`、`src/domain/prompt-vars.ts`、`src/prompts/`；
- 会话装配（技能来源顺序、环境段拼接）：`src/app/conversations.ts`。
