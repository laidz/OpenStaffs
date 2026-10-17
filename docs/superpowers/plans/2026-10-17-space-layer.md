# OpenStaffs 空间层：命名、技能来源与生效时机 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把四层结构（系统 / 空间 / 项目 / 员工）的名字、落点、技能来源与生效时机一次定稿并落地，并写清 MCP 骨架（不实现）。

**Architecture:** 命名与落点属文档级（手册 / README / 报错文案）；代码只做两件结构性的事——① **删掉**「环境段模板可被覆盖」这套机制（`promptTemplatePath` 只留系统内置）；② **补上空间级技能层**：新增 `openstaffs/skills/`（`paths.ts`）+ 外部 `config.skillPaths`（`config.readSkillPaths`），按「项目 → 员工 → 空间 → 外部 → 系统」接进 `skillDirsFor` / `instructionsFor`，由 `specFor` 在会话创建时读一次（快照）。MCP 只写约定文档。

**Tech Stack:** TypeScript（ESM，strip-only——不加参数属性、不用 enum）、Node ≥ 22.19、Vitest、`npm test` / `npm run typecheck` / `npm run build:web`。

**Spec:** `docs/superpowers/specs/2026-10-17-space-layer-design.md`

## Global Constraints

- **Node ≥ 22.19**，ESM（`"type": "module"`），`strict` + `noUncheckedIndexedAccess`；Node 直接跑 TS（strip-only）：**不用参数属性、不用 enum**。
- 基座 `@earendil-works/*` **锁定 1.3.0**，禁升级。
- **不改** `projects/` 目录名、`project_name` / `project_id` 变量、内部类型名（`Workspace` 等）。
- **不实现 MCP**（本轮只写文档）；**不设**技能条数上限。
- `readSkillPaths` 必须**独立读** `config.json`（不与 `WorkspaceConfig` 耦合，未配置模式下也要生效）：路径语法 = `~` 开头 → 家目录 / 绝对路径 → 原样 / 其余 → 相对办公空间根；去重、坏条目跳过、坏 JSON 返回 `[]`（不崩）。
- 新增 / 改动的对外行为一律**测试驱动**：先写失败测试 → 跑失败 → 实现 → 跑通过 → commit；提交信息用中文 `feat:` / `docs:` / `fix:` 前缀。
- 文档同步是**硬要求**（仓库 `AGENTS.md`）：能力变更 → `src/skills/openstaffs/SKILL.md`；运维知识变更 → `src/skills/openstaffs-ops/SKILL.md`；上手 → `README.md`；愿景 → `docs/产品规划.md`。本轮四份都要动。

## Review Focus

以下失败模式最易伤人，每条在其归属任务的测试里钉住：

1. **技能链被写反 / 断档**：空间级与外部目录必须在「员工之后、系统之前」，顺序错就不会报错、只会「技能静默不生效」。→ Task 4。
2. **`readSkillPaths` 把坏配置放大成崩溃**：坏 JSON、非数组、数组里混入 `null` / 数字 / 空串，都必须安全跳过并继续。→ Task 3。
3. **覆盖机制残留**：`.openstaffs/prompts/` 一旦还有引用（代码或测试），就会出现「文档说不能覆盖、实际能覆盖」。→ Task 2。
4. **快照语义被破坏**：技能清单必须在**会话创建**时固化（`specFor`），不能在每轮 send 时重读。→ Task 4。
5. **命名半改**：报错文案改了、手册没改（或反之），员工 / 老板会拿到两套话术。→ Task 5 / Task 6。

---

## File Structure

```
src/
  domain/
    paths.ts         # 改：SPACE_DIR_NAME / spaceDir / spaceSkillsDir
    config.ts        # 改：readSkillPaths（独立读 config.json）
    prompt.ts        # 改：promptTemplatePath(kind)，删覆盖机制
    skills.ts        # 改：注释「系统内置技能」
  app/
    conversations.ts # 改：skillDirsFor / instructionsFor 接外部目录；specFor 传 readSkillPaths
  server/
    startup.ts       # 改：3 处报错文案 + JSDoc →「办公空间」
  skills/
    openstaffs/SKILL.md      # 改：「系统内置」、技能来源
    openstaffs-ops/SKILL.md  # 改：全景 / 级别表 / 技能来源 / 生效 3 档 / MCP 骨架
tests/
  domain/prompt.test.ts      # 改：删覆盖用例、新签名
  domain/config.test.ts      # 改：readSkillPaths 用例
  app/conversations.test.ts  # 改：删覆盖用例、技能链用例
  server/startup.test.ts     # 改：报错文案断言
README.md / docs/产品规划.md / AGENTS.md / TODO.md
```

