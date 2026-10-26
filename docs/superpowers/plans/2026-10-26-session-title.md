# 会话标题（自动命名 + 手动改名）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给每条会话引入标题：新建会话立即用当前时间命名，命名 agent 成功后走同一套会话重命名 API 改写；老板可在四处 UI 手动改名。

**Architecture:** 自有库改名 `openstaffs.sqlite` 并新增 `sessions` 表（`conv_id` / `title` / `title_source` / `updated_at`），标题的覆盖规则由 `title_source` 的条件 UPSERT 保证原子。命名 = 一次 `Models.completeSimple` 调用（system 只放 `src/prompts/naming.md`），不新开 Pi 会话。所有写入都经应用层 `renameSession`（写库 + 广播 SSE `session.title`）。

**Tech Stack:** Node ≥ 22.19 直接跑 TypeScript、`node:sqlite`（`DatabaseSync`）、`@earendil-works/pi-ai`（`Models.completeSimple` / `getSupportedThinkingLevels`）、vitest、原生 DOM 前端（`web/`，esbuild 打包）。

**Spec:** `docs/superpowers/specs/2026-10-26-session-title-design.md`

## Global Constraints

- 开发阶段：**不写任何兼容代码**。旧 `messages.sqlite` 不迁移、不读取（改名为 `openstaffs.sqlite` 后旧文件留在 `.data/` 里由老板自己删）。
- 服务端改动沿用现有分层：`src/domain`（纯域）→ `src/app`（编排）→ `src/server`（HTTP/SSE）→ `web`（视图）。`src/app` 不得 import `http`。
- 命名失败**一律不重试**：超时 `20_000` ms；失败只保留 `fallback` 时间标题 + 一条 `console.warn`。
- 标题**必须单行**，长度 ≤ 40 字（手动改名）/ ≤ 20 字（自动命名清洗后）。
- 命名标题**不进入模型上下文**（只存库、只展示），不得改动会话 instructions 装配。
- 注释与文档一律中文；提交信息 `<type>(<scope>): <中文描述>`。
- 每完成一个 Task 跑一次 `npm test` 相关用例 + `npm run typecheck`，全绿再提交。

## Review Focus

- 命名模型被配成**思考模型**（如 `anthropic/claude-*`）或**模型目录查不到**（未知 id / 供应商没配密钥）时，必须判为「自动命名不可用」并 `console.warn`，不能真的发请求。
- 首条消息**超长**（几万字的粘贴）必须截断到 500 字再喂命名模型。
- 命名返回**脏输出**（多行、包着 `「」`、只回一句 `标题：xxx`、纯空）必须被 `cleanTitle` 收拾干净；收拾完为空 = 失败，保留时间标题。
- 老板手动改名后，飞行中的自动命名结果**不得覆盖**（条件 UPSERT 保证）。
- 群聊一条消息 @ 两位成员 → 两条会话各自独立命名，一条失败不影响另一条。
- 本次改动之前就存在的会话（库里没有 `sessions` 行）→ 所有取标题的接口与 UI 都不能 500、不能显示 `undefined`。
- 命名在途时进程重启 / 中断 → 标题停在时间标题，不报错、不重试。

---

### Task 1: 自有库改名 + `sessions` 表

**Files:**
- Modify: `src/domain/paths.ts`（`messagesDbFile` → `officeDbFile`，文件名 `openstaffs.sqlite`）
- Modify: `src/store/messages.ts`（建 `sessions` 表 + 三个方法）
- Modify: `src/server/main.ts`（`messagesDbFile(ws)` → `officeDbFile(ws)`）
- Modify: `tests/tools/registry.test.ts`、`tests/app/conversations.test.ts`、`tests/app/permission-flow.test.ts`、`tests/server/http.test.ts`、`tests/server/store-wiring.test.ts`、`tests/server/pump-trigger.test.ts`、`tests/server/main-bad-store.test.ts`（凡 import `messagesDbFile` 者一律改名为 `officeDbFile`）
- Test: `tests/store/messages.test.ts`、`tests/store/sessions.test.ts`（新建）

**Interfaces:**
- Produces（后续所有 Task 依赖，签名照抄）：
  ```ts
  // src/store/messages.ts
  export type TitleSource = "fallback" | "auto" | "manual";
  export type SessionMeta = { convId: string; title: string; titleSource: TitleSource; updatedAt: string };
  // MessageStore 新增三个方法（同一个 db handle）：
  sessionOf(convId: string): SessionMeta | undefined;
  sessionsOf(convIds: readonly string[]): Map<string, SessionMeta>;
  /** 条件写入：manual 恒覆盖；fallback / auto 只在行不存在或现状为 fallback 时覆盖。返回落库后的实际值。 */
  setTitle(convId: string, title: string, source: TitleSource): SessionMeta;
  ```
  ```ts
  // src/domain/paths.ts
  export function officeDbFile(ws: Workspace): string; // <root>/openstaffs/.data/openstaffs.sqlite
  ```

- [ ] **Step 1: 改路径函数（先让 import 断掉，确认波及面）**

`src/domain/paths.ts`：把 `messagesDbFile` 改名为 `officeDbFile`，文件名常量化：

```ts
/** 自有库（消息流水 + 会话元数据）：`openstaffs/.data/openstaffs.sqlite`。 */
export function officeDbFile(ws: Workspace): string {
  return path.join(stateDir(ws), "openstaffs.sqlite");
}
```

