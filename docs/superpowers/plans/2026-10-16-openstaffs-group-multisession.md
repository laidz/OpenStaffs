# OpenStaffs 群聊多会话 + permission 小修 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 群聊由"单房间会话"改为"**每位成员一条独立会话、按需创建**"（可并行），并把 permissions 的三处小修（`"/"` 全盘、`speaker.id` 统一、条目 trim）落地。

**Architecture:** 域层的会话链读写不变，只改两处路径选择与键：群聊的链文件落到 `projects/<任务>/conversation_ids/<成员>.md`（每成员一个），会话键加入成员 id；`startNewSession` 自动建父目录。`permissions.ts` 支持根条目与 trim。`app/conversations.ts` 统一按 `speaker.id` 取员工权限文件，并在私聊断言发言人与关系一致。

**Tech Stack:** TypeScript (ESM)、Node ≥ 22.19、Vitest；基座 `@earendil-works/*` 锁 1.3.0（本计划不碰基座）。

**Spec:**
- `docs/superpowers/specs/2026-10-16-openstaffs-architecture-design.md`（§4.2/§4.3/§5.1/§5.2 —— 2026-10-16 修订版）
- `docs/superpowers/specs/2026-10-16-openstaffs-permissions-design.md`（D10/D11/D12）

## Global Constraints

- **Node ≥ 22.19**，ESM，`strict` + `noUncheckedIndexedAccess`；基座锁 `1.3.0`。
- **群聊 = 每位成员一条独立会话**；**按需创建**（第一次需要该成员发言时才建/复用；不预建全员）。
- **群聊会话键**必须区分成员：`group:<任务>:<成员>`；**私聊**键 `dm:<员工>`。
- **群聊链文件**：`projects/<任务>/conversation_ids/<成员>.md`（每成员一个）；**私聊链文件**：`agents/<员工>/conversation_ids.md`（不变）。
- 群聊会话 `cwd` 仍是 `projects/<任务>/`；ACL 仍是 `permission.json` 基线 ∪ 加法（本次不改 ACL 语义）。
- **`permission.json` 条目 `"/"` = 授权全盘**；条目两端空白 **trim**；写任何 `permission.json` 仍拒绝。
- 员工权限文件一律按 **`speaker.id`**；私聊断言 `speaker.id === relation.employeeId`，不一致**报错**。
- **读不拦**；**`bash` 全开**（已定，不改）。
- 员工目录扁平。

## Review Focus

以下输入/失败模式 spec 隐含但任何单测都不天然覆盖，最易伤人，按危害从高到低；每条在其归属任务的测试里钉住：

1. **按需创建**：未被 `openGroup` 触达的成员**不得**有会话或链文件（别把"预建全员"当默认）。→ Task 3。
2. **会话与链按成员隔离**：两位成员不得共用会话 id 或链文件；`@谁` 只动谁的链。→ Task 3。
3. **群聊链的父目录**：`conversation_ids/` 子目录不存在时链写入**不得 ENOENT**（需自动创建）。→ Task 3。
4. **`"/"` 全盘授权**：`"/"` 命中任意绝对路径（含 `/etc/passwd`），且不改变其它条目的"子树/兄弟"边界。→ Task 1。
5. **条目空白与非字符串**：`" ./data "` 必须等价 `"./data"`；纯空白跳过；含非字符串元素整份忽略（既有行为不得回归）。→ Task 1。
6. **私聊一致性**：DM 的发言人与关系员工不一致时必须**报错**，不得静默挂错权限文件。→ Task 2。

---

## File Structure

```
src/
  domain/
    permissions.ts          # 修改："/" 全盘 + 条目 trim
    paths.ts                # 修改：新增 groupConversationIdsFile
    conversation-chain.ts   # 修改：startNewSession 自动建父目录
  app/
    conversations.ts        # 修改：relationKey 带成员；群聊链文件；DM 一致性断言
tests/
  domain/permissions.test.ts        # 修改
  domain/paths.test.ts              # 修改
  domain/conversation-chain.test.ts # 修改（嵌套目录落盘）
  app/conversations.test.ts         # 修改（群聊多会话 + DM 断言 + relationKey 参数）
```

