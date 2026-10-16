# OpenStaffs 写权限（permission.json）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把写权限从代码里的铁律扩展为"基线 ∪ 文件夹里的 `permission.json` 加法授权"，并把 `bash` 全开。

**Architecture:** 纯域层新增 `permissions.ts`（读取 + 路径匹配）；`access-control.ts` 的 `isWriteAllowed` 改为"基线（自己 + 成员项目）∪ `permission.json`"；`app/conversations.ts` 按会话来源算出适用的 `permission.json` 文件（私聊=员工文件；群聊=项目文件+员工文件）；`harness/access-extension.ts` 移除对 `bash` 的拦截。域层不认识基座。

**Tech Stack:** TypeScript (ESM)、Node ≥ 22.19、Vitest；基座 `@earendil-works/*` 锁 1.3.0。

**Spec:** `docs/superpowers/specs/2026-10-16-openstaffs-permissions-design.md`

## Global Constraints

- **Node ≥ 22.19**，ESM（`"type": "module"`），`strict` + `noUncheckedIndexedAccess`。
- 基座版本**锁定 `1.3.0`**，禁跨版本升级。
- **写 ACL = 基线 ∪ `permission.json` 加法**：基线（`<root>/agents/<自己>/**` 与成员项目 `<root>/projects/<任务>/**`）永远生效；`permission.json` 只在其上补充允许区域；**只加不减、无 deny**。
- `permission.json` 内容是 **JSON 字符串数组**（无正则）；相对条目相对该文件所在目录解析（支持 `../`）；绝对条目按绝对；**目录条目含其全部下级**（`./dir/` 命中 `dir/a/b`）。
- **相对目标 path 一律按会话 cwd 解析**（与工具真实落点一致）——移除旧的 `agents/`/`projects/` 前缀根相对硬化。
- **读不拦**；**`bash` 全开**（接受其可绕过写 ACL，属 MVP 软边界）。
- 不限定工作区根：`permission.json` 可授权到工作区根之外的绝对位置。
- 员工目录扁平。

## Review Focus

以下输入/失败模式 spec 隐含但任何单测都不天然覆盖，最易伤人，按危害从高到低；每条在其归属任务的测试里钉住：

1. **权限文件归属/合并错误**：群聊必须同时挂"项目 `permission.json` + 员工 `permission.json`"，私聊只挂员工文件；挂错会放大/缩小某人权限。→ Task 3。
2. **目录条目的子树语义与边界**：`./dir/` 必须命中 `dir/a/b`，但**不得**命中兄弟 `dir2`（前缀必须带分隔符边界）。→ Task 1。
3. **相对 path 的解析基准**：必须按会话 cwd 解析（与工具真实落点一致）；`../` 归一后若爬到基线外应拒绝。→ Task 2。
4. **坏/缺权限文件**：缺文件、坏 JSON、非数组、非字符串元素、空条目 → 不崩溃，且**退回基线，绝不因解析失败而放大权限**。→ Task 1 / Task 2。
5. **bash 全开不误伤其它工具**：`bash` 能跑；`write`/`edit` 仍走 ACL。→ Task 4。

---

## File Structure

```
src/
  domain/
    permissions.ts          # 新增：读取 permission.json + 路径匹配
    access-control.ts       # 修改：AccessContext 增 permissionFiles；isWriteAllowed 重写
  app/
    conversations.ts        # 修改：permissionFilesFor（私聊/群聊选文件）
  harness/
    access-extension.ts     # 修改：移除 bash 拦截
tests/
  domain/permissions.test.ts        # 新增
  domain/access-control.test.ts     # 修改：新 ACL 语义
  app/conversations.test.ts         # 修改：断言 permissionFiles
  harness/access-extension.test.ts  # 修改：越界改绝对路径 + 授权放行 + bash 放行
  harness/pi-durable.test.ts        # 修改：spec 增 permissionFiles
```

---

### Task 1: 权限路径模块（permissions.ts）

**Files:**
- Create: `src/domain/permissions.ts`
- Test: `tests/domain/permissions.test.ts`

**Interfaces:**
- Consumes: 无（纯 Node）
- Produces:
  - `readPermissionPaths(file: string): string[]`
  - `matchesPermission(paths: string[], permissionDir: string, targetAbs: string): boolean`
  - `isWriteAllowedByPermission(files: string[], targetAbs: string): boolean`