---

## Task 1: 命名统一——启动报错文案改「办公空间」

**Files:**
- Modify: `src/server/startup.ts`
- Test: `tests/server/startup.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: 报错文案（供 Task 6 的手册「故障对照」引用）：`必须指定办公空间目录。` / `办公空间目录不存在或不是目录：<path>` / `办公空间目录不能是框架目录本身：办公数据请使用独立目录（框架与办公数据分离）`

- [ ] **Step 1: 改测试断言（先失败）**

`tests/server/startup.test.ts` 里把三处断言改掉：

```ts
    expectError(missing, "必须指定办公空间目录");
```
（第 54、59 行两处同样改成 `必须指定办公空间目录`；第 65、68 行的 `"不能是框架目录"` 保持不变。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/server/startup.test.ts`
Expected: FAIL——报错文案仍是「必须指定项目目录」。

- [ ] **Step 3: 改实现**

`src/server/startup.ts`：

```ts
/**
 * 解析启动选项：
 * - 办公空间目录**必填**（CLI 第二参优先，其次 `OPENSTAFFS_ROOT`）——不默认 cwd、不允许等于框架目录（框架与办公数据分离）；
 * - 端口可选（CLI 第三参优先，其次 `OPENSTAFFS_PORT`）——未提供时返回 undefined，由调用方回落 config.json / 默认值。
 */
```
```ts
    return { ok: false, error: `必须指定办公空间目录。${USAGE}` };
```
```ts
    return { ok: false, error: `办公空间目录不存在或不是目录：${resolved}` };
```
```ts
    return { ok: false, error: "办公空间目录不能是框架目录本身：办公数据请使用独立目录（框架与办公数据分离）" };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/server/startup.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/server/startup.ts tests/server/startup.test.ts
git commit -m "feat: 启动报错文案改口径——指根一律「办公空间」"
```

---

## Task 2: 环境段模板去掉覆盖机制

**Files:**
- Modify: `src/domain/prompt.ts`
- Test: `tests/domain/prompt.test.ts`、`tests/app/conversations.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `promptTemplatePath(kind: PromptKind): string`（**新签名**：不再接 `ws`）；`renderEnvironment(ctx)` 行为不变（空模板 → 空串）

- [ ] **Step 1: 改测试（先失败）**

`tests/domain/prompt.test.ts`：
- 删掉 `it("办公目录覆盖优先，且不影响另一种会话", …)`（第 73–80 行）；
- 删掉 `it("办公覆盖模板生效", …)`（第 94–100 行）；
- 删掉 `it("覆盖文件为空 → 环境段为空串（不产出空段）", …)`（第 102–108 行）；
- `it("默认指向框架模板（src/prompts/<kind>.md）", …)` 改为新签名：

```ts
  it("模板固定指向系统内置（src/prompts/<kind>.md）；空间不可覆盖", () => {
    const dm = promptTemplatePath("dm");
    const group = promptTemplatePath("group");
    expect(dm.endsWith(path.join("src", "prompts", "dm.md"))).toBe(true);
    expect(group.endsWith(path.join("src", "prompts", "group.md"))).toBe(true);
    expect(fs.existsSync(dm)).toBe(true);
    expect(fs.existsSync(group)).toBe(true);
  });
```

`tests/app/conversations.test.ts`：删掉 `it("instructionsFor：办公目录覆盖的环境模板生效且置顶", …)`（第 253–263 行）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/domain/prompt.test.ts tests/app/conversations.test.ts`
Expected: FAIL / 编译失败——`promptTemplatePath` 仍要 `ws`，且覆盖用例被删后无对应实现。

- [ ] **Step 3: 改实现**

`src/domain/prompt.ts` 顶部：

```ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promptVariables, type PromptVarContext } from "./prompt-vars.ts";
```
（删掉 `import { stateDir, type Workspace } from "./paths.ts";`）

```ts
/** 系统内置模板目录（本文件在 src/domain → src/prompts）。 */
const FRAMEWORK_PROMPT_DIR = fileURLToPath(new URL("../prompts/", import.meta.url));

/** 模板路径：固定指向系统内置（环境段属系统级，不可被空间覆盖；要加规矩写空间 AGENTS.md）。 */
export function promptTemplatePath(kind: PromptKind): string {
  return path.join(FRAMEWORK_PROMPT_DIR, `${kind}.md`);
}
```
`renderEnvironment` 里改为 `promptTemplatePath(ctx.kind)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/domain/prompt.test.ts tests/app/conversations.test.ts && npm run typecheck`
Expected: PASS——无 `.openstaffs/prompts` 残留引用。

