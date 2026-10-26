# 系统级 Prompt 框架自持 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把环境 / 私聊 / 群聊 / 记忆四类系统 prompt 收回框架持有，启动时读入内存，新开会话时渲染，不再物化进工作区配置。

**Architecture:** `src/prompts/` 下放四个 Markdown 模板；`src/capabilities/system-prompt.ts` 在模块加载时一次性读入并负责渲染；`instructionsFor` 按「系统段 → 用户 prompt 链 → 记忆 → 技能目录」装配。`space.config.json` 的 `prompt` 降级为可选用户自定义层，工作区初始化不再复制框架文案。

**Tech Stack:** Node ≥ 22.19（直接运行 TypeScript）、Vitest、现有 `renderTemplate` 变量机制。

**Spec:** `docs/superpowers/specs/2026-10-26-framework-owned-system-prompts-design.md`

## Global Constraints

- 不做老工作区兼容 / 迁移；旧 `space.config.json` 里的物化副本按普通用户内容处理，不识别、不清空。
- 系统模板只在进程启动时读取一次，运行期不读盘；新开会话生效，已存在会话不热更新。
- 文案一律简体中文；模板变量沿用现有 11 个（改名为 10 个，删 `group_rules`，`workdir` → `private_dir`）。
- `private_dir` 取 `PromptVarContext.cwd`；代码领域概念 `paths.workDir` 不改名。
- 记忆关闭（`speaker.memoryEnabled === false`）时，记忆说明与动态记忆块整段不出现。
- 每个任务结束前必须跑该任务的测试并保持全绿；提交信息用 `<type>(<scope>): <中文描述>`。

## Review Focus

- **模板文件被误删或清空**：渲染应降级为空段、不崩；由「四个模板都存在且非空」测试守住。
- **私聊误渲染群聊规则**：私聊 instructions 不得出现 @ 规则 / 派活礼仪；由 `system-prompt.test.ts` 的私聊用例守住。
- **记忆关闭仍注入工具说明**：关闭后 `## 使用记忆` 与 profile 都不得出现；由 `renderMemoryPrompt(ctx, false)` 与 conversations 既有开关用例守住。
- **旧变量名 `{{workdir}}` 残留**：新标准下应渲染为空串且注册表不再暴露；由 `prompt-vars.test.ts` 的注册表断言守住。
- **老工作区保留物化副本导致重复**：框架不清理，但用户空间 `prompt` 必须仍能作为自定义层正常参与链；由 conversations 的「空间自定义段」用例守住。

---

### Task 1: 系统模板与渲染模块（先不接线）

**Files:**
- Create: `src/prompts/environment.md`
- Create: `src/prompts/dm.md`
- Create: `src/prompts/group.md`
- Create: `src/prompts/memory.md`
- Create: `src/capabilities/system-prompt.ts`
- Create: `tests/capabilities/system-prompt.test.ts`
- Modify: `src/domain/prompt-vars.ts:36-38,94-106`
- Modify: `src/prompts/space.md:2`（临时改用新变量，Task 2 删除此文件）
- Test: `tests/domain/prompt-vars.test.ts:7,42-45,90-99`
- Test: `tests/capabilities/prompt.test.ts:31`

**Interfaces:**
- Consumes: `renderTemplate(text, ctx)`、`PromptVarContext`、`renderMemoryBlock(ws, agentId)`。
- Produces:
  - `SYSTEM_PROMPT_TEMPLATES: Readonly<Record<"environment" | "dm" | "group" | "memory", string>>`
  - `renderSystemPrompt(ctx: PromptVarContext): string`
  - `renderMemoryPrompt(ctx: PromptVarContext, enabled: boolean): string`
  - 变量 `private_dir`（函数 `privateDir(ctx)`）。