- [ ] **Step 1: 写失败测试**

`tests/domain/permissions.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isWriteAllowedByPermission, matchesPermission, readPermissionPaths,
} from "../../src/domain/permissions.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-perm-"));
beforeEach(() => { fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root, { recursive: true }); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe("readPermissionPaths", () => {
  it("读字符串数组", () => {
    const f = path.join(root, "permission.json");
    write(f, JSON.stringify(["./data/", "/abs/x"]));
    expect(readPermissionPaths(f)).toEqual(["./data/", "/abs/x"]);
  });

  it("缺失/坏 JSON/非数组/非字符串元素 → 安全降级", () => {
    expect(readPermissionPaths(path.join(root, "nope.json"))).toEqual([]);
    const bad = path.join(root, "bad.json"); write(bad, "{ not json");
    expect(readPermissionPaths(bad)).toEqual([]);
    const obj = path.join(root, "obj.json"); write(obj, JSON.stringify({ write: [] }));
    expect(readPermissionPaths(obj)).toEqual([]);
    const mix = path.join(root, "mix.json"); write(mix, JSON.stringify(["./a", 5, "", "  "]));
    expect(readPermissionPaths(mix)).toEqual(["./a"]);
  });
});

describe("matchesPermission", () => {
  const dir = "/company/agents/alice";

  it("目录条目含其全部下级", () => {
    expect(matchesPermission(["./data/"], dir, "/company/agents/alice/data")).toBe(true);
    expect(matchesPermission(["./data/"], dir, "/company/agents/alice/data/a/b.md")).toBe(true);
  });

  it("不误命中兄弟目录", () => {
    expect(matchesPermission(["./data/"], dir, "/company/agents/alice/data2/x.md")).toBe(false);
    expect(matchesPermission(["./data/"], dir, "/company/agents/alice/dataX")).toBe(false);
  });

  it("../ 相对该文件所在目录归一", () => {
    expect(matchesPermission(["../bob/notes.md"], dir, "/company/agents/bob/notes.md")).toBe(true);
    expect(matchesPermission(["../bob/notes.md"], dir, "/company/agents/bob/other.md")).toBe(false);
  });

  it("绝对条目", () => {
    expect(matchesPermission(["/shared/x"], "/whatever", "/shared/x/y")).toBe(true);
    expect(matchesPermission(["/shared/x"], "/whatever", "/shared/y/x")).toBe(false);
  });

  it("大小写敏感", () => {
    expect(matchesPermission(["/Shared/"], "/", "/shared/a")).toBe(false);
  });
});

describe("isWriteAllowedByPermission", () => {
  it("任一文件命中即 true", () => {
    const proj = path.join(root, "projects", "yt", "permission.json");
    write(proj, JSON.stringify(["../../agents/bob/"]));
    expect(isWriteAllowedByPermission([proj], path.join(root, "agents", "bob", "x.md"))).toBe(true);
    expect(isWriteAllowedByPermission([proj], path.join(root, "agents", "carol", "x.md"))).toBe(false);
  });

  it("坏/缺文件 → false（不放大权限）", () => {
    expect(isWriteAllowedByPermission([path.join(root, "nope.json")], path.join(root, "agents", "bob", "x.md"))).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/domain/permissions.test.ts`
Expected: FAIL（找不到模块 `src/domain/permissions.ts`）。

- [ ] **Step 3: 实现**

`src/domain/permissions.ts`:

```ts
import fs from "node:fs";
import path from "node:path";

/** 读取一个 permission.json：必须是字符串数组；任何失败返回 []。 */
export function readPermissionPaths(file: string): string[] {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
  } catch {
    return [];
  }
}

/** targetAbs 命中任一 pattern（相等或在其下）即 true。相对 pattern 相对 permissionDir 归一。 */
export function matchesPermission(patterns: string[], permissionDir: string, targetAbs: string): boolean {
  return patterns.some((pattern) => {
    const base = path.resolve(permissionDir, pattern);
    return targetAbs === base || targetAbs.startsWith(base + path.sep);
  });
}

/** 任一 permission.json 命中 targetAbs 即 true。 */
export function isWriteAllowedByPermission(files: string[], targetAbs: string): boolean {
  return files.some((file) => matchesPermission(readPermissionPaths(file), path.dirname(file), targetAbs));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/domain/permissions.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/domain/permissions.ts tests/domain/permissions.test.ts
git commit -m "feat(domain): permission.json 读取与路径匹配（目录含全部下级）"
```