- [ ] **Step 5: Commit**

```bash
git add src/domain/prompt.ts tests/domain/prompt.test.ts tests/app/conversations.test.ts
git commit -m "feat: 环境段模板不再可覆盖——只留系统内置（要加规矩写空间 AGENTS.md）"
```

---

## Task 3: `readSkillPaths`——外部技能目录

**Files:**
- Modify: `src/domain/config.ts`
- Test: `tests/domain/config.test.ts`

**Interfaces:**
- Consumes: `configFile(ws)`、`requiredString`
- Produces: `export function readSkillPaths(ws: Workspace): string[]`——返回**已解析的绝对路径**数组（去重、顺序即书写顺序）

- [ ] **Step 1: 写失败测试**

`tests/domain/config.test.ts` 新增（`import` 补 `readSkillPaths`，顶部补 `import os from "node:os";`）：

```ts
describe("readSkillPaths（外部技能目录）", () => {
  it("三种写法：~ 开头按家目录、绝对路径原样、相对路径按办公空间根；顺序保留", () => {
    const ws = createWorkspace(root);
    fs.mkdirSync(path.join(root, ".openstaffs"), { recursive: true });
    fs.writeFileSync(configFile(ws), JSON.stringify({
      skillPaths: ["~/global-skills", "/abs/skills", "vendor/skills"],
    }));
    expect(readSkillPaths(ws)).toEqual([
      path.join(os.homedir(), "global-skills"),
      "/abs/skills",
      path.join(root, "vendor", "skills"),
    ]);
  });

  it("去重（同一目录两种写法算同一条，先出现者胜）", () => {
    const ws = createWorkspace(root);
    fs.mkdirSync(path.join(root, ".openstaffs"), { recursive: true });
    fs.writeFileSync(configFile(ws), JSON.stringify({
      skillPaths: ["/abs/skills", "/abs/skills/", "/abs/./skills"],
    }));
    expect(readSkillPaths(ws)).toEqual(["/abs/skills"]);
  });

  it("坏条目跳过：非数组 / 混入 null、数字、空串 / 数组本身不是数组", () => {
    const ws = createWorkspace(root);
    fs.mkdirSync(path.join(root, ".openstaffs"), { recursive: true });
    fs.writeFileSync(configFile(ws), JSON.stringify({ skillPaths: [null, 42, "  ", "/ok"] }));
    expect(readSkillPaths(ws)).toEqual(["/ok"]);
    fs.writeFileSync(configFile(ws), JSON.stringify({ skillPaths: "/not-an-array" }));
    expect(readSkillPaths(ws)).toEqual([]);
    fs.writeFileSync(configFile(ws), JSON.stringify({}));
    expect(readSkillPaths(ws)).toEqual([]);
  });

  it("文件缺失 / 坏 JSON → []（不崩）", () => {
    const ws = createWorkspace(root);
    expect(readSkillPaths(ws)).toEqual([]);
    fs.mkdirSync(path.join(root, ".openstaffs"), { recursive: true });
    fs.writeFileSync(configFile(ws), "{坏");
    expect(readSkillPaths(ws)).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/domain/config.test.ts`
Expected: FAIL——`readSkillPaths` 未导出。

- [ ] **Step 3: 实现**

`src/domain/config.ts`：补 `import os from "node:os";`，并在 `readBossName` 之后加：