Run: `npx tsc --noEmit`
Expected: FAIL，报所有 `messagesDbFile` 引用处（main.ts 与若干测试）。

- [ ] **Step 2: 把所有调用点改名**

`src/server/main.ts` 与上面列出的测试文件：`messagesDbFile` → `officeDbFile`（只改名字，不动别的）。
`tests/app/send.test.ts` 里自建的 `m.db`、`tests/store/messages.test.ts` 里的 `messages.sqlite` 文件名改成 `openstaffs.sqlite`（只是测试临时文件名，保持一致）。

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: 写失败测试（新表 + 覆盖规则）**

新建 `tests/store/sessions.test.ts`：

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { openMessageStore, type MessageStore } from "../../src/store/messages.ts";

let dir: string;
let store: MessageStore;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "os-sess-"));
  store = openMessageStore(path.join(dir, "openstaffs.sqlite"));
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

test("没有标题时 sessionOf 返回 undefined；sessionsOf 跳过不存在的 id", () => {
  expect(store.sessionOf("conv_x")).toBeUndefined();
  expect(store.sessionsOf(["conv_x"]).size).toBe(0);
});

test("setTitle 落库并原样返回；sessionsOf 批量取", () => {
  store.setTitle("conv_a", "10-26 15:32", "fallback");
  store.setTitle("conv_b", "改过的名字", "manual");
  const map = store.sessionsOf(["conv_a", "conv_b", "conv_missing"]);
  expect(map.get("conv_a")?.title).toBe("10-26 15:32");
  expect(map.get("conv_a")?.titleSource).toBe("fallback");
  expect(map.get("conv_b")?.titleSource).toBe("manual");
  expect(map.has("conv_missing")).toBe(false);
});

test("auto 覆盖 fallback；auto 不覆盖 manual；manual 覆盖一切", () => {
  store.setTitle("conv_a", "10-26 15:32", "fallback");
  expect(store.setTitle("conv_a", "自动名字", "auto").title).toBe("自动名字");
  expect(store.setTitle("conv_a", "手改的名字", "manual").title).toBe("手改的名字");
  // 关键：飞行中的自动命名结果不得覆盖手动改名
  expect(store.setTitle("conv_a", "迟到的自动名字", "auto").title).toBe("手改的名字");
  expect(store.sessionOf("conv_a")?.titleSource).toBe("manual");
});

