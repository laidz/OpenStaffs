# OpenStaffs 核心引擎 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 OpenStaffs 的核心引擎——把"文件夹即员工 + 会话即消息"落到 Pi Durable 上，并让"只写自己 + 所在项目"的访问控制生效。

**Architecture:** 三层：**域层**（纯 TypeScript，不认识 Pi：工作区路径、员工加载、访问控制、提及解析、会话链）→ **适配层**（`HarnessPort` 接口 + Pi Durable 实现，把域操作翻译成基座调用）→ **应用层**（私聊/群聊/@路由/老板待办）。状态真相源是文件夹；消息真相源是 Pi 的 conversation transcript。

**Tech Stack:** TypeScript (ESM)、Node ≥ 22.19、Vitest、`@earendil-works/pi-durable@1.3.0` + `@earendil-works/pi-ai@1.3.0` + `@earendil-works/chord@1.3.0`、SQLite 存储。

**Spec:** `docs/superpowers/specs/2026-10-16-openstaffs-architecture-design.md`

## Global Constraints

- **Node ≥ 22.19**（`package.json` 的 `engines`），ESM（`"type": "module"`）。
- 基座版本**锁定 `1.3.0`**（experimental，禁跨版本升级）。
- **状态真相源在文件夹**；**消息真相源在 Pi transcript**；两者互不落地到对方。
- 访问控制铁律：员工只写 ① `agents/<自己>/` ② 自己"在成员名单里"的 `projects/<任务>/`；其余只读。
- **`cwd` 由会话来源决定**：私聊 = `agents/<自己>/`；群聊 = `projects/<任务>/`。
- **不引入温度**（Pi Durable 的 per-conversation agent 不含温度）。
- 员工模型配置来自员工 `config.json`：`provider` / `modelId` / `thinkingLevel`（`off` 即关闭思考）。
- MVP 的 **`bash` 默认禁用**（访问控制轻档，见 spec §6）。
- 员工目录**扁平**，不自嵌套层级。

## Review Focus

以下输入/失败模式 spec 隐含但任何单测都不天然覆盖，最易伤人，按危害从高到低列出；每条在其**归属任务的测试**里钉住：

1. **越界路径写法**：`../`、绝对路径、`agents/alice/../bob`、空串 → `isWriteAllowed` 必须一律拒绝（否则铁律形同虚设）。
2. **缺失文件**：员工目录缺 `AGENTS.md`/`profile.md`/`MEMORY.md`/`config.json`，或 `members.md` 缺失/为空 → 不崩溃，且**权限从严**（无成员 = 不可写任何项目）。
3. **会话链损坏**：`conversation_ids.md` 不存在、表头缺失、`ended` 空行缺失、多行"进行中" → 不崩溃；活跃会话取**最后一行**。
4. **提及歧义**：`@不存在的人`、`@老板`、大小写/空格混杂 → 不误路由（未知 `@名` 原样保留在正文，且视为"未点名"=广播）。
5. **重复/并发提交**：对同一条 conversation 连续两次 `send` → 不丢消息、不重复触发（第二次排队）。

---
```

## File Structure

```
src/
  domain/
    types.ts              # 共享类型（Employee, Session 等）
    paths.ts              # 公司根与各目录/文件路径
    employee.ts           # 员工加载（AGENTS.md 入口 + profile/MEMORY + config.json）
    access-control.ts     # members.md 解析 + isWriteAllowed + 员工所在项目
    mention.ts            # @提及解析（定向/广播）
    conversation-chain.ts # conversation_ids.md 读写 + 活跃会话 + 新开会话
  harness/
    port.ts               # HarnessPort 接口（域 ↔ 基座 的契约）
    access-extension.ts   # Pi 的 beforeTool 钩子：落访问控制
    pi-durable.ts         # HarnessPort 的 Pi Durable 实现
  app/
    conversations.ts      # 私聊/群聊用例（含"新开会话"）
    routing.ts            # @触发 / 广播
    unread.ts             # 老板待办（小红点）
tests/
  ...                     # 与 src 同构