```ts
/**
 * 外部技能目录（config.json 的 skillPaths）：老板的全局技能库，多个 agent 工具共用。
 * 写法：`~` 开头 → 家目录；绝对路径 → 原样；其余 → 相对办公空间根目录。
 * 去重（先出现者胜）；文件缺失 / 坏 JSON / 非数组 / 坏条目 → 跳过（不崩）。
 */
export function readSkillPaths(ws: Workspace): string[] {
  let raw = "";
  try {
    raw = fs.readFileSync(configFile(ws), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { skillPaths?: unknown };
    if (!Array.isArray(parsed.skillPaths)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const entry of parsed.skillPaths) {
      const text = requiredString(entry);
      if (text === undefined) continue;
      const abs = text === "~" || text.startsWith("~/")
        ? path.join(os.homedir(), text.slice(1))
        : path.resolve(ws.root, text);
      if (seen.has(abs)) continue;
      seen.add(abs);
      out.push(abs);
    }
    return out;
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/domain/config.test.ts && npm run typecheck`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/domain/config.ts tests/domain/config.test.ts
git commit -m "feat: config.json 新增 skillPaths——引用外部技能目录（~/ 绝对/相对空间根）"
```

---

## Task 4: 空间级技能 + 外部技能接进技能链

**Files:**
- Modify: `src/domain/paths.ts`、`src/domain/skills.ts`、`src/app/conversations.ts`
- Test: `tests/app/conversations.test.ts`

**Interfaces:**
- Consumes: `readSkillPaths(ws)`（Task 3）
- Produces:
  - `paths.ts`：`export const SPACE_DIR_NAME = "openstaffs"`、`spaceDir(ws): string`、`spaceSkillsDir(ws): string`
  - `conversations.ts`：`skillDirsFor(ws, relation, speaker, externalSkillDirs: readonly string[] = []): string[]`、`instructionsFor(ws, relation, speaker, externalSkillDirs: readonly string[] = []): string`

**技能链顺序（越窄越优先，同名先出现者胜）：**

```
群聊: 项目 → 员工 → 空间 → 外部… → 系统
私聊:        员工 → 空间 → 外部… → 系统
```

- [ ] **Step 1: 改测试（先失败）**

`tests/app/conversations.test.ts` 第 170 行的用例改为（含空间级与外部目录）：

```ts
  it("技能目录：项目 → 员工 → 空间 → 外部 skillPaths → 系统（越窄越优先）", () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const speaker = loadEmployee(ws, "alice");
    const external = ["/ext/one", "/ext/two"];
    expect(skillDirsFor(ws, { kind: "dm", employeeId: "alice" }, speaker, external)).toEqual([
      path.join(root, "agents", "alice", "skills"),
      path.join(root, "openstaffs", "skills"),
      ...external,
      FRAMEWORK_SKILLS_DIR,
    ]);
    expect(skillDirsFor(ws, { kind: "group", project: "yt" }, speaker, external)).toEqual([
      path.join(root, "projects", "yt", "skills"),
      path.join(root, "agents", "alice", "skills"),
      path.join(root, "openstaffs", "skills"),
      ...external,
      FRAMEWORK_SKILLS_DIR,
    ]);
    // 不传外部目录（默认参数）：只少那几项，链与顺序不变
    expect(skillDirsFor(ws, { kind: "dm", employeeId: "alice" }, speaker)).toEqual([
      path.join(root, "agents", "alice", "skills"),
      path.join(root, "openstaffs", "skills"),
      FRAMEWORK_SKILLS_DIR,
    ]);
  });
```

新增两个用例（空间级技能生效 + 同名去重优先级）：

```ts
  it("空间级技能随会话注入（私聊与群聊都注入），且同名时窄者胜", () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const spaceSkill = path.join(root, "openstaffs", "skills", "s", "SKILL.md");
    fs.mkdirSync(path.dirname(spaceSkill), { recursive: true });
    fs.writeFileSync(spaceSkill, "---\nname: 空间技能\ndescription: 来自空间\n---\n");
    const agentSkill = path.join(root, "agents", "alice", "skills", "a", "SKILL.md");
    fs.mkdirSync(path.dirname(agentSkill), { recursive: true });
    fs.writeFileSync(agentSkill, "---\nname: 空间技能\ndescription: 来自员工\n---\n");
    const speaker = loadEmployee(ws, "alice");

    const dm = instructionsFor(ws, { kind: "dm", employeeId: "alice" }, speaker);
    expect(dm).toContain("- 空间技能：来自员工"); // 员工（窄）胜空间（宽）
    expect(dm).not.toContain("来自空间");

    const group = instructionsFor(ws, { kind: "group", project: "yt" }, speaker);
    expect(group).toContain("- 空间技能：来自员工");
  });

  it("外部 skillPaths 的技能随会话注入（所有会话），来源在空间之后", () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const extDir = path.join(root, "ext-skills");
    const extSkill = path.join(extDir, "x", "SKILL.md");
    fs.mkdirSync(path.dirname(extSkill), { recursive: true });
    fs.writeFileSync(extSkill, "---\nname: 外部技能\ndescription: 来自外部库\n---\n");
    fs.mkdirSync(path.join(root, ".openstaffs"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".openstaffs", "config.json"),
      JSON.stringify({ skillPaths: ["ext-skills"] }), // 相对办公空间根
    );
    const speaker = loadEmployee(ws, "alice");

    const dm = instructionsFor(ws, { kind: "dm", employeeId: "alice" }, speaker, readSkillPaths(ws));
    expect(dm).toContain("- 外部技能：来自外部库");
  });