---

### Task 2: 写 ACL 重写（access-control.ts）

**Files:**
- Modify: `src/domain/access-control.ts`（`AccessContext`、`isWriteAllowed`）
- Modify: `tests/domain/access-control.test.ts`
- Modify: `tests/harness/access-extension.test.ts:19`（spec 的 `access` 增 `permissionFiles: []`；并把"越界写"改成**绝对路径**）
- Modify: `tests/harness/pi-durable.test.ts`（spec 的 `access` 增 `permissionFiles: []`）
- Modify: `src/app/conversations.ts:26`（`specFor` 的 `access` 增 `permissionFiles: []`，**占位为 `[]`，Task 3 替换为真实值**）

**Interfaces:**
- Consumes: Task 1 的 `isWriteAllowedByPermission`
- Produces:
  - `AccessContext = { root: string; cwd: string; selfId: string; memberProjects: ProjectName[]; permissionFiles: string[] }`
  - `isWriteAllowed(ctx: AccessContext, targetPath: string): boolean`（签名不变）

- [ ] **Step 1: 改测试（新 ACL 语义）**

`tests/domain/access-control.test.ts`（整文件替换）:

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

function ctx(extra: Partial<AccessContext> = {}): AccessContext {
  return {
    root: ws.root,
    cwd: path.join(tmp, "projects", "yt"),
    selfId: "alice",
    memberProjects: ["yt"],
    permissionFiles: [],
    ...extra,
  };
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
  it("允许写自己的工作区（私聊 cwd = 员工目录）", () => {
    const c = ctx({ cwd: path.join(tmp, "agents", "alice") });
    expect(isWriteAllowed(c, "note.md")).toBe(true);
    expect(isWriteAllowed(c, "data/x.md")).toBe(true);
  });

  it("允许写所在项目（群聊 cwd = 项目目录）", () => {
    expect(isWriteAllowed(ctx(), "data/out.md")).toBe(true);
    expect(isWriteAllowed(ctx(), path.join(tmp, "projects", "yt", "data", "out.md"))).toBe(true);
  });

  it("相对 path 一律按 cwd 解析（与工具落点一致）", () => {
    expect(isWriteAllowed(ctx(), "agents/bob/x.md")).toBe(true);
    expect(isWriteAllowed(ctx(), "projects/other/x.md")).toBe(true);
  });

  it("拒绝真正的工作区外（爬到根外或绝对外部）", () => {
    expect(isWriteAllowed(ctx(), "../../agents/bob/x.md")).toBe(false);
    expect(isWriteAllowed(ctx(), "../../etc/passwd")).toBe(false);
    expect(isWriteAllowed(ctx(), "/etc/passwd")).toBe(false);
    expect(isWriteAllowed(ctx(), "")).toBe(false);
  });

  it("permission.json 授权可写界外", () => {
    const perm = path.join(tmp, "projects", "yt", "permission.json");
    fs.mkdirSync(path.dirname(perm), { recursive: true });
    fs.writeFileSync(perm, JSON.stringify(["../../agents/bob/"]));
    const c = ctx({ permissionFiles: [perm] });
    expect(isWriteAllowed(c, "../../agents/bob/x.md")).toBe(true);
    expect(isWriteAllowed(c, "../../agents/carol/x.md")).toBe(false);
  });

  it("授权文件损坏 → 退回基线，不放大权限", () => {
    const c = ctx({ permissionFiles: [path.join(tmp, "projects", "yt", "nope.json")] });
    expect(isWriteAllowed(c, "../../agents/bob/x.md")).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/domain/access-control.test.ts`
Expected: FAIL（`permissionFiles` 不在类型里 / 旧实现把 `agents/bob/x.md` 判 false）。

- [ ] **Step 3: 实现**

`src/domain/access-control.ts`（整文件替换）:

```ts
import fs from "node:fs";
import path from "node:path";
import { membersFile, projectsDir, type Workspace } from "./paths.ts";
import { isWriteAllowedByPermission } from "./permissions.ts";
import type { EmployeeId, ProjectName } from "./types.ts";

export type AccessContext = {
  root: string;
  cwd: string;
  selfId: string;
  memberProjects: ProjectName[];
  permissionFiles: string[];
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

function isWithin(baseDir: string, target: string): boolean {
  const rel = path.relative(baseDir, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function isWriteAllowed(ctx: AccessContext, targetPath: string): boolean {
  if (targetPath.trim() === "") return false;
  const target = path.resolve(ctx.cwd, targetPath);
  if (isWithin(path.join(ctx.root, "agents", ctx.selfId), target)) return true;
  for (const project of ctx.memberProjects) {
    if (isWithin(path.join(ctx.root, "projects", project), target)) return true;
  }
  return isWriteAllowedByPermission(ctx.permissionFiles, target);
}
```

- [ ] **Step 4: 跑该测试确认通过，再修既有构造点保持编译**

Run: `npx vitest run tests/domain/access-control.test.ts`
Expected: PASS。

其余构造 `AccessContext` 的地方需补 `permissionFiles`，否则 `npm run typecheck` 会失败：

- `tests/harness/access-extension.test.ts` 的 `spec()`：`access: { root, cwd: aliceCwd, selfId: "alice", memberProjects: [], permissionFiles: [] }`
- `tests/harness/pi-durable.test.ts` 的 `spec()`：`access: { root, cwd, selfId: "alice", memberProjects: [], permissionFiles: [] }`
- `src/app/conversations.ts` 的 `specFor()`：`access: { root: ws.root, cwd, selfId: speaker.id, memberProjects: projectsOf(ws, speaker.id), permissionFiles: [] }`（**占位 `[]`，Task 3 替换**）

同时把 `tests/harness/access-extension.test.ts` 的"越界写"改为绝对路径（相对 `agents/bob/evil.md` 现在按 cwd 落项目/自己目录内、会被放行）：

- 第二个 faux 响应改为
  `fauxAssistantMessage(fauxToolCall("write", { path: path.join(root, "agents", "bob", "evil.md"), content: "pwn" }), { stopReason: "toolUse" })`
- 删除对 `path.join(aliceCwd, "agents", "bob", "evil.md")` 的断言（第 47–49 行的注释与其断言）与那条断言
- 保留断言：`fs.existsSync(path.join(aliceCwd, "note.md"))` 为 `true`；`fs.existsSync(path.join(root, "agents", "bob", "evil.md"))` 为 `false`

- [ ] **Step 5: 全套测试 + 类型检查**

Run: `npm test && npm run typecheck`
Expected: 全 PASS，类型无误。

- [ ] **Step 6: 提交**

```bash
git add src/domain/access-control.ts src/app/conversations.ts tests/domain/access-control.test.ts tests/harness/access-extension.test.ts tests/harness/pi-durable.test.ts
git commit -m "feat(domain): 写 ACL = 基线 ∪ permission.json 加法（相对 path 按 cwd 解析）"
```

---

### Task 3: 会话权限文件选择（conversations.ts）

**Files:**
- Modify: `src/app/conversations.ts`（新增 `permissionFilesFor`；`specFor` 用真实值替换 Task 2 的占位 `[]`）
- Test: `tests/app/conversations.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `AccessContext.permissionFiles`；`paths.ts` 的 `projectDir`、`employeeDir`
- Produces: `permissionFilesFor(ws: Workspace, relation: Relation, speaker: Employee): string[]`

- [ ] **Step 1: 写失败测试**

在 `tests/app/conversations.test.ts` 末尾的 `describe("应用用例", ...)` 内追加：

```ts
  it("私聊只挂员工 permission.json", () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const speaker = loadEmployee(ws, "alice");
    expect(permissionFilesFor(ws, { kind: "dm", employeeId: "alice" }, speaker)).toEqual([
      path.join(root, "agents", "alice", "permission.json"),
    ]);
  });

  it("群聊挂项目 + 员工 permission.json（项目在前）", () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const speaker = loadEmployee(ws, "alice");
    expect(permissionFilesFor(ws, { kind: "group", project: "yt" }, speaker)).toEqual([
      path.join(root, "projects", "yt", "permission.json"),
      path.join(root, "agents", "alice", "permission.json"),
    ]);
  });
```

并在文件顶部把既有那一行 `import { newSession, openDm, relationKey } from "../../src/app/conversations.ts";` **替换为**下面两行（补 `permissionFilesFor` 与 `loadEmployee`，避免重复导入）：

```ts
import { newSession, openDm, permissionFilesFor, relationKey } from "../../src/app/conversations.ts";
import { loadEmployee } from "../../src/domain/employee.ts";
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/app/conversations.test.ts`
Expected: FAIL（`permissionFilesFor` 未导出）。

- [ ] **Step 3: 实现**

`src/app/conversations.ts`：

1. 顶部增补 `import path from "node:path";`
2. 新增导出函数（放在 `relationCwd` 之后）：

```ts
export function permissionFilesFor(ws: Workspace, relation: Relation, speaker: Employee): string[] {
  const files: string[] = [];
  if (relation.kind === "group") files.push(path.join(projectDir(ws, relation.project), "permission.json"));
  files.push(path.join(employeeDir(ws, speaker.id), "permission.json"));
  return files;
}
```

3. `specFor` 里把 Task 2 的占位替换为真实值：

```ts
    access: {
      root: ws.root,
      cwd,
      selfId: speaker.id,
      memberProjects: projectsOf(ws, speaker.id),
      permissionFiles: permissionFilesFor(ws, relation, speaker),
    },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/app/conversations.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/app/conversations.ts tests/app/conversations.test.ts
git commit -m "feat(app): 会话 permission.json 选择（私聊=员工；群聊=项目+员工）"
```

---

### Task 4: bash 全开

**Files:**
- Modify: `src/harness/access-extension.ts`（移除 `bash` 拦截）
- Test: `tests/harness/access-extension.test.ts`

**Interfaces:**
- Consumes: 现有 `createAccessExtension`
- Produces: 无（行为变更：`bash` 不再被拦）

- [ ] **Step 1: 写失败测试**

在 `tests/harness/access-extension.test.ts` 的 `describe` 内追加：

```ts
  it("bash 放行：命令被执行、未被拦", async () => {
    fs.mkdirSync(aliceCwd, { recursive: true });
    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "printf hi > made-by-bash.txt" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const harness = createPiHarness({ root, sqlitePath: path.join(root, ".openstaffs", "state.sqlite"), models });
    await harness.open();
    try {
      const convId = await harness.ensureActive("dm:alice", spec());
      await harness.send(convId, "跑个命令");
    } finally {
      await harness.close();
    }
    expect(fs.existsSync(path.join(aliceCwd, "made-by-bash.txt"))).toBe(true);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/harness/access-extension.test.ts`
Expected: FAIL（`made-by-bash.txt` 未生成——bash 被 hooks 拦截）。

- [ ] **Step 3: 实现**

`src/harness/access-extension.ts`：删除下列分支（第 21–23 行）：

```ts
          if (call.name === "bash") {
            return { block: "访问控制：bash 在本期默认禁用" };
          }
```

删除后 `beforeTool` 只对 `write`/`edit` 做判定，其余一律 `return undefined`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/harness/access-extension.test.ts`
Expected: PASS（含原"界内放行/界外拦截"用例与新 bash 用例）。

- [ ] **Step 5: 全套测试 + 类型检查**

Run: `npm test && npm run typecheck`
Expected: 全 PASS，类型无误。

- [ ] **Step 6: 提交**

```bash
git add src/harness/access-extension.ts tests/harness/access-extension.test.ts
git commit -m "feat(harness): bash 全开（移除钩子拦截）"
```

---

## 自检记录

- **Spec 覆盖**：§3/§4 匹配规则（Task 1）· §5 基线∪加法（Task 2）· §7 `permissionFiles` 选择（Task 3）· D8/§6/§7 bash 全开（Task 4）· §6 错误边界（Task 1 Step 1 / Task 2 Step 1）。
- **占位符扫描**：无 TODO/TBD；Task 2 中 `specFor` 的 `permissionFiles: []` 是**显式过渡值**，Task 3 Step 3 替换为真实计算，且 Task 2 的 Interfaces/步骤已标注。
- **类型一致性**：`AccessContext.permissionFiles: string[]`（Task 2）贯穿 Task 3；`isWriteAllowedByPermission`（Task 1）被 Task 2 消费；`permissionFilesFor`（Task 3）被 `specFor` 消费。
- **Review Focus**：5 条均已钉住——权限文件归属(Task 3)、目录子树边界(Task 1)、相对 path 基准(Task 2)、坏文件降级(Task 1/2)、bash 不误伤(Task 4)。
