# OpenStaffs 服务端与 Web UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把已完工的引擎装成可用产品：本地 HTTP 服务 + SSE 推流 + 极简 Web UI（列表 / 聊天 / 新开会话 / 未读 / 回看），所有配置走文件。

**Architecture:** 单进程 Node 服务。HarnessPort 演进为"会话即快照"：`startSession`（创建事务内原子固化 instructions/model/cwd）、`attach`（只注册 access，绝不重配置）、`submit`（不等回答）、`watch`（归一化事件流）。应用层新增房间合并（读侧）、未读水印、发送编排（fire-and-forget + per-key 队列）。服务端 `http` / `sse` / `pump` 三层。前端 vanilla TS + esbuild。

**Tech Stack:** TypeScript（Node ≥ 22.19，ESM，import 带 `.ts` 后缀）· vitest + faux provider（不需要 API key）· esbuild（唯一新 devDependency）· `@earendil-works/pi-durable@1.3.0` / `pi-ai@1.3.0` / `chord@1.3.0`（版本锁定）

**Spec:** `docs/superpowers/specs/2026-10-16-openstaffs-server-ui-design.md`（执行前先通读；本计划实现其 D1–D15 决策）

## Global Constraints

- Node ≥ 22.19（本机 v24）；TypeScript；ESM（`"type": "module"`）；相对 import 一律带 `.ts` 后缀（现有风格）。
- 基座版本锁定（见上）；**任何签名不符一律以 `node_modules/**/*.d.ts` 为准，只改适配层（`src/harness/`），不改域层**。
- 新增依赖仅 `esbuild`（devDependency，用于打包前端）；**无其它新增依赖**。
- 测试全走 vitest + faux provider；验证命令 `npm test && npm run typecheck`，两者都要绿。
- 错误信息/提示文案用中文（与现有风格一致）。
- **apiKey 永不回显、永不落日志**；`.openstaffs/config.json` 由老板手工维护（服务端只读）。
- git：不要 `git pull`；远程名是 `github`；开发分支不 push；完成后 squash 合回 master。
- **计划有错就记 Ruling**（原因 + 偏差 + 采用方案，写入计划文件末尾"执行日志"），不要偷偷偏离。

## Review Focus

以下 5 类输入/失败模式是 spec 隐含但最容易咬人的，各任务必须测试覆盖：

1. **未配置 / 坏 config.json**：所有 API 应返回 409 或引导页，不崩、不回显 apiKey（Task 8 测）。
2. **群成员为空 / 只 @老板**：不丢消息不错崩——空成员群 400，只 @老板返回 202+空 deliveries（Task 7、Task 9 测）。
3. **会话中改档案文件**（profile.md / MEMORY.md / 技能）：已开会话不受影响（快照），新开会话生效（Task 6 测）。
4. **慢 SSE 客户端**：不阻塞 agent、不阻塞其它客户端；delta 可丢、权威消息不丢（Task 10 测）。
5. **员工 config.json 坏 / 未配模型**：列表不崩、模型兜底全局、无模型时给出明确失败而非静默（Task 8、Task 6 测）。

## 执行注意

- 在本地分支执行（建议 `feat/server-ui`），每个任务一个 commit；**不 push 分支**；全部完成后 squash 合回 master 再 push。
- 噪声大的测试输出重定向到文件只读尾部（如 `npm test > /tmp/test.log 2>&1; tail -30 /tmp/test.log`）。
- 每步"Run … Expected: …"都要真跑真读；与预期不符时先查原因再继续。

## File Structure

| 路径 | 动作 | 职责 |
|---|---|---|
| `src/domain/config.ts` | 新增 | config.json 读取容错、默认端口、员工模型兜底 |
| `src/domain/employee.ts` | 追加 | `listEmployees` |
| `src/domain/project.ts` | 追加 | `loadProject` / `listProjects` |
| `src/harness/port.ts` | 改造 | 新接口：startSession/attach/submit/watch/send/transcript + ChatMessage(带 kind/data) |
| `src/harness/pi-durable.ts` | 改造 | 新接口实现（创建即固化、watchEvents 映射） |
| `src/app/conversations.ts` | 改造 | accessFor、快照清单、ensure 拆分、defaults 兜底、sessionChains/activeMemberSessions/roomTranscripts |
| `src/app/rooms.ts` | 新增 | RoomMessage、normalizeChatMessage、mergeRoomMessages、countUnread、roomKeyOf/parseRoomKey |
| `src/app/unread.ts` | 重写 | SeenState（state.json 读写）、markSeen、unreadCounts；删除 unreadForBoss |
| `src/app/send.ts` | 新增 | KeyedQueue、EmptyGroupError、sendToRoom |
| `src/server/models.ts` | 新增 | 从 config 构造 Models（CredentialStore 注入 apiKey） |
| `src/server/http.ts` | 新增 | createHttpServer：路由、API、静态、409 门卫 |
| `src/server/sse.ts` | 新增 | SseHub（客户端管理、背压） |
| `src/server/pump.ts` | 新增 | 订阅活跃会话 → 归一化 → SSE 广播 + 未读重算 |
| `src/server/main.ts` | 新增 | 入口：config → models → harness → pump → http |
| `web/index.html` `web/styles.css` | 新增 | 页面与样式 |
| `web/main.ts` | 新增 | bootstrap 与接线 |
| `web/state.ts` | 新增 | 纯状态归约 reduce / selectView |
| `web/render.ts` | 新增 | 纯渲染函数（字符串） |
| `web/api.ts` | 新增 | fetch 封装 |
| `web/sse.ts` | 新增 | EventSource 封装 |
| `scripts/build-web.mjs` | 新增 | esbuild 打包 + 拷贝到 public/ |
| `README.md` | 新增 | 手动配置指南 + 手动验收清单 |
| `public/` | 忽略 | 构建产物（进 .gitignore） |

---

### Task 1: 全局配置（domain/config.ts）

**Files:**
- Create: `src/domain/config.ts`
- Test: `tests/domain/config.test.ts`

**Interfaces:**
- Consumes: `src/domain/paths.ts` 的 `stateDir` / `Workspace`；`src/domain/types.ts` 的 `ModelChoice`。
- Produces（后续任务依赖）:
  - `type WorkspaceConfig = { provider: string; apiKey: string; modelId: string; port: number }`
  - `const DEFAULT_PORT = 4319`
  - `configFile(ws: Workspace): string`
  - `readConfig(ws: Workspace): WorkspaceConfig | undefined`
  - `type ModelRefLike = { provider: string; modelId: string }`
  - `resolveEmployeeModel(global: ModelRefLike, employee: ModelChoice): ModelRefLike`

- [ ] **Step 1: 写失败测试**