```

（该文件 `import` 补 `readSkillPaths`。会话创建路径的快照语义已有既有用例覆盖（「会话快照：会话中改档案文件不生效」），本任务不重复。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/app/conversations.test.ts`
Expected: FAIL——`skillDirsFor` 不认第 4 个参数、链里没有空间级目录。

- [ ] **Step 3: 实现**

`src/domain/paths.ts` 末尾加：

```ts
/** 空间级附属目录名：老板的能力与附属（skills/、mcp.json）；可见、可版本化、随空间整包迁移。 */
export const SPACE_DIR_NAME = "openstaffs";

export function spaceDir(ws: Workspace): string {
  return path.join(ws.root, SPACE_DIR_NAME);
}

export function spaceSkillsDir(ws: Workspace): string {
  return path.join(spaceDir(ws), "skills");
}
```

`src/domain/skills.ts` 第 5 行注释改为：

```ts
/** 系统内置技能目录（本文件在 src/domain → src/skills）。 */
```

`src/app/conversations.ts`：

```ts
import { spaceSkillsDir, ... } from "../domain/paths.ts";   // 补 spaceSkillsDir
import { readSkillPaths, resolveEmployeeModel } from "../domain/config.ts"; // 补 readSkillPaths
```

```ts
/**
 * 技能根目录（越窄越优先，同名先出现者胜）：
 * 群聊 = 项目 + 员工 + 空间 + 外部 skillPaths + 系统内置；私聊 = 员工 + 空间 + 外部 + 系统内置。
 */
export function skillDirsFor(
  ws: Workspace, relation: Relation, speaker: Employee, externalSkillDirs: readonly string[] = [],
): string[] {
  const dirs: string[] = [];
  if (relation.kind === "group") dirs.push(path.join(projectDir(ws, relation.project), "skills"));
  dirs.push(path.join(employeeDir(ws, speaker.id), "skills"));
  dirs.push(spaceSkillsDir(ws));
  dirs.push(...externalSkillDirs);
  dirs.push(FRAMEWORK_SKILLS_DIR);
  return dirs;
}
```

```ts
/** 会话快照（仅 startSession/新开会话时渲染一次）：系统环境段 → 空间总纲 → 项目规范（群聊）→ 员工 → 技能。 */
export function instructionsFor(
  ws: Workspace, relation: Relation, speaker: Employee, externalSkillDirs: readonly string[] = [],
): string {
  // …（前面不变）
  parts.push(renderSkills(listSkills(skillDirsFor(ws, relation, speaker, externalSkillDirs))));
  return parts.filter((part) => part.trim() !== "").join("\n\n");
}
```

```ts
/** 新会话默认模型 "provider/modelId"（员工未配模型时兜底）。 */
export type SessionDefaults = { model: string };

function specFor(ws: Workspace, relation: Relation, speaker: Employee, defaults?: SessionDefaults): ConversationSpec {
  // …（前面不变）
  return {
    cwd,
    // 技能清单随会话快照固化：这里读一次（新开会话才重读）
    instructions: instructionsFor(ws, relation, speaker, readSkillPaths(ws)),
    model: { provider: model.provider, modelId: model.modelId },
    // …
  };
}
```

同时把 `instructionsFor` 上方那句「框架环境段 → 根总纲」注释统一成「系统环境段 → 空间总纲」。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/app/conversations.test.ts && npm run typecheck`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/domain/paths.ts src/domain/skills.ts src/app/conversations.ts tests/app/conversations.test.ts
git commit -m "feat: 技能来源扩展——空间级 openstaffs/skills/ + 外部 skillPaths 接进技能链"
```

---

## Task 5: 文档同步——运维真相源 `openstaffs-ops/SKILL.md`

**Files:**
- Modify: `src/skills/openstaffs-ops/SKILL.md`

**Interfaces:**
- Consumes: Task 1 报错文案、Task 3/4 的 `skillPaths` 与空间级技能、Spec §3–§8
- Produces: 运维手册新表述（无代码接口）

- [ ] **Step 1: 改「办公室全景」目录树**

用下面这棵树替换（新增 `openstaffs/`，删掉 `.openstaffs/prompts/`，`openstaffs/` 行标注空间级）：