- [ ] **Step 1: 写失败测试 `tests/capabilities/system-prompt.test.ts`**

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  renderMemoryPrompt, renderSystemPrompt, SYSTEM_PROMPT_TEMPLATES,
} from "../../src/capabilities/system-prompt.ts";
import { writeProfile } from "../../src/domain/memory/store.ts";
import { createWorkspace } from "../../src/domain/paths.ts";
import type { PromptVarContext } from "../../src/domain/prompt-vars.ts";
import { seedOffice } from "../helpers/office.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-system-prompt-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function ctx(kind: "dm" | "group", projectId?: string): PromptVarContext {
  return {
    ws: createWorkspace(root),
    kind,
    selfId: "alice",
    ...(projectId === undefined ? {} : { projectId }),
    cwd: path.join(root, "work", "alice"),
  };
}

describe("系统级 prompt", () => {
  it("四个模板都存在且非空", () => {
    for (const name of ["environment", "dm", "group", "memory"] as const) {
      expect(SYSTEM_PROMPT_TEMPLATES[name].trim().length).toBeGreaterThan(0);
    }
  });

  it("环境段：身份 / 私人目录 / 负责人 / 权限边界", () => {
    seedOffice(root, { agents: [{ id: "alice", alias: "爱丽丝" }] });
    const text = renderSystemPrompt(ctx("dm"));
    expect(text).toContain("OpenStaffs");
    expect(text).toContain("爱丽丝");
    expect(text).toContain("alice");
    expect(text).toContain(path.join(root, "work", "alice"));
    expect(text).toContain("老板");
    expect(text).toContain("request_permission");
  });

  it("私聊：含私聊前缀，不含群聊规则", () => {
    seedOffice(root, { agents: [{ id: "alice" }] });
    const text = renderSystemPrompt(ctx("dm"));
    expect(text).toContain("1 对 1 私聊");
    expect(text).not.toContain("群聊规则");
    expect(text).not.toContain("每条消息都以 @ 开头");
    expect(text).not.toContain("派活一次说完");
  });

  it("群聊：项目 / 成员 / 负责人 / @ 规则 / 派活礼仪", () => {
    seedOffice(root, {
      agents: [{ id: "alice", alias: "爱丽丝" }, { id: "bob" }],
      projects: [{ id: "demo", alias: "演示项目", members: ["alice", "bob"] }],
    });
    const text = renderSystemPrompt(ctx("group", "demo"));
    expect(text).toContain("演示项目");
    expect(text).toContain("demo");
    expect(text).toContain("爱丽丝");
    expect(text).toContain("bob");
    expect(text).toContain("每条消息都以 @ 开头");
    expect(text).toContain("派活一次说完");
    expect(text).toContain("@老板");
  });

  it("记忆：含工具说明；关闭为空串；无 profile 时只留说明", () => {
    seedOffice(root, { agents: [{ id: "alice" }] });
    const withTools = renderMemoryPrompt(ctx("dm"), true);
    expect(withTools).toContain("## 使用记忆");
    expect(withTools).toContain("memory_profile");
    expect(withTools).toContain("memory_add");
    expect(withTools).toContain("memory_get");
    expect(withTools).toContain("memory_list");
    expect(withTools).not.toContain("## 你的记忆");

    expect(renderMemoryPrompt(ctx("dm"), false)).toBe("");

    writeProfile(createWorkspace(root), "alice", "我是 alice");
    const withProfile = renderMemoryPrompt(ctx("dm"), true);
    expect(withProfile).toContain("## 你的记忆");
    expect(withProfile).toContain("我是 alice");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/capabilities/system-prompt.test.ts`
Expected: FAIL，`Failed to resolve import ... src/capabilities/system-prompt.ts`。

- [ ] **Step 3: 创建四个模板**

`src/prompts/environment.md`：

```text
你运行在 OpenStaffs（本地 AI 办公室）里，是员工「{{agent_name}}」（{{agent_id}}）。
你的私人目录：{{private_dir}}，只有你自己使用；它由系统分配，不随项目变化。

**负责人最高**：办公空间的负责人（`{{boss_name}}`，你的负责人）拥有最高权威；需要拍板、资源或权限时先请示，不要绕过权限闸门。

消息规范：
- **大内容走文件，聊天只发摘要**：长报告、大段代码 / 日志 / 完整清单 / 表格等通过私人目录里的文件交接，聊天里只给「一句话结论 + 文件路径」；一条消息应当几行内一眼看完。
- **来回两三轮没有收敛就停**：改写文件 + 给负责人一次性小结，别在群里互 @。

你只能写自己的私人目录与权限允许的路径；超出范围用 `request_permission` 申请，不要用 bash 绕过。
```

`src/prompts/dm.md`：

```text
你正在和负责人「{{boss_name}}」进行 1 对 1 私聊；这段对话只有你们两人能看到。需要拍板、资源或汇报时直接说。
```

`src/prompts/group.md`：

```text
你正在项目群聊「{{project_name}}」（{{project_id}}）里和大家沟通。群里有 {{member_count}} 人：{{members}}；负责人「{{boss_name}}」也在群里。

群聊规则：
- **每条消息都以 @ 开头**：`@` 只在消息最开头生效（正文中 / 结尾出现的 @ 只是文字，不会触发任何人）；要让某位成员做事，把 `@成员 id` 写在最前面（可多个）；发给负责人（`@{{boss_name}}`，`@老板` / `@boss` 是它的别名）写最前面。你收到的每条群消息都是指名发给你的；没写 @、或开头 @ 了但没解析出有效对象时，系统视为发给负责人。
- **非必须不要主动 @ 别人**：@ 同伴 = 派活（真的唤醒对方跑一轮，有成本）；寒暄、感谢等都不需要 @。被 @ 后直接干活、不要回「收到」；完工回告以派活约定为准（要对方完成后回告，就在同一条消息里写明）。
- **派活一次说完**：背景、目标、产出要求写进同一条消息；不要「@同伴 在吗」「@同伴 再问下……」式挤牙膏——每一条都是一轮唤醒。
- 成员之间没有私聊；协作一律在群里 @。找负责人也可以用 `send_message`（target=boss）。
```

`src/prompts/memory.md`：

```markdown
## 使用记忆

你可以用记忆工具维护长期信息：`memory_profile` 写每次新会话都全文注入的身份 / 职责 / 硬规则，`memory_add` 存普通记忆，`memory_get` 按 id 取正文，`memory_list` 查看索引，`memory_update` / `memory_remove` 维护。只记长期有用的事实与结论，保持精简，别把流水账塞进去。
```

- [ ] **Step 4: 创建 `src/capabilities/system-prompt.ts`**

```ts
// src/capabilities/system-prompt.ts —— 系统级 prompt：框架自持，进程启动时读入内存。
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { renderMemoryBlock } from "../domain/memory/view.ts";
import { renderTemplate } from "../domain/prompt.ts";
import type { PromptVarContext } from "../domain/prompt-vars.ts";

export type SystemPromptName = "environment" | "dm" | "group" | "memory";

/** 读一个内置模板；缺失 / 读失败 → 空串（不拖垮建会话）。 */
function loadTemplate(name: SystemPromptName): string {
  try {
    return fs.readFileSync(fileURLToPath(new URL(`../prompts/${name}.md`, import.meta.url)), "utf8").trim();
  } catch {
    return "";
  }
}

/** 进程启动（模块加载）时一次性读入；运行期不再读盘。 */
export const SYSTEM_PROMPT_TEMPLATES: Readonly<Record<SystemPromptName, string>> = {
  environment: loadTemplate("environment"),
  dm: loadTemplate("dm"),
  group: loadTemplate("group"),
  memory: loadTemplate("memory"),
};

/** 渲染、trim、丢空段、`\n\n` 连接。 */
function join(parts: readonly string[]): string {
  return parts.map((part) => part.trim()).filter((part) => part !== "").join("\n\n");
}

/** 环境段 + 会话类型前缀（私聊 dm / 群聊 group）。 */
export function renderSystemPrompt(ctx: PromptVarContext): string {
  const session = ctx.kind === "dm" ? SYSTEM_PROMPT_TEMPLATES.dm : SYSTEM_PROMPT_TEMPLATES.group;
  return join([
    renderTemplate(SYSTEM_PROMPT_TEMPLATES.environment, ctx),
    renderTemplate(session, ctx),
  ]);
}

/** 记忆说明 + 动态记忆块；记忆关闭 → 空串。 */
export function renderMemoryPrompt(ctx: PromptVarContext, enabled: boolean): string {
  if (!enabled) return "";
  return join([
    renderTemplate(SYSTEM_PROMPT_TEMPLATES.memory, ctx),
    renderMemoryBlock(ctx.ws, ctx.selfId),
  ]);
}
```

- [ ] **Step 5: 跑系统 prompt 测试确认通过**

Run: `npx vitest run tests/capabilities/system-prompt.test.ts`
Expected: PASS（5 个用例）。

- [ ] **Step 6: 写变量改名的失败测试**

把 `tests/domain/prompt-vars.test.ts` 改为使用 `privateDir` / `private_dir`：

```ts
import {
  agentId, agentName, bossName, memberCount, members, privateDir, projectId, projectName, promptVariables, sessionInfo, sessionKind,
  type PromptVarContext,
} from "../../src/domain/prompt-vars.ts";
```

将原 `workdir` 用例替换为：

```ts
  it("private_dir 直出 cwd（= 自己的私人目录）", () => {
    seedOffice(root, { agents: [{ id: "alice" }] });
    expect(privateDir(dmCtx("alice"))).toBe(path.join(root, "work", "alice"));
  });
```

将注册表用例改为：

```ts
  it("promptVariables 注册表暴露全部变量函数（消费端按名字调用）", () => {
    seedOffice(root, { agents: [{ id: "alice", alias: "爱丽丝" }], projects: [{ id: "demo", members: ["alice"] }] });
    const group = groupCtx("demo", "alice");
    expect(Object.keys(promptVariables).sort()).toEqual([
      "agent_id", "agent_name", "boss_name", "group_rules", "member_count", "members", "private_dir", "project_id",
      "project_name", "session_info", "session_kind",
    ]);
    expect(promptVariables["agent_name"]?.(group)).toBe("爱丽丝");
    expect(promptVariables["private_dir"]?.(group)).toBe(path.join(root, "work", "alice"));
    expect(promptVariables["workdir"]).toBeUndefined();
  });
```

- [ ] **Step 7: 跑变量测试确认失败**

Run: `npx vitest run tests/domain/prompt-vars.test.ts`
Expected: FAIL，`privateDir` 未导出 / 注册表仍是 `workdir`。

- [ ] **Step 8: 实现变量改名**

在 `src/domain/prompt-vars.ts` 把：

```ts
export function workdir(ctx: PromptVarContext): string {
  return ctx.cwd;
}
```

改为：

```ts
/** 私人目录（= 会话 cwd）：系统分配的固定目录，不随项目增加。 */
export function privateDir(ctx: PromptVarContext): string {
  return ctx.cwd;
}
```

把注册表中的 `workdir,` 改为 `private_dir: privateDir,`（保留 `group_rules` 到 Task 2 再删）。

同时把 `src/prompts/space.md` 第 2 行改为：

```text
当前会话：{{session_info}}。私人目录：{{private_dir}}。
```

- [ ] **Step 9: 更新 `tests/capabilities/prompt.test.ts` 的旧变量**

把第 31 行：

```ts
  const text = renderPromptChain([loaded("agent", "alice", "你是 {{agent_id}}，在 {{workdir}} 干活。")], ctx);
```

改为：

```ts
  const text = renderPromptChain([loaded("agent", "alice", "你是 {{agent_id}}，在 {{private_dir}} 干活。")], ctx);
```

- [ ] **Step 10: 跑 Task 1 全部相关测试**

Run: `npx vitest run tests/capabilities/system-prompt.test.ts tests/domain/prompt-vars.test.ts tests/capabilities/prompt.test.ts tests/domain/prompt.test.ts`
Expected: PASS。

- [ ] **Step 11: Commit**

```bash
git add src/prompts/environment.md src/prompts/dm.md src/prompts/group.md src/prompts/memory.md \
  src/capabilities/system-prompt.ts src/domain/prompt-vars.ts src/prompts/space.md \
  tests/capabilities/system-prompt.test.ts tests/domain/prompt-vars.test.ts tests/capabilities/prompt.test.ts
git commit -m "feat(prompt): 新增框架自持的系统模板与 private_dir 变量"
```

---

### Task 2: 切换会话装配并移除物化

**Files:**
- Modify: `src/app/conversations.ts:11-16,56-68`
- Modify: `src/domain/space.ts`（整文件）
- Modify: `src/server/bootstrap.ts`（注释去「物化」口径）
- Modify: `src/domain/prompt-vars.ts:77-106`（删 `groupRules` 与注册项）
- Delete: `src/prompts/space.md`
- Test: `tests/domain/space.test.ts`
- Test: `tests/domain/prompt-vars.test.ts`（注册表去掉 `group_rules`）
- Test: `tests/capabilities/prompt.test.ts`（删内置 space.md 用例）
- Test: `tests/app/conversations.test.ts:3-18,54-67,400-430`

**Interfaces:**
- Consumes: Task 1 的 `renderSystemPrompt(ctx)` / `renderMemoryPrompt(ctx, enabled)` / `SYSTEM_PROMPT_TEMPLATES`。
- Produces: `instructionsFor(ws, relation, speaker): string` 固定顺序「系统段 → 用户 prompt 链 → 记忆 → 技能目录」；`newSpaceConfig(): Record<string, never>`。

- [ ] **Step 1: 写失败测试**

`tests/domain/space.test.ts` 整文件替换为：

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createWorkspace, type Workspace } from "../../src/domain/paths.ts";
import { ensureSpaceConfig, newSpaceConfig, spaceConfigFile } from "../../src/domain/space.ts";

let root: string;
let ws: Workspace;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "os-space-"));
  ws = createWorkspace(root);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test("newSpaceConfig 为空声明（系统 prompt 由框架自持，不再物化）", () => {
  expect(newSpaceConfig()).toEqual({});
});

test("spaceConfigFile：落点 openstaffs/space.config.json（可见、可版本化）", () => {
  expect(spaceConfigFile(ws)).toBe(path.join(root, "openstaffs", "space.config.json"));
});

test("ensureSpaceConfig：缺失则写空声明；已存在不覆盖（含空文件 / 坏 JSON）", () => {
  expect(ensureSpaceConfig(ws)).toBe("created");
  const file = spaceConfigFile(ws);
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({});

  fs.writeFileSync(file, JSON.stringify({ prompt: "老板改过的总纲" }));
  expect(ensureSpaceConfig(ws)).toBe("exists");
  expect(JSON.parse(fs.readFileSync(file, "utf8")).prompt).toBe("老板改过的总纲");

  fs.writeFileSync(file, "");
  expect(ensureSpaceConfig(ws)).toBe("exists");
  expect(fs.readFileSync(file, "utf8")).toBe("");
});
```

`tests/domain/prompt-vars.test.ts` 的注册表期望改为（去掉 `group_rules`）：

```ts
    expect(Object.keys(promptVariables).sort()).toEqual([
      "agent_id", "agent_name", "boss_name", "member_count", "members", "private_dir", "project_id", "project_name",
      "session_info", "session_kind",
    ]);
```

`tests/capabilities/prompt.test.ts`：删除第 6 行 `import { builtinSpacePrompt } ...` 与整个「内置 space.md 的群聊规则由 group_rules 门控」用例（原第 55-71 行）；群规则断言已由 `tests/capabilities/system-prompt.test.ts` 覆盖。

在 `tests/app/conversations.test.ts`：

1. 删除 `import { newSpaceConfig } from "../../src/domain/space.ts";`。
2. 在「新会话注入 profile + 索引」用例末尾追加顺序断言：

```ts
    const ordered = instructionsFor(ws, { kind: "dm", employeeId: "alice" }, loadEmployee(ws, "alice"));
    const indexes = ["OpenStaffs", "你是 alice。", "## 使用记忆", "我是 alice", "## 可用技能"]
      .map((needle) => ordered.indexOf(needle));
    expect(indexes.every((index) => index >= 0)).toBe(true);
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
```

3. 把「空间 prompt（内置物化）在最前…」用例替换为：

```ts
  it("系统段在最前；空间自定义段其次；私聊不带群聊段", () => {
    const ws = seedOffice(root, {
      space: { prompt: "空间自定义规矩。" },
      agents: [{ id: "alice", prompt: "你是 alice。" }, { id: "bob", prompt: "你是 bob。" }],
      projects: [{ id: "yt", alias: "演示项目", members: ["alice", "bob"] }],
    });
    const speaker = loadEmployee(ws, "alice");

    const group = instructionsFor(ws, { kind: "group", project: "yt" }, speaker);
    expect(group).toContain("OpenStaffs");
    expect(group).toContain("空间自定义规矩。");
    expect(group).toContain("演示项目");
    expect(group).toContain("bob");
    expect(group.indexOf("OpenStaffs")).toBeLessThan(group.indexOf("空间自定义规矩。"));
    expect(group.indexOf("空间自定义规矩。")).toBeLessThan(group.indexOf("你是 alice。"));

    const dm = instructionsFor(ws, { kind: "dm", employeeId: "alice" }, speaker);
    expect(dm).toContain("1 对 1 私聊");
    expect(dm).not.toContain("群聊规则");
    expect(dm).not.toContain("演示项目");
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/domain/space.test.ts tests/domain/prompt-vars.test.ts tests/capabilities/prompt.test.ts tests/app/conversations.test.ts`
Expected: FAIL（`newSpaceConfig` 仍返回 prompt；注册表仍有 `group_rules`；instructions 顺序尚无系统段）。

- [ ] **Step 3: 重写 `src/domain/space.ts`**

```ts
import fs from "node:fs";
import { spaceDir, type Workspace } from "./paths.ts";
// 空间声明文件的路径口径由 P3 的 src/config/naming.ts 唯一定义；
// 本模块只 re-export，绝不重复实现。
import { spaceConfigFile } from "../config/naming.ts";

export { spaceConfigFile };

/** 新建空间的初始声明：系统 prompt 由框架自持，空间 prompt 只是可选自定义层（默认空）。 */
export function newSpaceConfig(): Record<string, never> {
  return {};
}

/**
 * 首次启动探测：`space.config.json` 不存在 → 写入空声明。
 * 幂等——已存在一律不覆盖（含老板手改内容、空文件、坏 JSON）。
 */
export function ensureSpaceConfig(ws: Workspace): "created" | "exists" {
  const file = spaceConfigFile(ws);
  if (fs.existsSync(file)) return "exists";
  fs.mkdirSync(spaceDir(ws), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(newSpaceConfig(), null, 2)}\n`);
  return "created";
}
```

- [ ] **Step 4: 改 `src/app/conversations.ts` 的装配**

在 import 区加入：

```ts
import { renderMemoryPrompt, renderSystemPrompt } from "../capabilities/system-prompt.ts";
```

把 `instructionsFor` 替换为：

```ts
/** 会话快照（仅新开会话时渲染一次）：系统段 → prompt 链（空间 → 部门 → 项目 → 员工）→ 记忆 → 技能目录。 */
export function instructionsFor(ws: Workspace, relation: Relation, speaker: Employee): string {
  const scopes = scopesFor(ws, relation, speaker);
  const ctx = promptContextFor(ws, relation, speaker);
  const parts: string[] = [];
  parts.push(renderSystemPrompt(ctx));
  const chain = renderPromptChain(scopes, ctx);
  if (chain !== "") parts.push(chain);
  parts.push(renderMemoryPrompt(ctx, speaker.memoryEnabled));
  parts.push(renderSkillCatalog(ws, scopes, readSkillPaths(ws)));
  return parts.filter((part) => part.trim() !== "").join("\n\n");
}
```

- [ ] **Step 5: 删除 `groupRules` 与旧模板**

在 `src/domain/prompt-vars.ts`：

- 删除 `export function groupRules(...)` 整个函数（含其上注释）。
- 删除注册表中的 `group_rules: groupRules,`。
- 确认 `members` / `memberCount` 仍保留（群聊模板用）。

删除文件 `src/prompts/space.md`：

```bash
rm src/prompts/space.md
```

把 `src/server/bootstrap.ts` 的两处注释改为新口径：

```ts
  /** 本次是否新建了空间（以 space.config.json 首次写入为准）。 */
```

```ts
 * 启动探测（P4）：新建空间写入空 `space.config.json` + 首次启动自动建 Staff0（§8）。
```

- [ ] **Step 6: 跑 Task 2 测试**

Run: `npx vitest run tests/domain/space.test.ts tests/domain/prompt-vars.test.ts tests/capabilities/prompt.test.ts tests/app/conversations.test.ts tests/capabilities/system-prompt.test.ts`
Expected: PASS。

- [ ] **Step 7: 全量测试与类型检查**

Run: `npm test`
Expected: 全部 PASS。

Run: `npm run typecheck`
Expected: 无输出（exit 0）。

- [ ] **Step 8: Commit**

```bash
git add src/app/conversations.ts src/domain/space.ts src/domain/prompt-vars.ts src/server/bootstrap.ts \
  tests/domain/space.test.ts tests/domain/prompt-vars.test.ts \
  tests/capabilities/prompt.test.ts tests/app/conversations.test.ts
git add -u src/prompts/space.md
git commit -m "feat(prompt): 会话装配改用框架系统模板并移除空间物化"
```

---

### Task 3: 文档同步与最终验证

**Files:**
- Modify: `src/skills/openstaffs-ops/SKILL.md:237-256`
- Modify: `src/skills/openstaffs/SKILL.md`（「你是谁、在哪工作」里的系统提示词说明；按关键词定位）
- Modify: `README.md:64-66,76,101,148`
- Modify: `docs/产品规划.md:53,59`

**Interfaces:**
- Consumes: Task 1/2 的最终行为（系统段自持、`private_dir`、空间 prompt 可选）。
- Produces: 与实现一致的运维 / 能力 / 上手文档。

- [ ] **Step 1: 重写 `openstaffs-ops` 的装配段**

把 `## 会话装配：prompt 链 + 记忆 + 技能清单` 整段（从该标题到「整套系统提示词在**会话创建时固化**…」那一行）替换为：

```markdown
## 会话装配：系统段 + prompt 链 + 记忆 + 技能清单

- 会话创建时，框架把**四段**拼成系统提示词（instructions），此后随会话**固化**（快照）：
  1. **系统段**（框架自持）：`src/prompts/environment.md`（环境与通用规则）+ `src/prompts/dm.md` 或 `src/prompts/group.md`（会话前缀）。模板在 `npm start` 时读入内存；升级框架后**重启**，新开会话即用新版。
  2. **prompt 链**：各层 `*.config.json` 的 `prompt` 按**空间 → 部门链（根 → 叶）→ 项目（群聊）→ 员工**累加——空段丢弃、同值保留、`\n\n` 连接，**无覆盖 / 无优先级**。
  3. **记忆**：该人 `work/<id>/memory/` 的 profile 全文 + 未过期条目的索引（阶段说明见 `src/prompts/memory.md`；关闭或两者都为空时不注入动态块，关闭时说明也不注入）。
  4. **技能清单**：本次会话可用的技能（见「技能」章节；恒含系统内置）。
- **系统 prompt 由框架自持**：四个模板在 `src/prompts/`，改工作区不会改系统文案。`space.config.json` 的 `prompt` 只是**可选的自定义层**（默认空），与部门 / 项目 / 员工 `prompt` 一起累加。
- **变量**（在任意层的 `prompt` 里写 `{{变量}}`；支持 `{{members.0.name}}` 这类多级路径；未知变量渲染为空串；数组用「、」连接，对象取 `name` 缺省 `id`）：

| 变量 | 含义 |
| --- | --- |
| `agent_name` / `agent_id` | 你的展示名 / 你的 id |
| `boss_name` | 负责人称谓（`bossName`） |
| `private_dir` | 私人目录（= 会话 cwd，私聊 / 群聊都 = `work/<你>`） |
| `project_name` / `project_id` | 项目展示名 / 项目 id（私聊为空） |
| `members` / `member_count` | 群成员数组（`{id,name}`）/ 成员数（私聊为空 / 0） |
| `session_kind` | 会话类型：`dm`（私聊）/ `group`（群聊） |
| `session_info` | 当前会话的一句话描述（私聊 = 「与『负责人称谓』的私聊」；群聊 = 项目展示名 + id + 成员名单） |

- 整套系统提示词在**会话创建时固化**（随会话快照）：要换系统模板 / prompt 链 / 记忆 / 技能清单，都需**重启后新开会话**（用户 `prompt` 改完新开会话即可）。
```

- [ ] **Step 2: 更新 `openstaffs` 能力手册**

按关键词定位并替换：

1. 「会话创建时，你已通过系统提示词（各层 `prompt` 累加而成）得知自己的身份、当前会话、成员与工作目录——**优先相信提示词给出的事实**。」
   → 「会话创建时，你已通过系统提示词（系统段 + 各层 `prompt` 累加 + 记忆 + 技能）得知自己的身份、当前会话、成员与私人目录——**优先相信提示词给出的事实**。」
2. 「**私聊**：会话的工作目录是你的工作目录 `work/<你的名字>/`（私聊会话链 `conversation_ids.md` 落此处）。」
   → 「**私聊**：会话的工作目录是你的私人目录 `work/<你的名字>/`（私聊会话链 `conversation_ids.md` 落此处）。」
3. 群聊那行里的「群聊里每个人的会话工作目录同样是自己的 `work/<你的名字>/`」→「群聊里每个人的会话工作目录同样是自己的私人目录 `work/<你的名字>/`」。

- [ ] **Step 3: 更新 `README.md`**

1. 把 64-66 行的两段 blockquote（「新建空间时框架已自动物化…」与「旧空间升级提示…」）替换为：

```markdown
> 系统级提示词（身份、私聊 / 群聊规则、记忆说明）由框架自持，随框架升级；此处 `prompt` 只是**空间级自定义层**（可选，默认空），与部门 / 项目 / 员工 `prompt` 一起累加。
```

2. 把 `prompt` 的说明改为：

```markdown
- `prompt`：可选的空间级自定义层，与部门 / 项目 / 员工的 `prompt` 一起按空间 → 部门 → 项目 → 员工累加（系统级提示词另由框架注入）。
```

3. 第 101 行「她的**工作目录**是 `work/<她的 id>/`」改为「她的**私人目录**是 `work/<她的 id>/`」。

4. 第 148 行「空间规矩（`space.config.json` 的 `prompt`）」改为「空间自定义 prompt（`space.config.json` 的 `prompt`，可选）」。

- [ ] **Step 4: 更新 `docs/产品规划.md`**

1. 第 53 行系统行改为：

```markdown
| 系统 | 框架、OpenStaffs 本体 | 框架内置（`src/prompts/{environment,dm,group,memory}.md`，进程启动时读入内存；新开会话生效；`src/skills/`），非用户可编辑 |
```

2. 第 54 行空间行保留 `prompt`，但把描述改为「`prompt`（可选自定义层）」：

```markdown
| 空间 | 办公空间、空间、办公室、运行实例 | `openstaffs/space.config.json`：`prompt`（可选自定义层）/ `skills` / `mcp` / `permissions` |
```

3. 第 59 行改为：

```markdown
- 管理辅助：`prompt` / `skills` / `mcp` = **累加**（系统段 + 空间 → 部门链 → 项目 → 员工，无覆盖 / 无优先级）；`permissions`（落盘）= **累加**（仅项目 + 员工两层），运行时另**自动授予**私人目录（所有工具）与主管对管理子树的写权。
```

- [ ] **Step 5: 残留检查**

Run: `grep -rn "space.md\|builtinSpacePrompt\|group_rules\|{{workdir}}\|物化" src README.md docs/产品规划.md`
Expected: 无输出（`docs/superpowers/` 下的历史计划与 spec 不算）。

- [ ] **Step 6: 最终验证**

Run: `npm test`
Expected: 全部 PASS。

Run: `npm run typecheck`
Expected: 无输出（exit 0）。

- [ ] **Step 7: Commit**

```bash
git add src/skills/openstaffs-ops/SKILL.md src/skills/openstaffs/SKILL.md README.md docs/产品规划.md
git commit -m "docs(prompt): 同步系统 prompt 框架自持与新变量说明"
```