```

每个文件一个明确职责：`domain/*` 不 import 任何 `@earendil-works/*`（可用测试直接断言）；只有 `harness/*` 认识基座。

---

### Task 1: 项目脚手架与测试基线

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Test: `tests/smoke.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: 可运行的 `npm test`（Vitest）；`src/`、`tests/` 可写 TS。

- [ ] **Step 1: 写脚手架文件**

`package.json`:

```json
{
  "name": "openstaffs",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.19" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@earendil-works/chord": "1.3.0",
    "@earendil-works/pi-ai": "1.3.0",
    "@earendil-works/pi-durable": "1.3.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "typescript": "^5.7.0",
    "vitest": "^2.1.8"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "allowImportingTsExtensions": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src", "tests"]
}
```

`.gitignore`:

```
node_modules/
.openstaffs/
*.sqlite
```

- [ ] **Step 2: 写冒烟测试**

`tests/smoke.test.ts`:

```ts
import { describe, expect, it } from "vitest";

describe("脚手架", () => {
  it("能跑测试", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 3: 安装依赖并跑测试**

Run: `npm install --ignore-scripts && npm test`
Expected: PASS（1 passed）。

- [ ] **Step 4: 类型检查**

Run: `npm run typecheck`
Expected: 无错误退出。

- [ ] **Step 5: 提交**

```bash
git add package.json tsconfig.json .gitignore tests/smoke.test.ts
git commit -m "chore: 项目脚手架与测试基线"
```

---

### Task 2: 工作区路径

**Files:**
- Create: `src/domain/paths.ts`
- Test: `tests/domain/paths.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type Workspace = { readonly root: string }`
  - `createWorkspace(root: string): Workspace`
  - `stateDir(ws: Workspace): string`
  - `agentsDir(ws: Workspace): string`
  - `projectsDir(ws: Workspace): string`
  - `employeeDir(ws: Workspace, id: string): string`
  - `projectDir(ws: Workspace, name: string): string`
  - `membersFile(ws: Workspace, name: string): string`
  - `conversationIdsFile(ws: Workspace, dir: string): string`

- [ ] **Step 1: 写失败测试**

`tests/domain/paths.test.ts`:

```ts
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentsDir, conversationIdsFile, createWorkspace, employeeDir, membersFile, projectDir,
} from "../../src/domain/paths.ts";

describe("workspace paths", () => {
  const ws = createWorkspace("/tmp/company");

  it("把根解析为绝对路径", () => {
    expect(createWorkspace("relative").root).toBe(path.resolve("relative"));
  });

  it("给出各标准目录", () => {
    expect(agentsDir(ws)).toBe(path.join("/tmp/company", "agents"));
    expect(employeeDir(ws, "alice")).toBe(path.join("/tmp/company", "agents", "alice"));
    expect(projectDir(ws, "yt")).toBe(path.join("/tmp/company", "projects", "yt"));
    expect(membersFile(ws, "yt")).toBe(path.join("/tmp/company", "projects", "yt", "members.md"));
  });

  it("会话链文件落在给定目录下", () => {
    expect(conversationIdsFile(ws, projectDir(ws, "yt"))).toBe(
      path.join("/tmp/company", "projects", "yt", "conversation_ids.md"),
    );
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/domain/paths.test.ts`
Expected: FAIL（找不到模块 `src/domain/paths.ts`）。

- [ ] **Step 3: 实现**

`src/domain/paths.ts`:

```ts
import path from "node:path";

export type Workspace = { readonly root: string };

export function createWorkspace(root: string): Workspace {
  return { root: path.resolve(root) };
}

export function stateDir(ws: Workspace): string {
  return path.join(ws.root, ".openstaffs");
}

export function agentsDir(ws: Workspace): string {
  return path.join(ws.root, "agents");
}

export function projectsDir(ws: Workspace): string {
  return path.join(ws.root, "projects");
}

export function employeeDir(ws: Workspace, id: string): string {
  return path.join(agentsDir(ws), id);
}

export function projectDir(ws: Workspace, name: string): string {
  return path.join(projectsDir(ws), name);
}

export function membersFile(ws: Workspace, name: string): string {
  return path.join(projectDir(ws, name), "members.md");
}

export function conversationIdsFile(_ws: Workspace, dir: string): string {
  return path.join(dir, "conversation_ids.md");
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/domain/paths.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/domain/paths.ts tests/domain/paths.test.ts
git commit -m "feat(domain): 工作区路径"
```

---

### Task 3: 员工加载器

**Files:**
- Create: `src/domain/types.ts`
- Create: `src/domain/employee.ts`
- Test: `tests/domain/employee.test.ts`

**Interfaces:**
- Consumes: `paths.ts` 的 `Workspace`、`employeeDir`
- Produces:
  - `type ModelChoice = { provider: string; modelId: string; thinkingLevel?: string }`
  - `type Employee = { id: string; dir: string; entry: string; profile: string; memory: string; model: ModelChoice }`
  - `loadEmployee(ws: Workspace, id: string): Employee`
  - `renderInstructions(employee: Employee): string`

- [ ] **Step 1: 写失败测试**

`tests/domain/employee.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { loadEmployee, renderInstructions } from "../../src/domain/employee.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-"));
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(id: string, file: string, content: string) {
  const dir = path.join(tmp, "agents", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
}

describe("loadEmployee", () => {
  it("以 AGENTS.md 为入口，引入档案与记忆", () => {
    const ws = createWorkspace(tmp);
    write("alice", "AGENTS.md", "你是 alice。");
    write("alice", "profile.md", "岗位：运营");
    write("alice", "MEMORY.md", "记得老板喜欢简短。");
    write("alice", "config.json", JSON.stringify({ provider: "opencode-go", modelId: "deepseek-v4.1-flash", thinkingLevel: "low" }));

    const e = loadEmployee(ws, "alice");
    expect(e.id).toBe("alice");
    expect(e.entry).toBe("你是 alice。");
    expect(e.model).toEqual({ provider: "opencode-go", modelId: "deepseek-v4.1-flash", thinkingLevel: "low" });
    expect(renderInstructions(e)).toContain("你是 alice。");
    expect(renderInstructions(e)).toContain("岗位：运营");
    expect(renderInstructions(e)).toContain("记得老板喜欢简短。");
  });

  it("缺文件时不崩溃，且 model 为空", () => {
    const ws = createWorkspace(tmp);
    write("bob", "AGENTS.md", "你是 bob。");
    const e = loadEmployee(ws, "bob");
    expect(e.profile).toBe("");
    expect(e.memory).toBe("");
    expect(e.model).toEqual({ provider: "", modelId: "" });
    expect(renderInstructions(e)).toBe("你是 bob。");
  });

  it("员工不存在时报错", () => {
    const ws = createWorkspace(tmp);
    expect(() => loadEmployee(ws, "nobody")).toThrow("员工不存在");
  });

  it("config.json 损坏时不崩溃", () => {
    const ws = createWorkspace(tmp);
    write("carol", "AGENTS.md", "你是 carol。");
    write("carol", "config.json", "{ not json");
    expect(loadEmployee(ws, "carol").model).toEqual({ provider: "", modelId: "" });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/domain/employee.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`src/domain/types.ts`:

```ts
export type EmployeeId = string;
export type ProjectName = string;

export type ModelChoice = {
  provider: string;
  modelId: string;
  thinkingLevel?: string;
};
```

`src/domain/employee.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import { employeeDir, type Workspace } from "./paths.ts";
import type { EmployeeId, ModelChoice } from "./types.ts";

export type Employee = {
  id: EmployeeId;
  dir: string;
  entry: string;
  profile: string;
  memory: string;
  model: ModelChoice;
};

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function readModel(dir: string): ModelChoice {
  const raw = readText(path.join(dir, "config.json"));
  if (raw.trim() === "") return { provider: "", modelId: "" };
  try {
    const parsed = JSON.parse(raw) as Partial<ModelChoice>;
    return {
      provider: parsed.provider ?? "",
      modelId: parsed.modelId ?? "",
      ...(parsed.thinkingLevel === undefined ? {} : { thinkingLevel: parsed.thinkingLevel }),
    };
  } catch {
    return { provider: "", modelId: "" };
  }
}

export function loadEmployee(ws: Workspace, id: EmployeeId): Employee {
  const dir = employeeDir(ws, id);
  if (!fs.existsSync(dir)) throw new Error(`员工不存在: ${id}`);
  return {
    id,
    dir,
    entry: readText(path.join(dir, "AGENTS.md")),
    profile: readText(path.join(dir, "profile.md")),
    memory: readText(path.join(dir, "MEMORY.md")),
    model: readModel(dir),
  };
}

export function renderInstructions(employee: Employee): string {
  return [employee.entry, employee.profile, employee.memory]
    .filter((part) => part.trim() !== "")
    .join("\n\n");
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/domain/employee.test.ts`
Expected: PASS（4 passed）。

- [ ] **Step 5: 提交**

```bash
git add src/domain/types.ts src/domain/employee.ts tests/domain/employee.test.ts
git commit -m "feat(domain): 员工加载器（AGENTS.md 入口 + 档案/记忆 + config.json）"
```

---

### Task 4: 访问控制

**Files:**
- Create: `src/domain/access-control.ts`
- Test: `tests/domain/access-control.test.ts`

**Interfaces:**
- Consumes: `paths.ts`（`Workspace`、`projectDir`、`membersFile`）、`types.ts`
- Produces:
  - `type AccessContext = { root: string; cwd: string; selfId: string; memberProjects: string[] }`
  - `parseMembers(ws: Workspace, name: string): EmployeeId[]`
  - `projectsOf(ws: Workspace, id: EmployeeId): ProjectName[]`
  - `isWriteAllowed(ctx: AccessContext, targetPath: string): boolean`

- [ ] **Step 1: 写失败测试**

`tests/domain/access-control.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { isWriteAllowed, parseMembers, projectsOf, type AccessContext } from "../../src/domain/access-control.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-acl-"));
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
const ws = createWorkspace(tmp);

function member(name: string, lines: string[]) {
  const dir = path.join(tmp, "projects", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "members.md"), ["# 成员", ...lines].join("\n"));
}

function ctx(): AccessContext {
  return { root: ws.root, cwd: path.join(tmp, "projects", "yt"), selfId: "alice", memberProjects: ["yt"] };
}

describe("parseMembers", () => {
  it("读成员，忽略注释与空行，支持 - 前缀", () => {
    member("yt", ["- alice", "bob", "", "# 注释", "* carol"]);
    expect(parseMembers(ws, "yt")).toEqual(["alice", "bob", "carol"]);
  });

  it("members.md 缺失时返回空（权限从严）", () => {
    expect(parseMembers(ws, "missing")).toEqual([]);
  });
});

describe("projectsOf", () => {
  it("找出员工是成员的项目", () => {
    member("yt", ["alice"]);
    member("xhs", ["bob"]);
    expect(projectsOf(ws, "alice")).toEqual(["yt"]);
  });
});

describe("isWriteAllowed", () => {
  it("允许写自己的工作区", () => {
    expect(isWriteAllowed(ctx(), "agents/alice/note.md")).toBe(true);
  });

  it("允许写所在项目（相对 cwd 与绝对路径都行）", () => {
    expect(isWriteAllowed(ctx(), "data/out.md")).toBe(true);
    expect(isWriteAllowed(ctx(), path.join(tmp, "projects", "yt", "data", "out.md"))).toBe(true);
  });

  it("拒绝写别人的工作区或不在的项目", () => {
    expect(isWriteAllowed(ctx(), "agents/bob/x.md")).toBe(false);
    expect(isWriteAllowed(ctx(), "projects/other/x.md")).toBe(false);
  });

  it("拒绝越界写法", () => {
    expect(isWriteAllowed(ctx(), "../../etc/passwd")).toBe(false);
    expect(isWriteAllowed(ctx(), "agents/alice/../bob/x.md")).toBe(false);
    expect(isWriteAllowed(ctx(), "/etc/passwd")).toBe(false);
    expect(isWriteAllowed(ctx(), "")).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/domain/access-control.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`src/domain/access-control.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import { membersFile, projectsDir, type Workspace } from "./paths.ts";
import type { EmployeeId, ProjectName } from "./types.ts";

export type AccessContext = {
  root: string;
  cwd: string;
  selfId: string;
  memberProjects: ProjectName[];
};

export function parseMembers(ws: Workspace, name: ProjectName): EmployeeId[] {
  const file = membersFile(ws, name);
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter((line) => line !== "");
}

export function projectsOf(ws: Workspace, id: EmployeeId): ProjectName[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(projectsDir(ws), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  return names.filter((name) => parseMembers(ws, name).includes(id));
}

export function isWriteAllowed(ctx: AccessContext, targetPath: string): boolean {
  if (targetPath.trim() === "") return false;
  const absolute = path.isAbsolute(targetPath) ? targetPath : path.resolve(ctx.cwd, targetPath);
  const relative = path.relative(ctx.root, absolute);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  const parts = relative.split(path.sep);
  if (parts[0] === "agents" && parts[1] === ctx.selfId) return true;
  if (parts[0] === "projects" && parts[1] !== undefined && ctx.memberProjects.includes(parts[1])) return true;
  return false;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/domain/access-control.test.ts`
Expected: PASS（7 passed）。

- [ ] **Step 5: 提交**

```bash
git add src/domain/access-control.ts tests/domain/access-control.test.ts
git commit -m "feat(domain): 访问控制（成员制 + 只写自己/所在项目）"
```

---

### Task 5: 提及解析

**Files:**
- Create: `src/domain/mention.ts`
- Test: `tests/domain/mention.test.ts`

**Interfaces:**
- Consumes: `types.ts`
- Produces:
  - `const BOSS_ID = "boss"`
  - `type MentionResult = { targets: string[]; body: string; broadcast: boolean }`
  - `parseMentions(text: string, knownEmployees: EmployeeId[], bossNames?: string[]): MentionResult`

- [ ] **Step 1: 写失败测试**

`tests/domain/mention.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BOSS_ID, parseMentions } from "../../src/domain/mention.ts";

const employees = ["alice", "bob"];

describe("parseMentions", () => {
  it("点名一个员工：定向，正文去掉 @名", () => {
    expect(parseMentions("@alice 写个脚本", employees)).toEqual({
      targets: ["alice"], body: "写个脚本", broadcast: false,
    });
  });

  it("点名多个", () => {
    const r = parseMentions("@alice @bob 一起看下", employees);
    expect(r.targets).toEqual(["alice", "bob"]);
    expect(r.body).toBe("一起看下");
  });

  it("不点名 = 广播", () => {
    expect(parseMentions("大家看下", employees)).toEqual({
      targets: [], body: "大家看下", broadcast: true,
    });
  });

  it("@老板 映射到 BOSS_ID", () => {
    const r = parseMentions("@老板 请审批", employees);
    expect(r.targets).toEqual([BOSS_ID]);
  });

  it("未知的 @名 原样留在正文，且不误路由", () => {
    const r = parseMentions("@nobody 你好", employees);
    expect(r.targets).toEqual([]);
    expect(r.broadcast).toBe(true);
    expect(r.body).toBe("@nobody 你好");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/domain/mention.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`src/domain/mention.ts`:

```ts
import type { EmployeeId } from "./types.ts";

export const BOSS_ID = "boss";

export type MentionResult = {
  targets: string[];
  body: string;
  broadcast: boolean;
};

export function parseMentions(
  text: string,
  knownEmployees: EmployeeId[],
  bossNames: string[] = ["老板", "boss"],
): MentionResult {
  const targets: string[] = [];
  const body = text
    .replace(/@([^\s@]+)/gu, (match, name: string) => {
      if (knownEmployees.includes(name)) {
        if (!targets.includes(name)) targets.push(name);
        return "";
      }
      if (bossNames.includes(name)) {
        if (!targets.includes(BOSS_ID)) targets.push(BOSS_ID);
        return "";
      }
      return match;
    })
    .replace(/\s+/gu, " ")
    .trim();
  return { targets, body, broadcast: targets.length === 0 };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/domain/mention.test.ts`
Expected: PASS（5 passed）。

- [ ] **Step 5: 提交**

```bash
git add src/domain/mention.ts tests/domain/mention.test.ts
git commit -m "feat(domain): @提及解析（定向/广播）"
```

---

### Task 6: 会话链

**Files:**
- Create: `src/domain/conversation-chain.ts`
- Test: `tests/domain/conversation-chain.test.ts`

**Interfaces:**
- Consumes: `paths.ts` 的 `conversationIdsFile`
- Produces:
  - `type SessionRow = { id: string; started: string; ended: string | null; previous: string | null }`
  - `readChain(file: string): SessionRow[]`
  - `activeSession(file: string): SessionRow | undefined`
  - `startNewSession(file: string, id: string, now: string): SessionRow[]`（结束当前，追加新行）

- [ ] **Step 1: 写失败测试**

`tests/domain/conversation-chain.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { activeSession, readChain, startNewSession } from "../../src/domain/conversation-chain.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-chain-"));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const file = path.join(dir, "conversation_ids.md");

describe("conversation chain", () => {
  it("文件不存在时返回空", () => {
    expect(readChain(file)).toEqual([]);
    expect(activeSession(file)).toBeUndefined();
  });

  it("开始一条新会话会落盘，且成为活跃", () => {
    startNewSession(file, "1", "2026-10-16T10:00:00Z");
    expect(readChain(file)).toEqual([
      { id: "1", started: "2026-10-16T10:00:00Z", ended: null, previous: null },
    ]);
    expect(activeSession(file)?.id).toBe("1");
  });

  it("新开会话结束上一条并链接到 previous", () => {
    startNewSession(file, "1", "2026-10-16T10:00:00Z");
    startNewSession(file, "2", "2026-10-16T11:00:00Z");
    const rows = readChain(file);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ id: "1", started: "2026-10-16T10:00:00Z", ended: "2026-10-16T11:00:00Z", previous: null });
    expect(rows[1]).toEqual({ id: "2", started: "2026-10-16T11:00:00Z", ended: null, previous: "1" });
    expect(activeSession(file)?.id).toBe("2");
  });

  it("有多行进行中时取最后一行", () => {
    fs.writeFileSync(file, [
      "| id | started | ended | previous |",
      "|----|---------|-------|----------|",
      "| 1 | t |  | - |",
      "| 2 | t |  | 1 |",
    ].join("\n"));
    expect(activeSession(file)?.id).toBe("2");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/domain/conversation-chain.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`src/domain/conversation-chain.ts`:

```ts
import fs from "node:fs";

export type SessionRow = {
  id: string;
  started: string;
  ended: string | null;
  previous: string | null;
};

const HEADER = ["# 会话链", "", "| id | started | ended | previous |", "|----|---------|-------|----------|"];

function encode(rows: SessionRow[]): string {
  const body = rows.map((r) =>
    `| ${r.id} | ${r.started} | ${r.ended ?? ""} | ${r.previous ?? "-"} |`,
  );
  return [...HEADER, ...body, ""].join("\n");
}

export function readChain(file: string): SessionRow[] {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const rows: SessionRow[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed.replace(/^\|/u, "").replace(/\|$/u, "").split("|").map((c) => c.trim());
    if (cells.length !== 4) continue;
    const [id, started, ended, previous] = cells as [string, string, string, string];
    if (id === "id" || id.startsWith("---")) continue;
    rows.push({
      id,
      started,
      ended: ended === "" ? null : ended,
      previous: previous === "-" || previous === "" ? null : previous,
    });
  }
  return rows;
}

export function activeSession(file: string): SessionRow | undefined {
  const rows = readChain(file).filter((row) => row.ended === null);
  return rows.length === 0 ? undefined : rows[rows.length - 1];
}

export function startNewSession(file: string, id: string, now: string): SessionRow[] {
  const rows = readChain(file).map((row) => (row.ended === null ? { ...row, ended: now } : row));
  const previous = rows.length === 0 ? null : rows[rows.length - 1]!.id;
  rows.push({ id, started: now, ended: null, previous });
  fs.writeFileSync(file, encode(rows));
  return rows;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/domain/conversation-chain.test.ts`
Expected: PASS（4 passed）。

- [ ] **Step 5: 提交**

```bash
git add src/domain/conversation-chain.ts tests/domain/conversation-chain.test.ts
git commit -m "feat(domain): 会话链（conversation_ids.md）"
```

---

### Task 7: HarnessPort 与 Pi Durable 实现

**Files:**
- Create: `src/harness/port.ts`
- Create: `src/harness/pi-durable.ts`
- Test: `tests/harness/pi-durable.test.ts`

**Interfaces:**
- Consumes: `paths.ts`、`access-control.ts` 的 `AccessContext`
- Produces:
  - `type ModelRef = { provider: string; modelId: string }`
  - `type ConversationSpec = { cwd: string; instructions: string; model: ModelRef; thinkingLevel?: string; access: AccessContext }`
  - `type ChatMessage = { id: string; role: "user" | "assistant"; text: string }`
  - `interface HarnessPort { open(opts): Promise<void>; close(): Promise<void>; ensureActive(key: string, spec: ConversationSpec): Promise<string>; startSession(key: string, spec: ConversationSpec): Promise<string>; send(convId: string, text: string): Promise<ChatMessage>; transcript(convId: string): Promise<ChatMessage[]> }`
  - `createPiHarness(opts: { root: string; sqlitePath: string; models?: Models }): HarnessPort`

- [ ] **Step 1: 写失败测试（用 faux 假模型，无需真实 key）**

`tests/harness/pi-durable.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { afterEach, describe, expect, it } from "vitest";
import { createPiHarness } from "../../src/harness/pi-durable.ts";
import type { ConversationSpec } from "../../src/harness/port.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-harness-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function spec(cwd: string): ConversationSpec {
  return {
    cwd,
    instructions: "你是测试员工。",
    model: { provider: "faux", modelId: "faux-model" },
    access: { root, cwd, selfId: "alice", memberProjects: [] },
  };
}

function fauxModels() {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
  faux.setResponses([fauxAssistantMessage("你好，我是 alice。")]);
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, faux };
}

describe("Pi Durable HarnessPort", () => {
  it("能开一条会话、发消息、拿回答、读回 transcript", async () => {
    const { models } = fauxModels();
    const harness = createPiHarness({ root, sqlitePath: path.join(root, ".openstaffs", "state.sqlite"), models });
    await harness.open();
    try {
      const cwd = path.join(root, "agents", "alice");
      fs.mkdirSync(cwd, { recursive: true });
      const convId = await harness.ensureActive("dm:alice", spec(cwd));
      const reply = await harness.send(convId, "你是谁？");
      expect(reply.role).toBe("assistant");
      expect(reply.text).toContain("alice");
      const history = await harness.transcript(convId);
      expect(history.some((m) => m.role === "user" && m.text === "你是谁？")).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("ensureActive 幂等：同 key 返回同一会话 id", async () => {
    const { models } = fauxModels();
    const harness = createPiHarness({ root, sqlitePath: path.join(root, ".openstaffs", "state.sqlite"), models });
    await harness.open();
    try {
      const cwd = path.join(root, "agents", "alice");
      fs.mkdirSync(cwd, { recursive: true });
      const a = await harness.ensureActive("dm:alice", spec(cwd));
      const b = await harness.ensureActive("dm:alice", spec(cwd));
      expect(b).toBe(a);
    } finally {
      await harness.close();
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/harness/pi-durable.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现接口**

`src/harness/port.ts`:

```ts
import type { AccessContext } from "../domain/access-control.ts";

export type ModelRef = { provider: string; modelId: string };

export type ConversationSpec = {
  cwd: string;
  instructions: string;
  model: ModelRef;
  thinkingLevel?: string;
  access: AccessContext;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

export interface HarnessPort {
  open(): Promise<void>;
  close(): Promise<void>;
  ensureActive(key: string, spec: ConversationSpec): Promise<string>;
  startSession(key: string, spec: ConversationSpec): Promise<string>;
  send(convId: string, text: string): Promise<ChatMessage>;
  transcript(convId: string): Promise<ChatMessage[]>;
}
```

- [ ] **Step 4: 实现 Pi Durable 适配**

`src/harness/pi-durable.ts`:

```ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { AssistantEntry, Harness, createRegistry, type Conversation } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { Message } from "@earendil-works/pi-ai";
import type { ChatMessage, ConversationSpec, HarnessPort, ModelRef } from "./port.ts";

export type PiHarnessOptions = {
  root: string;
  sqlitePath: string;
  models?: Models;
};

function textOf(message: Message | undefined): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => (block && block.type === "text" ? [String(block.text ?? "")] : []))
    .join("")
    .trim();
}

export function createPiHarness(options: PiHarnessOptions): HarnessPort {
  const ctx = BACKGROUND_CONTEXT;
  const models = options.models ?? (() => {
    const m = createModels();
    m.setProvider(opencodeGoProvider());
    return m;
  })();
  const registry = createRegistry();
  registry.install(CodingTools);

  let harness: Harness | undefined;
  const activeByKey = new Map<string, ConversationId>();

  async function conversation(id: ConversationId): Promise<Conversation> {
    const found = await harness!.conversation(id, ctx);
    if (!found) throw new Error(`会话不存在: ${id}`);
    return found;
  }

  async function applyAgent(conv: Conversation, spec: ConversationSpec): Promise<void> {
    await conv.configure(
      {
        model: spec.model,
        ...(spec.thinkingLevel === undefined ? {} : { thinkingLevel: spec.thinkingLevel as never }),
        instructions: spec.instructions,
        cwd: spec.cwd,
      },
      ctx,
    );
  }

  return {
    async open() {
      harness = await Harness.open(
        await openNodeSqliteStorage(options.sqlitePath),
        { models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? options.root }) },
        ctx,
      );
    },
    async close() {
      if (harness) await harness.close(ctx);
      harness = undefined;
    },
    async ensureActive(key, spec) {
      const existing = activeByKey.get(key);
      if (existing !== undefined) {
        await applyAgent(await conversation(existing), spec);
        return String(existing);
      }
      const conv = await harness!.createConversation({ ownership: { kind: "ownerless" } }, ctx);
      activeByKey.set(key, conv.id);
      await applyAgent(conv, spec);
      return String(conv.id);
    },
    async startSession(key, spec) {
      activeByKey.delete(key);
      const conv = await harness!.createConversation({ ownership: { kind: "ownerless" } }, ctx);
      activeByKey.set(key, conv.id);
      await applyAgent(conv, spec);
      return String(conv.id);
    },
    async send(convId, text) {
      const conv = await conversation(convId as unknown as ConversationId);
      const submission = await conv.submit({ type: "input", content: text }, ctx);
      const settled = await submission.wait(ctx);
      if (settled.status !== "done") {
        return { id: `err-${convId}`, role: "assistant", text: `[未完成: ${settled.status}]` };
      }
      const entry = await conv.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
      const message = entry?.model?.[0];
      const body = textOf(message);
      return { id: String(settled.answer), role: "assistant", text: body };
    },
    async transcript(convId) {
      const conv = await conversation(convId as unknown as ConversationId);
      const view = await conv.viewState(ctx);
      const messages: ChatMessage[] = [];
      for (const entry of view.value.entries) {
        const model = (entry as { model?: Message[] }).model;
        if (!Array.isArray(model)) continue;
        for (const message of model) {
          const role = message.role === "user" ? "user" : "assistant";
          const body = textOf(message);
          if (body !== "") messages.push({ id: String(entry.id), role, text: body });
        }
      }
      return messages;
    },
  };
}
```

> 注：`view.value.entries` 的条目形状以 `pi-durable` 的类型为准；若字段名不同，按 `dist/harness/types.d.ts` 的 `EntryRecord` 调整 `transcript()`（其余实现不受影响）。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/harness/pi-durable.test.ts`
Expected: PASS（2 passed）。

- [ ] **Step 6: 提交**

```bash
git add src/harness/port.ts src/harness/pi-durable.ts tests/harness/pi-durable.test.ts
git commit -m "feat(harness): HarnessPort 与 Pi Durable 实现"
```

---

### Task 8: 访问控制钩子接入

**Files:**
- Create: `src/harness/access-extension.ts`
- Modify: `src/harness/pi-durable.ts`（安装访问控制扩展 + 维护 per-conversation 的 `AccessContext`）
- Test: `tests/harness/access-extension.test.ts`

**Interfaces:**
- Consumes: `AccessContext`、`isWriteAllowed`、`HarnessPort`
- Produces:
  - `createAccessExtension(getContext: (convId: string) => AccessContext | undefined): Extension`

- [ ] **Step 1: 写失败测试（假模型要求写界外文件，断言未创建）**

`tests/harness/access-extension.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { afterEach, describe, expect, it } from "vitest";
import { createPiHarness } from "../../src/harness/pi-durable.ts";
import type { ConversationSpec } from "../../src/harness/port.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-hook-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const aliceCwd = path.join(root, "agents", "alice");

function spec(): ConversationSpec {
  return {
    cwd: aliceCwd,
    instructions: "你是 alice。",
    model: { provider: "faux", modelId: "faux-model" },
    access: { root, cwd: aliceCwd, selfId: "alice", memberProjects: [] },
  };
}

describe("访问控制钩子", () => {
  it("界内 write 生效，界外 write 被拦", async () => {
    fs.mkdirSync(aliceCwd, { recursive: true });
    fs.mkdirSync(path.join(root, "agents", "bob"), { recursive: true });
    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "note.md", content: "hi" })),
      fauxAssistantMessage(fauxToolCall("write", { path: "agents/bob/evil.md", content: "pwn" })),
      fauxAssistantMessage("done"),
      fauxAssistantMessage("done"),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const harness = createPiHarness({ root, sqlitePath: path.join(root, ".openstaffs", "state.sqlite"), models });
    await harness.open();
    try {
      const convId = await harness.ensureActive("dm:alice", spec());
      await harness.send(convId, "先在界内写 note.md，再写到 agents/bob/evil.md");
      await harness.send(convId, "继续");
    } finally {
      await harness.close();
    }
    expect(fs.existsSync(path.join(aliceCwd, "note.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, "agents", "bob", "evil.md"))).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/harness/access-extension.test.ts`
Expected: FAIL（`agents/bob/evil.md` 被创建，因为尚未装钩子）。

- [ ] **Step 3: 实现扩展**

`src/harness/access-extension.ts`:

```ts
import { ToolTask, defineExtension, hook, type Extension } from "@earendil-works/pi-durable";
import { isWriteAllowed, type AccessContext } from "../domain/access-control.ts";

export function createAccessExtension(
  getContext: (convId: string) => AccessContext | undefined,
): Extension {
  return defineExtension({
    name: "openstaffs-access",
    hooks: [
      hook(ToolTask, {
        beforeTool: (call, api) => {
          const ctx = getContext(String(api.conversationId));
          if (ctx === undefined) return { block: "访问控制：未注册的会话" };
          if (call.name === "write" || call.name === "edit") {
            const target = String((call.arguments as { path?: unknown } | undefined)?.path ?? "");
            if (!isWriteAllowed(ctx, target)) {
              return { block: `访问控制：不可写 "${target}"` };
            }
            return undefined;
          }
          if (call.name === "bash") {
            return { block: "访问控制：bash 在本期默认禁用" };
          }
          return undefined;
        },
      }),
    ],
  });
}
```

- [ ] **Step 4: 接入 pi-durable 实现**

在 `src/harness/pi-durable.ts` 里：
1. `import { createAccessExtension } from "./access-extension.ts";`
2. 新增 `const accessByConv = new Map<string, AccessContext>();`
3. `registry.install(CodingTools);` 之后加：`registry.install(createAccessExtension((id) => accessByConv.get(id)));`
4. `applyAgent()` 里，`configure` 之前写入：`accessByConv.set(String(conv.id), spec.access);`

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/harness/access-extension.test.ts`
Expected: PASS。

- [ ] **Step 6: 跑全部测试**

Run: `npm test`
Expected: 全部 PASS。

- [ ] **Step 7: 提交**

```bash
git add src/harness/access-extension.ts src/harness/pi-durable.ts tests/harness/access-extension.test.ts
git commit -m "feat(harness): beforeTool 访问控制钩子"
```

---

### Task 9: 应用用例（私聊 / 群聊 / 新开会话）

**Files:**
- Create: `src/app/conversations.ts`
- Test: `tests/app/conversations.test.ts`

**Interfaces:**
- Consumes: `paths.ts`、`employee.ts`、`access-control.ts`、`conversation-chain.ts`、`harness/port.ts`
- Produces:
  - `type Relation = { kind: "dm"; employeeId: string } | { kind: "group"; project: string }`
  - `relationKey(relation: Relation): string`
  - `relationCwd(ws, relation): string`
  - `openDm(ws, harness, employeeId): Promise<string>`（得到当前活跃会话 id）
  - `openGroup(ws, harness, project, speakerId): Promise<string>`
  - `newSession(ws, harness, relation, speakerId): Promise<string>`

- [ ] **Step 1: 写失败测试**

`tests/app/conversations.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { readChain } from "../../src/domain/conversation-chain.ts";
import { createPiHarness } from "../../src/harness/pi-durable.ts";
import { newSession, openDm, relationKey } from "../../src/app/conversations.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-app-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function seedEmployee(id: string) {
  const dir = path.join(root, "agents", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "AGENTS.md"), `你是 ${id}。`);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ provider: "faux", modelId: "faux-model" }));
}

function harnessWithFaux() {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
  faux.setResponses([fauxAssistantMessage("ok"), fauxAssistantMessage("ok")]);
  const models = createModels();
  models.setProvider(faux.provider);
  return createPiHarness({ root, sqlitePath: path.join(root, ".openstaffs", "state.sqlite"), models });
}

describe("应用用例", () => {
  it("开私聊：建立会话并在员工目录落 conversation_ids.md", async () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const harness = harnessWithFaux();
    await harness.open();
    try {
      const convId = await openDm(ws, harness, "alice");
      const chain = readChain(path.join(root, "agents", "alice", "conversation_ids.md"));
      expect(chain).toHaveLength(1);
      expect(chain[0]!.id).toBe(convId);
    } finally {
      await harness.close();
    }
  });

  it("新开会话：追加一条并结束上一条", async () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const harness = harnessWithFaux();
    await harness.open();
    try {
      const first = await openDm(ws, harness, "alice");
      const second = await newSession(ws, harness, { kind: "dm", employeeId: "alice" }, "alice");
      expect(second).not.toBe(first);
      const chain = readChain(path.join(root, "agents", "alice", "conversation_ids.md"));
      expect(chain).toHaveLength(2);
      expect(chain[0]!.ended).not.toBeNull();
      expect(chain[1]!.previous).toBe(first);
      expect(relationKey({ kind: "dm", employeeId: "alice" })).toBe("dm:alice");
    } finally {
      await harness.close();
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/app/conversations.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`src/app/conversations.ts`:

```ts
import { employeeDir, projectDir, type Workspace } from "../domain/paths.ts";
import { loadEmployee, renderInstructions, type Employee } from "../domain/employee.ts";
import { projectsOf } from "../domain/access-control.ts";
import { activeSession, startNewSession } from "../domain/conversation-chain.ts";
import { conversationIdsFile } from "../domain/paths.ts";
import type { HarnessPort, ConversationSpec } from "../harness/port.ts";

export type Relation =
  | { kind: "dm"; employeeId: string }
  | { kind: "group"; project: string };

export function relationKey(relation: Relation): string {
  return relation.kind === "dm" ? `dm:${relation.employeeId}` : `group:${relation.project}`;
}

export function relationCwd(ws: Workspace, relation: Relation): string {
  return relation.kind === "dm" ? employeeDir(ws, relation.employeeId) : projectDir(ws, relation.project);
}

function specFor(ws: Workspace, relation: Relation, speaker: Employee): ConversationSpec {
  const cwd = relationCwd(ws, relation);
  return {
    cwd,
    instructions: renderInstructions(speaker),
    model: { provider: speaker.model.provider, modelId: speaker.model.modelId },
    ...(speaker.model.thinkingLevel === undefined ? {} : { thinkingLevel: speaker.model.thinkingLevel }),
    access: { root: ws.root, cwd, selfId: speaker.id, memberProjects: projectsOf(ws, speaker.id) },
  };
}

async function ensure(ws: Workspace, harness: HarnessPort, relation: Relation, speakerId: string): Promise<string> {
  const speaker = loadEmployee(ws, speakerId);
  const file = conversationIdsFile(ws, relationCwd(ws, relation));
  const active = activeSession(file);
  const spec = specFor(ws, relation, speaker);
  if (active === undefined) {
    const convId = await harness.ensureActive(relationKey(relation), spec);
    startNewSession(file, convId, new Date().toISOString());
    return convId;
  }
  return harness.ensureActive(relationKey(relation), spec);
}

export function openDm(ws: Workspace, harness: HarnessPort, employeeId: string): Promise<string> {
  return ensure(ws, harness, { kind: "dm", employeeId }, employeeId);
}

export function openGroup(ws: Workspace, harness: HarnessPort, project: string, speakerId: string): Promise<string> {
  return ensure(ws, harness, { kind: "group", project }, speakerId);
}

export async function newSession(ws: Workspace, harness: HarnessPort, relation: Relation, speakerId: string): Promise<string> {
  const speaker = loadEmployee(ws, speakerId);
  const spec = specFor(ws, relation, speaker);
  const convId = await harness.startSession(relationKey(relation), spec);
  startNewSession(conversationIdsFile(ws, relationCwd(ws, relation)), convId, new Date().toISOString());
  return convId;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/app/conversations.test.ts`
Expected: PASS（2 passed）。

- [ ] **Step 5: 提交**

```bash
git add src/app/conversations.ts tests/app/conversations.test.ts
git commit -m "feat(app): 私聊/群聊/新开会话用例"
```

---

### Task 10: 路由与老板待办

**Files:**
- Create: `src/app/routing.ts`
- Create: `src/app/unread.ts`
- Test: `tests/app/routing.test.ts`

**Interfaces:**
- Consumes: `mention.ts`、`conversations.ts`、`harness/port.ts`
- Produces:
  - `type Delivery = { to: string; body: string }`
  - `planRouting(text: string, memberIds: string[]): { deliveries: Delivery[]; broadcast: boolean }`
  - `type Unread = { relation: string; message: ChatMessage }`
  - `unreadForBoss(conversations: { relation: string; messages: ChatMessage[] }[], bossSeenCount: Record<string, number>): Unread[]`

- [ ] **Step 1: 写失败测试**

`tests/app/routing.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { planRouting } from "../../src/app/routing.ts";
import { unreadForBoss } from "../../src/app/unread.ts";

describe("planRouting", () => {
  it("点名 → 只投给被点名者", () => {
    expect(planRouting("@alice 写脚本", ["alice", "bob"])).toEqual({
      deliveries: [{ to: "alice", body: "写脚本" }],
      broadcast: false,
    });
  });

  it("不点名 → 广播给全体", () => {
    expect(planRouting("大家看下", ["alice", "bob"])).toEqual({
      deliveries: [
        { to: "alice", body: "大家看下" },
        { to: "bob", body: "大家看下" },
      ],
      broadcast: true,
    });
  });
});

describe("unreadForBoss", () => {
  it("老板没看过的、非老板发的消息 = 小红点", () => {
    const unread = unreadForBoss(
      [
        { relation: "dm:alice", messages: [
          { id: "1", role: "user", text: "在吗" },
          { id: "2", role: "assistant", text: "在的" },
        ] },
      ],
      { "dm:alice": 1 },
    );
    expect(unread).toEqual([{ relation: "dm:alice", message: { id: "2", role: "assistant", text: "在的" } }]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/app/routing.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`src/app/routing.ts`:

```ts
import { BOSS_ID, parseMentions } from "../domain/mention.ts";

export type Delivery = { to: string; body: string };

export function planRouting(text: string, memberIds: string[]): { deliveries: Delivery[]; broadcast: boolean } {
  const mention = parseMentions(text, memberIds);
  if (mention.broadcast) {
    return { deliveries: memberIds.map((to) => ({ to, body: mention.body })), broadcast: true };
  }
  const deliveries = mention.targets
    .filter((target) => target !== BOSS_ID && memberIds.includes(target))
    .map((to) => ({ to, body: mention.body }));
  return { deliveries, broadcast: false };
}
```

`src/app/unread.ts`:

```ts
import type { ChatMessage } from "../harness/port.ts";

export type Unread = { relation: string; message: ChatMessage };

export function unreadForBoss(
  conversations: { relation: string; messages: ChatMessage[] }[],
  bossSeenCount: Record<string, number>,
): Unread[] {
  const unread: Unread[] = [];
  for (const conversation of conversations) {
    const seen = bossSeenCount[conversation.relation] ?? 0;
    conversation.messages.slice(seen).forEach((message) => {
      if (message.role !== "user") unread.push({ relation: conversation.relation, message });
    });
  }
  return unread;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/app/routing.test.ts`
Expected: PASS（3 passed）。

- [ ] **Step 5: 全套测试 + 类型检查**

Run: `npm test && npm run typecheck`
Expected: 全 PASS，类型无误。

- [ ] **Step 6: 提交**

```bash
git add src/app/routing.ts src/app/unread.ts tests/app/routing.test.ts
git commit -m "feat(app): @路由与老板待办小红点"
```

---

## 自检记录

- **Spec 覆盖**：§4.1 目录（Task 2/3/6）· §4.2 映射（Task 3/7/9）· §4.3 会话链（Task 6/9）· §5.1–5.4 流程（Task 9/10）· §5.5 待办（Task 10）· §5.7 新开会话（Task 9）· §6 访问控制（Task 4/8）· 员工 `config.json`（Task 3）。**服务端 + Web UI 属第二份计划（未在本计划内）。**
- **占位符扫描**：无 TODO/TBD；除 Task 7 Step 4 一条对 `EntryRecord` 字段的显式适配说明外，全部为可直接落地的代码。
- **类型一致性**：`AccessContext`（Task 4）贯穿 Task 7/8/9；`ConversationSpec`（Task 7）贯穿 Task 8/9；`ChatMessage`（Task 7）贯穿 Task 9/10；`SessionRow`（Task 6）仅 Task 6/9 使用。
- **Review Focus**：5 条均已钉在归属任务——越界写法(Task 4)、缺失文件(Task 3/4)、会话链损坏(Task 6)、提及歧义(Task 5/10)、重复提交(Task 7，`submission.wait` 串行)。

## 执行注意

- 需真实模型时，设 `OPENCODE_API_KEY`（OpenCode Go）。测试全部走 `faux` 假模型，**不需要 key**。
- Pi Durable 是 **experimental**：任何 `configure`/`submit`/`viewState` 报签名不符，以 `node_modules/@earendil-works/pi-durable/dist/**/*.d.ts` 为准就地修正，**不改域层**。