```
<办公空间>/                       # 老板启动时指定的运行目录（与框架代码分离）
├─ AGENTS.md                     # 空间总纲（可选；注入所有会话）
├─ agents/<员工 id>/             # 员工（目录名 = 员工 id，不可变）
├─ projects/<项目 id>/           # 项目 = 群聊（目录名 = 项目 id）
├─ openstaffs/                   # 老板的能力与附属（可见、可版本化、随空间整包迁移）
│  ├─ skills/<技能名>/SKILL.md   # 空间级技能：全部会话可见（同名时员工 / 项目技能更优先）
│  └─ mcp.json                   # 空间级 MCP server（未来能力，见「MCP 约定」）
└─ .openstaffs/                  # 机器私有（含密钥与运行状态；老板维护，你只读）
   ├─ config.json                # 全局配置：providers / model / port / bossName / skillPaths
   ├─ state.json                 # 老板的 pin 标记（机器维护，不要手改）
   ├─ permission-requests.json   # 待处理授权请求（机器维护，处理完即删）
   └─ state.sqlite               # 对话库（机器维护，不要手改）
```

- [ ] **Step 2: 补「级别定义」表（Spec §3 表 A）**

在「办公室全景」之后加一节：

```md
## 级别定义（系统 / 空间 / 项目 / 员工）

**级别是逻辑级别**——它回答「这是谁的内容、谁是权威方、改了影响谁」；文件夹只是它的落点。

| 级别 | 常用别名 | 是什么 | 逻辑上包含 | 权威方 | 改动代价 |
| --- | --- | --- | --- | --- | --- |
| 系统 | 框架、OpenStaffs 本体 | OpenStaffs 框架本身 | 内置模板、内置技能、内置工具 | 框架作者 | 改代码／升级框架 |
| 空间 | 办公空间、空间、办公室、运行实例 | 一个运行实例 + 指定的运行目录 | 该目录下全部 agents、projects 及其附属 | 老板 | 改文件即可 |
| 项目 | 群聊、群 | 空间内一个协作单位 | 项目成员 + 共享工作区 | 群成员 | 改文件即可 |
| 员工 | agent、职员、同事 | 空间内一个 Agent | 人格／记忆／技能／权限 | 本人（+老板） | 改文件即可 |

> 指根一律说「办公空间」；中间层一律说「项目（群聊）」；最上层的内置技能叫「系统内置技能」。别名只用于口语，文档正文一律用主名。
```

- [ ] **Step 3: 改「全局配置」小节**

- 示例 JSON 里加 `"skillPaths": ["~/global-skills"]`；
- 字段表加一行：

```md
| `skillPaths` | 可选：外部技能目录数组（老板的全局技能库）。写法：`~` 开头 = 家目录，绝对路径 = 原样，其余 = 相对办公空间根目录。算**空间级**技能，所有会话可用；改动**新开会话**生效。 |
```

- [ ] **Step 4: 改「环境段与模板」小节**

把「老板可用 `<办公目录>/.openstaffs/prompts/dm.md` / `group.md` 覆盖」整句删掉，改为：

```md
- 模板：**只有系统内置一份**——`src/prompts/dm.md`（私聊）/ `group.md`（群聊），空间不可覆盖。要加规矩写空间 `AGENTS.md`（追加注入、排在环境段之后）；要改环境段本身属**系统级**（改框架代码）。
```

- [ ] **Step 5: 改「技能」小节**

```md
## 技能（Agent Skills）

- 每个技能 = 一个含 `SKILL.md` 的目录；frontmatter 提供 `name`（缺省 = 目录名）与 `description`；正文由 agent 按需 `read`。
- 来源与优先级（同名时越窄越优先）：**项目技能 → 员工技能 → 空间技能（`openstaffs/skills/` → `config.skillPaths` 的外部技能库）→ 系统内置技能**。
- 技能清单在会话创建时固化：新增 / 修改技能 → 新开会话生效；`SKILL.md` 正文改完即时生效（`read` 时才读）。
- 你可以给自己建技能：写 `agents/<你>/skills/<技能名>/SKILL.md`（在自己的写权限内）。空间技能（`openstaffs/skills/`）属老板地盘，你写不进去。
```

- [ ] **Step 6: 把「改动生效方式」改写成 3 档机制（Spec §7）**

```md
## 改动生效方式（只由 3 档机制决定，与文件放哪儿无关）

| 机制 | 何时生效 | 属于这档的东西 |
| --- | --- | --- |
| 启动初始化 | **重启服务** | `config.json` 的供应商 / 密钥 / 端口；MCP server 注册 |
| 会话装配（进 instructions，快照） | **新开会话** | 环境段模板、空间 / 项目 / 员工 `AGENTS.md`、`profile.md`、`MEMORY.md`、技能清单、员工 `model` / `thinkingLevel` |
| 运行中按需读取 | **即时** | `SKILL.md` 正文（`read` 时读）、`permission.json`（每次写校验）、`members.md`（@ 路由与成员校验） |
| 直读展示 | **刷新页面** | `bossName`、员工 `alias` |

- **「快照」是刻意的**：保护供应商的 prompt cache，并让会话可复现——不是 bug。会话进行中改档案 / 技能清单，老会话不会变。
- **别被假象骗到**：`config.json` 改全局 `model` 后，新开会话就会显示新模型名，但供应商凭据还是启动时那份 → **一律以重启后为准**。
```