test("fallback 也只覆盖 fallback（不覆盖 auto / manual）", () => {
  store.setTitle("conv_a", "自动名字", "auto");
  expect(store.setTitle("conv_a", "10-26 16:00", "fallback").title).toBe("自动名字");
});
```

- [ ] **Step 4: 跑测试确认失败**

Run: `npx vitest run tests/store/sessions.test.ts`
Expected: FAIL（`store.setTitle is not a function`）

- [ ] **Step 5: 实现表与方法**

`src/store/messages.ts`：`openMessageStore` 的 `db.exec` 里追加建表（与 `messages` 表并列）：

```sql
CREATE TABLE IF NOT EXISTS sessions (
  conv_id      TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  title_source TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
```

准备语句：

```ts
const upsertTitle = db.prepare(`
  INSERT INTO sessions (conv_id, title, title_source, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(conv_id) DO UPDATE SET
    title = excluded.title,
    title_source = excluded.title_source,
    updated_at = excluded.updated_at
  WHERE excluded.title_source = 'manual' OR sessions.title_source = 'fallback'
`);
const selectTitle = db.prepare("SELECT * FROM sessions WHERE conv_id = ?");
```

`setTitle` 的实现顺序：先 `upsertTitle.run(convId, title, source, new Date().toISOString())`，再 `selectTitle.get(convId)` 读回落库后的**实际**值（未覆盖时返回旧值——这是函数的契约，调用方据此知道「没盖掉手动改名」）。
`stats` 行类型 `{ conv_id: string; title: string; title_source: string; updated_at: string }` → `SessionMeta` 的映射写成一个 `toSessionMeta` 小函数（上界：`title_source` 按 `TitleSource` 断言）。

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run tests/store tests/app tests/server && npx tsc --noEmit`
Expected: 全 PASS

- [ ] **Step 7: Commit**

```bash
git add -A src/domain/paths.ts src/store/messages.ts src/server/main.ts tests/
git commit -m "feat(store): 自有库改名 openstaffs.sqlite 并新增 sessions 表"
```

---

### Task 2: 空间配置 `namingModel`

**Files:**
- Modify: `src/config/schema.ts`
- Test: `tests/config/schema.test.ts`

**Interfaces:**
- Produces: `ConfigFields.namingModel?: string`（仅空间层有意义；其余层解析但不用）

- [ ] **Step 1: 写失败测试**

`tests/config/schema.test.ts` 追加：

```ts
test("namingModel：字符串解析进 fields；非字符串记 issue 并忽略；空串忽略", () => {
  expect(parseConfigFields({ namingModel: "opencode-go/deepseek-v4.1-flash" }).fields.namingModel)
    .toBe("opencode-go/deepseek-v4.1-flash");
  expect(parseConfigFields({ namingModel: "" }).fields.namingModel).toBeUndefined();
  const bad = parseConfigFields({ namingModel: 42 });
  expect(bad.fields.namingModel).toBeUndefined();
  expect(bad.issues.some((issue) => issue.includes("namingModel"))).toBe(true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/config/schema.test.ts -t namingModel`
Expected: FAIL

- [ ] **Step 3: 实现**

`ConfigFields` 加 `namingModel?: string;`（放在 `thinkingLevel` 之后，注释：`/** 空间层专用：自动命名会话用的模型（必须是非思考模型）；未指定 = 自动命名不可用。 */`）。
`parseConfigFields` 里按现有 `model` 的写法补：

```ts
const namingModel = text(raw["namingModel"]);
if (namingModel !== undefined) fields.namingModel = namingModel;
else if (raw["namingModel"] !== undefined) issues.push("namingModel 必须是非空字符串（已忽略）");
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/config && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config/schema.ts tests/config/schema.test.ts
git commit -m "feat(config): 空间配置支持 namingModel 字段"
```

---

### Task 3: 命名 prompt + `createNamer`

**Files:**
- Create: `src/prompts/naming.md`
- Modify: `src/capabilities/system-prompt.ts`（模板表加 `naming`）
- Create: `src/app/naming.ts`
- Test: `tests/app/naming.test.ts`（新建）

**Interfaces:**
- Consumes: `SYSTEM_PROMPT_TEMPLATES.naming`（`src/capabilities/system-prompt.ts`）；`parseModelRef`（`src/domain/config.ts`）
- Produces:
  ```ts
  // src/app/naming.ts
  export const NAMING_INPUT_MAX = 500;      // 首条消息截断（字符）
  export const NAMING_TITLE_MAX = 20;       // 清洗后标题上限（字符）
  export const NAMING_TIMEOUT_MS = 20_000;
  export type Namer = (firstMessage: string) => Promise<string | undefined>; // undefined = 失败/不可用
  export function cleanTitle(raw: string): string;                            // "" = 不可用
  export function createNamer(options: { models: Models; namingModel?: string }): Namer | undefined;
  ```

- [ ] **Step 1: 写 prompt 模板**

`src/prompts/naming.md`（全文，纯文本，不做变量渲染）：

```markdown
你在给一场人机对话起标题。

用户会给你这场对话的第一条消息。你的工作只有一件：用一句话概括「这场对话在说什么」。

规则：
- 输出**只有标题本身**，不要解释、不要引号、不要「标题：」这样的前缀、不要结尾标点。
- 用中文，动宾短语或名词短语，**不超过 20 个字**。
- 不要复述原文的口水词（「帮我」「麻烦」），抓真正的事由。
- 看不出具体事由（例如只有一句问候）时，就概括意图本身，别编内容。
```

- [ ] **Step 2: 模板进系统 prompt 表**

`src/capabilities/system-prompt.ts`：`SystemPromptName` 联合类型加 `"naming"`，模板表里补 `naming: loadTemplate("naming")`。`renderSystemPrompt` 不动（只拼 `environment` + `dm`/`group`）。

- [ ] **Step 3: 写失败测试**

新建 `tests/app/naming.test.ts`：

```ts
import { describe, expect, test } from "vitest";
import type { Models } from "@earendil-works/pi-ai/models";
import { cleanTitle, createNamer, NAMING_INPUT_MAX } from "../../src/app/naming.ts";

/** 假 Models：getModel 给假模型对象（带 reasoning / thinkingLevelMap），completeSimple 不打网络。 */
function fakeModels(options: {
  model?: object | undefined;
  reply?: { text?: string; stopReason?: string; throw?: boolean };
  seen?: { systemPrompt?: string; user?: string }[];
}): Models {
  const model = options.model ?? { id: "m", provider: "faux", api: "openai-completions", reasoning: false };
  return {
    getModel: () => (model === undefined ? undefined : model),
    completeSimple: async (_m: unknown, context: { systemPrompt?: string; messages: { content: string }[] }) => {
      options.seen?.push({ systemPrompt: context.systemPrompt, user: String(context.messages[0]?.content) });
      const reply = options.reply ?? {};
      if (reply.throw === true) throw new Error("boom");
      return { role: "assistant", content: [{ type: "text", text: reply.text ?? "标题" }], stopReason: reply.stopReason ?? "stop" };
    },
  } as unknown as Models;
}
```

「非思考模型」的判定不依赖 pi-ai 的 `getSupportedThinkingLevels`（它会去模型目录查，测试里没法喂假模型），改由 `naming.ts` 内部私有函数 `thinkingLevelsOf(model)` 从模型的 `reasoning` / `thinkingLevelMap` 推——规则与 pi-ai 一致：`reasoning !== true` → 只有 `["off"]`。所以测试可以直接喂假模型对象。

用例（每条一个 `test`）：
1. `cleanTitle("「帮我修复登录 Bug。」")` → `"帮我修复登录 Bug"`（去包裹符号 + 去结尾句号）
2. `cleanTitle("标题：部署流程梳理\n第二行")` → `"部署流程梳理"`（第一行 + 去前缀）
3. `cleanTitle("   ")` → `""`
4. `[...cleanTitle("很长".repeat(40))].length <= 20`（含省略号）
5. 非思考模型（`reasoning: false`）→ `createNamer` 返回函数；调用后拿到 `"标题"`，且 `seen[0].systemPrompt` 含命名 prompt 正文（如「起标题」）
6. `namingModel: undefined` → `undefined`（未指定）
7. `namingModel: "not-a-ref"` → `undefined`（格式非法）
8. `model: undefined`（目录查不到）→ `undefined`（fail closed）
9. `model: { ...base, reasoning: true, thinkingLevelMap: { off: null, low: "low" } }` → `undefined`（是思考模型）
10. `reply: { throw: true }` → `undefined`；`reply: { stopReason: "aborted" }` → `undefined`；`reply: { text: "  " }` → `undefined`
11. 传入 10 万字符时 `seen[0].user.length === NAMING_INPUT_MAX`（截断）

- [ ] **Step 4: 跑测试确认失败**

Run: `npx vitest run tests/app/naming.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 5: 实现 `src/app/naming.ts`**

要点（签名与数值都在上面 Interfaces / 测试里，实现照办）：
- `cleanTitle`：切 `\n` 取第一条非空 → 去 `标题:` / `标题：` / `title:` 前缀（大小写不敏感）→ 去包裹的 `「」『』""''《》` → 连续空白折叠成单个空格 → 去结尾的 `。，,.;；!！` → `[...text]` 截断到 `NAMING_TITLE_MAX`（超出时前 19 个字符 + `…`）→ trim。
- `thinkingLevelsOf(model)`（私有，不导出）：`model.reasoning === true` 时返回 `Object.keys(model.thinkingLevelMap ?? { off: null, low: "low", medium: "medium", high: "high" })`，否则返回 `["off"]`；判定「非思考」= 结果恰好 `["off"]`。
- `createNamer`：`namingModel` 缺失 / `parseModelRef` 失败 / `models.getModel` 查不到 / `thinkingLevelsOf` 不是恰好 `["off"]` → `console.warn("[openstaffs] 自动命名不可用：…")` 并返回 `undefined`；否则返回 `async (firstMessage) => { ... }`：
  - 入参截断到 `NAMING_INPUT_MAX`；
  - `Promise.race` 一个 `NAMING_TIMEOUT_MS` 的定时器（超时返回 `undefined`，定时器 `unref()` 由 race 包住即可）；
  - 调用 `models.completeSimple(model, { systemPrompt: SYSTEM_PROMPT_TEMPLATES.naming, messages: [{ role: "user", content: text, timestamp: Date.now() }] })`；
  - `stopReason !== "stop"` → 失败；取 `content` 里第一个 `type === "text"` 块的 `text` 交给 `cleanTitle`；空 → 失败；
  - 任何 `throw` / 超时 → `console.warn` 一条（带原因）+ 返回 `undefined`（**不重试**）。

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run tests/app/naming.test.ts tests/capabilities/system-prompt.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/prompts/naming.md src/capabilities/system-prompt.ts src/app/naming.ts tests/app/naming.test.ts
git commit -m "feat(naming): 会话命名 prompt 与命名模型闸门"
```

---

### Task 4: `openDm` / `openGroup` / `newSession` 返回 `created`

**Files:**
- Modify: `src/app/conversations.ts:116-160`（`ensure` / 三个导出函数）
- Modify: `src/app/send.ts:100-112`、`src/tools/registry.ts:172-210`
- Test: `tests/app/conversations.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/app/conversations.ts —— 三个函数的返回值统一改形状
  export type OpenResult = { convId: string; created: boolean };
  export function openDm(...): Promise<OpenResult>;
  export function openGroup(...): Promise<OpenResult>;
  export function newSession(...): Promise<OpenResult>;   // created 恒为 true
  ```

- [ ] **Step 1: 写失败测试**

`tests/app/conversations.test.ts` 追加：

```ts
it("openDm：首次建会话 created=true；复用同一条活跃会话 created=false；newSession 恒 true", async () => {
  seedOffice(root, { agents: [{ id: "alice", model: "faux/faux-model" }] });
  const first = await openDm(ws, port, "alice");
  expect(first.created).toBe(true);
  const again = await openDm(ws, port, "alice");
  expect(again.created).toBe(false);
  expect(again.convId).toBe(first.convId);
  const fresh = await newSession(ws, port, { kind: "dm", employeeId: "alice" }, "alice");
  expect(fresh.created).toBe(true);
  expect(fresh.convId).not.toBe(first.convId);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/app/conversations.test.ts -t "created"`
Expected: FAIL（`first.created` 为 undefined）

- [ ] **Step 3: 实现**

`ensure` 里：`attach` 成功 → `{ convId: active.id, created: false }`；否则 `startSession` 后 `{ convId, created: true }`。三个导出函数透传这个对象。
`src/app/send.ts` 与 `src/tools/registry.ts` 的调用点：`const { convId } = await openDm(...)`（或 `const opened = ...; opened.convId`），行为不变。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test && npx tsc --noEmit`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/conversations.ts src/app/send.ts src/tools/registry.ts tests/app/conversations.test.ts
git commit -m "refactor(session): openDm/openGroup/newSession 返回 created 标志"
```

---

### Task 5: 应用层 `src/app/sessions.ts` + SSE `session.title`

**Files:**
- Create: `src/app/sessions.ts`
- Modify: `src/server/sse.ts`（`ServerEvent` 加一支）
- Test: `tests/app/sessions.test.ts`（新建）

**Interfaces:**
- Consumes: `MessageStore.setTitle` / `sessionOf`（Task 1）、`Namer`（Task 3）、`TitleSource`（Task 1）
- Produces:
  ```ts
  // src/app/sessions.ts
  export type TitleEvent = { roomKey: string; convId: string; title: string };
  export type SessionTitleDeps = {
    store: Pick<MessageStore, "setTitle" | "sessionOf">;
    notify?: (event: TitleEvent) => void;
    namer?: Namer;
  };
  export function fallbackTitle(now: Date): string;   // 'MM-DD HH:mm'（本地时区，补零）
  export function renameSession(
    deps: SessionTitleDeps, roomKey: string, convId: string, title: string, source: TitleSource,
  ): SessionMeta;                                     // 写库 + notify
  export function nameNewSession(
    deps: SessionTitleDeps, roomKey: string, convId: string, firstMessage: string,
  ): void;                                            // 先 fallback 再后台命名
  ```
  ```ts
  // src/server/sse.ts
  | { type: "session.title"; roomKey: string; convId: string; title: string }
  ```

- [ ] **Step 1: 写失败测试**

新建 `tests/app/sessions.test.ts`（用真的 `openMessageStore` 临时库，`namer` 用假函数）：

```ts
test("nameNewSession 先落时间标题并广播；命名成功后改成 auto 并再广播一次", async () => {
  const events: TitleEvent[] = [];
  const deps = { store, notify: (event: TitleEvent) => events.push(event), namer: async () => "修复登录 Bug" };
  nameNewSession(deps, "dm:alice", "conv_a", "帮我看看登录为什么 500");
  // 同步部分：fallback 已落库并广播（不 await）
  expect(store.sessionOf("conv_a")?.titleSource).toBe("fallback");
  expect(events).toHaveLength(1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(store.sessionOf("conv_a")?.title).toBe("修复登录 Bug");
  expect(store.sessionOf("conv_a")?.titleSource).toBe("auto");
  expect(events).toHaveLength(2);
});

test("命名失败（undefined）只留 fallback；没有 namer 时不发请求", async () => {
  const deps = { store, notify: () => {}, namer: async () => undefined };
  nameNewSession(deps, "dm:alice", "conv_b", "你好");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(store.sessionOf("conv_b")?.titleSource).toBe("fallback");
});

test("手动改名后再来的自动结果不覆盖（nameNewSession 迟到不生效）", async () => {
  let release: (value: string | undefined) => void = () => {};
  const deps = { store, notify: () => {}, namer: () => new Promise<string | undefined>((resolve) => { release = resolve; }) };
  nameNewSession(deps, "dm:alice", "conv_c", "整理周报");
  renameSession(deps, "dm:alice", "conv_c", "我自己的名字", "manual");
  release("自动名字");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(store.sessionOf("conv_c")?.title).toBe("我自己的名字");
});

test("fallbackTitle 形如 10-26 15:32（补零、本地时区）", () => {
  expect(fallbackTitle(new Date(2026, 9, 26, 5, 7))).toBe("10-26 05:07");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/app/sessions.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

- `fallbackTitle`：`MM-DD HH:mm`，月/日/时/分全部 `padStart(2, "0")`。
- `renameSession`：`const meta = deps.store.setTitle(convId, title, source); deps.notify?.({ roomKey, convId, title: meta.title }); return meta;`（广播**落库后的实际值**，未覆盖时前端仍显示正确标题）。
- `nameNewSession`：`renameSession(deps, roomKey, convId, fallbackTitle(new Date()), "fallback")`；若 `deps.namer` 存在则 `void deps.namer(firstMessage).then((title) => { if (title !== undefined && title !== "") renameSession(deps, roomKey, convId, title, "auto"); })`（`.then` 内不 catch 也行——`createNamer` 自己吞错，但保险起见补 `.catch(() => undefined)`）。
- `src/server/sse.ts` 的 `ServerEvent` 加 `session.title` 一支（客户端事件类型列表在 Task 9 处理）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/app/sessions.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/sessions.ts src/server/sse.ts tests/app/sessions.test.ts
git commit -m "feat(session): 会话标题写入通道与 session.title 事件"
```

---

### Task 6: 发送链路接线（新会话即命名）

**Files:**
- Modify: `src/app/send.ts`（`sendToRoom` 的 options 与投递循环）
- Modify: `src/server/http.ts`（`ServerDeps` 加 `titles?: SessionTitleDeps`，POST messages 时传给 `sendToRoom`）
- Modify: `src/server/main.ts`（启动时建 namer，注入 `titles`）
- Test: `tests/app/send.test.ts`、`tests/server/http.test.ts`

**Interfaces:**
- Consumes: `SessionTitleDeps` / `nameNewSession`（Task 5）、`OpenResult.created`（Task 4）、`createNamer`（Task 3）、`loadSpaceConfig`（`src/config/load.ts`）
- Produces: `sendToRoom(..., options.titles?: SessionTitleDeps)`

- [ ] **Step 1: 写失败测试**

`tests/app/send.test.ts` 追加（`FakePort` 已有 `startSession` → `conv-N`）：

```ts
it("新会话的第一条消息命名：落 fallback 标题、调一次 namer；复用旧会话不命名", async () => {
  seedEmployee("alice");
  const store = tempStore();
  const named: { convId: string; text: string }[] = [];
  const titles = { store, notify: () => {}, namer: async (text: string) => { named.push({ convId: "?", text }); return "登录排查"; } };
  const port = new FakePort();
  await sendToRoom(ws, port, { kind: "dm", employeeId: "alice" }, "帮我看看登录", { queue: new KeyedQueue(), store, titles });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(named.map((item) => item.text)).toEqual(["帮我看看登录"]);
  expect(store.sessionOf("conv-1")?.title).toBe("登录排查");
  // 第二条消息复用同一会话 → 不再命名
  await sendToRoom(ws, port, { kind: "dm", employeeId: "alice" }, "继续", { queue: new KeyedQueue(), store, titles });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(named).toHaveLength(1);
});

it("群聊一条消息 @ 两人 → 两条会话各自命名", async () => {
  // seedGroup("seo", ["alice", "bob"])；正文 "@alice @bob 看下这个"
  // 断言 store 里两条 conv 都有 fallback 标题，且 namer 被调用两次
});

it("没有 titles 依赖时行为不变（不落标题、不报错）", async () => {
  // 传 options 不带 titles → sendToRoom 正常返回 deliveries
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/app/send.test.ts -t 命名`
Expected: FAIL（`sessionOf` 为空 / namer 没被调用）

- [ ] **Step 3: 实现**

`send.ts`：
- options 类型加 `titles?: SessionTitleDeps`。
- 投递循环里把 `openDm/openGroup/newSession` 的返回值解构为 `{ convId, created }`（Task 4 已改形状）。
- `harness.submit` 之后：`if (created && options.titles !== undefined) options.titles !== undefined` → 调 `nameNewSession(options.titles, roomKeyOf(relation), convId, target.body)`。`roomKeyOf(relation)` 私有帮助函数：`relation.kind === "dm" ? \`dm:${relation.employeeId}\` : \`group:${relation.project}\``（**注意** 不是 `relationKey`——那个带成员 id）。
- 位置放在 `submit` 之后、`return` 之前，**不 await** 命名。

`http.ts`：`ServerDeps` 加 `titles?: SessionTitleDeps`；POST messages 调 `sendToRoom` 时 `...(deps.titles === undefined ? {} : { titles: deps.titles })`。

`main.ts`（harness 建好之后、`createHttpServer` 之前）：
```ts
const spaceConfig = loadSpaceConfig(ws);
const namer = models === undefined ? undefined : createNamer({ models, ...(spaceConfig?.fields.namingModel === undefined ? {} : { namingModel: spaceConfig.fields.namingModel }) });
const titles: SessionTitleDeps = {
  store,
  notify: (event) => hub.broadcast({ type: "session.title", ...event }),
  ...(namer === undefined ? {} : { namer }),
};
```
（`models` 目前在 `if (config !== undefined)` 块里是局部变量——把它提到该块外能访问的位置，或用 `let namer` 在块内赋值、块外使用。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test && npx tsc --noEmit`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/send.ts src/server/http.ts src/server/main.ts tests/app/send.test.ts tests/server/http.test.ts
git commit -m "feat(session): 新会话首条消息触发自动命名"
```

---

### Task 7: HTTP —— 四处 GET 带标题 + PATCH 改名

**Files:**
- Modify: `src/server/http.ts`（`/api/rooms/:key/sessions`、`/sessions/info`、`/api/employees/:id/sessions`、`/sessions/:convId/context`，新增 PATCH）
- Modify: `src/app/conversations.ts`（`RoomSessionInfo` 加 `title?: string`；`roomSessionInfo` 填标题）
- Test: `tests/server/http.test.ts`

**Interfaces:**
- Consumes: `SessionTitleDeps.renameSession`（Task 5）、`MessageStore.sessionsOf` / `sessionOf`（Task 1）、`findSessionOwner`（已有）
- Produces:
  - `RoomSessionInfo` 增 `title?: string`
  - `PATCH /api/rooms/:key/sessions/:convId/title` body `{ title }` → 200 `{ convId, title, titleSource: "manual" }`；400（空 / > 40 字 / JSON 坏）；404（房间或会话不存在）

- [ ] **Step 1: 写失败测试**

`tests/server/http.test.ts` 追加：
1. `GET /api/rooms/dm:alice/sessions`：先 `store.setTitle("conv-1", "登录排查", "auto")`，断言返回行 `title === "登录排查"`；**没有标题的会话** 行里 `title` 为 `undefined`（不出现 `"undefined"` 字符串、不 500）。
2. `GET /api/rooms/dm:alice/sessions/info`：同上断言 `sessions[0].title`。
3. `PATCH .../title`：body `{ title: "  周报整理 " }` → 200，`store.sessionOf` 得到 `"周报整理"` + `titleSource === "manual"`。
4. 400：`{ title: "" }`、`{ title: "字".repeat(41) }`。
5. 404：convId 不属于该房间（如 `conv_nope`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/server/http.test.ts -t 标题`
Expected: FAIL

- [ ] **Step 3: 实现**

- `roomSessionInfo(ws, harness, relation, store?)`：加第 4 个可选参数 `store`（`Pick<MessageStore,"sessionsOf">`），一次性 `sessionsOf(活跃 convId 列表)`，命中则填 `title`。`http.ts` 调用处传 `deps.store`。
- `GET /api/rooms/:key/sessions`：`sessionChains` 之后对所有 `row.id` 调一次 `deps.store.sessionsOf(...)`，每行补 `...(meta === undefined ? {} : { title: meta.title, titleSource: meta.titleSource })`。
- `handleEmployees` 的两处：`out.push` 时按 `deps.store.sessionOf(session.convId)` 补 `title`；context 端点同样补 `title`。
- 新端点（照 `pin` 分支的写法放在 `handleRooms` 里，`rest` 形状为 `["sessions", convId, "title"]` + `method === "PATCH"`）：
  - 解析 body `title` 为 string → `trim()`；空或 `[...title].length > 40` → 400。
  - `findSessionOwner(deps.ws, relation, convId) === undefined` → 404 `{ error: "会话不存在" }`。
  - `deps.titles === undefined` → 503 `{ error: "会话标题未启用" }`。
  - 成功：`const meta = renameSession(deps.titles, roomKey, convId, title, "manual")` → `json(res, 200, { convId, title: meta.title, titleSource: meta.titleSource })`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test && npx tsc --noEmit`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/http.ts src/app/conversations.ts tests/server/http.test.ts
git commit -m "feat(api): 会话标题随会话下发，新增改名端点"
```

---

### Task 8: 前端展示（四处）

**Files:**
- Modify: `web/api.ts`（类型加 `title?: string`；新增 `renameSession(roomKey, convId, title)`）
- Modify: `web/state.ts`（`UiEvent` 加 `title`；`reduce` 与 `reduceSse` 处理）
- Modify: `web/render.ts`（chat 顶部私聊 chip、会话信息条、会话详情头部）
- Modify: `web/main.ts`（历史列表行显示标题）
- Test: `tests/web/render.test.ts`、`tests/web/state.test.ts`、`tests/web/api.test.ts`

**Interfaces:**
- Consumes: `RoomSessionInfo.title`（Task 7）、`ChainRow.title` / `EmployeeSession.title`（Task 7 的响应）
- Produces:
  ```ts
  // web/api.ts
  export type ChainRow = { id: string; started: string; ended: string | null; previous: string | null; title?: string; titleSource?: string };
  export type EmployeeSession = { /* 原有字段 */ title?: string };
  // api 增加：
  renameSession(roomKey: string, convId: string, title: string): Promise<{ convId: string; title: string; titleSource: string }>;
  ```
  ```ts
  // web/state.ts
  | { type: "title"; roomKey: string; convId: string; title: string }   // 原地改 state.sessions 里的标题
  ```

- [ ] **Step 1: 写失败测试**

`tests/web/render.test.ts`：
1. 私聊 + `state.sessions = [{ convId: "c1", memberId: "alice", title: "登录排查", … }]` → `chatHtml` 输出包含 `data-rename-conv="c1"` 与 `登录排查`。
2. 群聊（`roomKey = "group:seo"`）→ `chatHtml` **不**包含 `data-rename-conv`；`sessionInfoHtml` 同时包含成员名与 `登录排查`，且带 `data-rename-conv`。
3. `sessionInfoHtml` 在 `title` 缺省时渲染 `未命名` 占位（不出现 `undefined`）。
4. 会话详情：`sessionPanelHtml` 传入带 `title` 的 context → 头部含标题与 `data-rename-conv`。

`tests/web/state.test.ts`：
5. `reduce(state, { type: "title", roomKey: "dm:alice", convId: "c1", title: "X" })` 改到 `sessions[0].title`；房间不匹配时返回同一引用。
6. `reduce` 收到 `{ type: "sse", event: { type: "session.title", roomKey, convId, title } }` 同样生效。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/web/render.test.ts tests/web/state.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

- `web/render.ts` 加一个共用小函数：
  ```ts
  /** 标题按钮（点击进入原地改名）；`title` 缺省时显示「未命名」占位。 */
  function titleHtml(convId: string, title: string | undefined, className: string): string
  ```
  输出 `<button type="button" class="session-title ${className}" data-rename-conv="${convId}" title="点击改名">${title ?? "未命名"}</button>`。
- `chatHtml`：私聊且 `state.sessions[0]` 存在 → 房间名后追加 `titleHtml(state.sessions[0].convId, state.sessions[0].title, "chat-title")`。
- `sessionInfoHtml`：每条 meta 最前面插标题（群聊仍是 `标题 · 成员 · 模型 …`）。
- `contextBodyHtml`：头部第一行前插 `titleHtml(context.convId, context.title, "detail-title")`。
- `web/main.ts` 的 `openHistory`：行文案改成 `标题 · 成员 · 时间（进行中）`，行尾加 `<button data-rename-conv="…">改名</button>`＋在 `data-conv` 绑定的循环里给 `data-rename-conv` 也绑事件（Task 9 接交互，本 Task 只保证渲染）。
- `web/state.ts`：`title` 分支只改匹配 `convId` 的那条 `sessions`；未命中返回原 state。
- `web/api.ts`：`asChainRow` 等读取处补可选字段；新增 `renameSession` 用 `PATCH`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/web && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/ tests/web/
git commit -m "feat(web): 会话标题在聊天顶部/信息条/历史/详情展示"
```

---

### Task 9: 前端改名交互 + SSE 刷新

**Files:**
- Modify: `web/main.ts`（标题点击 → 原地输入框；Enter 保存 / Esc 取消 / 失焦保存；失败提示；SSE 处理）
- Modify: `web/sse.ts`（`EVENT_TYPES` 加 `"session.title"`）
- Modify: `web/styles.css`（`.session-title` / 标题输入框样式）
- Test: `tests/web/render.test.ts`（如拆出了纯函数）、`tests/web/sse.test.ts`

**Interfaces:**
- Consumes: `api.renameSession`（Task 8）、`dispatch({ type: "title" })`（Task 8）

- [ ] **Step 1: 写失败测试**

`tests/web/sse.test.ts`：断言 `EVENT_TYPES`（或 `connectEvents` 注册的监听名）包含 `"session.title"`。

`tests/web/render.test.ts`：断言改名输入框的渲染函数（若独立成 `titleEditorHtml(convId, title)`）输出 `<input class="session-title-input"` 并预填 `value`（把输入框渲染抽成纯函数，便于测）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/web/sse.test.ts tests/web/render.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

- `web/sse.ts`：`EVENT_TYPES` 加 `"session.title"`。
- `web/main.ts`：
  - `bindTitles()`：给所有 `[data-rename-conv]` 绑定点击 → 把该按钮替换成输入框（`document.createElement("input")`，预填当前标题，`select()`）；Enter / 失焦 → `api.renameSession(state.roomKey, convId, value)`；成功后 `dispatch({ type: "title", … })` + `renderAll()`；失败 → 在按钮旁插一条 `<span class="title-error">`（输入框保留，不丢字）；Esc → `renderAll()` 复原。
  - 在 `renderAll()`（或各视图渲染完）后统一调 `bindTitles()`；`openHistory` / 详情 / chat 三处都要绑。
  - SSE：`onEvent` 里 `event.type === "session.title"` → `dispatch({ type: "sse", event })`；若当前正开着历史面板，再 `void openHistory()` 重取。
- `web/styles.css`：`.session-title`（无边框、悬停显示下划线）、`.session-title-input`（就地输入框，宽 `12em`）、`.title-error`（红字小号）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/web && npm run typecheck && npm run build:web`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/ tests/web/
git commit -m "feat(web): 会话标题原地改名与实时刷新"
```

---

### Task 10: 文档同步 + 全量验证

**Files:**
- Modify: `src/skills/openstaffs-ops/SKILL.md`
- Modify: `src/skills/openstaffs/SKILL.md`
- Modify: `TODO.md`
- Modify: `README.md`（如提到 `.data/messages.sqlite` 或「自有消息库」）
- Modify: `docs/产品规划.md`（如列表里提到会话 / 消息能力）

- [ ] **Step 1: 同步 `openstaffs-ops/SKILL.md`**

- 「统一配置」字段表（四类同构那张）加一行：`namingModel? | string | 自动命名会话用的模型（**仅空间层有意义**）；必须是**非思考模型**（不支持思考档），否则自动命名不可用；未指定 = 自动命名不可用。改完**重启服务**生效。` 同时修正「`model` 仅员工层有意义」那句的例外说明。
- 「办公空间全景」与 `openstaffs/.data/` 目录说明：`messages.sqlite` → `openstaffs.sqlite`（「自有库：消息流水 + 会话元数据 `sessions` 表」）。
- 「改动生效方式」表：把 `namingModel` 归到「启动初始化 = 重启」。
- 需要时在「常见故障对照」补一行：「自动命名不生效 / 标题全是时间」→ 检查 `space.config.json` 的 `namingModel` 是否为**非思考模型**、供应商是否已配密钥、是否已重启。

- [ ] **Step 2: 同步 `openstaffs/SKILL.md`**

在会话相关能力处补一小节：会话有**标题**（新建即按时间命名；自动命名成功会改写；老板可在聊天顶部 / 信息条 / 历史 / 详情手动改名）；**员工没有改标题的工具，也不要臆造**（改标题是老板的 UI 操作）。

- [ ] **Step 3: 同步 `TODO.md` 与 README / 产品规划**

- `TODO.md`「已定口径」补一条：「会话标题存自有库 `sessions` 表，不进 `conversation_ids.md`（那是会话状态机）；写入只有一条通道 `app/sessions.ts` 的 `renameSession`」。
- `README.md` / `docs/产品规划.md`：`grep -n "messages.sqlite\|自有消息库"` 命中的位置改成 `openstaffs.sqlite`。

- [ ] **Step 4: 全量验证**

Run: `npm run typecheck && npm test && npm run build:web`
Expected: 全 PASS（记录 vitest 的通过数）

- [ ] **Step 5: 实跑验证（本地空间）**

在 `/Users/laidezhong/Desktop/code/OpenStaffs_WorkSpace`：
1. 在 `openstaffs/space.config.json` 加 `"namingModel": "<非思考模型>"`；
2. 重启服务（`npm start`），日志里**没有**「自动命名不可用」告警；
3. 新开一条私聊发一句话 → 标题先显时间、几秒内变成命名结果；「历史」里同一标题；会话详情头部一致；
4. 手动改一个名字，随后再新开会话确认自动命名不会盖掉它；
5. 故意把 `namingModel` 改成思考模型重启 → 日志出现「自动命名不可用」，标题停在时间标题。

- [ ] **Step 6: Commit**

```bash
git add src/skills TODO.md README.md docs/
git commit -m "docs: 同步会话标题与 namingModel 的运维与能力说明"
```