创建 `tests/domain/config.test.ts`：

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { DEFAULT_PORT, configFile, readConfig, resolveEmployeeModel } from "../../src/domain/config.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-config-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("全局配置", () => {
  it("缺失/坏 JSON/缺字段/空串 → undefined（未配置，不崩）", () => {
    const ws = createWorkspace(root);
    expect(readConfig(ws)).toBeUndefined();
    fs.mkdirSync(path.join(root, ".openstaffs"), { recursive: true });
    fs.writeFileSync(configFile(ws), "{坏");
    expect(readConfig(ws)).toBeUndefined();
    fs.writeFileSync(configFile(ws), JSON.stringify({ provider: "opencode-go", apiKey: "k" }));
    expect(readConfig(ws)).toBeUndefined();
    fs.writeFileSync(configFile(ws), JSON.stringify({ provider: "  ", apiKey: "k", modelId: "m" }));
    expect(readConfig(ws)).toBeUndefined();
  });

  it("读全配置；port 缺省/非法一律回落 4319", () => {
    const ws = createWorkspace(root);
    fs.mkdirSync(path.join(root, ".openstaffs"), { recursive: true });
    fs.writeFileSync(configFile(ws), JSON.stringify({ provider: "opencode-go", apiKey: "k", modelId: "m" }));
    expect(readConfig(ws)).toEqual({ provider: "opencode-go", apiKey: "k", modelId: "m", port: DEFAULT_PORT });
    fs.writeFileSync(configFile(ws), JSON.stringify({ provider: "opencode-go", apiKey: "k", modelId: "m", port: -1 }));
    expect(readConfig(ws)?.port).toBe(DEFAULT_PORT);
    fs.writeFileSync(configFile(ws), JSON.stringify({ provider: "opencode-go", apiKey: "k", modelId: "m", port: 5000 }));
    expect(readConfig(ws)?.port).toBe(5000);
  });

  it("员工模型兜底：provider+modelId 成对填写才生效，否则整体用全局", () => {
    const global = { provider: "opencode-go", modelId: "global-model" };
    expect(resolveEmployeeModel(global, { provider: "faux", modelId: "f" })).toEqual({ provider: "faux", modelId: "f" });
    expect(resolveEmployeeModel(global, { provider: "", modelId: "" })).toEqual(global);
    expect(resolveEmployeeModel(global, { provider: "faux", modelId: "" })).toEqual(global);
    expect(resolveEmployeeModel(global, { provider: "faux", modelId: "f", thinkingLevel: "high" })).toEqual({
      provider: "faux", modelId: "f", thinkingLevel: "high",
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/domain/config.test.ts`
Expected: FAIL —— 找不到模块 `src/domain/config.ts`。

- [ ] **Step 3: 实现 `src/domain/config.ts`**

```ts
import fs from "node:fs";
import path from "node:path";
import { stateDir, type Workspace } from "./paths.ts";
import type { ModelChoice } from "./types.ts";

export type WorkspaceConfig = {
  provider: string;
  apiKey: string;
  modelId: string;
  port: number;
};

/** 默认端口（config.json 未给 port 时）。 */
export const DEFAULT_PORT = 4319;

export function configFile(ws: Workspace): string {
  return path.join(stateDir(ws), "config.json");
}

function requiredString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** 读取全局配置；缺失/坏 JSON/必需字段缺失 → undefined（未配置模式）。 */
export function readConfig(ws: Workspace): WorkspaceConfig | undefined {
  let raw = "";
  try {
    raw = fs.readFileSync(configFile(ws), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const provider = requiredString(parsed.provider);
    const apiKey = requiredString(parsed.apiKey);
    const modelId = requiredString(parsed.modelId);
    if (provider === undefined || apiKey === undefined || modelId === undefined) return undefined;
    const port =
      typeof parsed.port === "number" && Number.isInteger(parsed.port) && parsed.port > 0 && parsed.port < 65536
        ? parsed.port
        : DEFAULT_PORT;
    return { provider, apiKey, modelId, port };
  } catch {
    return undefined;
  }
}

export type ModelRefLike = { provider: string; modelId: string };

/** 员工模型兜底：员工 provider+modelId 成对非空则用员工的，否则整体用全局；thinkingLevel 独立保留。 */
export function resolveEmployeeModel(global: ModelRefLike, employee: ModelChoice): ModelChoice & ModelRefLike {
  const thinking = employee.thinkingLevel === undefined ? {} : { thinkingLevel: employee.thinkingLevel };
  const provider = employee.provider.trim();
  const modelId = employee.modelId.trim();
  if (provider !== "" && modelId !== "") return { provider, modelId, ...thinking };
  return { provider: global.provider, modelId: global.modelId, ...thinking };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/domain/config.test.ts`
Expected: PASS（3 个用例全绿）。

- [ ] **Step 5: 全量验证 + 提交**

Run: `npm test && npm run typecheck`
Expected: 全绿（现有 80 个用例 + 新增 3 个）。

```bash
git add src/domain/config.ts tests/domain/config.test.ts
git commit -m "feat(server): 全局配置读取（容错、默认端口、员工模型兜底）"
```

---

### Task 2: HarnessPort 生命周期改造（会话即快照）

**Files:**
- Modify: `src/harness/port.ts`（整体替换接口）
- Modify: `src/harness/pi-durable.ts`（startSession/attach/transcript 实现；移除 ensureActive/旧 attach）
- Modify: `src/app/conversations.ts`（`accessFor` 抽出；`ensure`/`newSession` 适配新接口）
- Test: `tests/harness/pi-durable.test.ts`（改造）、`tests/app/conversations.test.ts`（不改也应通过——签名兼容）

**Interfaces:**
- Consumes: `AccessContext`（`src/domain/access-control.ts`）；Pi 的 `createConversation({ ownership, agent })`、`conversation(id)`、`viewState(ctx)`。
- Produces（后续任务依赖）:
  - `type ChatMessage = { id: string; role: "user" | "assistant"; text: string; kind?: string; data?: unknown }`
  - `type ConversationSpec = { cwd; instructions; model; thinkingLevel?; access }`（不变）
  - `HarnessPort = { open, close, startSession(spec), attach(convId, access), send(convId, text), transcript(convId) }`（本任务版；submit/watch 在 Task 5 加入）
  - `conversations.accessFor(ws, relation, speaker): AccessContext`
  - 私有 `specFor` 内联 `accessFor`；`openDm/openGroup/newSession` 签名不变。

- [ ] **Step 1: 写失败测试（改造 `tests/harness/pi-durable.test.ts`）**

把整个文件替换为下述内容（保留既有覆盖，适配新接口，新增固化/attach 断言）：

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { afterEach, describe, expect, it } from "vitest";
import { createPiHarness } from "../../src/harness/pi-durable.ts";
import type { ConversationSpec } from "../../src/harness/port.ts";
import type { AccessContext } from "../../src/domain/access-control.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-harness-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function spec(cwd: string): ConversationSpec {
  return {
    cwd,
    instructions: "你是测试员工。",
    model: { provider: "faux", modelId: "faux-model" },
    access: { root, cwd, selfId: "alice", memberProjects: [], permissionFiles: [] },
  };
}

function access(cwd: string): AccessContext {
  return { root, cwd, selfId: "alice", memberProjects: [], permissionFiles: [] };
}

function fauxModels(responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]) {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, faux };
}

/** 从请求上下文里提取全部 system 文本（faux 响应工厂用）。 */
function systemTextOf(messages: readonly { role: string; content: unknown }[]): string {
  return messages
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("waitFor 超时");
}

describe("Pi Durable HarnessPort", () => {
  it("能开一条会话、发消息、拿回答、读回 transcript", async () => {
    const { models } = fauxModels([fauxAssistantMessage("你好，我是 alice。")]);
    const harness = createPiHarness({ root, sqlitePath: path.join(root, ".openstaffs", "state.sqlite"), models });
    await harness.open();
    try {
      const cwd = path.join(root, "agents", "alice");
      fs.mkdirSync(cwd, { recursive: true });
      const convId = await harness.startSession(spec(cwd));
      const reply = await harness.send(convId, "你是谁？");
      expect(reply.role).toBe("assistant");
      expect(reply.text).toContain("alice");
      const history = await harness.transcript(convId);
      expect(history.some((m) => m.role === "user" && m.text === "你是谁？")).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("startSession 把 instructions/model 固化进会话（请求上下文可见），attach 只读回不改配置", async () => {
    let seenSystem = "";
    const { models } = fauxModels([
      (context: { messages: readonly { role: string; content: unknown }[] }) => {
        seenSystem = systemTextOf(context.messages);
        return fauxAssistantMessage("ok");
      },
    ]);
    const harness = createPiHarness({ root, sqlitePath: path.join(root, ".openstaffs", "state.sqlite"), models });
    await harness.open();
    try {
      const cwd = path.join(root, "agents", "alice");
      fs.mkdirSync(cwd, { recursive: true });
      const convId = await harness.startSession(spec(cwd));
      expect(await harness.attach(convId, access(cwd))).toBe(true);
      await harness.send(convId, "你好");
      expect(seenSystem).toContain("你是测试员工。");

      const other = createPiHarness({ root, sqlitePath: path.join(root, ".openstaffs", "state2.sqlite"), models });
      await other.open();
      try {
        expect(await other.attach(convId, access(cwd))).toBe(false);
      } finally {
        await other.close();
      }
    } finally {
      await harness.close();
    }
  });

  it("transcript 只含员工/老板发言（带 kind），不把工具结果当发言", async () => {
    const { models } = fauxModels([
      fauxAssistantMessage(fauxToolCall("write", { path: "note.md", content: "hi" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("完成"),
    ]);
    const harness = createPiHarness({ root, sqlitePath: path.join(root, ".openstaffs", "state.sqlite"), models });
    await harness.open();
    try {
      const cwd = path.join(root, "agents", "alice");
      fs.mkdirSync(cwd, { recursive: true });
      const convId = await harness.startSession(spec(cwd));
      await harness.send(convId, "写 note.md");
      const history = await harness.transcript(convId);
      expect(history.some((m) => m.text.includes("Successfully wrote"))).toBe(false);
      const user = history.find((m) => m.role === "user");
      expect(user?.text).toBe("写 note.md");
      expect(user?.kind).toBe("pi.user");
      expect(history.some((m) => m.role === "assistant" && m.text === "完成")).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("连续两次 send：消息不丢不重、按序", async () => {
    const { models } = fauxModels([fauxAssistantMessage("答一"), fauxAssistantMessage("答二")]);
    const harness = createPiHarness({ root, sqlitePath: path.join(root, ".openstaffs", "state.sqlite"), models });
    await harness.open();
    try {
      const cwd = path.join(root, "agents", "alice");
      fs.mkdirSync(cwd, { recursive: true });
      const convId = await harness.startSession(spec(cwd));
      await harness.send(convId, "问一");
      await harness.send(convId, "问二");
      const history = await harness.transcript(convId);
      expect(history.filter((m) => m.role === "user").map((m) => m.text)).toEqual(["问一", "问二"]);
      expect(history.filter((m) => m.role === "assistant").map((m) => m.text)).toEqual(["答一", "答二"]);
    } finally {
      await harness.close();
    }
  });

  it("send 在提交未完成时抛错，而非伪造员工发言", async () => {
    const { models } = fauxModels([fauxAssistantMessage("unused")]);
    const harness = createPiHarness({ root, sqlitePath: path.join(root, ".openstaffs", "state.sqlite"), models });
    await harness.open();
    try {
      const cwd = path.join(root, "agents", "nobody");
      fs.mkdirSync(cwd, { recursive: true });
      const empty: ConversationSpec = {
        cwd,
        instructions: "无模型员工。",
        model: { provider: "", modelId: "" },
        access: access(cwd),
      };
      const convId = await harness.startSession(empty);
      await expect(harness.send(convId, "在吗")).rejects.toThrow();
    } finally {
      await harness.close();
    }
  });
});
```

（`waitFor` 本任务暂未用到，保留给 Task 5 使用；若 lint 报未使用，先忽略——测试文件无该检查。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/harness/pi-durable.test.ts`
Expected: FAIL —— `startSession` 不存在（`ensureActive` 才存在）。

- [ ] **Step 3: 替换 `src/harness/port.ts`**

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
  /** Pi entry kind（如 pi.user / pi.assistant / chat.message）。 */
  kind?: string;
  /** entry data（如 { author: "boss", roomMessageId }）。 */
  data?: unknown;
};

export interface HarnessPort {
  open(): Promise<void>;
  close(): Promise<void>;
  /** 新建会话：spec 在创建事务内原子固化（快照）。返回 convId。 */
  startSession(spec: ConversationSpec): Promise<string>;
  /** 读回既有会话并注册 access（绝不重配置）；不存在返回 false。 */
  attach(convId: string, access: AccessContext): Promise<boolean>;
  /** 阻塞发送（测试与非流式场景）；编排走 submit + watch（Task 5）。 */
  send(convId: string, text: string): Promise<ChatMessage>;
  transcript(convId: string): Promise<ChatMessage[]>;
}
```

- [ ] **Step 4: 改 `src/harness/pi-durable.ts`**

改动点（其余保持不变）：
1. import 行去掉 `UserEntry`（`AssistantEntry` 仍需用于 `send` 里的读取）；新增无。
2. 删除 `ensureActive`、旧 `attach(key, convId, spec)`；新增：

```ts
    async startSession(spec) {
      const conv = await harness!.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: {
            model: spec.model,
            ...(spec.thinkingLevel === undefined ? {} : { thinkingLevel: spec.thinkingLevel as never }),
            instructions: spec.instructions,
            cwd: spec.cwd,
          },
        },
        ctx,
      );
      accessByConv.set(String(conv.id), spec.access);
      return String(conv.id);
    },
    async attach(convId, access) {
      const found = await harness!.conversation(convId as unknown as ConversationId, ctx);
      if (!found) return false;
      accessByConv.set(String(found.id), access);
      return true;
    },
```

3. `transcript` 改为按 `entry.model` 首条消息的 role 过滤（不再依赖 UserEntry/AssistantEntry），并带上 `kind`/`data`：

```ts
    async transcript(convId) {
      const conv = await conversation(convId as unknown as ConversationId);
      const view = await conv.viewState(ctx);
      const messages: ChatMessage[] = [];
      for (const entry of view.value.entries) {
        for (const message of entry.model ?? []) {
          const role = (message as { role?: unknown }).role;
          if (role !== "user" && role !== "assistant") continue;
          const body = textOf(message);
          if (body === "") continue;
          messages.push({
            id: String(entry.id),
            role,
            text: body,
            kind: entry.kind,
            ...(entry.data === undefined ? {} : { data: entry.data }),
          });
        }
      }
      return messages;
    },
```

注意：`entry.kind` 类型是 `string`、`entry.data` 是 `JsonValue | undefined`，赋给 `kind?: string` / `data?: unknown` 直接兼容。

- [ ] **Step 5: 改 `src/app/conversations.ts`（accessFor 抽出 + ensure/newSession 适配）**

关键改动：

```ts
/** 只计算 access 上下文（实时读 members.md；不读 profile/记忆）。 */
export function accessFor(ws: Workspace, relation: Relation, speaker: Employee): AccessContext {
  const cwd = relationCwd(ws, relation);
  return {
    root: ws.root,
    cwd,
    selfId: speaker.id,
    memberProjects: projectsOf(ws, speaker.id),
    permissionFiles: permissionFilesFor(ws, relation, speaker),
  };
}

function specFor(ws: Workspace, relation: Relation, speaker: Employee): ConversationSpec {
  if (relation.kind === "dm" && speaker.id !== relation.employeeId) {
    throw new Error(`私聊关系与发言人不一致: ${relation.employeeId} ≠ ${speaker.id}`);
  }
  const cwd = relationCwd(ws, relation);
  return {
    cwd,
    instructions: instructionsFor(ws, relation, speaker),
    model: { provider: speaker.model.provider, modelId: speaker.model.modelId },
    ...(speaker.model.thinkingLevel === undefined ? {} : { thinkingLevel: speaker.model.thinkingLevel }),
    access: accessFor(ws, relation, speaker),
  };
}

async function ensure(ws: Workspace, harness: HarnessPort, relation: Relation, speakerId: string): Promise<string> {
  const speaker = loadEmployee(ws, speakerId);
  const file = chainFileFor(ws, relation, speakerId);
  const active = activeSession(file);
  if (active !== undefined && (await harness.attach(active.id, accessFor(ws, relation, speaker)))) {
    return active.id;
  }
  const convId = await harness.startSession(specFor(ws, relation, speaker));
  startNewSession(file, convId, new Date().toISOString());
  return convId;
}
```

`newSession` 保持原对外行为（`startSession` + 链文件记录）：

```ts
export async function newSession(ws: Workspace, harness: HarnessPort, relation: Relation, speakerId: string): Promise<string> {
  const speaker = loadEmployee(ws, speakerId);
  const convId = await harness.startSession(specFor(ws, relation, speaker));
  startNewSession(chainFileFor(ws, relation, speakerId), convId, new Date().toISOString());
  return convId;
}
```

需要补 import：`type AccessContext`（`../domain/access-control.ts`）。删除不再使用的 import 如果有。

- [ ] **Step 6: 跑全部测试**

Run: `npm test && npm run typecheck`
Expected: 全绿。注意 `tests/app/conversations.test.ts` 应无需修改（openDm/openGroup/newSession 对外签名未变；行为从"ensureActive/attach 重配置"变为"attach 只注册"，测试断言都是链文件与 convId 关系，不受影响）。

- [ ] **Step 7: 提交**

```bash
git add src/harness/port.ts src/harness/pi-durable.ts src/app/conversations.ts tests/harness/pi-durable.test.ts
git commit -m "feat(server): HarnessPort 会话即快照——startSession 原子固化、attach 不重配置"
```

---

### Task 3: 房间合并视图（app/rooms.ts）

**Files:**
- Create: `src/app/rooms.ts`
- Test: `tests/app/rooms.test.ts`

**Interfaces:**
- Consumes: `ChatMessage`（`src/harness/port.ts`）；`Relation` 类型（`src/app/conversations.ts`，type-only import）。
- Produces（后续任务依赖）:
  - `type RoomSpeaker = { kind: "boss" } | { kind: "employee"; id: string; alias?: string }`
  - `type RoomMessage = { convId; entryId; roomKey; speaker; text; roomMessageId? }`
  - `type MemberTranscript = { memberId: string; alias?: string; convId: string; messages: ChatMessage[] }`
  - `roomKeyOf(relation): string` / `parseRoomKey(key): Relation | undefined`
  - `normalizeChatMessage(roomKey, member, chat): RoomMessage | undefined`
  - `mergeRoomMessages(roomKey, members): RoomMessage[]`
  - `countUnread(messages, watermark: number | undefined): number`

- [ ] **Step 1: 写失败测试（`tests/app/rooms.test.ts`）**

```ts
import { describe, expect, it } from "vitest";
import { countUnread, mergeRoomMessages, normalizeChatMessage, parseRoomKey, roomKeyOf, type MemberTranscript } from "../../src/app/rooms.ts";
import type { ChatMessage } from "../../src/harness/port.ts";

function chat(id: string, role: "user" | "assistant", text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role, text, ...extra };
}

describe("房间合并视图", () => {
  it("roomKeyOf / parseRoomKey 往返与非法键", () => {
    expect(roomKeyOf({ kind: "dm", employeeId: "alice" })).toBe("dm:alice");
    expect(roomKeyOf({ kind: "group", project: "demo" })).toBe("group:demo");
    expect(parseRoomKey("dm:alice")).toEqual({ kind: "dm", employeeId: "alice" });
    expect(parseRoomKey("group:demo")).toEqual({ kind: "group", project: "demo" });
    expect(parseRoomKey("dm:")).toBeUndefined();
    expect(parseRoomKey("bogus")).toBeUndefined();
  });

  it("按 entryId 数值升序合并各成员会话", () => {
    const members: MemberTranscript[] = [
      {
        memberId: "bob", convId: "c2",
        messages: [chat("20", "assistant", "bob 答")],
      },
      {
        memberId: "alice", alias: "Alice", convId: "c1",
        messages: [
          chat("10", "user", "任务", { kind: "chat.message", data: { author: "boss", roomMessageId: "rm_1" } }),
          chat("30", "assistant", "alice 答"),
        ],
      },
    ];
    const merged = mergeRoomMessages("group:demo", members);
    expect(merged.map((m) => m.entryId)).toEqual(["10", "20", "30"]);
    expect(merged[0]!.speaker).toEqual({ kind: "boss" });
    expect(merged[1]!.speaker).toEqual({ kind: "employee", id: "bob" });
    expect(merged[2]!.speaker).toEqual({ kind: "employee", id: "alice", alias: "Alice" });
  });

  it("老板广播消息按 roomMessageId 去重取最小 entryId；无 roomMessageId 的不去重", () => {
    const members: MemberTranscript[] = [
      { memberId: "alice", convId: "c1", messages: [chat("15", "user", "广播", { kind: "chat.message", data: { author: "boss", roomMessageId: "rm_x" } })] },
      { memberId: "bob", convId: "c2", messages: [chat("16", "user", "广播", { kind: "chat.message", data: { author: "boss", roomMessageId: "rm_x" } })] },
    ];
    const merged = mergeRoomMessages("group:demo", members);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.entryId).toBe("15");

    const plain = mergeRoomMessages("dm:alice", [
      { memberId: "alice", convId: "c1", messages: [chat("1", "user", "甲"), chat("2", "user", "乙")] },
    ]);
    expect(plain).toHaveLength(2);
  });

  it("countUnread：watermark 之后的员工消息计数，老板消息不计", () => {
    const members: MemberTranscript[] = [
      { memberId: "alice", convId: "c1", messages: [
        chat("5", "assistant", "旧回答"),
        chat("10", "user", "老板问", { kind: "chat.message", data: { author: "boss", roomMessageId: "rm_1" } }),
        chat("11", "assistant", "新回答"),
        chat("12", "assistant", "再答"),
      ] },
    ];
    const merged = mergeRoomMessages("dm:alice", members);
    expect(countUnread(merged, undefined)).toBe(3);
    expect(countUnread(merged, 10)).toBe(2);
    expect(countUnread(merged, 12)).toBe(0);
  });

  it("空输入、空会话不产生消息", () => {
    expect(mergeRoomMessages("dm:alice", [])).toEqual([]);
    expect(normalizeChatMessage("dm:alice", { memberId: "alice", convId: "c1", messages: [] }, chat("1", "assistant", ""))).toEqual({
      convId: "c1", entryId: "1", roomKey: "dm:alice", speaker: { kind: "employee", id: "alice" }, text: "",
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/app/rooms.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 `src/app/rooms.ts`**

```ts
import type { ChatMessage } from "../harness/port.ts";
import type { Relation } from "./conversations.ts";

export type RoomSpeaker = { kind: "boss" } | { kind: "employee"; id: string; alias?: string };

export type RoomMessage = {
  convId: string;
  entryId: string;
  roomKey: string;
  speaker: RoomSpeaker;
  text: string;
  /** 老板发言的房间级去重键（同一次发送的 N 份只有一份被保留）。 */
  roomMessageId?: string;
};

export type MemberTranscript = {
  memberId: string;
  alias?: string;
  convId: string;
  messages: ChatMessage[];
};

export function roomKeyOf(relation: Relation): string {
  return relation.kind === "dm" ? `dm:${relation.employeeId}` : `group:${relation.project}`;
}

export function parseRoomKey(key: string): Relation | undefined {
  if (key.startsWith("dm:") && key.length > "dm:".length) return { kind: "dm", employeeId: key.slice(3) };
  if (key.startsWith("group:") && key.length > "group:".length) return { kind: "group", project: key.slice(6) };
  return undefined;
}

function bossDataOf(chat: ChatMessage): { roomMessageId?: string } {
  const data = typeof chat.data === "object" && chat.data !== null ? (chat.data as Record<string, unknown>) : {};
  return typeof data.roomMessageId === "string" ? { roomMessageId: data.roomMessageId } : {};
}

/** 单条聊天消息 → 房间消息；user=老板、assistant=员工；其他 undefined。 */
export function normalizeChatMessage(roomKey: string, member: MemberTranscript, chat: ChatMessage): RoomMessage | undefined {
  if (chat.role === "user") {
    return {
      convId: member.convId,
      entryId: chat.id,
      roomKey,
      speaker: { kind: "boss" },
      text: chat.text,
      ...bossDataOf(chat),
    };
  }
  if (chat.role === "assistant") {
    return {
      convId: member.convId,
      entryId: chat.id,
      roomKey,
      speaker: { kind: "employee", id: member.memberId, ...(member.alias === undefined ? {} : { alias: member.alias }) },
      text: chat.text,
    };
  }
  return undefined;
}

/** 合并各成员活跃会话的 transcript：按 entryId 排序；老板消息按 roomMessageId 去重取最小 entryId。 */
export function mergeRoomMessages(roomKey: string, members: MemberTranscript[]): RoomMessage[] {
  const all: RoomMessage[] = [];
  for (const member of members) {
    for (const chat of member.messages) {
      const message = normalizeChatMessage(roomKey, member, chat);
      if (message !== undefined) all.push(message);
    }
  }
  const deduped = new Map<string, RoomMessage>();
  const plain: RoomMessage[] = [];
  for (const message of all) {
    if (message.roomMessageId === undefined) {
      plain.push(message);
      continue;
    }
    const existing = deduped.get(message.roomMessageId);
    if (existing === undefined || Number(message.entryId) < Number(existing.entryId)) {
      deduped.set(message.roomMessageId, message);
    }
  }
  return [...plain, ...deduped.values()].sort((a, b) => Number(a.entryId) - Number(b.entryId));
}

/** 未读数：entryId 严格大于 watermark 的员工消息。 */
export function countUnread(messages: RoomMessage[], watermark: number | undefined): number {
  const seen = watermark === undefined ? 0 : watermark;
  return messages.filter((m) => m.speaker.kind === "employee" && Number(m.entryId) > seen).length;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/app/rooms.test.ts`
Expected: PASS（5 个用例）。

- [ ] **Step 5: 全量验证 + 提交**

Run: `npm test && npm run typecheck`

```bash
git add src/app/rooms.ts tests/app/rooms.test.ts
git commit -m "feat(server): 房间合并视图（读侧合并、boss 消息去重、未读计数）"
```

---

### Task 4: 未读水印（app/unread.ts 重写）

**Files:**
- Modify: `src/app/unread.ts`（整体重写；删除 `unreadForBoss`）
- Modify: `tests/app/routing.test.ts`（删除 `unreadForBoss` 的 describe，仅保留 planRouting）
- Test: `tests/app/unread.test.ts`（新增）

**Interfaces:**
- Consumes: `countUnread`、`RoomMessage`（Task 3）；`stateDir`（domain/paths）。
- Produces（后续任务依赖）:
  - `type SeenState = { seen: Record<string, number> }`
  - `seenFile(ws): string` / `readSeen(ws): SeenState` / `markSeen(ws, roomKey, entryId): SeenState`
  - `unreadCounts(rooms: { key: string; messages: RoomMessage[] }[], seen: SeenState): { total: number; rooms: Record<string, number> }`

- [ ] **Step 1: 写失败测试（`tests/app/unread.test.ts`）**

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { markSeen, readSeen, seenFile, unreadCounts } from "../../src/app/unread.ts";
import type { RoomMessage } from "../../src/app/rooms.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-unread-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function msg(entryId: string, kind: "boss" | "employee", roomKey = "dm:alice"): RoomMessage {
  return kind === "boss"
    ? { convId: "c1", entryId, roomKey, speaker: { kind: "boss" }, text: "t", roomMessageId: `rm_${entryId}` }
    : { convId: "c1", entryId, roomKey, speaker: { kind: "employee", id: "alice" }, text: "t" };
}

describe("未读水印", () => {
  it("缺失/坏 JSON → 空状态；markSeen 原子写入并可读回", () => {
    const ws = createWorkspace(root);
    expect(readSeen(ws)).toEqual({ seen: {} });
    fs.mkdirSync(path.dirname(seenFile(ws)), { recursive: true });
    fs.writeFileSync(seenFile(ws), "{坏");
    expect(readSeen(ws)).toEqual({ seen: {} });
    markSeen(ws, "dm:alice", "42");
    expect(readSeen(ws)).toEqual({ seen: { "dm:alice": 42 } });
    expect(fs.existsSync(`${seenFile(ws)}.tmp`)).toBe(false);
  });

  it("watermark 单调不倒退", () => {
    const ws = createWorkspace(root);
    markSeen(ws, "dm:alice", "42");
    markSeen(ws, "dm:alice", "10");
    expect(readSeen(ws).seen["dm:alice"]).toBe(42);
  });

  it("unreadCounts 逐房间计数与总数", () => {
    const ws = createWorkspace(root);
    markSeen(ws, "dm:alice", "10");
    const counts = unreadCounts(
      [
        { key: "dm:alice", messages: [msg("9", "employee"), msg("10", "employee"), msg("11", "employee"), msg("12", "boss")] },
        { key: "group:demo", messages: [msg("20", "employee", "group:demo")] },
      ],
      readSeen(ws),
    );
    expect(counts.rooms).toEqual({ "dm:alice": 1, "group:demo": 1 });
    expect(counts.total).toBe(2);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/app/unread.test.ts`
Expected: FAIL —— `markSeen` 等不存在（旧文件只有 unreadForBoss）。

- [ ] **Step 3: 重写 `src/app/unread.ts`**

```ts
import fs from "node:fs";
import path from "node:path";
import { stateDir, type Workspace } from "../domain/paths.ts";
import { countUnread, type RoomMessage } from "./rooms.ts";

export type SeenState = { seen: Record<string, number> };

export function seenFile(ws: Workspace): string {
  return path.join(stateDir(ws), "state.json");
}

/** 读已读水印；缺失/坏 JSON → 空状态（丢失只导致未读重置，无资产损失）。 */
export function readSeen(ws: Workspace): SeenState {
  let raw = "";
  try {
    raw = fs.readFileSync(seenFile(ws), "utf8");
  } catch {
    return { seen: {} };
  }
  try {
    const parsed = JSON.parse(raw) as { seen?: unknown };
    const seen: Record<string, number> = {};
    if (typeof parsed.seen === "object" && parsed.seen !== null) {
      for (const [key, value] of Object.entries(parsed.seen)) {
        if (typeof value === "number" && Number.isFinite(value)) seen[key] = value;
      }
    }
    return { seen };
  } catch {
    return { seen: {} };
  }
}

function writeSeen(ws: Workspace, state: SeenState): void {
  fs.mkdirSync(stateDir(ws), { recursive: true });
  const file = seenFile(ws);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** 把房间已读水位推进到 entryId（单调不倒退），返回新状态。 */
export function markSeen(ws: Workspace, roomKey: string, entryId: string): SeenState {
  const state = readSeen(ws);
  const value = Number(entryId);
  if (Number.isFinite(value)) {
    state.seen[roomKey] = Math.max(state.seen[roomKey] ?? 0, value);
  }
  writeSeen(ws, state);
  return state;
}

/** 逐房间未读计数与总数（老板自己的发言不计）。 */
export function unreadCounts(
  rooms: { key: string; messages: RoomMessage[] }[],
  seen: SeenState,
): { total: number; rooms: Record<string, number> } {
  const counts: Record<string, number> = {};
  let total = 0;
  for (const room of rooms) {
    const count = countUnread(room.messages, seen.seen[room.key]);
    if (count > 0) {
      counts[room.key] = count;
      total += count;
    }
  }
  return { total, rooms: counts };
}
```

- [ ] **Step 4: 改 `tests/app/routing.test.ts`（删掉 unreadForBoss 用例）**

删除该文件里 `unreadForBoss` 的 import 与整个 `describe("unreadForBoss", ...)` 块，仅保留 planRouting 的用例。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/app/unread.test.ts tests/app/routing.test.ts`
Expected: PASS。

- [ ] **Step 6: 全量验证 + 提交**

Run: `npm test && npm run typecheck`

```bash
git add src/app/unread.ts src/app/rooms.ts tests/app/unread.test.ts tests/app/routing.test.ts
git commit -m "feat(server): 未读水印（state.json 原子写、单调推进、逐房间计数）"
```

---

### Task 5: HarnessPort 提交与推流（submit / watch）

**Files:**
- Modify: `src/harness/port.ts`（追加 InputMeta / HarnessEvent / submit / watch）
- Modify: `src/harness/pi-durable.ts`（`mapPiEvent` + `submit` + `watch` 实现）
- Test: `tests/harness/pi-durable.test.ts`（追加 describe）

**Interfaces:**
- Consumes: `watchEvents`、`AgentEvent`（Pi 类型，import 时别名 `PiAgentEvent`）、`EntryRecord`。
- Produces（后续任务依赖）:
  - `type InputMeta = { kind?: string; data?: unknown; requestId?: string }`
  - `type HarnessEvent = { type:"delta";convId;channel:"text"|"thinking";delta } | { type:"message";convId;message:ChatMessage } | { type:"run";convId;phase:"start"|"end" } | { type:"tool";convId;name;phase:"start"|"end" } | { type:"failed";convId;message }`
  - `HarnessPort.submit(convId, text, meta?): Promise<void>`
  - `HarnessPort.watch(convId, listener): Promise<() => Promise<void>>`

- [ ] **Step 1: 追加失败测试（`tests/harness/pi-durable.test.ts` 末尾新增 describe）**

```ts
describe("提交与推流", () => {
  it("submit 写入自定义 entry（kind/data），transcript 读回", async () => {
    const { models } = fauxModels([fauxAssistantMessage("收到")]);
    const harness = createPiHarness({ root, sqlitePath: path.join(root, ".openstaffs", "state-submit.sqlite"), models });
    await harness.open();
    try {
      const cwd = path.join(root, "agents", "alice");
      fs.mkdirSync(cwd, { recursive: true });
      const convId = await harness.startSession(spec(cwd));
      await harness.submit(convId, "做X", { kind: "chat.message", data: { author: "boss", roomMessageId: "rm_1" } });
      await waitFor(async () => (await harness.transcript(convId)).some((m) => m.role === "assistant"));
      const boss = (await harness.transcript(convId)).find((m) => m.role === "user");
      expect(boss?.kind).toBe("chat.message");
      expect(boss?.text).toBe("做X");
      expect((boss?.data as { roomMessageId?: string } | undefined)?.roomMessageId).toBe("rm_1");
    } finally {
      await harness.close();
    }
  });

  it("watch 推送 delta / 落盘消息 / run 起止", async () => {
    const { models } = fauxModels([fauxAssistantMessage("你好呀")]);
    const harness = createPiHarness({ root, sqlitePath: path.join(root, ".openstaffs", "state-watch.sqlite"), models });
    await harness.open();
    try {
      const cwd = path.join(root, "agents", "alice");
      fs.mkdirSync(cwd, { recursive: true });
      const convId = await harness.startSession(spec(cwd));
      const events: HarnessEvent[] = [];
      const unsubscribe = await harness.watch(convId, (event) => events.push(event));
      try {
        await harness.submit(convId, "你好");
        await waitFor(() => events.some((e) => e.type === "message" && e.message.role === "assistant"));
        expect(events.some((e) => e.type === "message" && e.message.role === "user" && e.message.text === "你好")).toBe(true);
        expect(events.some((e) => e.type === "delta" && e.channel === "text" && e.delta.length > 0)).toBe(true);
        expect(events.some((e) => e.type === "run" && e.phase === "start")).toBe(true);
        expect(events.some((e) => e.type === "run" && e.phase === "end")).toBe(true);
        const assistant = events.find((e) => e.type === "message" && e.message.role === "assistant");
        expect(assistant?.type === "message" ? assistant.message.text : "").toContain("你好呀");
      } finally {
        await unsubscribe();
      }
    } finally {
      await harness.close();
    }
  });

  it("同 requestId 重复提交不产生重复输入（Pi 去重语义）", async () => {
    const { models } = fauxModels([fauxAssistantMessage("一"), fauxAssistantMessage("二")]);
    const harness = createPiHarness({ root, sqlitePath: path.join(root, ".openstaffs", "state-request.sqlite"), models });
    await harness.open();
    try {
      const cwd = path.join(root, "agents", "alice");
      fs.mkdirSync(cwd, { recursive: true });
      const convId = await harness.startSession(spec(cwd));
      await harness.submit(convId, "同一个请求", { requestId: "req-1" });
      await harness.submit(convId, "同一个请求", { requestId: "req-1" });
      await waitFor(async () => (await harness.transcript(convId)).some((m) => m.role === "assistant"));
      const users = (await harness.transcript(convId)).filter((m) => m.role === "user");
      expect(users).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });
});
```

文件顶部 import 需补：`import type { HarnessEvent } from "../../src/harness/port.ts";`（并到既有 port import 里）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/harness/pi-durable.test.ts`
Expected: FAIL —— `harness.submit` / `harness.watch` 不存在。

- [ ] **Step 3: 扩展 `src/harness/port.ts`（追加类型与接口方法）**

```ts
export type InputMeta = {
  /** entry kind；缺省 pi.user。编排传 "chat.message"。 */
  kind?: string;
  /** entry data（如 { author: "boss", roomMessageId }）。 */
  data?: unknown;
  /** Pi 会话内去重键（重试不产生重复输入）。 */
  requestId?: string;
};

export type HarnessEvent =
  | { type: "delta"; convId: string; channel: "text" | "thinking"; delta: string }
  | { type: "message"; convId: string; message: ChatMessage }
  | { type: "run"; convId: string; phase: "start" | "end" }
  | { type: "tool"; convId: string; name: string; phase: "start" | "end" }
  | { type: "failed"; convId: string; message: string };
```

`HarnessPort` 接口内追加：

```ts
  /** 提交输入，不等待回答（admission 完成即返回）。 */
  submit(convId: string, text: string, meta?: InputMeta): Promise<void>;
  /** 订阅该会话的归一化事件；返回退订函数。 */
  watch(convId: string, listener: (event: HarnessEvent) => void): Promise<() => Promise<void>>;
```

- [ ] **Step 4: 实现（`src/harness/pi-durable.ts`）**

import 行更新：

```ts
import {
  AssistantEntry, Harness, watchEvents, createRegistry,
  type AgentEvent as PiAgentEvent, type Conversation, type ConversationId, type EntryRecord,
} from "@earendil-works/pi-durable";
import type { ChatMessage, ConversationSpec, HarnessEvent, HarnessPort } from "./port.ts";
```

模块级新增（`textOf` 附近）：

```ts
/** entry → 单条聊天消息（只认 user/assistant；工具结果等跳过）。 */
function entryToChatMessage(entry: EntryRecord): ChatMessage | undefined {
  for (const message of entry.model ?? []) {
    const role = (message as { role?: unknown }).role;
    if (role !== "user" && role !== "assistant") continue;
    const body = textOf(message);
    if (body === "") continue;
    return {
      id: String(entry.id),
      role,
      text: body,
      kind: entry.kind,
      ...(entry.data === undefined ? {} : { data: entry.data }),
    };
  }
  return undefined;
}

/** Pi 事件 → 归一化事件（不泄漏 Pi 类型）。 */
export function mapPiEvent(event: PiAgentEvent, convId: string): HarnessEvent[] {
  switch (event.type) {
    case "message_update": {
      const out: HarnessEvent[] = [];
      for (const change of event.changes) {
        if (change.type === "text_delta") out.push({ type: "delta", convId, channel: "text", delta: change.delta });
        else if (change.type === "thinking_delta") out.push({ type: "delta", convId, channel: "thinking", delta: change.delta });
      }
      return out;
    }
    case "entry_appended": {
      const message = entryToChatMessage(event.entry);
      return message === undefined ? [] : [{ type: "message", convId, message }];
    }
    case "run_start":
      return [{ type: "run", convId, phase: "start" }];
    case "run_end":
      return [{ type: "run", convId, phase: "end" }];
    case "tool_execution_start":
      return [{ type: "tool", convId, name: event.toolName, phase: "start" }];
    case "tool_execution_end":
      return [{ type: "tool", convId, name: event.toolName, phase: "end" }];
    case "task_failed":
      return [{ type: "failed", convId, message: event.message }];
    default:
      return [];
  }
}
```

返回对象里追加两个方法（`send` 附近）：

```ts
    async submit(convId, text, meta) {
      const conv = await conversation(convId as unknown as ConversationId);
      await conv.submit(
        {
          type: "input",
          content: text,
          ...(meta?.kind === undefined
            ? {}
            : { entry: { kind: meta.kind, ...(meta.data === undefined ? {} : { data: meta.data as never }) } }),
          ...(meta?.requestId === undefined ? {} : { requestId: meta.requestId }),
        },
        ctx,
      );
    },
    async watch(convId, listener) {
      const stream = await watchEvents(harness!, convId as unknown as ConversationId, ctx);
      stream.start(async (events) => {
        for (const event of events) {
          for (const mapped of mapPiEvent(event, String(convId))) listener(mapped);
        }
      });
      return async () => {
        await stream.stop();
      };
    },
```

**实测校准点**：若测试发现 assistant 回复落盘不经过 `entry_appended`（例如只经 `message_end`），则在 `mapPiEvent` 中把 `message_end` 也映射为 `message` 事件，并保证同一 entry 只发一次（两者都发时用 `entry.id` 去重）。以测试真实观察为准，记录 Ruling。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/harness/pi-durable.test.ts`
Expected: PASS（原有用例 + 新 3 个）。若 eventos 顺序断言失败，先打印事件序列核对再调断言（保持断言强度：delta 存在、user/assistant 消息存在、run 起止存在）。

- [ ] **Step 6: 全量验证 + 提交**

Run: `npm test && npm run typecheck`

```bash
git add src/harness/port.ts src/harness/pi-durable.ts tests/harness/pi-durable.test.ts
git commit -m "feat(server): HarnessPort submit/watch——fire-and-forget 提交与归一化事件流"
```

---

### Task 6: 会话装配增强（快照清单 + 兜底 + 链辅助）

**Files:**
- Modify: `src/app/conversations.ts`
- Test: `tests/app/conversations.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 1 的 `resolveEmployeeModel` / `ModelRefLike`；`readChain`、`activeSession`（conversation-chain）；`parseMembers`（access-control）。
- Produces（后续任务依赖）:
  - `type SessionDefaults = { model: ModelRefLike }`
  - `openDm(ws, harness, employeeId, defaults?)` / `openGroup(ws, harness, project, speakerId, defaults?)` / `newSession(ws, harness, relation, speakerId, defaults?)`
  - `sessionChains(ws, relation): { memberId: string; rows: SessionRow[] }[]`
  - `activeMemberSessions(ws, relation): { memberId: string; convId: string }[]`
  - `findSessionOwner(ws, relation, convId): string | undefined`
  - `roomTranscripts(ws, harness, relation): Promise<MemberTranscript[]>`
  - `instructionsFor` 快照清单：根 AGENTS.md →（群聊）项目 AGENTS.md → 员工三件套 → 技能清单

- [ ] **Step 1: 追加失败测试（`tests/app/conversations.test.ts` 追加）**

新 import 需补：`activeMemberSessions, findSessionOwner, roomTranscripts, sessionChains, type SessionDefaults`。

```ts
it("快照清单：根 AGENTS.md 与项目 AGENTS.md 按序注入（群聊），私聊只注入根 + 员工", () => {
  seedEmployee("alice");
  const ws = createWorkspace(root);
  fs.writeFileSync(path.join(root, "AGENTS.md"), "公司总纲：不得违法。");
  fs.mkdirSync(path.join(root, "projects", "yt"), { recursive: true });
  fs.writeFileSync(path.join(root, "projects", "yt", "AGENTS.md"), "任务：做 yt 视频。");
  const speaker = loadEmployee(ws, "alice");

  const group = instructionsFor(ws, { kind: "group", project: "yt" }, speaker);
  expect(group).toContain("公司总纲：不得违法。");
  expect(group).toContain("任务：做 yt 视频。");
  expect(group.indexOf("公司总纲")).toBeLessThan(group.indexOf("任务：做 yt 视频。"));
  expect(group.indexOf("任务：做 yt 视频。")).toBeLessThan(group.indexOf("你是 alice。"));

  const dm = instructionsFor(ws, { kind: "dm", employeeId: "alice" }, speaker);
  expect(dm).toContain("公司总纲：不得违法。");
  expect(dm).not.toContain("任务：做 yt 视频。");
});

it("员工未配模型时用 defaults 兜底可对话；无 defaults 则失败（不静默）", async () => {
  const dir = path.join(root, "agents", "carol");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "你是 carol。");
  const ws = createWorkspace(root);
  const harness = harnessWithFaux();
  await harness.open();
  try {
    const defaults: SessionDefaults = { model: { provider: "faux", modelId: "faux-model" } };
    const convId = await openDm(ws, harness, "carol", defaults);
    const reply = await harness.send(convId, "在吗");
    expect(reply.text).toBe("ok");
  } finally {
    await harness.close();
  }
});

it("会话链辅助：sessionChains / activeMemberSessions / findSessionOwner", async () => {
  seedEmployee("alice");
  seedEmployee("bob");
  const ws = createWorkspace(root);
  fs.mkdirSync(path.join(root, "projects", "yt"), { recursive: true });
  fs.writeFileSync(path.join(root, "projects", "yt", "members.md"), "# 成员\n- alice\n- bob\n");
  const harness = harnessWithFaux();
  await harness.open();
  try {
    const a1 = await openGroup(ws, harness, "yt", "alice");
    const chains = sessionChains(ws, { kind: "group", project: "yt" });
    expect(chains.map((c) => c.memberId)).toEqual(["alice", "bob"]);
    expect(chains[0]!.rows).toHaveLength(1);

    const active = activeMemberSessions(ws, { kind: "group", project: "yt" });
    expect(active).toEqual([{ memberId: "alice", convId: a1 }]);
    expect(findSessionOwner(ws, { kind: "group", project: "yt" }, a1)).toBe("alice");
    expect(findSessionOwner(ws, { kind: "group", project: "yt" }, "conv:不存在")).toBeUndefined();

    const transcripts = await roomTranscripts(ws, harness, { kind: "group", project: "yt" });
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]!.memberId).toBe("alice");
  } finally {
    await harness.close();
  }
});

it("会话快照：会话中改档案文件不生效；新开会话后生效", async () => {
  const dir = path.join(root, "agents", "dave");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "你是 dave。");
  fs.writeFileSync(path.join(dir, "profile.md"), "档案版本一。");
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ provider: "faux", modelId: "faux-model" }));

  const systems: string[] = [];
  const recordSystem = (messages: readonly { role: string; content: unknown }[]): void => {
    systems.push(
      messages
        .filter((m) => m.role === "system")
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
        .join("\n"),
    );
  };

  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
  faux.setResponses([
    (context) => {
      recordSystem(context.messages);
      return fauxAssistantMessage("ok");
    },
    (context) => {
      recordSystem(context.messages);
      return fauxAssistantMessage("ok");
    },
    (context) => {
      recordSystem(context.messages);
      return fauxAssistantMessage("ok");
    },
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = createPiHarness({ root, sqlitePath: path.join(root, ".openstaffs", "state-snapshot.sqlite"), models });
  await harness.open();
  try {
    const ws = createWorkspace(root);
    const first = await openDm(ws, harness, "dave");
    await harness.send(first, "在吗");
    fs.writeFileSync(path.join(dir, "profile.md"), "档案版本二。");
    const again = await openDm(ws, harness, "dave");
    expect(again).toBe(first); // attach 复用旧会话，不重配置
    await harness.send(again, "还在吗");
    const fresh = await newSession(ws, harness, { kind: "dm", employeeId: "dave" }, "dave");
    expect(fresh).not.toBe(first);
    await harness.send(fresh, "新会话");

    expect(systems).toHaveLength(3);
    expect(systems[0]).toContain("档案版本一。");
    expect(systems[1]).toContain("档案版本一。"); // 会话进行中：文件变更不生效
    expect(systems[2]).toContain("档案版本二。"); // 新开会话：读到新档案
  } finally {
    await harness.close();
  }
});
```

（`harnessWithFaux` 的响应队列只有两条 `ok`：上面 carol 用例会消耗一条。注意 `setResponses` 是全局顺序消费，测试内多条用例共用同一 root 但各自新建 harness——faux 实例也是各自的（`harnessWithFaux` 每次新建）✓。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/app/conversations.test.ts`
Expected: FAIL —— `activeMemberSessions` 等未导出；快照清单断言失败（尚无根/项目注入）。

- [ ] **Step 3: 实现（`src/app/conversations.ts`）**

1. 顶部 import 补充：

```ts
import fs from "node:fs";
import { parseMembers } from "../domain/access-control.ts";
import { readChain, activeSession, startNewSession, type SessionRow } from "../domain/conversation-chain.ts";
import { resolveEmployeeModel, type ModelRefLike } from "../domain/config.ts";
import type { MemberTranscript } from "./rooms.ts";
```

（`MemberTranscript` 为 type-only，允许与 rooms.ts 的类型环。）

2. `instructionsFor` 替换为快照清单：

```ts
function readTextOrEmpty(file: string): string {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

/** 会话快照（仅 startSession/新开会话时渲染一次）：根总纲 → 项目规范（群聊）→ 员工 → 技能。 */
export function instructionsFor(ws: Workspace, relation: Relation, speaker: Employee): string {
  const parts: string[] = [];
  const rootAgents = readTextOrEmpty(path.join(ws.root, "AGENTS.md"));
  if (rootAgents !== "") parts.push(rootAgents);
  if (relation.kind === "group") {
    const projectAgents = readTextOrEmpty(path.join(projectDir(ws, relation.project), "AGENTS.md"));
    if (projectAgents !== "") parts.push(projectAgents);
  }
  parts.push(renderInstructions(speaker));
  parts.push(renderSkills(listSkills(skillDirsFor(ws, relation, speaker))));
  return parts.filter((part) => part.trim() !== "").join("\n\n");
}
```

3. 默认模型兜底：

```ts
export type SessionDefaults = { model: ModelRefLike };

function specFor(ws: Workspace, relation: Relation, speaker: Employee, defaults?: SessionDefaults): ConversationSpec {
  if (relation.kind === "dm" && speaker.id !== relation.employeeId) {
    throw new Error(`私聊关系与发言人不一致: ${relation.employeeId} ≠ ${speaker.id}`);
  }
  const cwd = relationCwd(ws, relation);
  const model = resolveEmployeeModel(defaults?.model ?? { provider: "", modelId: "" }, speaker.model);
  return {
    cwd,
    instructions: instructionsFor(ws, relation, speaker),
    model: { provider: model.provider, modelId: model.modelId },
    ...(model.thinkingLevel === undefined ? {} : { thinkingLevel: model.thinkingLevel }),
    access: accessFor(ws, relation, speaker),
  };
}
```

`ensure` / `openDm` / `openGroup` / `newSession` 全部追加可选 `defaults?: SessionDefaults` 并透传给 `specFor`。

4. 链辅助 + 房间聚合：

```ts
export function sessionChains(ws: Workspace, relation: Relation): { memberId: string; rows: SessionRow[] }[] {
  if (relation.kind === "dm") {
    return [{ memberId: relation.employeeId, rows: readChain(conversationIdsFile(ws, employeeDir(ws, relation.employeeId))) }];
  }
  return parseMembers(ws, relation.project).map((memberId) => ({
    memberId,
    rows: readChain(groupConversationIdsFile(ws, relation.project, memberId)),
  }));
}

export function activeMemberSessions(ws: Workspace, relation: Relation): { memberId: string; convId: string }[] {
  const out: { memberId: string; convId: string }[] = [];
  for (const chain of sessionChains(ws, relation)) {
    const active = chain.rows.filter((row) => row.ended === null).at(-1);
    if (active !== undefined) out.push({ memberId: chain.memberId, convId: active.id });
  }
  return out;
}

export function findSessionOwner(ws: Workspace, relation: Relation, convId: string): string | undefined {
  for (const chain of sessionChains(ws, relation)) {
    if (chain.rows.some((row) => row.id === convId)) return chain.memberId;
  }
  return undefined;
}

/** 当前房间各成员活跃会话的 transcript（合并视图输入；只读不创建）。 */
export async function roomTranscripts(ws: Workspace, harness: HarnessPort, relation: Relation): Promise<MemberTranscript[]> {
  const out: MemberTranscript[] = [];
  for (const session of activeMemberSessions(ws, relation)) {
    let alias: string | undefined;
    try {
      alias = loadEmployee(ws, session.memberId).alias;
    } catch {
      alias = undefined;
    }
    const messages = await harness.transcript(session.convId);
    out.push({ memberId: session.memberId, ...(alias === undefined ? {} : { alias }), convId: session.convId, messages });
  }
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/app/conversations.test.ts`
Expected: PASS（原有 + 新增 3 个）。

- [ ] **Step 5: 全量验证 + 提交**

Run: `npm test && npm run typecheck`

```bash
git add src/app/conversations.ts tests/app/conversations.test.ts
git commit -m "feat(server): 会话快照清单（根/项目 AGENTS.md 注入）、默认模型兜底、房间链辅助"
```

---

### Task 7: 发送编排（app/send.ts）

**Files:**
- Create: `src/app/send.ts`
- Test: `tests/app/send.test.ts`

**Interfaces:**
- Consumes: `planRouting`（routing.ts）；`parseMembers`（access-control）；`openDm` / `openGroup`、`SessionDefaults`（conversations.ts）；`HarnessPort`。
- Produces（后续任务依赖）:
  - `class KeyedQueue { run<T>(key: string, fn: () => Promise<T>): Promise<T> }`（同 key 串行、异 key 并行、失败不连坐）
  - `class EmptyGroupError extends Error`
  - `sessionKey(relation, memberId): string`
  - `sendToRoom(ws, harness, relation, text, options): Promise<{ roomMessageId: string; deliveries: { memberId: string; convId: string }[] }>`

- [ ] **Step 1: 写失败测试（`tests/app/send.test.ts`）**

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { EmptyGroupError, KeyedQueue, sendToRoom, sessionKey } from "../../src/app/send.ts";
import type { ChatMessage, ConversationSpec, HarnessPort, InputMeta } from "../../src/harness/port.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-send-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function seedEmployee(id: string) {
  const dir = path.join(root, "agents", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "AGENTS.md"), `你是 ${id}。`);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ provider: "faux", modelId: "faux-model" }));
}

function seedGroup(project: string, members: string[]) {
  const dir = path.join(root, "projects", project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "members.md"), ["# 成员", ...members.map((m) => `- ${m}`), ""].join("\n"));
}

class FakePort implements HarnessPort {
  readonly starts: ConversationSpec[] = [];
  readonly submits: { convId: string; text: string; meta?: InputMeta }[] = [];
  gate?: Promise<void>;

  async open(): Promise<void> {}
  async close(): Promise<void> {}
  async startSession(spec: ConversationSpec): Promise<string> {
    this.starts.push(spec);
    return `conv-${this.starts.length}`;
  }
  async attach(convId: string): Promise<boolean> {
    return convId.startsWith("conv-");
  }
  async submit(convId: string, text: string, meta?: InputMeta): Promise<void> {
    if (this.gate !== undefined) await this.gate;
    this.submits.push({ convId, text, meta });
  }
  async watch(): Promise<() => Promise<void>> {
    return async () => {};
  }
  async send(convId: string, text: string): Promise<ChatMessage> {
    return { id: "x", role: "assistant", text };
  }
  async transcript(): Promise<ChatMessage[]> {
    return [];
  }
}

const defaults = { model: { provider: "faux", modelId: "faux-model" } };

describe("发送编排", () => {
  it("私聊直接投递（原文不剥 @），meta 带 author 与同一 roomMessageId", async () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const port = new FakePort();
    const result = await sendToRoom(ws, port, { kind: "dm", employeeId: "alice" }, "@老板 你好", {
      queue: new KeyedQueue(),
      defaults,
      requestId: "r1",
    });
    expect(result.deliveries).toHaveLength(1);
    expect(port.submits).toHaveLength(1);
    expect(port.submits[0]!.text).toBe("@老板 你好");
    expect(port.submits[0]!.meta?.kind).toBe("chat.message");
    expect(port.submits[0]!.meta?.requestId).toBe("r1");
    const data = port.submits[0]!.meta?.data as { author?: string; roomMessageId?: string };
    expect(data.author).toBe("boss");
    expect(data.roomMessageId).toBe(result.roomMessageId);
  });

  it("群聊 @alice：只投递 alice，body 剥除提及；广播：全员各一份同 roomMessageId", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    seedGroup("yt", ["alice", "bob"]);
    const ws = createWorkspace(root);
    const port = new FakePort();
    const queue = new KeyedQueue();

    const mentioned = await sendToRoom(ws, port, { kind: "group", project: "yt" }, "@alice 做视频", { queue, defaults });
    expect(mentioned.deliveries.map((d) => d.memberId)).toEqual(["alice"]);
    expect(port.submits[0]!.text).toBe("做视频");

    port.submits.length = 0;
    const broadcast = await sendToRoom(ws, port, { kind: "group", project: "yt" }, "全体汇报", { queue, defaults });
    expect(broadcast.deliveries.map((d) => d.memberId).sort()).toEqual(["alice", "bob"]);
    const rids = new Set(port.submits.map((s) => (s.meta?.data as { roomMessageId?: string } | undefined)?.roomMessageId));
    expect(rids).toEqual(new Set([broadcast.roomMessageId]));
  });

  it("群聊只 @老板：202 语义（deliveries 空、不 submit、不抛错）", async () => {
    seedEmployee("alice");
    seedGroup("yt", ["alice"]);
    const ws = createWorkspace(root);
    const port = new FakePort();
    const result = await sendToRoom(ws, port, { kind: "group", project: "yt" }, "@老板 收到", { queue: new KeyedQueue(), defaults });
    expect(result.deliveries).toEqual([]);
    expect(port.submits).toEqual([]);
  });

  it("空成员群：抛 EmptyGroupError", async () => {
    fs.mkdirSync(path.join(root, "projects", "empty"), { recursive: true });
    fs.writeFileSync(path.join(root, "projects", "empty", "members.md"), "# 成员\n");
    const ws = createWorkspace(root);
    await expect(
      sendToRoom(ws, new FakePort(), { kind: "group", project: "empty" }, "在吗", { queue: new KeyedQueue(), defaults }),
    ).rejects.toThrow(EmptyGroupError);
  });

  it("per-key 串行：同 key 后一个等前一个进入 submit 后才开始", async () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const port = new FakePort();
    const queue = new KeyedQueue();
    let release!: () => void;
    port.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = sendToRoom(ws, port, { kind: "dm", employeeId: "alice" }, "一", { queue, defaults });
    const second = sendToRoom(ws, port, { kind: "dm", employeeId: "alice" }, "二", { queue, defaults });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(port.submits).toHaveLength(1); // 第二个还没进入
    release();
    await Promise.all([first, second]);
    expect(port.submits.map((s) => s.text)).toEqual(["一", "二"]);
  });

  it("异 key 并行：两个成员同时进入 submit（互不阻塞）", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    seedGroup("yt", ["alice", "bob"]);
    const ws = createWorkspace(root);
    const port = new FakePort();
    let release!: () => void;
    port.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const p = sendToRoom(ws, port, { kind: "group", project: "yt" }, "全体动起来", { queue: new KeyedQueue(), defaults });
    const started = Date.now();
    while (port.submits.length < 2 && Date.now() - started < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(port.submits).toHaveLength(2); // 两个成员都在 submit 中等待
    release();
    await p;
  });

  it("sessionKey：dm 与 group 的 key 形状", () => {
    expect(sessionKey({ kind: "dm", employeeId: "alice" }, "alice")).toBe("dm:alice");
    expect(sessionKey({ kind: "group", project: "yt" }, "bob")).toBe("group:yt:bob");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/app/send.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 `src/app/send.ts`**

```ts
import { randomUUID } from "node:crypto";
import { parseMembers } from "../domain/access-control.ts";
import type { Workspace } from "../domain/paths.ts";
import type { HarnessPort, InputMeta } from "../harness/port.ts";
import { openDm, openGroup, type Relation, type SessionDefaults } from "./conversations.ts";
import { planRouting } from "./routing.ts";

/** per-key 串行队列：同 key 串行（FIFO）、异 key 并行；前序失败不连坐后续。 */
export class KeyedQueue {
  #tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#tails.get(key) ?? Promise.resolve();
    const result = prev.catch(() => undefined).then(fn);
    this.#tails.set(
      key,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }
}

/** 群没有成员（members.md 为空）时拒绝发送。 */
export class EmptyGroupError extends Error {}

export function sessionKey(relation: Relation, memberId: string): string {
  return relation.kind === "dm" ? `dm:${relation.employeeId}` : `group:${relation.project}:${memberId}`;
}

export type DeliveryReport = { memberId: string; convId: string };

/**
 * 发送编排：私聊直投原文；群聊走 planRouting（@定向/广播）。
 * 只等全部 admission 落盘（模型回答并行在途，经 watch 推流）。
 */
export async function sendToRoom(
  ws: Workspace,
  harness: HarnessPort,
  relation: Relation,
  text: string,
  options: { queue: KeyedQueue; defaults?: SessionDefaults; requestId?: string },
): Promise<{ roomMessageId: string; deliveries: DeliveryReport[] }> {
  const body = text.trim();
  if (body === "") throw new Error("消息不能为空");

  const targets: { memberId: string; body: string }[] = [];
  if (relation.kind === "dm") {
    targets.push({ memberId: relation.employeeId, body });
  } else {
    const memberIds = parseMembers(ws, relation.project);
    if (memberIds.length === 0) throw new EmptyGroupError("群还没有成员");
    for (const delivery of planRouting(body, memberIds).deliveries) {
      targets.push({ memberId: delivery.to, body: delivery.body });
    }
  }

  const roomMessageId = `rm_${randomUUID()}`;
  const deliveries = await Promise.all(
    targets.map((target) =>
      options.queue.run(sessionKey(relation, target.memberId), async (): Promise<DeliveryReport> => {
        const convId =
          relation.kind === "dm"
            ? await openDm(ws, harness, relation.employeeId, options.defaults)
            : await openGroup(ws, harness, relation.project, target.memberId, options.defaults);
        const meta: InputMeta = {
          kind: "chat.message",
          data: { author: "boss", roomMessageId },
          ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
        };
        await harness.submit(convId, target.body, meta);
        return { memberId: target.memberId, convId };
      }),
    ),
  );
  return { roomMessageId, deliveries };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/app/send.test.ts`
Expected: PASS（7 个用例）。

- [ ] **Step 5: 全量验证 + 提交**

Run: `npm test && npm run typecheck`

```bash
git add src/app/send.ts tests/app/send.test.ts
git commit -m "feat(server): 发送编排（per-key 队列、私聊直投、@定向/广播、requestId）"
```

---

### Task 8: HTTP 骨架 + 只读 API + 静态文件

**Files:**
- Modify: `src/domain/employee.ts`（追加 `listEmployees`）
- Modify: `src/domain/project.ts`（追加 `loadProject` / `listProjects`）
- Create: `src/server/http.ts`
- Create: `src/server/main.ts`
- Modify: `package.json`（`"start": "node src/server/main.ts"`；如 Node 报错改用 `node --experimental-strip-types src/server/main.ts`）
- Test: `tests/domain/employee.test.ts` 追加、`tests/domain/project.test.ts` 追加、`tests/server/http.test.ts`（新增）

**Interfaces:**
- Consumes: `readConfig` / `resolveEmployeeModel`（config）；`createWorkspace`、`agentsDir`、`projectsDir`、`employeeDir`、`projectDir`；`parseMembers`。
- Produces（后续任务依赖）:
  - `listEmployees(ws): Employee[]`；`loadProject(ws, id): Project`；`listProjects(ws): Project[]`
  - `type ServerDeps = { ws; getConfig: () => WorkspaceConfig | undefined; publicDir: string }`
  - `createHttpServer(deps: ServerDeps): http.Server`（本任务只含 status/employees/projects/静态/409；房间路由 404 占位）

- [ ] **Step 1: 域函数测试（追加到既有文件）**

`tests/domain/employee.test.ts` 追加：

```ts
it("listEmployees：按 id 排序、跳过隐藏目录、坏 config.json 不崩", () => {
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-list-"));
  try {
    for (const id of ["bob", "alice"]) {
      const dir = path.join(root2, "agents", id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "AGENTS.md"), `你是 ${id}。`);
    }
    fs.mkdirSync(path.join(root2, "agents", ".hidden"), { recursive: true });
    fs.writeFileSync(path.join(root2, "agents", "alice", "config.json"), "{坏");
    const ws = createWorkspace(root2);
    expect(listEmployees(ws).map((e) => e.id)).toEqual(["alice", "bob"]);
    expect(listEmployees(ws)[0]!.model).toEqual({ provider: "", modelId: "" });
  } finally {
    fs.rmSync(root2, { recursive: true, force: true });
  }
});
```

（该文件顶部 import 若缺 `os`/`createWorkspace`/`listEmployees` 请补齐。）

`tests/domain/project.test.ts` 追加：

```ts
it("loadProject / listProjects：读 alias、坏 JSON 回落 id、排序", () => {
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-projects-"));
  try {
    const ws = createWorkspace(root2);
    createProject(ws, "beta", ["alice"]);
    createProject(ws, "alpha", ["bob"], "阿尔法");
    fs.writeFileSync(path.join(root2, "projects", "beta", "project.json"), "{坏");
    expect(loadProject(ws, "alpha").alias).toBe("阿尔法");
    expect(loadProject(ws, "beta").alias).toBe("beta");
    expect(listProjects(ws).map((p) => p.id)).toEqual(["alpha", "beta"]);
    expect(listProjects(ws).map((p) => p.alias)).toEqual(["阿尔法", "beta"]);
  } finally {
    fs.rmSync(root2, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/domain/employee.test.ts tests/domain/project.test.ts`
Expected: FAIL —— `listEmployees` / `loadProject` / `listProjects` 未定义。

- [ ] **Step 3: 实现域函数**

`src/domain/employee.ts` 追加（import `agentsDir`）：

```ts
/** 扫描 agents/ 下全部员工（按 id 排序；跳过隐藏目录）。 */
export function listEmployees(ws: Workspace): Employee[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(agentsDir(ws), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort()
    .map((id) => loadEmployee(ws, id));
}
```

`src/domain/project.ts` 追加（import `projectsDir`）：

```ts
/** 读项目 alias；project.json 缺失/坏 JSON → alias = id。 */
export function loadProject(ws: Workspace, id: ProjectName): Project {
  const dir = projectDir(ws, id);
  if (!fs.existsSync(dir)) throw new Error(`项目不存在: ${id}`);
  let alias = id;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8")) as { alias?: unknown };
    if (typeof parsed.alias === "string" && parsed.alias.trim() !== "") alias = parsed.alias.trim();
  } catch {
    // 容错：回落 id
  }
  return { id, alias };
}

export function listProjects(ws: Workspace): Project[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(projectsDir(ws), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort()
    .map((id) => loadProject(ws, id));
}
```

- [ ] **Step 4: 写 http 测试（`tests/server/http.test.ts`）**

```ts
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { createHttpServer, type ServerDeps } from "../../src/server/http.ts";
import type { WorkspaceConfig } from "../../src/domain/config.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-http-"));
const publicDir = path.join(root, "public");
fs.mkdirSync(publicDir, { recursive: true });
fs.writeFileSync(path.join(publicDir, "index.html"), "<html>Office</html>");
fs.writeFileSync(path.join(root, "secret.txt"), "top-secret");

afterEach(() => {
  fs.rmSync(path.join(root, "agents"), { recursive: true, force: true });
  fs.rmSync(path.join(root, "projects"), { recursive: true, force: true });
});

function start(deps: ServerDeps): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createHttpServer(deps);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

const configured: WorkspaceConfig = { provider: "faux", apiKey: "k", modelId: "faux-model", port: 4319 };

describe("HTTP 骨架", () => {
  it("未配置：status 可用、其余 API 409、静态可用", async () => {
    const ws = createWorkspace(root);
    const { base, close } = await start({ ws, getConfig: () => undefined, publicDir });
    try {
      const status = await fetch(`${base}/api/status`);
      expect(status.status).toBe(200);
      expect(await status.json()).toEqual({ configured: false, root: ws.root, port: 4319 });

      expect((await fetch(`${base}/api/employees`)).status).toBe(409);
      expect((await fetch(`${base}/api/unread`)).status).toBe(409);

      const page = await fetch(`${base}/`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("Office");
    } finally {
      await close();
    }
  });

  it("status 永不回显 apiKey；employees/projects 列表（含 alias 与模型兜底）", async () => {
    const aliceDir = path.join(root, "agents", "alice");
    fs.mkdirSync(aliceDir, { recursive: true });
    fs.writeFileSync(path.join(aliceDir, "AGENTS.md"), "你是 alice。");
    fs.writeFileSync(path.join(aliceDir, "config.json"), JSON.stringify({ alias: "爱丽丝", provider: "faux", modelId: "faux-model" }));
    const carolDir = path.join(root, "agents", "carol");
    fs.mkdirSync(carolDir, { recursive: true });
    fs.writeFileSync(path.join(carolDir, "AGENTS.md"), "你是 carol。");
    const projectDir = path.join(root, "projects", "yt");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "members.md"), "# 成员\n- alice\n- ghost\n");
    fs.writeFileSync(path.join(projectDir, "project.json"), JSON.stringify({ alias: "油管项目" }));

    const ws = createWorkspace(root);
    const { base, close } = await start({ ws, getConfig: () => configured, publicDir });
    try {
      const status = (await (await fetch(`${base}/api/status`)).json()) as Record<string, unknown>;
      expect(status.apiKey).toBeUndefined();
      expect(status.configured).toBe(true);
      expect(status.provider).toBe("faux");

      const employees = (await (await fetch(`${base}/api/employees`)).json()) as { id: string; alias?: string; model: { provider: string; modelId: string } }[];
      expect(employees.map((e) => e.id)).toEqual(["alice", "carol"]);
      expect(employees[0]).toEqual({ id: "alice", alias: "爱丽丝", model: { provider: "faux", modelId: "faux-model" } });
      expect(employees[1]!.model).toEqual({ provider: "faux", modelId: "faux-model" }); // 兜底全局

      const projects = (await (await fetch(`${base}/api/projects`)).json()) as { id: string; alias: string; members: { id: string; alias?: string }[] }[];
      expect(projects).toEqual([
        { id: "yt", alias: "油管项目", members: [{ id: "alice", alias: "爱丽丝" }, { id: "ghost" }] },
      ]);
    } finally {
      await close();
    }
  });

  it("静态文件：防路径穿越、404", async () => {
    const ws = createWorkspace(root);
    const { base, close } = await start({ ws, getConfig: () => configured, publicDir });
    try {
      expect((await fetch(`${base}/nope.txt`)).status).toBe(404);
      // 原始 http 请求绕过 fetch 的路径规范化
      const status = await new Promise<number>((resolve) => {
        const req = http.request({ host: "127.0.0.1", port: new URL(base).port, path: "/..%2Fsecret.txt" }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.end();
      });
      expect(status).toBe(404);
    } finally {
      await close();
    }
  });
});
```

- [ ] **Step 5: 实现 `src/server/http.ts`**

```ts
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { listEmployees, loadEmployee } from "../domain/employee.ts";
import { listProjects } from "../domain/project.ts";
import { parseMembers } from "../domain/access-control.ts";
import { DEFAULT_PORT, resolveEmployeeModel, type WorkspaceConfig } from "../domain/config.ts";
import type { Workspace } from "../domain/paths.ts";

export type ServerDeps = {
  ws: Workspace;
  getConfig: () => WorkspaceConfig | undefined;
  publicDir: string;
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 1024 * 1024) throw new Error("请求体过大");
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("请求体不是合法 JSON");
  }
}

function memberSummaries(ws: Workspace, project: string): { id: string; alias?: string }[] {
  return parseMembers(ws, project).map((id) => {
    try {
      const employee = loadEmployee(ws, id);
      return { id, ...(employee.alias === undefined ? {} : { alias: employee.alias }) };
    } catch {
      return { id };
    }
  });
}

function resolveStatic(publicDir: string, pathname: string): string | undefined {
  const decoded = decodeURIComponent(pathname);
  const rel = decoded === "/" ? "index.html" : decoded.replace(/^\/+/u, "");
  const base = path.resolve(publicDir);
  const target = path.resolve(base, rel);
  if (target === base) return path.join(base, "index.html");
  if (!target.startsWith(base + path.sep)) return undefined;
  return target;
}

export function createHttpServer(deps: ServerDeps): http.Server {
  return http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const segments = url.pathname.split("/").filter((part) => part !== "");
        const method = req.method ?? "GET";

        if (segments[0] === "api") {
          const config = deps.getConfig();
          if (segments[1] === "status" && method === "GET") {
            json(res, 200, {
              configured: config !== undefined,
              root: deps.ws.root,
              port: config?.port ?? DEFAULT_PORT,
              ...(config === undefined ? {} : { provider: config.provider, modelId: config.modelId }),
            });
            return;
          }
          if (config === undefined) {
            json(res, 409, { error: "尚未配置：请编辑 .openstaffs/config.json 后重启服务" });
            return;
          }
          if (segments[1] === "employees" && method === "GET") {
            const global = { provider: config.provider, modelId: config.modelId };
            json(
              res,
              200,
              listEmployees(deps.ws).map((employee) => ({
                id: employee.id,
                ...(employee.alias === undefined ? {} : { alias: employee.alias }),
                model: resolveEmployeeModel(global, employee.model),
              })),
            );
            return;
          }
          if (segments[1] === "projects" && method === "GET") {
            json(
              res,
              200,
              listProjects(deps.ws).map((project) => ({
                id: project.id,
                alias: project.alias,
                members: memberSummaries(deps.ws, project.id),
              })),
            );
            return;
          }
          json(res, 404, { error: "接口不存在" });
          return;
        }

        // 静态文件（GET/HEAD）
        if (method !== "GET" && method !== "HEAD") {
          json(res, 405, { error: "方法不允许" });
          return;
        }
        const target = resolveStatic(deps.publicDir, url.pathname);
        if (target === undefined || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
          json(res, 404, { error: "文件不存在" });
          return;
        }
        res.writeHead(200, { "content-type": MIME[path.extname(target)] ?? "application/octet-stream" });
        fs.createReadStream(target).pipe(res);
      } catch (error) {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    })();
  });
}
```

**注意**：`json`、`readJsonBody`、`memberSummaries`、`resolveStatic` 均为本文件模块级辅助；`readConfig` 只在 main 用到（http.ts 通过 `getConfig` 注入拿到配置，不直接读文件）。

- [ ] **Step 6: 实现 `src/server/main.ts`**

```ts
import path from "node:path";
import { createWorkspace } from "../domain/paths.ts";
import { readConfig } from "../domain/config.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkspace } from "../domain/paths.ts";
import { readConfig } from "../domain/config.ts";
import { createHttpServer } from "./http.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const root = process.env.OPENSTAFFS_ROOT ?? process.cwd();
  const ws = createWorkspace(root);
  const config = readConfig(ws);
  if (config === undefined) {
    console.log(`[openstaffs] 未配置：请编辑 ${path.join(root, ".openstaffs", "config.json")} 后重启服务`);
  }
  const server = createHttpServer({
    ws,
    getConfig: () => readConfig(ws),
    publicDir: path.join(here, "..", "..", "public"),
  });
  const port = config?.port ?? 4319;
  server.listen(port, () => {
    console.log(`[openstaffs] 服务已启动：http://localhost:${port}（根目录 ${root}）`);
  });
}

void main();
```

（`publicDir` 的路径：`src/server/main.ts` → 项目根 `public/`。上面写法：`new URL(import.meta.url).pathname` 的父父目录 + public。更稳妥写法用 `fileURLToPath(import.meta.url)`——实现时任选其一以实测为准。Node 22+ 也可用 `import.meta.dirname`。）

- [ ] **Step 7: 跑测试确认通过**

Run: `npx vitest run tests/domain/employee.test.ts tests/domain/project.test.ts tests/server/http.test.ts`
Expected: PASS。

- [ ] **Step 8: 全量验证 + 手动冒烟 + 提交**

Run: `npm test && npm run typecheck`

手动冒烟（可选但推荐）：

```bash
(node src/server/main.ts > /tmp/oss-server.log 2>&1 & echo $! > /tmp/oss.pid)
sleep 1
curl -s http://127.0.0.1:4319/api/status
kill $(cat /tmp/oss.pid)
tail -5 /tmp/oss-server.log
```

Expected: status 返回 `{"configured":false,...}`（临时目录起服务或本仓库无 config——本仓库根没有 `.openstaffs/config.json` 时即未配置模式）；若 Node 版本对类型剥离报错，把 `package.json` 的 start 改为 `node --experimental-strip-types src/server/main.ts` 并记录 Ruling。

```bash
git add src/domain/employee.ts src/domain/project.ts src/server/http.ts src/server/main.ts package.json tests/domain/employee.test.ts tests/domain/project.test.ts tests/server/http.test.ts
git commit -m "feat(server): HTTP 骨架——status/employees/projects/静态、未配置 409 门卫"
```

---

### Task 9: 房间 API（messages / new-session / sessions / read / unread）+ 装配启动

**Files:**
- Create: `src/server/models.ts`
- Modify: `src/server/http.ts`（deps 扩展 + 房间路由）
- Modify: `src/server/main.ts`（models → harness → deps 装配）
- Modify: `src/harness/pi-durable.ts`（`open()` 末尾加 `harness.resume()`）
- Test: `tests/server/models.test.ts`（新增）、`tests/server/http.test.ts`（追加 rooms describe）

**Interfaces:**
- Consumes: `sendToRoom`/`KeyedQueue`/`EmptyGroupError`（Task 7）；`roomTranscripts`/`activeMemberSessions`/`sessionChains`/`findSessionOwner`/`newSession`（Task 6）；`mergeRoomMessages`/`parseRoomKey`/`roomKeyOf`（Task 3）；`readSeen`/`markSeen`/`unreadCounts`（Task 4）。
- Produces（后续任务依赖）:
  - `createConfiguredModels(config): Promise<Models>`；`PROVIDERS` 白名单
  - `ServerDeps = { ws; getConfig; getHarness: () => HarnessPort | undefined; queue: KeyedQueue; publicDir; pump?: PumpLike }`
  - `type PumpLike = { register(convId, ref: { roomKey: string; memberId: string }): Promise<void>; unregister(convId: string): Promise<void> }`
  - 全部房间 API 端点（响应形状见 spec §6.1）

- [ ] **Step 1: 写 models.test.ts（失败）**

```ts
import { describe, expect, it } from "vitest";
import { PROVIDERS, createConfiguredModels } from "../../src/server/models.ts";

describe("Models 装配", () => {
  it("apiKey 经 CredentialStore 注入（本地可解析），未知 provider 抛错", async () => {
    const models = await createConfiguredModels({ provider: "opencode-go", apiKey: "sk-test-123", modelId: "m", port: 4319 });
    const auth = await models.getAuth("opencode-go");
    expect(auth).toBeDefined();
    expect(JSON.stringify(auth?.auth)).toContain("sk-test-123");

    await expect(
      createConfiguredModels({ provider: "nope", apiKey: "k", modelId: "m", port: 4319 }),
    ).rejects.toThrow("未知供应商");

    expect(Object.keys(PROVIDERS)).toContain("opencode-go");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/server/models.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 `src/server/models.ts`**

```ts
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createModels, type Models, type Provider } from "@earendil-works/pi-ai/models";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { WorkspaceConfig } from "../domain/config.ts";

/** 内置供应商白名单（README 同步列出；以各 provider 工厂 d.ts 为准）。 */
export const PROVIDERS: Record<string, () => Provider> = {
  "opencode-go": opencodeGoProvider,
  anthropic: anthropicProvider,
  openai: openaiProvider,
  deepseek: deepseekProvider,
  google: googleProvider,
  openrouter: openrouterProvider,
};

/**
 * 从全局配置构造 Models：apiKey 经 CredentialStore 注入（stored credential 优先于环境变量）；
 * 未知 provider 抛错（启动时可给出明确原因）。
 */
export async function createConfiguredModels(config: WorkspaceConfig): Promise<Models> {
  const factory = PROVIDERS[config.provider];
  if (factory === undefined) {
    throw new Error(`未知供应商 ${config.provider}（可选：${Object.keys(PROVIDERS).join(", ")}）`);
  }
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(config.provider, async () => ({ type: "api_key", key: config.apiKey }));
  const models = createModels({ credentials });
  models.setProvider(factory());
  return models;
}
```

- [ ] **Step 4: `pi-durable.ts` 的 `open()` 加 resume**

```ts
    async open() {
      harness = await Harness.open(
        await openNodeSqliteStorage(options.sqlitePath),
        { models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? options.root }) },
        ctx,
      );
      harness.resume();
    },
```

- [ ] **Step 5: 扩展 `src/server/http.ts`**

1. `ServerDeps` 扩展（并补 import：`parseRoomKey`/`mergeRoomMessages`/`countUnread`、`roomTranscripts`/`activeMemberSessions`/`sessionChains`/`findSessionOwner`/`newSession`、`sendToRoom`/`EmptyGroupError`/`KeyedQueue`、`markSeen`/`readSeen`/`unreadCounts`、`HarnessPort`、`employeeDir`/`projectDir`、`type Relation`（../app/conversations.ts））：

```ts
export type PumpLike = {
  register(convId: string, ref: { roomKey: string; memberId: string }): Promise<void>;
  unregister(convId: string): Promise<void>;
};

export type ServerDeps = {
  ws: Workspace;
  getConfig: () => WorkspaceConfig | undefined;
  getHarness: () => HarnessPort | undefined;
  queue: KeyedQueue;
  publicDir: string;
  pump?: PumpLike;
};
```

2. 在 `employees`/`projects` 分支后加 `rooms` 分支（放在 `json(res, 404)` 之前）：

```ts
          if (segments[1] === "rooms" && segments[2] !== undefined && harness !== undefined) {
            await handleRooms(deps, req, res, method, segments[2], segments.slice(3));
            return;
          }
```

其中 `const harness = deps.getHarness();` 提到 config 检查之后。

3. 新增函数：

```ts
function roomExists(ws: Workspace, relation: Relation): boolean {
  return relation.kind === "dm"
    ? fs.existsSync(employeeDir(ws, relation.employeeId))
    : fs.existsSync(projectDir(ws, relation.project));
}

async function handleRooms(
  deps: ServerDeps,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  rawKey: string,
  rest: string[],
): Promise<void> {
  const roomKey = decodeURIComponent(rawKey);
  const relation = parseRoomKey(roomKey);
  const harness = deps.getHarness();
  const config = deps.getConfig();
  if (relation === undefined || harness === undefined || config === undefined || !roomExists(deps.ws, relation)) {
    json(res, 404, { error: "房间不存在" });
    return;
  }
  const defaults = { model: { provider: config.provider, modelId: config.modelId } };

  if (rest.length === 1 && rest[0] === "messages" && method === "GET") {
    const members = await roomTranscripts(deps.ws, harness, relation);
    json(res, 200, { roomKey, messages: mergeRoomMessages(roomKey, members) });
    return;
  }

  if (rest.length === 1 && rest[0] === "messages" && method === "POST") {
    const body = (await readJsonBody(req)) as { text?: unknown; requestId?: unknown } | undefined;
    const text = typeof body?.text === "string" ? body.text : "";
    if (text.trim() === "") {
      json(res, 400, { error: "消息不能为空" });
      return;
    }
    const requestId = typeof body?.requestId === "string" && body.requestId !== "" ? body.requestId : undefined;
    try {
      const result = await sendToRoom(deps.ws, harness, relation, text, {
        queue: deps.queue,
        defaults,
        ...(requestId === undefined ? {} : { requestId }),
      });
      for (const delivery of result.deliveries) {
        await deps.pump?.register(delivery.convId, { roomKey, memberId: delivery.memberId });
      }
      json(res, 202, result);
    } catch (error) {
      if (error instanceof EmptyGroupError) {
        json(res, 400, { error: error.message });
        return;
      }
      throw error;
    }
    return;
  }

  if (rest.length === 1 && rest[0] === "new-session" && method === "POST") {
    const body = (await readJsonBody(req)) as { memberId?: unknown } | undefined;
    let speakerId: string;
    if (relation.kind === "dm") {
      speakerId = relation.employeeId;
    } else {
      const memberId = typeof body?.memberId === "string" ? body.memberId : "";
      if (!parseMembers(deps.ws, relation.project).includes(memberId)) {
        json(res, 400, { error: "memberId 必须是该群成员" });
        return;
      }
      speakerId = memberId;
    }
    const old = activeMemberSessions(deps.ws, relation).find((s) => s.memberId === speakerId);
    if (old !== undefined) await deps.pump?.unregister(old.convId);
    const convId = await newSession(deps.ws, harness, relation, speakerId, defaults);
    await deps.pump?.register(convId, { roomKey, memberId: speakerId });
    json(res, 200, { convId });
    return;
  }

  if (rest.length === 1 && rest[0] === "read" && method === "POST") {
    const members = await roomTranscripts(deps.ws, harness, relation);
    const merged = mergeRoomMessages(roomKey, members);
    const max = merged.reduce((acc, m) => Math.max(acc, Number(m.entryId)), 0);
    if (max > 0) markSeen(deps.ws, roomKey, String(max));
    const count = countUnread(merged, readSeen(deps.ws).seen[roomKey]);
    deps.hub?.broadcast({ type: "room.unread", roomKey, count });
    json(res, 200, { ok: true });
    return;
  }

  if (rest.length === 1 && rest[0] === "sessions" && method === "GET") {
    json(res, 200, { chains: sessionChains(deps.ws, relation) });
    return;
  }

  if (rest.length === 3 && rest[0] === "sessions" && rest[2] === "messages" && method === "GET") {
    const convId = decodeURIComponent(rest[1]!);
    const owner = findSessionOwner(deps.ws, relation, convId);
    if (owner === undefined) {
      json(res, 404, { error: "会话不存在" });
      return;
    }
    let alias: string | undefined;
    try {
      alias = loadEmployee(deps.ws, owner).alias;
    } catch {
      alias = undefined;
    }
    const messages = mergeRoomMessages(roomKey, [
      { memberId: owner, ...(alias === undefined ? {} : { alias }), convId, messages: await harness.transcript(convId) },
    ]);
    json(res, 200, { convId, memberId: owner, messages });
    return;
  }

  json(res, 404, { error: "接口不存在" });
}
```

4. 新增 `unread` 分支（在 rooms 分支旁）：

```ts
          if (segments[1] === "unread" && method === "GET" && harness !== undefined) {
            const rooms: { key: string; messages: ReturnType<typeof mergeRoomMessages> }[] = [];
            for (const employee of listEmployees(deps.ws)) {
              const key = `dm:${employee.id}`;
              rooms.push({ key, messages: mergeRoomMessages(key, await roomTranscripts(deps.ws, harness, { kind: "dm", employeeId: employee.id })) });
            }
            for (const project of listProjects(deps.ws)) {
              const key = `group:${project.id}`;
              rooms.push({ key, messages: mergeRoomMessages(key, await roomTranscripts(deps.ws, harness, { kind: "group", project: project.id })) });
            }
            json(res, 200, unreadCounts(rooms, readSeen(deps.ws)));
            return;
          }
```

（`employees`/`projects` 分支之后、404 之前。）

- [ ] **Step 6: 扩展 `src/server/main.ts`**

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkspace } from "../domain/paths.ts";
import { readConfig } from "../domain/config.ts";
import { KeyedQueue } from "../app/send.ts";
import { createPiHarness } from "../harness/pi-durable.ts";
import { createConfiguredModels } from "./models.ts";
import { createHttpServer } from "./http.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const root = process.env.OPENSTAFFS_ROOT ?? process.cwd();
  const ws = createWorkspace(root);
  const getConfig = () => readConfig(ws);
  const config = getConfig();

  let harness: ReturnType<typeof createPiHarness> | undefined;
  if (config !== undefined) {
    try {
      const models = await createConfiguredModels(config);
      harness = createPiHarness({ root, sqlitePath: path.join(root, ".openstaffs", "state.sqlite"), models });
      await harness.open();
    } catch (error) {
      console.error(`[openstaffs] 启动失败：${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  } else {
    console.log(`[openstaffs] 未配置：请编辑 ${path.join(root, ".openstaffs", "config.json")} 后重启服务`);
  }

  const server = createHttpServer({
    ws,
    getConfig,
    getHarness: () => harness,
    queue: new KeyedQueue(),
    publicDir: path.join(here, "..", "..", "public"),
  });
  const port = config?.port ?? 4319;
  server.listen(port, () => {
    console.log(`[openstaffs] 服务已启动：http://localhost:${port}（根目录 ${root}）`);
  });
}

void main();
```

（Task 10 会在这里补 pump 的构造与 registerAll。）

- [ ] **Step 7: 追加 http rooms 测试（`tests/server/http.test.ts` 追加 describe）**

```ts
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { createPiHarness } from "../../src/harness/pi-durable.ts";
import { KeyedQueue } from "../../src/app/send.ts";

async function startWithFaux(employeeIds: string[], groupMembers: string[]): Promise<{ base: string; close: () => Promise<void> }> {
  for (const id of employeeIds) {
    const dir = path.join(root, "agents", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "AGENTS.md"), `你是 ${id}。`);
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ alias: id === "alice" ? "爱丽丝" : id, provider: "faux", modelId: "faux-model" }));
  }
  if (groupMembers.length > 0) {
    const dir = path.join(root, "projects", "yt");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "members.md"), ["# 成员", ...groupMembers.map((m) => `- ${m}`), ""].join("\n"));
  }
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
  faux.setResponses(Array.from({ length: 20 }, (_, i) => fauxAssistantMessage(`收到${i}`)));
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = createPiHarness({ root, sqlitePath: path.join(root, `.openstaffs/state-${Date.now()}-${Math.random()}.sqlite`), models });
  await harness.open();
  const ws = createWorkspace(root);
  const server = createHttpServer({ ws, getConfig: () => configured, getHarness: () => harness, queue: new KeyedQueue(), publicDir });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await harness.close();
    },
  };
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("房间 API", () => {
  it("私聊：发消息 202 → 合并视图出现 boss 与员工回复（含 speaker 形状）", async () => {
    const { base, close } = await startWithFaux(["alice"], []);
    try {
      const post = await fetch(`${base}/api/rooms/dm:alice/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "你好", requestId: "t-1" }),
      });
      expect(post.status).toBe(202);
      const accepted = (await post.json()) as { roomMessageId: string; deliveries: { memberId: string; convId: string }[] };
      expect(accepted.deliveries[0]!.memberId).toBe("alice");

      const merged = await waitFor(async () => {
        const res = await fetch(`${base}/api/rooms/dm:alice/messages`);
        const body = (await res.json()) as { messages: { speaker: unknown; text: string; roomMessageId?: string }[] };
        return body.messages.some((m) => (m.speaker as { kind?: string }).kind === "employee") ? body : undefined;
      });
      expect(merged.messages[0]).toMatchObject({ speaker: { kind: "boss" }, text: "你好", roomMessageId: accepted.roomMessageId });
      expect(merged.messages[1]).toMatchObject({ speaker: { kind: "employee", id: "alice", alias: "爱丽丝" }, text: "收到0" });
    } finally {
      await close();
    }
  });

  it("群聊：@alice 定向、@老板 空投递、空成员群 400", async () => {
    const { base, close } = await startWithFaux(["alice", "bob"], ["alice", "bob"]);
    try {
      const mentioned = await fetch(`${base}/api/rooms/group:yt/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "@alice 做视频" }),
      });
      const accepted = (await mentioned.json()) as { deliveries: { memberId: string }[] };
      expect(accepted.deliveries.map((d) => d.memberId)).toEqual(["alice"]);

      const bossOnly = await fetch(`${base}/api/rooms/group:yt/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "@老板 收到" }),
      });
      expect(bossOnly.status).toBe(202);
      expect(((await bossOnly.json()) as { deliveries: unknown[] }).deliveries).toEqual([]);

      fs.rmSync(path.join(root, "projects", "yt", "members.md"));
      const empty = await fetch(`${base}/api/rooms/group:yt/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "在吗" }),
      });
      expect(empty.status).toBe(400);
    } finally {
      await close();
    }
  });

  it("new-session（群聊校验成员）、sessions、历史消息、read/unread", async () => {
    const { base, close } = await startWithFaux(["alice"], ["alice"]);
    try {
      // 先发一条消息建立链
      await fetch(`${base}/api/rooms/dm:alice/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "第一轮" }),
      });
      await waitFor(async () => {
        const res = await fetch(`${base}/api/rooms/dm:alice/messages`);
        const body = (await res.json()) as { messages: unknown[] };
        return body.messages.length >= 2 ? body : undefined;
      });

      const chains = (await (await fetch(`${base}/api/rooms/dm:alice/sessions`)).json()) as { chains: { memberId: string; rows: { id: string }[] }[] };
      expect(chains.chains[0]!.memberId).toBe("alice");
      const firstConv = chains.chains[0]!.rows[0]!.id;

      const newSessionRes = await fetch(`${base}/api/rooms/dm:alice/new-session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const { convId } = (await newSessionRes.json()) as { convId: string };
      expect(convId).not.toBe(firstConv);

      const after = (await (await fetch(`${base}/api/rooms/dm:alice/messages`)).json()) as { messages: unknown[] };
      expect(after.messages).toEqual([]); // 新会话视线清空

      const history = (await (await fetch(`${base}/api/rooms/dm:alice/sessions/${firstConv}/messages`)).json()) as { memberId: string; messages: unknown[] };
      expect(history.memberId).toBe("alice");
      expect(history.messages.length).toBeGreaterThanOrEqual(2);

      const badMember = await fetch(`${base}/api/rooms/group:yt/new-session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ memberId: "ghost" }),
      });
      expect(badMember.status).toBe(400);

      // unread：新会话为空 → 无法直接产生未读；此处只验证 read/unread 接口形状
      const read = await fetch(`${base}/api/rooms/dm:alice/read`, { method: "POST" });
      expect(read.status).toBe(200);
      const unread = (await (await fetch(`${base}/api/unread`)).json()) as { total: number; rooms: Record<string, number> };
      expect(typeof unread.total).toBe("number");
    } finally {
      await close();
    }
  });

  it("不存在的房间 404", async () => {
    const { base, close } = await startWithFaux([], []);
    try {
      expect((await fetch(`${base}/api/rooms/dm:nobody/messages`)).status).toBe(404);
      expect((await fetch(`${base}/api/rooms/group:none/messages`)).status).toBe(404);
    } finally {
      await close();
    }
  });
});
```

（`startWithFaux` 里的 `configured` 用文件顶部已定义的常量；注意 `afterEach` 已清理 `agents`/`projects`。）

- [ ] **Step 8: 跑测试确认通过**

Run: `npx vitest run tests/server/`
Expected: PASS（models + http 全部）。

- [ ] **Step 9: 全量验证 + 提交**

Run: `npm test && npm run typecheck`

```bash
git add src/server/models.ts src/server/http.ts src/server/main.ts src/harness/pi-durable.ts tests/server/models.test.ts tests/server/http.test.ts
git commit -m "feat(server): 房间 API（消息/新开/回看/已读/未读）+ Models 装配（key 注入）"
```

---

### Task 10: SSE 推流（server/sse.ts + server/pump.ts）

**Files:**
- Create: `src/server/sse.ts`
- Create: `src/server/pump.ts`
- Modify: `src/server/http.ts`（`/api/events` 路由 + deps.pump 类型对接）
- Modify: `src/server/main.ts`（构造 hub/pump、registerAll）
- Test: `tests/server/sse.test.ts`（新增）

**Interfaces:**
- Consumes: `HarnessPort.watch`（Task 5）；`normalizeChatMessage`/`mergeRoomMessages`/`parseRoomKey`（Task 3）；`readSeen`/`countUnread`（Task 4）；`roomTranscripts`/`activeMemberSessions`（Task 6）；`listEmployees`/`listProjects`。
- Produces:
  - `type ServerEvent`（5 种，见下）
  - `class SseHub { add(req, res): SseClientHandle; broadcast(event): void; get size(): number }`；`SseClientHandle = { pending: number; close(): void }`
  - `class Pump { constructor(deps); register(convId, ref); unregister(convId); registerAll(): Promise<void> }`（实现 `PumpLike`）

- [ ] **Step 1: 写 sse.test.ts（失败）**

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { createPiHarness } from "../../src/harness/pi-durable.ts";
import { KeyedQueue } from "../../src/app/send.ts";
import { SseHub, type ServerEvent } from "../../src/server/sse.ts";
import { Pump } from "../../src/server/pump.ts";
import { createHttpServer } from "../../src/server/http.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-sse-"));
afterEach(() => {
  fs.rmSync(path.join(root, "agents"), { recursive: true, force: true });
  fs.rmSync(path.join(root, "projects"), { recursive: true, force: true });
  fs.rmSync(path.join(root, ".openstaffs"), { recursive: true, force: true });
});

function fakeRes(): { res: ServerResponse; writes: string[] } {
  const writes: string[] = [];
  const res = {
    writeHead: () => res,
    write: (chunk: string) => {
      writes.push(String(chunk));
      return true;
    },
    once: () => res,
    end: () => {},
  } as unknown as ServerResponse;
  return { res, writes };
}

describe("SseHub", () => {
  it("广播写入客户端；慢客户端溢出丢弃 delta、保留权威事件；断开清理", async () => {
    const hub = new SseHub();
    const client = hub.add({ on: () => {} } as never, fakeRes().res);
    expect(hub.size).toBe(1);
    for (let i = 0; i < 300; i++) {
      hub.broadcast({ type: "room.delta", roomKey: "dm:a", convId: "c", memberId: "a", channel: "text", delta: `d${i}` });
    }
    hub.broadcast({ type: "room.message", roomKey: "dm:a", message: { convId: "c", entryId: "1", roomKey: "dm:a", speaker: { kind: "boss" }, text: "权威" } });
    expect(client.pending).toBeLessThanOrEqual(200);
    client.close();
    expect(hub.size).toBe(0);
  });
});

async function collect(body: ReadableStream<Uint8Array>, sink: ServerEvent[]): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (line !== undefined) sink.push(JSON.parse(line.slice(6)) as ServerEvent);
    }
  }
}