同时把「常见故障对照」里「启动报『必须指定项目目录』」一行改为：

```md
| 启动报「必须指定办公空间目录」 | 启动时漏了目录参数；目录也不能是框架目录本身 |
```

- [ ] **Step 7: 加「MCP 约定」小节（骨架，Spec §8）**

```md
## MCP 约定（骨架；实现见后续批次）

- 每层一个 `mcp.json`：系统 = `src/mcp.json`；空间 = `openstaffs/mcp.json`；项目 = `projects/{项目}/mcp.json`；员工 = `agents/{员工}/mcp.json`。
- 合并：同名 server **窄者胜**（项目 → 员工 → 空间 → 系统），不同名的都挂上。
- 凭据：**不写明文**。密钥统一放 `.openstaffs/config.json`（机器私有、不进版本库、权限 600），`mcp.json` 只引用凭据名（语法待定，如 `${config.mcp.<server>.<key>}`）。
- 权限：员工级 `mcp.json` 在你的写权限内，可以自己挂 server；但凭据在老板独占的 `config.json` → 挂需要密钥的 server 得请老板把凭据加进去。
- 生效：新增 / 改动 server 要**重启**才注册；某层是否生效随会话装配（新开会话）。
```

- [ ] **Step 8: 改 frontmatter description 与正文措辞**

`description` 里「办公室的文件结构」→「办公空间的文件结构」；全文搜一遍「办公室」→ 语境合适则改「办公空间」（「办公室」作为产品比喻仍可保留，但指目录时一律「办公空间」）。

- [ ] **Step 9: 自查 + Commit**

Run: `grep -n "框架内置\|办公目录\|办公数据根\|\.openstaffs/prompts" src/skills/openstaffs-ops/SKILL.md`
Expected: 无输出。

```bash
git add src/skills/openstaffs-ops/SKILL.md
git commit -m "docs: 运维参考同步空间层——级别定义、空间级技能、生效 3 档、MCP 骨架"
```

---

## Task 6: 文档同步——能力手册 / README / 产品规划 / 仓库 AGENTS.md

**Files:**
- Modify: `src/skills/openstaffs/SKILL.md`、`README.md`、`docs/产品规划.md`、`AGENTS.md`、`TODO.md`

**Interfaces:**
- Consumes: Spec §3–§7、Task 5 的表述
- Produces: 无代码接口

- [ ] **Step 1: `src/skills/openstaffs/SKILL.md`（能力真相源）**

第 75 行「**可用技能**：系统提示词里会列出你当前可用的技能」一段补一句来源：

```md
- **可用技能**：系统提示词里会列出你当前可用的技能（含各自的 `SKILL.md` 位置）；任务匹配某技能描述时，用 `read` 读取该文件全文再按其指引执行。技能来源（同名时越窄越优先）：项目 → 员工 → 空间（`openstaffs/skills/` 与老板配的外部技能库）→ **系统内置**。
```

- [ ] **Step 2: `README.md`**

- 第 15 行：`准备一个**项目目录**（办公数据根：…）` → `准备一个**办公空间目录**（运行数据与配置都存这里：`agents/` 员工、`projects/` 群聊、`openstaffs/` 你的技能与 MCP、`.openstaffs/` 配置，与框架代码相互独立）`；
- 第 19 / 20 / 28 / 36 行的「项目目录」→「办公空间目录」；第 28 行补一句四级命名；
- 「配置 → 1. 模型」小节加 `skillPaths`（与 `bossName` 并列，说明三种路径写法与生效档位）；
- 顶部特性列表下方加一小段**命名对齐**（不改顶部三行 slogan）：

```md
> **四层命名（口径统一）**：**系统**（框架本体）/ **空间**（一个办公空间 = 你启动时指定的运行目录）/ **项目**（群聊）/ **员工**。指目录一律说「办公空间」；`openstaffs/` 放你的能力与附属（技能、MCP），`.openstaffs/` 是机器私有（配置与运行状态）。
```

- [ ] **Step 3: `docs/产品规划.md`**

在「核心壁垒」或「未落地的愿景细节」附近加一小节：