---

### Task 1: permissions 小修（`"/"` 全盘 + trim）

**Files:**
- Modify: `src/domain/permissions.ts`
- Test: `tests/domain/permissions.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `readPermissionPaths` / `matchesPermission` / `isWriteAllowedByPermission`（签名不变，语义扩展）

- [ ] **Step 1: 写失败测试**

在 `tests/domain/permissions.test.ts` 的 `describe("matchesPermission", ...)` 内追加：

```ts
  it("条目 \"/\" = 授权全盘", () => {
    expect(matchesPermission(["/"], "/whatever", "/etc/passwd")).toBe(true);
    expect(matchesPermission(["/"], "/whatever", "/")).toBe(true);
  });
```

在 `describe("readPermissionPaths", ...)` 内追加：

```ts
  it("条目两端空白 trim（D12）", () => {
    const f = path.join(root, "spaced.json");
    write(f, JSON.stringify([" ./data ", "./x "]));
    expect(readPermissionPaths(f)).toEqual(["./data", "./x"]);
  });
```

并在 `describe("matchesPermission", ...)` 内追加（trim 后仍按目录子树命中）：

```ts
  it("trim 后的相对条目按目录子树命中", () => {
    expect(matchesPermission([" ./data "], dir, "/company/agents/alice/data/a.md")).toBe(true);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/domain/permissions.test.ts`
Expected: FAIL（`["/"]` 不命中 `/etc/passwd`；`" ./data "` 未 trim）。

- [ ] **Step 3: 实现**

`src/domain/permissions.ts`：

1. `readPermissionPaths` 末尾返回改为 trim：

```ts
    return (parsed as string[]).filter((entry) => entry.trim() !== "").map((entry) => entry.trim());
```

2. `matchesPermission` 判定改为处理文件系统根：

```ts
export function matchesPermission(patterns: string[], permissionDir: string, targetAbs: string): boolean {
  return patterns.some((pattern) => {
    const base = path.resolve(permissionDir, pattern);
    const root = path.parse(base).root;
    return targetAbs === base || targetAbs.startsWith(base === root ? root : base + path.sep);
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/domain/permissions.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/domain/permissions.ts tests/domain/permissions.test.ts
git commit -m "feat(domain): permission.json 条目 \"/\" 授权全盘 + 两端 trim"
```

---

### Task 2: 私聊一致性断言（speaker.id 统一）

**Files:**
- Modify: `src/app/conversations.ts`（`specFor` 增断言）
- Test: `tests/app/conversations.test.ts`

**Interfaces:**
- Consumes: `Relation`、`Employee`
- Produces: 行为变更——DM 且 `speaker.id !== relation.employeeId` 时抛 `Error`

- [ ] **Step 1: 写失败测试**

在 `tests/app/conversations.test.ts` 内追加（并确保顶部有 `import type { HarnessPort } from "../../src/harness/port.ts";`）：

```ts
  it("私聊发言人与关系不一致时报错（不静默挂错权限文件）", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    const ws = createWorkspace(root);
    const stub = {} as HarnessPort;
    await expect(
      newSession(ws, stub, { kind: "dm", employeeId: "alice" }, "bob"),
    ).rejects.toThrow("不一致");
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/app/conversations.test.ts`
Expected: FAIL（当前不报错，`startSession` 会在空 stub 上抛别的错误——断言 `toThrow("不一致")` 不成立）。

- [ ] **Step 3: 实现**

`src/app/conversations.ts` 的 `specFor` 开头加断言：

```ts
function specFor(ws: Workspace, relation: Relation, speaker: Employee): ConversationSpec {
  if (relation.kind === "dm" && speaker.id !== relation.employeeId) {
    throw new Error(`私聊关系与发言人不一致: ${relation.employeeId} ≠ ${speaker.id}`);
  }
  const cwd = relationCwd(ws, relation);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/app/conversations.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/app/conversations.ts tests/app/conversations.test.ts
git commit -m "feat(app): 私聊发言人与关系不一致时报错（speaker.id 统一）"
```

---

### Task 3: 群聊多会话（每成员一条、按需创建）

**Files:**
- Modify: `src/domain/paths.ts`（新增 `groupConversationIdsFile`）
- Modify: `src/domain/conversation-chain.ts`（`startNewSession` 自动建父目录）
- Modify: `src/app/conversations.ts`（`relationKey` 带成员；群聊链文件）
- Test: `tests/domain/paths.test.ts`、`tests/domain/conversation-chain.test.ts`、`tests/app/conversations.test.ts`

**Interfaces:**
- Consumes: `paths.ts`、`conversation-chain.ts`、Task 2 的 `specFor` 断言
- Produces:
  - `groupConversationIdsFile(ws: Workspace, name: string, agentId: string): string`
  - `relationKey(relation: Relation, speakerId: string): string`（**签名变更**：`dm:<员工>` / `group:<任务>:<成员>`）

- [ ] **Step 1: 写失败测试**

`tests/domain/paths.test.ts` 的 `describe("workspace paths", ...)` 内追加（并把 `groupConversationIdsFile` 加入顶部 import）：

```ts
  it("群聊链文件按成员落在 conversation_ids/ 子目录", () => {
    expect(groupConversationIdsFile(ws, "yt", "alice")).toBe(
      path.join("/tmp/company", "projects", "yt", "conversation_ids", "alice.md"),
    );
  });
```

`tests/domain/conversation-chain.test.ts` 内追加（新 describe 或现有 describe 内）：

```ts
describe("conversation chain · 嵌套目录", () => {
  it("父目录不存在时自动创建后落盘", () => {
    const nested = path.join(dir, "a", "b", "conversation_ids.md");
    startNewSession(nested, "1", "2026-10-16T10:00:00Z");
    expect(activeSession(nested)?.id).toBe("1");
  });
});
```

`tests/app/conversations.test.ts`：把既有断言 `relationKey({ kind: "dm", employeeId: "alice" })` 改为 `relationKey({ kind: "dm", employeeId: "alice" }, "alice")`；顶部 import 增补 `openGroup`；并追加：

```ts
  it("群聊：每成员一条会话、按需创建、各记各的链", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    const ws = createWorkspace(root);
    const harness = harnessWithFaux();
    await harness.open();
    try {
      const aliceConv = await openGroup(ws, harness, "yt", "alice");
      const aliceFile = path.join(root, "projects", "yt", "conversation_ids", "alice.md");
      const bobFile = path.join(root, "projects", "yt", "conversation_ids", "bob.md");
      expect(fs.existsSync(aliceFile)).toBe(true);
      expect(fs.existsSync(bobFile)).toBe(false);

      const bobConv = await openGroup(ws, harness, "yt", "bob");
      expect(bobConv).not.toBe(aliceConv);
      expect(await openGroup(ws, harness, "yt", "alice")).toBe(aliceConv);

      expect(readChain(aliceFile)).toHaveLength(1);
      expect(readChain(bobFile)).toHaveLength(1);
      expect(readChain(aliceFile)[0]!.id).toBe(aliceConv);
      expect(readChain(bobFile)[0]!.id).toBe(bobConv);
    } finally {
      await harness.close();
    }
  });

  it("群聊新开会话只影响该成员", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    const ws = createWorkspace(root);
    const harness = harnessWithFaux();
    await harness.open();
    try {
      const a1 = await openGroup(ws, harness, "yt", "alice");
      const b1 = await openGroup(ws, harness, "yt", "bob");
      const a2 = await newSession(ws, harness, { kind: "group", project: "yt" }, "alice");
      expect(a2).not.toBe(a1);
      const aliceFile = path.join(root, "projects", "yt", "conversation_ids", "alice.md");
      const bobFile = path.join(root, "projects", "yt", "conversation_ids", "bob.md");
      expect(readChain(aliceFile)).toHaveLength(2);
      expect(readChain(aliceFile)[0]!.ended).not.toBeNull();
      expect(readChain(aliceFile)[1]!.previous).toBe(a1);
      expect(readChain(bobFile)).toHaveLength(1);
      expect(readChain(bobFile)[0]!.id).toBe(b1);
    } finally {
      await harness.close();
    }
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/domain/paths.test.ts tests/domain/conversation-chain.test.ts tests/app/conversations.test.ts`
Expected: FAIL（`groupConversationIdsFile` 未导出；嵌套目录 ENOENT；`relationKey` 参数不符；群聊链写不进去）。

- [ ] **Step 3: 实现**

`src/domain/paths.ts` 追加：

```ts
export function groupConversationIdsFile(ws: Workspace, name: string, agentId: string): string {
  return path.join(projectDir(ws, name), "conversation_ids", `${agentId}.md`);
}
```

`src/domain/conversation-chain.ts`：顶部加 `import path from "node:path";`，并在 `startNewSession` 的 `fs.writeFileSync` 之前加：

```ts
  fs.mkdirSync(path.dirname(file), { recursive: true });
```

`src/app/conversations.ts`：

1. import 增补 `groupConversationIdsFile`：

```ts
import { conversationIdsFile, employeeDir, groupConversationIdsFile, projectDir, type Workspace } from "../domain/paths.ts";
```

2. `relationKey` 改为带成员：

```ts
export function relationKey(relation: Relation, speakerId: string): string {
  return relation.kind === "dm" ? `dm:${relation.employeeId}` : `group:${relation.project}:${speakerId}`;
}
```

3. 新增链文件选择（放在 `permissionFilesFor` 之后）：

```ts
function chainFileFor(ws: Workspace, relation: Relation, speakerId: string): string {
  return relation.kind === "dm"
    ? conversationIdsFile(ws, employeeDir(ws, relation.employeeId))
    : groupConversationIdsFile(ws, relation.project, speakerId);
}
```

4. `ensure` 与 `newSession` 改用它：

```ts
// ensure 内
  const file = chainFileFor(ws, relation, speakerId);
  ...
  if (active !== undefined && (await harness.attach(relationKey(relation, speakerId), active.id, spec))) {
  ...
  const convId = await harness.ensureActive(relationKey(relation, speakerId), spec);
  startNewSession(file, convId, new Date().toISOString());

// newSession 内
  const convId = await harness.startSession(relationKey(relation, speakerId), spec);
  startNewSession(chainFileFor(ws, relation, speakerId), convId, new Date().toISOString());
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/domain/paths.test.ts tests/domain/conversation-chain.test.ts tests/app/conversations.test.ts`
Expected: PASS。

- [ ] **Step 5: 全套测试 + 类型检查**

Run: `npm test && npm run typecheck`
Expected: 全 PASS，类型无误。

- [ ] **Step 6: 提交**

```bash
git add src/domain/paths.ts src/domain/conversation-chain.ts src/app/conversations.ts tests/domain/paths.test.ts tests/domain/conversation-chain.test.ts tests/app/conversations.test.ts
git commit -m "feat(app): 群聊多会话——每成员一条按需会话、各记各的链"
```

---

## 自检记录

- **Spec 覆盖**：架构 §4.2/§4.3（Task 3：每成员会话 + 按需 + 每成员链文件）· §5.1/§5.2（Task 3：会话按成员隔离，@谁动谁）· permissions D10（Task 1）· D11（Task 2）· D12（Task 1）。
- **占位符扫描**：无 TODO/TBD；所有步骤含可直接落地的代码。
- **类型一致性**：`groupConversationIdsFile(ws, name, agentId)`（Task 3 paths）被 `chainFileFor` 消费；`relationKey(relation, speakerId)` 签名变更在同一任务内更新全部调用点与测试。
- **Review Focus**：6 条均已钉住——按需创建(Task 3)、成员隔离(Task 3)、链父目录(Task 3)、`"/"`(Task 1)、trim/非字符串(Task 1)、DM 一致性(Task 2)。
- **不在本计划内（刻意）**：房间视图（各成员会话的合并）与 UI/服务层推流——属服务端那份计划；`planRouting` 的广播分发逻辑已满足"没 @ 全员各接一次"，不改。