async function waitUntil(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil 超时");
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

describe("SSE 全链路", () => {
  it("发消息后推送：room.message(user) → delta → room.message(assistant) → room.unread", async () => {
    const dir = path.join(root, "agents", "alice");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "你是 alice。");
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ provider: "faux", modelId: "faux-model" }));

    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
    faux.setResponses([fauxAssistantMessage("流式回答内容")]);
    const models = createModels();
    models.setProvider(faux.provider);
    const ws = createWorkspace(root);
    const harness = createPiHarness({ root, sqlitePath: path.join(root, ".openstaffs", "state.sqlite"), models });
    await harness.open();

    const hub = new SseHub();
    const pump = new Pump({ ws, harness, hub });
    const server = createHttpServer({
      ws,
      getConfig: () => ({ provider: "faux", apiKey: "k", modelId: "faux-model", port: 4319 }),
      getHarness: () => harness,
      queue: new KeyedQueue(),
      publicDir: path.join(root, "public"),
      pump,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const events: ServerEvent[] = [];
    const sseRes = await fetch(`${base}/api/events`);
    void collect(sseRes.body!, events);

    try {
      const post = await fetch(`${base}/api/rooms/dm:alice/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "你好" }),
      });
      expect(post.status).toBe(202);

      await waitUntil(() => events.some((e) => e.type === "room.message" && e.message.speaker.kind === "employee"));
      expect(events.some((e) => e.type === "room.message" && e.message.speaker.kind === "boss" && e.message.text === "你好")).toBe(true);
      expect(events.some((e) => e.type === "room.delta" && e.delta.length > 0)).toBe(true);
      const assistant = events.find((e) => e.type === "room.message" && e.message.speaker.kind === "employee");
      expect(assistant?.type === "room.message" ? assistant.message.text : "").toContain("流式回答内容");
      await waitUntil(() => events.some((e) => e.type === "room.unread" && e.roomKey === "dm:alice"));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await harness.close();
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/server/sse.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 `src/server/sse.ts`**

```ts
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RoomMessage } from "../app/rooms.ts";

export type ServerEvent =
  | { type: "room.message"; roomKey: string; message: RoomMessage }
  | { type: "room.delta"; roomKey: string; convId: string; memberId: string; channel: "text" | "thinking"; delta: string }
  | { type: "room.activity"; roomKey: string; convId: string; memberId: string; kind: "run" | "tool"; phase: "start" | "end"; name?: string }
  | { type: "room.failed"; roomKey: string; convId: string; memberId: string; message: string }
  | { type: "room.unread"; roomKey: string; count: number };

export interface SseClientHandle {
  readonly pending: number;
  close(): void;
}

/** 每客户端积压上限；溢出丢增量（delta/activity），权威事件保留。 */
const MAX_PENDING = 200;

type Client = { queue: ServerEvent[]; flushing: boolean };

/** SSE 客户端管理与广播；泵只调用 broadcast，绝不 await 慢客户端。 */
export class SseHub {
  #clients = new Map<ServerResponse, Client>();

  add(req: IncomingMessage, res: ServerResponse): SseClientHandle {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    const client: Client = { queue: [], flushing: false };
    this.#clients.set(res, client);
    req.on("close", () => this.#remove(res));
    return {
      get pending() {
        return client.queue.length;
      },
      close: () => this.#remove(res),
    };
  }

  get size(): number {
    return this.#clients.size;
  }

  broadcast(event: ServerEvent): void {
    for (const [res, client] of this.#clients) {
      if (client.queue.length >= MAX_PENDING) {
        if (event.type === "room.delta" || event.type === "room.activity") continue;
        client.queue = client.queue.filter((e) => e.type !== "room.delta" && e.type !== "room.activity");
        if (client.queue.length >= MAX_PENDING) client.queue.shift();
      }
      client.queue.push(event);
      this.#flush(res, client);
    }
  }

  #flush(res: ServerResponse, client: Client): void {
    if (client.flushing) return;
    while (client.queue.length > 0) {
      const event = client.queue[0]!;
      const ok = res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      client.queue.shift();
      if (!ok) {
        client.flushing = true;
        res.once("drain", () => {
          client.flushing = false;
          this.#flush(res, client);
        });
        return;
      }
    }
  }

  #remove(res: ServerResponse): void {
    if (!this.#clients.has(res)) return;
    this.#clients.delete(res);
    res.end();
  }
}
```

- [ ] **Step 4: 实现 `src/server/pump.ts`**

```ts
import { loadEmployee, listEmployees } from "../domain/employee.ts";
import { listProjects } from "../domain/project.ts";
import type { Workspace } from "../domain/paths.ts";
import type { HarnessEvent, HarnessPort } from "../harness/port.ts";
import { activeMemberSessions, roomTranscripts } from "../app/conversations.ts";
import { countUnread } from "../app/rooms.ts";
import { mergeRoomMessages, normalizeChatMessage, parseRoomKey, type MemberTranscript } from "../app/rooms.ts";
import { readSeen } from "../app/unread.ts";
import type { SseHub } from "./sse.ts";

export type RoomRef = { roomKey: string; memberId: string; alias?: string };

type Deps = { ws: Workspace; harness: HarnessPort; hub: SseHub };

/** 订阅活跃会话的归一化事件并广播；员工发言后重算未读。 */
export class Pump {
  #refs = new Map<string, { ref: RoomRef; unsubscribe: () => Promise<void> }>();

  constructor(private readonly deps: Deps) {}

  async register(convId: string, ref: { roomKey: string; memberId: string }): Promise<void> {
    if (this.#refs.has(convId)) return;
    let alias: string | undefined;
    try {
      alias = loadEmployee(this.deps.ws, ref.memberId).alias;
    } catch {
      alias = undefined;
    }
    const fullRef: RoomRef = { ...ref, ...(alias === undefined ? {} : { alias }) };
    const unsubscribe = await this.deps.harness.watch(convId, (event) => this.#onEvent(convId, fullRef, event));
    this.#refs.set(convId, { ref: fullRef, unsubscribe });
  }

  async unregister(convId: string): Promise<void> {
    const entry = this.#refs.get(convId);
    if (entry === undefined) return;
    this.#refs.delete(convId);
    await entry.unsubscribe();
  }

  /** 启动/重启后扫描全部活跃会话并订阅。 */
  async registerAll(): Promise<void> {
    const ws = this.deps.ws;
    for (const employee of listEmployees(ws)) {
      for (const session of activeMemberSessions(ws, { kind: "dm", employeeId: employee.id })) {
        await this.register(session.convId, { roomKey: `dm:${employee.id}`, memberId: employee.id });
      }
    }
    for (const project of listProjects(ws)) {
      for (const session of activeMemberSessions(ws, { kind: "group", project: project.id })) {
        await this.register(session.convId, { roomKey: `group:${project.id}`, memberId: session.memberId });
      }
    }
  }

  #onEvent(convId: string, ref: RoomRef, event: HarnessEvent): void {
    const hub = this.deps.hub;
    switch (event.type) {
      case "delta":
        hub.broadcast({ type: "room.delta", roomKey: ref.roomKey, convId, memberId: ref.memberId, channel: event.channel, delta: event.delta });
        return;
      case "message": {
        const member: MemberTranscript = { memberId: ref.memberId, ...(ref.alias === undefined ? {} : { alias: ref.alias }), convId, messages: [] };
        const message = normalizeChatMessage(ref.roomKey, member, event.message);
        if (message === undefined) return;
        hub.broadcast({ type: "room.message", roomKey: ref.roomKey, message });
        if (message.speaker.kind === "employee") void this.#pushUnread(ref.roomKey);
        return;
      }
      case "run":
      case "tool":
        hub.broadcast({
          type: "room.activity", roomKey: ref.roomKey, convId, memberId: ref.memberId,
          kind: event.type, phase: event.phase,
          ...(event.type === "tool" ? { name: event.name } : {}),
        });
        return;
      case "failed":
        hub.broadcast({ type: "room.failed", roomKey: ref.roomKey, convId, memberId: ref.memberId, message: event.message });
        return;
    }
  }

  async #pushUnread(roomKey: string): Promise<void> {
    try {
      const relation = parseRoomKey(roomKey);
      if (relation === undefined) return;
      const members = await roomTranscripts(this.deps.ws, this.deps.harness, relation);
      const messages = mergeRoomMessages(roomKey, members);
      const seen = readSeen(this.deps.ws);
      this.deps.hub.broadcast({ type: "room.unread", roomKey, count: countUnread(messages, seen.seen[roomKey]) });
    } catch {
      // 未读重算失败不影响推流
    }
  }
}
```

- [ ] **Step 5: http.ts 接 `/api/events` 路由**

在 api 分支中（`status` 判断之后、`config === undefined` 判断**之前**，SSE 不需要配置？——**需要**：未配置时 409（spec：除 status 与静态外全 409）。放在 config 检查之后：

```ts
          if (segments[1] === "events" && method === "GET") {
            if (deps.hub === undefined) {
              json(res, 503, { error: "推流未启用" });
              return;
            }
            deps.hub.add(req, res);
            return;
          }
```

`ServerDeps` 增加 `hub?: SseHub`；顶部 import `type { SseHub } from "./sse.ts"`。

- [ ] **Step 6: main.ts 集成 hub/pump**

```ts
import { SseHub } from "./sse.ts";
import { Pump } from "./pump.ts";

// …harness open 之后（config !== undefined 分支内）：
  const hub = new SseHub();
  let pump: Pump | undefined;
  if (harness !== undefined) {
    pump = new Pump({ ws, harness, hub });
    await pump.registerAll();
  }

// createHttpServer deps 增加：
    pump: pump,
    hub: hub,
```

（`pump: pump` 直接满足 `PumpLike` 结构。）

- [ ] **Step 7: 跑测试确认通过**

Run: `npx vitest run tests/server/sse.test.ts`
Expected: PASS（背压单元 + 全链路）。

- [ ] **Step 8: 全量验证 + 提交**

Run: `npm test && npm run typecheck`

```bash
git add src/server/sse.ts src/server/pump.ts src/server/http.ts src/server/main.ts tests/server/sse.test.ts
git commit -m "feat(server): SSE 推流（SseHub 背压 + Pump 会话订阅/未读重算）"
```

---

### Task 11: 前端构建管线 + API 封装 + 引导页

**Files:**
- Create: `scripts/build-web.mjs`、`web/index.html`、`web/styles.css`、`web/api.ts`、`web/main.ts`
- Modify: `tsconfig.json`（include 加 `web`；lib 加 DOM）、`package.json`（scripts）、`.gitignore`（加 `public/`）
- Test: `tests/web/api.test.ts`（新增）

**Interfaces:**
- Consumes: `RoomMessage`（src/app/rooms.ts）、`ServerEvent`（src/server/sse.ts）——前端只 import **类型**（`import type`）。
- Produces（后续任务依赖）:
  - `api` 对象（status/employees/projects/messages/send/newSession/sessions/history/read/unread）
  - `type Status / EmployeeSummary / ProjectSummary / SendResult / ChainRow`
  - `web/main.ts` bootstrap（`status → 引导页 / 主界面`）+ `dispatch` 扩展点

- [ ] **Step 1: 安装 esbuild + 更新配置**

```bash
npm install --save-dev esbuild
```

`tsconfig.json` 改为：

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
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src", "tests", "web"]
}
```

`package.json` scripts：

```json
"scripts": {
  "test": "vitest run",
  "typecheck": "tsc --noEmit",
  "build:web": "node scripts/build-web.mjs",
  "start": "npm run build:web && node src/server/main.ts"
}
```

（若 Node 对 TS 类型剥离报错，start 改为 `node --experimental-strip-types src/server/main.ts` 并记 Ruling。）

`.gitignore` 追加一行 `public/`。

- [ ] **Step 2: 写 `scripts/build-web.mjs`**

```js
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const outDir = path.join(root, "public");
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(root, "web", "main.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: path.join(outDir, "app.js"),
  logLevel: "silent",
});

fs.copyFileSync(path.join(root, "web", "index.html"), path.join(outDir, "index.html"));
fs.copyFileSync(path.join(root, "web", "styles.css"), path.join(outDir, "styles.css"));
console.log("[build-web] public/ 已生成");
```

- [ ] **Step 3: 写 `web/index.html` 与 `web/styles.css`**

`web/index.html`：

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenStaffs</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/app.js"></script>
</body>
</html>
```

`web/styles.css`（极简 IM 风格；可微调，保持类名与 render.ts 一致）：

```css
* { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f5f6f8; color: #1f2329; }
#app { height: 100vh; }
.layout { display: flex; height: 100vh; }
.sidebar { width: 260px; border-right: 1px solid #e3e5e8; background: #fff; padding: 12px; overflow-y: auto; }
.sidebar h3 { font-size: 12px; color: #8a9099; margin: 14px 4px 6px; }
.item { display: flex; align-items: center; justify-content: space-between; width: 100%; border: 0; background: transparent; padding: 8px 10px; border-radius: 8px; cursor: pointer; font-size: 14px; text-align: left; }
.item:hover { background: #f0f2f5; }
.item.active { background: #e8f0fe; }
.badge { background: #f5222d; color: #fff; border-radius: 10px; font-size: 11px; padding: 1px 7px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #faad14; margin-left: 6px; }
.hint { color: #8a9099; font-size: 12px; padding: 0 4px; }
.chat { flex: 1; display: flex; flex-direction: column; }
.chat-head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid #e3e5e8; background: #fff; }
.chat-head .title { font-weight: 600; }
.chat-head button { border: 1px solid #d0d4d9; background: #fff; border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 13px; }
.msg-list { flex: 1; overflow-y: auto; padding: 16px; }
.msg { margin-bottom: 14px; max-width: 72%; }
.msg.boss { margin-left: auto; text-align: right; }
.msg-name { font-size: 12px; color: #8a9099; margin-bottom: 3px; }
.msg-text { display: inline-block; padding: 9px 12px; border-radius: 10px; background: #fff; border: 1px solid #e3e5e8; white-space: pre-wrap; word-break: break-word; text-align: left; }
.msg.boss .msg-text { background: #d6e4ff; border-color: #adc6ff; }
.msg.live .msg-text { color: #5a6270; }
.msg .tool-line { font-size: 12px; color: #8a9099; }
.msg.error .msg-text { background: #fff1f0; border-color: #ffa39e; color: #a8071a; }
.empty { color: #8a9099; text-align: center; margin-top: 40px; }
.composer { display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid #e3e5e8; background: #fff; }
.composer textarea { flex: 1; resize: none; height: 60px; border: 1px solid #d0d4d9; border-radius: 8px; padding: 8px 10px; font: inherit; }
.composer button { border: 0; background: #1677ff; color: #fff; border-radius: 8px; padding: 0 18px; cursor: pointer; }
.composer button:disabled { background: #b9c7e2; cursor: default; }
.setup { max-width: 720px; margin: 40px auto; background: #fff; border: 1px solid #e3e5e8; border-radius: 12px; padding: 28px; }
.setup pre { background: #f5f6f8; padding: 12px; border-radius: 8px; overflow-x: auto; }
.setup code { background: #f5f6f8; padding: 1px 5px; border-radius: 4px; }
.panel { flex: 1; overflow-y: auto; padding: 16px; background: #fff; }
.panel .session { display: flex; justify-content: space-between; padding: 8px 10px; border-bottom: 1px solid #f0f2f5; font-size: 13px; }
.panel .session button { border: 1px solid #d0d4d9; background: #fff; border-radius: 6px; cursor: pointer; font-size: 12px; }
```

- [ ] **Step 4: 写 `web/api.ts`（整体）；写 `tests/web/api.test.ts` 先跑失败**

`tests/web/api.test.ts`：

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../web/api.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(body: unknown, status = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  return calls;
}

describe("前端 API 封装", () => {
  it("send：POST JSON、roomKey 编码、返回解析", async () => {
    const calls = stubFetch({ roomMessageId: "rm_1", deliveries: [] });
    const result = await api.send("dm:alice", "你好", "req-1");
    expect(result.roomMessageId).toBe("rm_1");
    expect(calls[0]!.url).toBe("/api/rooms/dm%3Aalice/messages");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ text: "你好", requestId: "req-1" });
  });

  it("错误响应抛 Error（带服务端 message）", async () => {
    stubFetch({ error: "群还没有成员" }, 400);
    await expect(api.send("group:yt", "hi", "r")).rejects.toThrow("群还没有成员");
  });

  it("status/messages/read/unread 的 URL 形状", async () => {
    const calls = stubFetch({});
    await api.status();
    await api.messages("group:yt");
    await api.read("dm:alice");
    await api.unread();
    expect(calls.map((c) => c.url)).toEqual([
      "/api/status",
      "/api/rooms/group%3Ayt/messages",
      "/api/rooms/dm%3Aalice/read",
      "/api/unread",
    ]);
  });
});
```

Run: `npx vitest run tests/web/api.test.ts`
Expected: FAIL（web/api.ts 不存在）。

- [ ] **Step 5: 实现 `web/api.ts`**

```ts
import type { RoomMessage } from "../src/app/rooms.ts";

export type Status = { configured: boolean; root: string; port: number; provider?: string; modelId?: string };
export type EmployeeSummary = { id: string; alias?: string; model: { provider: string; modelId: string } };
export type ProjectSummary = { id: string; alias: string; members: { id: string; alias?: string }[] };
export type RoomMessages = { roomKey: string; messages: RoomMessage[] };
export type SendResult = { roomMessageId: string; deliveries: { memberId: string; convId: string }[] };
export type ChainRow = { id: string; started: string; ended: string | null; previous: string | null };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const text = await res.text();
  const body = text === "" ? undefined : (JSON.parse(text) as unknown);
  if (!res.ok) {
    const message = (body as { error?: string } | undefined)?.error ?? `HTTP ${res.status}`;
    throw new Error(message);
  }
  return body as T;
}

function roomPath(roomKey: string): string {
  return `/api/rooms/${encodeURIComponent(roomKey)}`;
}

export const api = {
  status: () => request<Status>("/api/status"),
  employees: () => request<EmployeeSummary[]>("/api/employees"),
  projects: () => request<ProjectSummary[]>("/api/projects"),
  messages: (roomKey: string) => request<RoomMessages>(`${roomPath(roomKey)}/messages`),
  send: (roomKey: string, text: string, requestId: string) =>
    request<SendResult>(`${roomPath(roomKey)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, requestId }),
    }),
  newSession: (roomKey: string, memberId?: string) =>
    request<{ convId: string }>(`${roomPath(roomKey)}/new-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(memberId === undefined ? {} : { memberId }),
    }),
  sessions: (roomKey: string) =>
    request<{ chains: { memberId: string; rows: ChainRow[] }[] }>(`${roomPath(roomKey)}/sessions`),
  history: (roomKey: string, convId: string) =>
    request<{ convId: string; memberId: string; messages: RoomMessage[] }>(
      `${roomPath(roomKey)}/sessions/${encodeURIComponent(convId)}/messages`,
    ),
  read: (roomKey: string) => request<{ ok: boolean }>(`${roomPath(roomKey)}/read`, { method: "POST" }),
  unread: () => request<{ total: number; rooms: Record<string, number> }>("/api/unread"),
};
```

Run: `npx vitest run tests/web/api.test.ts` → PASS。

- [ ] **Step 6: 写 `web/main.ts`（bootstrap + 引导页）**

```ts
import { api } from "./api.ts";

const app = document.getElementById("app")!;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

function setupPage(root: string, port: number): string {
  return `
    <main class="setup">
      <h1>OpenStaffs · 首次配置</h1>
      <p>请创建/编辑下面这个文件（若目录不存在请先创建 <code>.openstaffs/</code>），填入供应商、密钥与默认模型：</p>
      <pre>${escapeHtml(root)}/.openstaffs/config.json</pre>
      <pre>{
  "provider": "opencode-go",
  "apiKey": "你的密钥",
  "modelId": "deepseek-v4.1-flash",
  "port": ${port}
}</pre>
      <p>可选 provider：opencode-go / anthropic / openai / deepseek / google / openrouter。</p>
      <p>保存配置后：Ctrl+C 停止服务 → 重新 <code>npm start</code> → 刷新本页。</p>
      <p class="hint">员工与项目不需要在这里配置：直接在 <code>agents/</code> 与 <code>projects/</code> 下建文件夹即可（详见 README.md）。</p>
    </main>`;
}

async function main(): Promise<void> {
  try {
    const status = await api.status();
    if (!status.configured) {
      app.innerHTML = setupPage(status.root, status.port);
      return;
    }
    app.innerHTML = `<main class="setup"><h1>OpenStaffs</h1><p>已配置，主界面将在下一个任务接入。</p></main>`;
  } catch (error) {
    app.innerHTML = `<main class="setup"><h1>OpenStaffs</h1><p>服务不可用：${escapeHtml(error instanceof Error ? error.message : String(error))}</p></main>`;
  }
}

void main();
```

- [ ] **Step 7: 构建 + 手动冒烟**

```bash
npm run build:web
ls public/            # 期望：app.js index.html styles.css
npm test && npm run typecheck
```

手动：`npm start`（后台）→ 浏览器打开 `http://localhost:4319` → 未配置时应看到引导页；curl 验证 `public/` 被伺服：

```bash
(node src/server/main.ts > /tmp/oss.log 2>&1 & echo $! > /tmp/oss.pid)
sleep 1
curl -s http://127.0.0.1:4319/ | head -3
curl -s http://127.0.0.1:4319/api/status
kill $(cat /tmp/oss.pid)
```

Expected: HTML 首页内容 + `{"configured":false,...}`。

- [ ] **Step 8: 提交**

```bash
git add scripts/build-web.mjs web/ tsconfig.json package.json package-lock.json .gitignore tests/web/api.test.ts
git commit -m "feat(web): 构建管线（esbuild）、API 封装、引导页"
```

---

### Task 12: 前端状态归约（web/state.ts）

**Files:**
- Create: `web/state.ts`
- Test: `tests/web/state.test.ts`

**Interfaces:**
- Consumes: `RoomMessage`（类型）、`ServerEvent`（类型）、`EmployeeSummary`/`ProjectSummary`（web/api.ts）。
- Produces（后续任务依赖）:
  - `type Live = { convId; memberId; text; thinking; tools: string[]; error?: string }`
  - `type State = { configured; employees; projects; roomKey?; messages; live; unread; busy; panel? }`
  - `type UiEvent`（status/employees/projects/room/close-room/panel/unread/sse）
  - `initialState`、`reduce(state, event)`、`selectView(state)`

- [ ] **Step 1: 写失败测试（`tests/web/state.test.ts`）**

```ts
import { describe, expect, it } from "vitest";
import { initialState, reduce, selectView, type State } from "../../web/state.ts";
import type { RoomMessage } from "../../src/app/rooms.ts";

function msg(entryId: string, convId: string, kind: "boss" | "employee", text: string, roomMessageId?: string): RoomMessage {
  return kind === "boss"
    ? { convId, entryId, roomKey: "dm:alice", speaker: { kind: "boss" }, text, ...(roomMessageId === undefined ? {} : { roomMessageId }) }
    : { convId, entryId, roomKey: "dm:alice", speaker: { kind: "employee", id: "alice" }, text };
}

function inRoom(): State {
  let state = reduce(initialState, { type: "status", configured: true });
  state = reduce(state, { type: "room", roomKey: "dm:alice", messages: [] });
  return state;
}

describe("前端状态归约", () => {
  it("selectView：configured 决定引导页/主界面", () => {
    expect(selectView(initialState)).toBe("setup");
    expect(selectView(reduce(initialState, { type: "status", configured: true }))).toBe("main");
  });

  it("room.message 增量合并：幂等（复合键/roomMessageId 双去重）、保持排序", () => {
    let state = inRoom();
    state = reduce(state, { type: "sse", event: { type: "room.message", roomKey: "dm:alice", message: msg("10", "c1", "boss", "任务", "rm_1") } });
    state = reduce(state, { type: "sse", event: { type: "room.message", roomKey: "dm:alice", message: msg("11", "c1", "employee", "回答") } });
    // 重复投递：应被忽略
    state = reduce(state, { type: "sse", event: { type: "room.message", roomKey: "dm:alice", message: msg("10", "c1", "boss", "任务", "rm_1") } });
    // 其他成员会话的同一次广播副本：也应被忽略（roomMessageId 已见）
    state = reduce(state, { type: "sse", event: { type: "room.message", roomKey: "dm:alice", message: msg("12", "c2", "boss", "任务", "rm_1") } });
    expect(state.messages.map((m) => m.entryId)).toEqual(["10", "11"]);
  });

  it("delta 聚合到 live 气泡；员工正式消息到达后清除 live", () => {
    let state = inRoom();
    state = reduce(state, { type: "sse", event: { type: "room.delta", roomKey: "dm:alice", convId: "c1", memberId: "alice", channel: "text", delta: "你" } });
    state = reduce(state, { type: "sse", event: { type: "room.delta", roomKey: "dm:alice", convId: "c1", memberId: "alice", channel: "text", delta: "好" } });
    expect(state.live["c1"]?.text).toBe("你好");
    state = reduce(state, { type: "sse", event: { type: "room.message", roomKey: "dm:alice", message: msg("20", "c1", "employee", "你好") } });
    expect(state.live["c1"]).toBeUndefined();
  });

  it("忙绿与工具活动、失败事件", () => {
    let state = inRoom();
    state = reduce(state, { type: "sse", event: { type: "room.activity", roomKey: "dm:alice", convId: "c1", memberId: "alice", kind: "run", phase: "start" } });
    expect(state.busy["alice"]).toBe(true);
    state = reduce(state, { type: "sse", event: { type: "room.activity", roomKey: "dm:alice", convId: "c1", memberId: "alice", kind: "tool", phase: "start", name: "write" } });
    expect(state.live["c1"]?.tools).toEqual(["write"]);
    state = reduce(state, { type: "sse", event: { type: "room.failed", roomKey: "dm:alice", convId: "c1", memberId: "alice", message: "模型不可用" } });
    expect(state.live["c1"]?.error).toBe("模型不可用");
    state = reduce(state, { type: "sse", event: { type: "room.activity", roomKey: "dm:alice", convId: "c1", memberId: "alice", kind: "run", phase: "end" } });
    expect(state.busy["alice"]).toBe(false);
  });

  it("非当前房间事件：只更新忙碌/未读，不污染消息", () => {
    let state = inRoom();
    state = reduce(state, { type: "sse", event: { type: "room.message", roomKey: "group:yt", message: msg("30", "cx", "employee", "别处") } });
    expect(state.messages).toHaveLength(0);
    state = reduce(state, { type: "sse", event: { type: "room.unread", roomKey: "group:yt", count: 2 } });
    expect(state.unread["group:yt"]).toBe(2);
  });

  it("room / close-room / unread / panel 状态迁移", () => {
    let state = inRoom();
    state = reduce(state, { type: "panel", panel: "history" });
    expect(state.panel).toBe("history");
    state = reduce(state, { type: "room", roomKey: "group:yt", messages: [msg("1", "c1", "boss", "hi")] });
    expect(state.roomKey).toBe("group:yt");
    expect(state.panel).toBeUndefined();
    state = reduce(state, { type: "close-room" });
    expect(state.roomKey).toBeUndefined();
    expect(state.messages).toHaveLength(0);
  });
});
```

Run: `npx vitest run tests/web/state.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 2: 实现 `web/state.ts`**

```ts
import type { RoomMessage } from "../src/app/rooms.ts";
import type { ServerEvent } from "../src/server/sse.ts";
import type { EmployeeSummary, ProjectSummary } from "./api.ts";

export type Live = {
  convId: string;
  memberId: string;
  text: string;
  thinking: string;
  tools: string[];
  error?: string;
};

export type State = {
  configured: boolean;
  employees: EmployeeSummary[];
  projects: ProjectSummary[];
  roomKey?: string;
  messages: RoomMessage[];
  live: Record<string, Live>;
  unread: Record<string, number>;
  busy: Record<string, boolean>;
  panel?: "history";
};

export const initialState: State = {
  configured: false,
  employees: [],
  projects: [],
  messages: [],
  live: {},
  unread: {},
  busy: {},
};

export type UiEvent =
  | { type: "status"; configured: boolean }
  | { type: "employees"; list: EmployeeSummary[] }
  | { type: "projects"; list: ProjectSummary[] }
  | { type: "room"; roomKey: string; messages: RoomMessage[] }
  | { type: "close-room" }
  | { type: "panel"; panel?: "history" }
  | { type: "unread"; unread: { total: number; rooms: Record<string, number> } }
  | { type: "sse"; event: ServerEvent };

export function selectView(state: State): "setup" | "main" {
  return state.configured ? "main" : "setup";
}

function messageKey(message: RoomMessage): string {
  return `${message.convId}:${message.entryId}`;
}

/** 增量合并：复合键去重；同 roomMessageId 的广播副本已见则不重复（先到先显，历史不动）。 */
function appendMessage(messages: RoomMessage[], incoming: RoomMessage): RoomMessage[] {
  if (messages.some((m) => messageKey(m) === messageKey(incoming))) return messages;
  if (incoming.roomMessageId !== undefined && messages.some((m) => m.roomMessageId === incoming.roomMessageId)) {
    return messages;
  }
  return [...messages, incoming].sort((a, b) => Number(a.entryId) - Number(b.entryId));
}

function liveOf(state: State, convId: string, memberId: string): Live {
  return state.live[convId] ?? { convId, memberId, text: "", thinking: "", tools: [] };
}

export function reduce(state: State, event: UiEvent): State {
  switch (event.type) {
    case "status":
      return { ...state, configured: event.configured };
    case "employees":
      return { ...state, employees: event.list };
    case "projects":
      return { ...state, projects: event.list };
    case "room":
      return { ...state, roomKey: event.roomKey, messages: event.messages, live: {}, panel: undefined };
    case "close-room":
      return { ...state, roomKey: undefined, messages: [], live: {}, panel: undefined };
    case "panel":
      return { ...state, panel: event.panel };
    case "unread":
      return { ...state, unread: event.unread.rooms };
    case "sse":
      return reduceSse(state, event.event);
  }
}

function reduceSse(state: State, event: ServerEvent): State {
  if (event.type === "room.unread") {
    return { ...state, unread: { ...state.unread, [event.roomKey]: event.count } };
  }
  if (state.roomKey !== event.roomKey) {
    if (event.type === "room.activity" && event.kind === "run") {
      return { ...state, busy: { ...state.busy, [event.memberId]: event.phase === "start" } };
    }
    return state;
  }
  switch (event.type) {
    case "room.message": {
      const live = { ...state.live };
      if (event.message.speaker.kind === "employee") delete live[event.message.convId];
      return { ...state, messages: appendMessage(state.messages, event.message), live };
    }
    case "room.delta": {
      const existing = liveOf(state, event.convId, event.memberId);
      const updated =
        event.channel === "text"
          ? { ...existing, text: existing.text + event.delta }
          : { ...existing, thinking: existing.thinking + event.delta };
      return { ...state, live: { ...state.live, [event.convId]: updated } };
    }
    case "room.activity": {
      if (event.kind === "run") {
        return { ...state, busy: { ...state.busy, [event.memberId]: event.phase === "start" } };
      }
      const existing = liveOf(state, event.convId, event.memberId);
      const tools = event.phase === "start" ? [...existing.tools, event.name ?? ""] : existing.tools.slice(0, -1);
      return { ...state, live: { ...state.live, [event.convId]: { ...existing, tools } } };
    }
    case "room.failed": {
      const existing = liveOf(state, event.convId, event.memberId);
      return { ...state, live: { ...state.live, [event.convId]: { ...existing, error: event.message } } };
    }
    default:
      return state;
  }
}
```

- [ ] **Step 3: 跑测试确认通过**

Run: `npx vitest run tests/web/`
Expected: PASS。

- [ ] **Step 4: 全量验证 + 提交**

Run: `npm test && npm run typecheck`

```bash
git add web/state.ts tests/web/state.test.ts
git commit -m "feat(web): 状态归约（增量去重、delta 聚合、忙碌/未读）"
```

---

### Task 13: 前端主界面（列表 / 聊天 / 发送）

**Files:**
- Create: `web/render.ts`
- Modify: `web/main.ts`（完整接线：renderAll / renderDynamic 双档渲染）
- Test: `tests/web/render.test.ts`（新增）

**Interfaces:**
- Consumes: `State`/`Live`（web/state.ts）、`RoomMessage`（类型）、`api`（web/api.ts）。
- Produces（后续任务依赖）:
  - `escapeHtml`、`setupPage(root, port)`、`sidebarHtml(state)`、`messageHtml(message)`、`messagesHtml(messages)`、`liveHtml(live)`、`chatHtml(state)`、`layoutHtml(state)`
  - `web/main.ts` 的 `dispatch(event, mode)`、`renderAll()`、`renderDynamic()`、`enterRoom(roomKey)`、`sendCurrent()`（Task 14 在其上扩展）

- [ ] **Step 1: 写 render 测试（失败）**

`tests/web/render.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { messageHtml, messagesHtml } from "../../web/render.ts";
import type { RoomMessage } from "../../src/app/rooms.ts";

describe("渲染", () => {
  it("HTML 转义与 boss/员工布局类名", () => {
    const boss: RoomMessage = { convId: "c1", entryId: "1", roomKey: "dm:a", speaker: { kind: "boss" }, text: "<script>alert(1)</script>" };
    const html = messageHtml(boss);
    expect(html).toContain('class="msg boss"');
    expect(html).toContain("老板");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("员工消息显示 alias；空列表提示", () => {
    const employee: RoomMessage = { convId: "c1", entryId: "2", roomKey: "dm:a", speaker: { kind: "employee", id: "alice", alias: "爱丽丝" }, text: "好" };
    expect(messageHtml(employee)).toContain('class="msg employee"');
    expect(messageHtml(employee)).toContain("爱丽丝");
    expect(messagesHtml([])).toContain("还没有消息");
  });
});
```

Run: `npx vitest run tests/web/render.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 2: 实现 `web/render.ts`**

```ts
import type { RoomMessage } from "../src/app/rooms.ts";
import type { Live, State } from "./state.ts";

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

export function setupPage(root: string, port: number): string {
  return `
    <main class="setup">
      <h1>OpenStaffs · 首次配置</h1>
      <p>请创建/编辑下面这个文件（若目录不存在请先创建 <code>.openstaffs/</code>），填入供应商、密钥与默认模型：</p>
      <pre>${escapeHtml(root)}/.openstaffs/config.json</pre>
      <pre>{
  "provider": "opencode-go",
  "apiKey": "你的密钥",
  "modelId": "deepseek-v4.1-flash",
  "port": ${port}
}</pre>
      <p>可选 provider：opencode-go / anthropic / openai / deepseek / google / openrouter。</p>
      <p>保存配置后：Ctrl+C 停止服务 → 重新 <code>npm start</code> → 刷新本页。</p>
      <p class="hint">员工与项目不需要在这里配置：直接在 <code>agents/</code> 与 <code>projects/</code> 下建文件夹即可（详见 README.md）。</p>
    </main>`;
}

export function sidebarHtml(state: State): string {
  const employeeItems = state.employees
    .map((employee) => {
      const roomKey = `dm:${employee.id}`;
      const unread = state.unread[roomKey] ?? 0;
      const busy = state.busy[employee.id] === true ? '<span class="dot"></span>' : "";
      const active = state.roomKey === roomKey ? " active" : "";
      return `<button class="item${active}" data-room="${escapeHtml(roomKey)}"><span>${escapeHtml(employee.alias ?? employee.id)}${busy}</span>${unread > 0 ? `<span class="badge">${unread}</span>` : ""}</button>`;
    })
    .join("");
  const projectItems = state.projects
    .map((project) => {
      const roomKey = `group:${project.id}`;
      const unread = state.unread[roomKey] ?? 0;
      const busy = project.members.some((m) => state.busy[m.id] === true) ? '<span class="dot"></span>' : "";
      const active = state.roomKey === roomKey ? " active" : "";
      return `<button class="item${active}" data-room="${escapeHtml(roomKey)}"><span>${escapeHtml(project.alias)}${busy}</span>${unread > 0 ? `<span class="badge">${unread}</span>` : ""}</button>`;
    })
    .join("");
  return `<aside class="sidebar" id="sidebar">
    <h3>员工</h3>${employeeItems || `<p class="hint">还没有员工：在 agents/ 下创建目录并写 AGENTS.md（见 README.md）。</p>`}
    <h3>项目</h3>${projectItems || `<p class="hint">还没有项目：在 projects/ 下创建目录并写 members.md（见 README.md）。</p>`}
  </aside>`;
}

export function messageHtml(message: RoomMessage): string {
  const boss = message.speaker.kind === "boss";
  const name = boss ? "老板" : (message.speaker.alias ?? message.speaker.id);
  return `<div class="msg ${boss ? "boss" : "employee"}"><div class="msg-name">${escapeHtml(name)}</div><div class="msg-text">${escapeHtml(message.text)}</div></div>`;
}

export function messagesHtml(messages: RoomMessage[]): string {
  return messages.length === 0 ? `<div class="empty">还没有消息，发一条试试。</div>` : messages.map(messageHtml).join("");
}

export function liveHtml(live: Record<string, Live>): string {
  return Object.values(live)
    .map((entry) => {
      const body =
        entry.error !== undefined
          ? `<div class="msg-text">⚠️ ${escapeHtml(entry.error)}</div>`
          : `<div class="msg-text">${escapeHtml(entry.text) || "…"}</div>`;
      const tool =
        entry.tools.length > 0
          ? `<div class="tool-line">正在执行 ${escapeHtml(entry.tools[entry.tools.length - 1]!)}…</div>`
          : "";
      return `<div class="msg employee live${entry.error !== undefined ? " error" : ""}"><div class="msg-name">${escapeHtml(entry.memberId)}</div>${body}${tool}</div>`;
    })
    .join("");
}

export function chatHtml(state: State): string {
  if (state.roomKey === undefined) {
    return `<section class="chat"><div class="empty">从左侧选择一个员工或项目开始对话。</div></section>`;
  }
  const isGroup = state.roomKey.startsWith("group:");
  const project = isGroup ? state.projects.find((p) => `group:${p.id}` === state.roomKey) : undefined;
  const employee = !isGroup ? state.employees.find((e) => `dm:${e.id}` === state.roomKey) : undefined;
  const title = isGroup ? (project?.alias ?? state.roomKey) : (employee?.alias ?? employee?.id ?? state.roomKey);
  const memberSelect = isGroup
    ? `<select id="member-select">${(project?.members ?? [])
        .map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.alias ?? m.id)}</option>`)
        .join("")}</select>`
    : "";
  return `<section class="chat">
    <header class="chat-head">
      <span class="title">${escapeHtml(title)}</span>
      ${memberSelect}
      <button id="btn-new-session">新开会话</button>
      <button id="btn-history">历史</button>
    </header>
    <div class="msg-list" id="msg-list">
      <div id="messages-part">${messagesHtml(state.messages)}</div>
      <div id="live-area">${liveHtml(state.live)}</div>
    </div>
    <div class="composer">
      <textarea id="composer-input" placeholder="输入消息，Enter 发送（@成员 定向触发；不 @ 则广播）"></textarea>
      <button id="composer-send">发送</button>
    </div>
  </section>`;
}

export function layoutHtml(state: State): string {
  return `<div class="layout">${sidebarHtml(state)}${chatHtml(state)}</div>`;
}
```

- [ ] **Step 3: 重写 `web/main.ts`（双档渲染 + 完整接线）**

```ts
import { api, type Status } from "./api.ts";
import { initialState, reduce, selectView, type State, type UiEvent } from "./state.ts";
import { escapeHtml, layoutHtml, liveHtml, messagesHtml, setupPage, sidebarHtml } from "./render.ts";

const app = document.getElementById("app")!;
let state: State = initialState;
let status: Status | undefined;
let sending = false;

function dispatch(event: UiEvent, mode: "all" | "dynamic" = "dynamic"): void {
  state = reduce(state, event);
  if (mode === "all") renderAll();
  else renderDynamic();
}

function renderAll(): void {
  if (selectView(state) === "setup") {
    app.innerHTML = setupPage(status?.root ?? "", status?.port ?? 4319);
    return;
  }
  app.innerHTML = layoutHtml(state);
  bindEvents();
  scrollToBottom(true);
}

/** SSE 高频更新：只重渲侧栏 / 消息 / live 三个容器，绝不重建输入框。 */
function renderDynamic(): void {
  if (selectView(state) === "setup") return;
  const sidebar = document.getElementById("sidebar");
  if (sidebar !== null) sidebar.outerHTML = sidebarHtml(state);
  const messagesPart = document.getElementById("messages-part");
  const liveArea = document.getElementById("live-area");
  if (messagesPart !== null && liveArea !== null) {
    const list = document.getElementById("msg-list");
    const nearBottom = list === null || list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    messagesPart.innerHTML = messagesHtml(state.messages);
    liveArea.innerHTML = liveHtml(state.live);
    if (nearBottom) scrollToBottom(true);
  }
}

function scrollToBottom(force: boolean): void {
  const list = document.getElementById("msg-list");
  if (list !== null && force) list.scrollTop = list.scrollHeight;
}

function bindEvents(): void {
  for (const element of app.querySelectorAll<HTMLElement>("[data-room]")) {
    element.addEventListener("click", () => void enterRoom(element.dataset.room!));
  }
  document.getElementById("composer-send")?.addEventListener("click", () => void sendCurrent());
  const input = document.getElementById("composer-input");
  input?.addEventListener("keydown", (event) => {
    const key = (event as KeyboardEvent).key;
    if (key === "Enter" && !(event as KeyboardEvent).shiftKey) {
      event.preventDefault();
      void sendCurrent();
    }
  });
  document.getElementById("btn-new-session")?.addEventListener("click", () => void newSession());
  document.getElementById("btn-history")?.addEventListener("click", () => void openHistory());
}

async function refreshUnread(): Promise<void> {
  const unread = await api.unread();
  dispatch({ type: "unread", unread });
}

async function enterRoom(roomKey: string): Promise<void> {
  const { messages } = await api.messages(roomKey);
  dispatch({ type: "room", roomKey, messages }, "all");
  void api.read(roomKey).then(refreshUnread);
}

async function sendCurrent(): Promise<void> {
  if (sending || state.roomKey === undefined) return;
  const roomKey = state.roomKey;
  const input = document.getElementById("composer-input") as HTMLTextAreaElement | null;
  const text = input?.value.trim() ?? "";
  if (text === "") return;
  const button = document.getElementById("composer-send") as HTMLButtonElement | null;
  sending = true;
  if (button !== null) button.disabled = true;
  try {
    const result = await api.send(roomKey, text, crypto.randomUUID());
    if (input !== null) input.value = "";
    if (result.deliveries.length === 0) window.alert("未触发任何成员（可能只 @ 了老板）");
  } catch (error) {
    window.alert(error instanceof Error ? error.message : String(error));
  } finally {
    sending = false;
    if (button !== null) button.disabled = false;
  }
}

async function newSession(): Promise<void> {
  if (state.roomKey === undefined) return;
  const roomKey = state.roomKey;
  const isGroup = roomKey.startsWith("group:");
  let memberId: string | undefined;
  if (isGroup) {
    const select = document.getElementById("member-select") as HTMLSelectElement | null;
    memberId = select?.value;
    if (memberId === undefined || memberId === "") return;
  }
  const label = isGroup ? `成员 ${memberId} 的` : "";
  if (!window.confirm(`确定新开${label}会话？当前会话将结束（可在历史中回看）。`)) return;
  await api.newSession(roomKey, memberId);
  await enterRoom(roomKey);
}

async function openHistory(): Promise<void> {
  if (state.roomKey === undefined) return;
  const roomKey = state.roomKey;
  const { chains } = await api.sessions(roomKey);
  const rows = chains
    .flatMap((chain) => chain.rows.map((row) => ({ ...row, memberId: chain.memberId })))
    .sort((a, b) => (a.started < b.started ? 1 : -1));
  app.innerHTML = `<div class="layout">${sidebarHtml(state)}<div class="panel">
    <h3>历史会话（只读）</h3>
    ${rows
      .map(
        (row) =>
          `<div class="session"><span>${escapeHtml(row.memberId)} · ${escapeHtml(row.started.slice(0, 19).replace("T", " "))}${row.ended === null ? "（进行中）" : ""}</span><button data-conv="${escapeHtml(row.id)}">查看</button></div>`,
      )
      .join("") || `<p class="hint">还没有会话。</p>`}
    <p><button id="btn-history-back">返回聊天</button></p>
  </div></div>`;
  document.getElementById("btn-history-back")?.addEventListener("click", () => renderAll());
  for (const element of app.querySelectorAll<HTMLElement>("[data-conv]")) {
    const convId = element.dataset.conv!;
    element.addEventListener("click", () => void loadHistoryView(roomKey, convId));
  }
}

async function loadHistoryView(roomKey: string, convId: string): Promise<void> {
  const { messages } = await api.history(roomKey, convId);
  app.innerHTML = `<div class="layout">${sidebarHtml(state)}<div class="panel">
    <p><button id="btn-history-back">返回列表</button></p>
    ${messagesHtml(messages)}
  </div></div>`;
  document.getElementById("btn-history-back")?.addEventListener("click", () => void openHistory());
}

async function main(): Promise<void> {
  try {
    status = await api.status();
    dispatch({ type: "status", configured: status.configured }, "all");
    if (!status.configured) return;
    const [employees, projects, unread] = await Promise.all([api.employees(), api.projects(), api.unread()]);
    dispatch({ type: "employees", list: employees }, "all");
    dispatch({ type: "projects", list: projects }, "all");
    dispatch({ type: "unread", unread }, "all");
  } catch (error) {
    app.innerHTML = `<main class="setup"><h1>OpenStaffs</h1><p>服务不可用：${escapeHtml(error instanceof Error ? error.message : String(error))}</p></main>`;
  }
}

void main();
```

（`newSession()` 与 `openHistory()` 在此任务中已可用；SSE 接入在 Task 14。）

- [ ] **Step 4: 跑测试 + 构建 + 手动验收**

```bash
npx vitest run tests/web/ && npm run build:web && npm test && npm run typecheck
```

手动验收（需已配置 config.json + 有一个员工目录）：

```bash
npm start
```

浏览器 `http://localhost:4319`：① 左侧出现员工 → 点击进入 → 输入消息 Enter 发送；② 员工回复出现在左侧气泡（此时无 SSE，需刷新页面才能看到回复——属预期，Task 14 接流式）；③ 发送后未读红点行为正常。

- [ ] **Step 5: 提交**

```bash
git add web/render.ts web/main.ts tests/web/render.test.ts
git commit -m "feat(web): 主界面（列表/聊天/发送/新开会话/历史面板）"
```

---

### Task 14: 前端实时（SSE 接流 + 未读时机 + 回看增强）

**Files:**
- Create: `web/sse.ts`
- Modify: `web/main.ts`（接流 + 已读时机 + 重连补齐）
- Test: 手动验收（实时性由 Task 10 的服务端测试覆盖；前端为接线）

**Interfaces:**
- Consumes: `ServerEvent`（类型）；`api`；`state.reduce`。
- Produces: `connectEvents({ onEvent, onReconnect })`（web/sse.ts）。

- [ ] **Step 1: 写 `web/sse.ts`**

```ts
import type { ServerEvent } from "../src/server/sse.ts";

const EVENT_TYPES = ["room.message", "room.delta", "room.activity", "room.failed", "room.unread"] as const;

/** 连接 SSE；返回断开函数。断线由 EventSource 自动重连，重连成功后回调 onReconnect（用于重拉补齐）。 */
export function connectEvents(handlers: {
  onEvent: (event: ServerEvent) => void;
  onReconnect: () => void;
}): () => void {
  const source = new EventSource("/api/events");
  for (const type of EVENT_TYPES) {
    source.addEventListener(type, (event) => {
      try {
        handlers.onEvent(JSON.parse((event as MessageEvent).data) as ServerEvent);
      } catch {
        // 忽略坏帧
      }
    });
  }
  source.addEventListener("open", () => handlers.onReconnect());
  return () => source.close();
}
```

- [ ] **Step 2: 修改 `web/main.ts`（接线）**

1. 顶部 import 增加：

```ts
import { connectEvents } from "./sse.ts";
import type { ServerEvent } from "../src/server/sse.ts";
```

2. **模块级**新增已读防抖 `scheduleRead()` 与事件入口 `onServerEvent()`；在 `main()` 里接线 `connectEvents`（加载列表之后）：

```ts
let readTimer: number | undefined;
function scheduleRead(): void {
  if (document.visibilityState !== "visible" || state.roomKey === undefined) return;
  const roomKey = state.roomKey;
  window.clearTimeout(readTimer);
  readTimer = window.setTimeout(() => {
    void api.read(roomKey).then(refreshUnread);
  }, 600);
}

function onServerEvent(event: ServerEvent): void {
  if (event.type !== "room.message" || state.roomKey !== event.roomKey || event.message.speaker.kind === "boss") {
    dispatch({ type: "sse", event });
    return;
  }
  dispatch({ type: "sse", event });
  scheduleRead(); // 当前房间有新消息且窗口可见 → 防抖标记已读
}
```

3. `main()` 中在列表加载完毕后：

```ts
    connectEvents({
      onEvent: onServerEvent,
      onReconnect: () => void refreshAll(),
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && state.roomKey !== undefined) {
        void api.read(state.roomKey).then(refreshUnread);
      }
    });
```

4. 新增 `refreshAll()`：

```ts
async function refreshAll(): Promise<void> {
  const [employees, projects, unread] = await Promise.all([api.employees(), api.projects(), api.unread()]);
  dispatch({ type: "employees", list: employees });
  dispatch({ type: "projects", list: projects });
  dispatch({ type: "unread", unread });
  if (state.roomKey !== undefined) {
    const roomKey = state.roomKey;
    const { messages } = await api.messages(roomKey);
    dispatch({ type: "room", roomKey, messages }, "all");
  }
}
```

（`refreshAll` 的 `"room"` 事件会以 `renderAll` 重建界面——重连补齐场景可接受。）

- [ ] **Step 3: 构建 + 全量验证**

```bash
npm run build:web && npm test && npm run typecheck
```

- [ ] **Step 4: 手动验收（实时全流程）**

`npm start` 后浏览器验证：

1. 私聊发消息 → **流式**出现回复（逐字增长）、生成中侧栏显示忙碌点，完成后消失；
2. 未读：切到另一个房间时，原房间新回复产生红点；打开房间后红点消失；
3. 群聊：`@alice 你好` 只触发 alice；不 @ 则广播（多名成员同时生成、互不阻塞）；
4. 新开会话：私聊/群聊（成员下拉）确认后消息视线清空；历史面板可看旧会话（只读）；
5. 会话快照：改 `agents/<id>/profile.md` 后，当前会话回复行为不变；新开会话后生效。

- [ ] **Step 5: 提交**

```bash
git add web/sse.ts web/main.ts
git commit -m "feat(web): SSE 实时（流式气泡/忙碌点/未读时机/重连补齐）"
```

---

### Task 15: README（手动配置指南 + 验收清单）

**Files:**
- Create: `README.md`
- Test: 无自动化；以"命令可复现 + 文档审阅"验收

- [ ] **Step 1: 写 `README.md`**

包含以下小节（内容用中文，示例完整可复制）：

```markdown
# OpenStaffs

完全本地化的"AI 办公室"：文件夹就是员工，拉群就是立项。浏览器访问 `http://localhost:4319` 使用。

## 快速开始

1. 需要 Node ≥ 22.19。
2. `npm install`
3. 写配置：创建 `.openstaffs/config.json`（见下）。
4. `npm start` → 打开 `http://localhost:4319`。

## 配置 `.openstaffs/config.json`

{
  "provider": "opencode-go",
  "apiKey": "sk-…",
  "modelId": "deepseek-v4.1-flash",
  "port": 4319
}

- `provider` 可选：`opencode-go`、`anthropic`、`openai`、`deepseek`、`google`、`openrouter`。
- 改配置需重启服务；员工/项目目录是运行时读取，改完刷新页面即生效。
- 建议 `chmod 600 .openstaffs/config.json`（密钥只存在本机）。
- 工作区根 = 启动命令所在目录；可用 `OPENSTAFFS_ROOT` 指定。

## 创建员工（agents/<id>/）

必需：`AGENTS.md`（入口：人格与职责）。可选：

agents/alice/
├─ AGENTS.md      # 你是 alice，负责……（必需）
├─ profile.md     # 岗位 / 职责 / 人格
├─ MEMORY.md      # 长期记忆（员工自己也会更新）
├─ config.json    # { "alias": "爱丽丝", "modelId": "…" }（模型留空用全局）
├─ skills/<名>/SKILL.md
└─ permission.json

## 创建项目 / 群聊（projects/<id>/）

必需：`members.md`（每行 `- <员工 id>`）。可选：`AGENTS.md`（任务规范）、`project.json`（`{ "alias": "展示名" }`）。

## 使用

- 私聊 / 群聊：左侧点员工或项目；群聊 `@成员` 定向、不 @ 则广播；`@老板` 的消息不会触发任何人。
- 新开会话：头部按钮（会话快照会重新读取员工档案/技能/记忆）。
- 会话快照：会话创建时固化档案/技能/记忆，**会话中改文件不生效**；要生效请新开会话。
- 历史：头部按钮，只读回看旧会话。

## 手动验收清单

1. 无 `config.json` 启动 → 浏览器显示引导页；`curl http://localhost:4319/api/status` 返回 `configured:false`。
2. 填好配置重启 → 引导页消失；无员工时列表区显示创建提示。
3. 建 `agents/alice/`（AGENTS.md + config.json）→ 刷新 → 列表出现 alice。
4. 私聊发消息 → 流式回复；发第二条可继续（不阻塞）。
5. 建 `projects/demo/`（members.md 含 alice）→ 刷新 → 项目出现。
6. 群聊 `@alice 你好` → 只 alice 回复；发"报个数"（不 @）→ 全员各自回复。
7. 未读红点 → 打开房间消失；切走后有新回复再现。
8. 新开会话 → 视线清空；历史面板可看旧会话。
9. 改 `profile.md` → 当前会话无变化；新开会话后生效。
10. `.openstaffs/config.json` 不出现在任何 API 响应里（除 status 的 provider/modelId 字段）。

## 常见问题

- 端口占用：改 `config.json` 的 `port` 后重启。
- 员工回复失败（红色提示）：检查 apiKey / modelId；错误会显示在聊天里。
- 技能不生效：技能清单在会话创建时固化 → 新开会话。
```

- [ ] **Step 2: 按 README 逐条复现（至少前 4 条）**

Run: 按"手动验收清单" 1–4 执行一遍（无配置启动、配置、建员工、私聊对话）。
Expected: 全部符合描述；有出入则修正 README（或记 Ruling）。

- [ ] **Step 3: 提交**

```bash
git add README.md
git commit -m "docs: README 手动配置指南与验收清单"
```

---

### Task 16: 最终全量验证

**Files:** 无（验证任务）

- [ ] **Step 1: 全量测试与类型检查**

```bash
npm test > /tmp/final-test.log 2>&1; tail -20 /tmp/final-test.log
npm run typecheck
```

Expected: 全部用例通过（含既有 80 个 + 本期新增）、typecheck 无错误。

- [ ] **Step 2: 构建 + 未配置模式冒烟**

```bash
npm run build:web
(node src/server/main.ts > /tmp/oss.log 2>&1 & echo $! > /tmp/oss.pid)
sleep 1
curl -s http://127.0.0.1:4319/api/status
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4319/api/employees   # 期望 409
kill $(cat /tmp/oss.pid)
```

- [ ] **Step 3: 真实模型手动验收（README 清单 1–10）**

由老板在浏览器执行；把发现的问题记录为 Ruling 或后续修复。

- [ ] **Step 4: 差异核对（防偷改）**

```bash
git diff master --stat
```

核对改动文件与计划 File Structure 一致；如有多余改动，说明原因。

- [ ] **Step 5: 汇总执行日志**

把本计划的 Ruling 汇总到文末"执行日志"小节（见下），并汇报：任务完成数、测试总数、遗留问题。

---

## 自检记录

- **Spec 覆盖对照**：D1–D15 全部落任务——D1（范围）Task 1–16；D2（读侧合并）Task 3/10；D3（vanilla+esbuild）Task 11；D4（配置零 UI）Task 11（引导页）/Task 15；D5/D6（快照固化+清单）Task 2/6；D7（权限实时）Task 2（attach 只注册 access）；D8（state.json）Task 4；D9（搜索不做）非目标；D10（SSE+Pump）Task 10；D11（fire-and-forget+队列）Task 5/7；D12（文件引导）Task 11；D13（端口 4319）Task 1/8；D14（回看）Task 9/13；D15（无时间戳）全程。spec §6.1 API 表 → Task 8/9/10；§6.2 事件模型 → Task 10；§7 → Task 1/8/11/15；§8 → Task 11–14；§9 测试 → 各任务；§10 修正点 → Task 6（快照清单）。
- **Placeholder 扫描**：已检查；仅存的"以实测为准"均指向明确的校准动作（Task 5 事件映射、Task 8/9 Node 启动 flag），不属于占位。
- **类型一致性**：`HarnessEvent`（port） vs `ServerEvent`（server/sse）分工明确；`SessionDefaults`/`ModelRefLike` 跨任务一致；`RoomMessage` 定义唯一（app/rooms.ts），前端只 import 类型；`PumpLike` 与 `Pump` 结构兼容。
- **Review Focus 测试映射**：①未配置 409 → Task 8；②空成员群/@老板 → Task 7/9；③会话中改文件 → Task 6（新增"会话快照"用例）；④慢 SSE 客户端 → Task 10（SseHub 单元）；⑤坏 config/未配模型 → Task 8/6。

## 执行日志

（执行者：每条 Ruling 记录——日期 / 任务 / 原因 / 偏差 / 采用方案。无 Ruling 则写"无"。）