```md
## 空间层命名与落点（已定稿）

| 级别 | 别名 | 落点（prompt / skills / MCP） |
| --- | --- | --- |
| 系统 | 框架、OpenStaffs 本体 | `src/prompts/` / `src/skills/` / `src/mcp.json`（未来） |
| 空间 | 办公空间、空间、办公室、运行实例 | 空间根 `AGENTS.md` / `openstaffs/skills/` / `openstaffs/mcp.json`（未来） |
| 项目 | 群聊、群 | `projects/{项目}/AGENTS.md` / `projects/{项目}/skills/` / `projects/{项目}/mcp.json`（未来） |
| 员工 | agent、职员、同事 | `agents/{员工}/AGENTS.md + profile.md + MEMORY.md` / `agents/{员工}/skills/` / `agents/{员工}/mcp.json`（未来） |

- 管理辅助：prompt = **叠加**（环境段 → 空间 → 项目 → 员工）；skills = **去重**（项目 → 员工 → 空间 → 系统）；MCP = **注册**（同名窄者胜）。
- 空间级附属统一收在可见的 `openstaffs/`（可版本化、随空间整包迁移）；`.openstaffs/` 只放机器私有（含密钥配置与运行状态）。
- 外部技能库通过 `config.json` 的 `skillPaths` 引用，算空间级。
```

并把「核心壁垒 → 文件夹即员工」里对技能的说法与表保持一致（若有冲突）。

- [ ] **Step 4: 仓库根 `AGENTS.md`**

第 5–6 行：

```md
- 框架代码：`src/`、`web/`、`tests/`；入口 `npm start -- <办公空间目录> [端口]`。
- 办公数据（`agents/`、`projects/`、`openstaffs/`、`.openstaffs/`）在用户另行指定的**办公空间目录**里，与框架分离。
```

- [ ] **Step 5: `TODO.md` 勾选**

把批次 3 的 5 条 `- [ ]` 改成 `- [x]`，并在每条下加**与其它条一致的「落地（2026-10-17）」**注记（照批次 1 / 2 的写法：一句话说清改了什么、落点在哪）；批次末尾「备注」一节的「状态」改成「批次 1–3 已落地」。

- [ ] **Step 6: 自查 + Commit**

Run: `grep -rn "框架内置\|办公数据根" README.md AGENTS.md docs/产品规划.md src/skills/`
Expected: 无输出（`openstaffs-ops` 已在上个任务清完）。

```bash
git add README.md AGENTS.md docs/产品规划.md src/skills/openstaffs/SKILL.md TODO.md
git commit -m "docs: 命名与落点同步——README/产品规划/能力手册/仓库约定 + 批次 3 勾选"
```

---

## Task 7: 全量验证

- [ ] **Step 1: 跑全量测试与类型检查**

Run: `npm test && npm run typecheck && npm run build:web`
Expected: 全绿；`build:web` 产物更新不应带来源码改动（`public/` 已被 gitignore）。

- [ ] **Step 2: 人工核对 Spec §10 验收标准**

逐条对照 `docs/superpowers/specs/2026-10-17-space-layer-design.md` §10（7 条）。

- [ ] **Step 3: 端到端冒烟（可选，本地）**

在一个临时空间目录里：

```bash
mkdir -p /tmp/osp-smoke/openstaffs/skills/hello /tmp/osp-smoke/.openstaffs
printf -- "---\nname: hello\ndescription: 空间级冒烟技能\n---\n" > /tmp/osp-smoke/openstaffs/skills/hello/SKILL.md
# 建一个员工后启动，检查其会话 instructions 里出现「hello」（可用既有测试工具或日志确认）
```

- [ ] **Step 4: 合并回主分支（按仓库约定）**

```bash
git checkout master
git merge --squash feat/batch3-space-layer
git commit -m "feat: 空间层——层级命名统一、空间级技能与外部 skillPaths、生效时机 3 档、MCP 骨架"
# 远程只保留 master；开发分支不推送
```

---

## Self-Review

- **Spec 覆盖**：§3 命名 → Task 1/5/6；§4 三类机制 → Task 5/6；§5 环境段 → Task 2；§6 技能 → Task 3/4；§7 生效 → Task 5；§8 MCP → Task 5/6；§9 文件清单 → Task 1–6 逐一对上；§10 验收 → Task 7。
- **占位符**：无 TBD / TODO（`mcp.json` 的凭据语法与键名明确标注为**批次 4 待定**，属实质内容而非占位）。
- **命名一致**：`readSkillPaths` / `spaceSkillsDir` / `skillDirsFor(…, externalSkillDirs)` / `promptTemplatePath(kind)` 在任务间签名一致。
- **风险**：Task 2 与 Task 4 动了签名 → 已列出全部调用点与测试改动；`web/render.ts` 按 D13 不动。
