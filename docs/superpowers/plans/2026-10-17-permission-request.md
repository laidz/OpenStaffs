# OpenStaffs 授权弹框与称谓单源化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给员工一条"申请写权限 → 老板弹框批准/拒绝 → 消息触发继续"的异步通道，并把负责人称谓（缺省「老板」）从 `config.bossName` 单源消费到全链路。

**Architecture:** 新增 `domain/permission-requests.ts`（请求存储，原子落盘 `.openstaffs/permission-requests.json`）与 `app/permission-flow.ts`（resolve 编排：写发起者员工级 `permission.json` → 复用 `sendToRoom` 投递「已完成授权/已拒绝授权」→ 清请求 → SSE 广播）；`tools/registry.ts` 加 `request_permission` 工具（立即返回，异步认知三层同步）；`server/http.ts` 加 REST 端点与 `status.bossName`；前端右下角卡片堆叠。称谓单源：`config.readBossName`（已存在）→ `bossNamesFor` 双认（`[当前称谓, 老板, boss]`）→ rooms 参数化 → http/pump/registry 传参 → UI 显示 → 环境段模板 → 手册映射。

**Tech Stack:** TypeScript (ESM, strip-only——不加参数属性等语法)、Node ≥ 22.19、Vitest、持手 pnpm/npm 脚本 `npm test` / `npm run typecheck`。

**Spec:** `docs/superpowers/specs/2026-10-17-permission-request-design.md`

## Global Constraints

- **Node ≥ 22.19**，ESM（`"type": "module"`），`strict` + `noUncheckedIndexedAccess`；Node 直接跑 TS（strip-only）：**不用参数属性、不用 enum**。
- 基座 `@earendil-works/*` **锁定 1.3.0**，禁升级。
- **异步模式**（决策 D1）：工具发起后立即返回；老板点击后框架以**消息**触发 agent 新一轮。不做工具阻塞等待。
- **授权一律写发起者员工级 `agents/<agentId>/permission.json`**（D2）；路径存**绝对路径**（D11）。
- **@ 解析双认**：`bossNames = [readBossName(ws), "老板", "boss"]` 去重；`@老板`/`@boss` 永久有效。
- 文案（用户/agent 可见）一律消费 `readBossName`；静态手册（SKILL.md）加术语映射，不做运行时渲染。
- 测试驱动：每个任务先写失败测试 → 跑失败 → 实现 → 跑通过 → commit；提交信息用中文 `feat:` / `docs:` 前缀。
- 不改写权限判定规则（`isWriteAllowed`/`matchesPermission` 不动）；`request_permission` 的校验错误用中文抛出（extension 层会包装为 tool 错误结果）。

## Review Focus

以下失败模式 spec 隐含、单测不天然覆盖，最易伤人，按危害排序；每条在其归属任务的测试里钉住：

1. **弹框"假成功"**：写 `permission.json` 失败必须保留请求（可重试）；投递失败必须回传 warning，绝不静默吞掉。→ Task 8 / Task 11。
2. **重复点击/并发点击**：同 id 并发只处理一次（处理中集合）；已批准路径重复出现幂等不重复追加；消息靠 `requestId: permission:<id>` 防重投。→ Task 7 / Task 8 / Task 11。
3. **越界提权**：只写发起者自己的文件；坏 `permission.json` 覆盖前必须备份 `.bak`，不因解析失败放大权限。→ Task 7 / Task 8。
4. **称谓回归**：自定义称谓后 `@老板`/`@boss` 仍有效；UI/消息/工具/手册全链路称呼一致。→ Task 1-5。
5. **重启与坏文件**：请求落盘可恢复；坏 JSON/坏条目安全降级不崩。→ Task 6 / Task 11。

---

## File Structure

```
src/
  domain/
    config.ts                # 改：bossNamesFor 双认列表
    permission-requests.ts   # 新增：请求模型 + 内存 store + 原子落盘
    permissions.ts           # 改：appendPermissionPaths（合并去重、.bak、mkdir、原子写）
    mention.ts               # 不动（bossNames 已是参数）
  app/
    rooms.ts                 # 改：normalize/merge 接 bossNames；fallback 用当前称谓
    permission-flow.ts       # 新增：resolvePermissionRequest + permissionRequestView
  tools/
    registry.ts              # 改：request_permission 工具；speakerName/send_message/room_history 称谓
    extension.ts             # 改：ToolContext 注入 permissions
  harness/
    access-extension.ts      # 改：拦截提示引导申请授权（导出文案函数便于测试）
  server/
    http.ts                  # 改：GET/POST 端点、status.bossName、merge 调用传 bossNames
    sse.ts                   # 改：permission.request / permission.resolved 事件
    pump.ts                  # 改：normalize/merge 调用传 bossNames
    main.ts                  # 改：装配 store / tools / http
  prompts/
    dm.md / group.md         # 改：称谓措辞 + @ 语法文案
  skills/
    openstaffs/SKILL.md      # 改：映射句、request_permission 工具、异步申请小节
    openstaffs-ops/SKILL.md  # 改：映射句、permission.json 代写、bossName 表
web/
  api.ts / state.ts / render.ts / main.ts / styles.css   # 改：卡片 UI + bossName 显示
tests/   （见各任务）
README.md / docs/手动验收清单.md   # 改：config 字段、status 字段、验收条目
```

---

### Task 1: 称谓双认基建（bossNamesFor + rooms 参数化）

**Files:**
- Modify: `src/domain/config.ts`（文件末尾 `formatModelRef` 后追加）
- Modify: `src/app/rooms.ts:71-117`（normalizeChatMessage）、`:120-141`（mergeRoomMessages）
- Test: `tests/domain/config.test.ts`、`tests/app/rooms.test.ts`、`tests/domain/mention.test.ts`

**Interfaces:**
- Consumes: `readBossName(ws)`（已存在）、`parseMentions(text, employees, bossNames)`（已存在）
- Produces:
  - `bossNamesFor(ws: Workspace): string[]` —— `[readBossName(ws), "老板", "boss"]` 去重保序（第一项 = 当前称谓）
  - `normalizeChatMessage(roomKey, member, chat, memberIds = [], bossNames = ["老板", "boss"])`（新增第 5 参）
  - `mergeRoomMessages(roomKey, members, memberIds = [], bossNames = ["老板", "boss"])`（新增第 4 参）

- [ ] **Step 1: 写失败测试**

`tests/domain/config.test.ts` 追加 import `bossNamesFor` 并在文件末尾追加：

```ts
describe("bossNamesFor（@提及双认）", () => {
  it("缺省 → [老板, boss]；自定义 → [当前称谓, 老板, boss] 去重保序", () => {
    const ws = createWorkspace(root);
    expect(bossNamesFor(ws)).toEqual(["老板", "boss"]);
    fs.mkdirSync(path.join(root, ".openstaffs"), { recursive: true });
    fs.writeFileSync(configFile(ws), JSON.stringify({ bossName: "掌柜" }));
    expect(bossNamesFor(ws)).toEqual(["掌柜", "老板", "boss"]);
    fs.writeFileSync(configFile(ws), JSON.stringify({ bossName: "老板" }));
    expect(bossNamesFor(ws)).toEqual(["老板", "boss"]);
    fs.writeFileSync(configFile(ws), JSON.stringify({ bossName: "boss" }));
    expect(bossNamesFor(ws)).toEqual(["boss", "老板"]);
  });
});
```

`tests/app/rooms.test.ts` 在「群聊 @前缀约定」describe 内追加：

```ts
it("bossNames 双认：@掌柜 视为给老板（不补前缀）；fallback 用当前称谓（首项）", () => {
  const bossNames = ["掌柜", "老板", "boss"];
  const direct = normalizeChatMessage("group:demo", alice, chat("9", "assistant", "@掌柜 汇报：已完成"), memberIds, bossNames);
  expect(direct?.text).toBe("@掌柜 汇报：已完成"); // 命中：不补 fallback 前缀
  expect(direct?.bossDirected).toBe(true);

  const legacy = normalizeChatMessage("group:demo", alice, chat("10", "assistant", "@老板 汇报"), memberIds, bossNames);
  expect(legacy?.bossDirected).toBe(true); // 历史写法仍有效

  const fallback = normalizeChatMessage("group:demo", alice, chat("11", "assistant", "好的，已完成"), memberIds, bossNames);
  expect(fallback?.text).toBe("@掌柜 好的，已完成");
  expect(fallback?.bossDirected).toBe(true);

  const merged = mergeRoomMessages("group:demo", [{ memberId: "alice", convId: "c1", messages: [chat("12", "assistant", "群里说句话")] }], memberIds, bossNames);
  expect(merged[0]!.text).toBe("@掌柜 群里说句话"); // mergeRoomMessages 透传
});
```

`tests/domain/mention.test.ts` 在 describe 内追加：

```ts
it("bossNames 参数：自定义称谓命中 BOSS_ID（双认列表由调用方给出）", () => {
  const bossNames = ["掌柜", "老板", "boss"];
  expect(parseMentions("@掌柜 汇报", employees, bossNames).targets).toEqual([BOSS_ID]);
  expect(parseMentions("@老板 汇报", employees, bossNames).targets).toEqual([BOSS_ID]);
  expect(parseMentions("@掌柜 汇报", employees).targets).toEqual([]); // 默认参数不含自定义称谓
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/domain/config.test.ts tests/app/rooms.test.ts tests/domain/mention.test.ts`
Expected: FAIL —— `bossNamesFor` 未导出（config.test 报 3 处 import 错误）；rooms 用例中 `@掌柜` 未被识别（`direct.text` 变成 `@老板 @掌柜 汇报：已完成`）、fallback 仍为 `@老板`；mention 用例的「@掌柜 汇报」默认参数下 targets 为空 ✔（该条已通过），但 rooms/config 失败。

- [ ] **Step 3: 实现**

`src/domain/config.ts` 末尾追加：

```ts
/** @提及解析用的负责人写法：当前称谓 + 历史写法（双认；首项 = 当前称谓）。 */
export function bossNamesFor(ws: Workspace): string[] {
  return [...new Set([readBossName(ws), DEFAULT_BOSS_NAME, "boss"])];
}
```

`src/app/rooms.ts` 修改两处（其余逻辑不变）：

```ts
export function normalizeChatMessage(
  roomKey: string,
  member: MemberTranscript,
  chat: ChatMessage,
  memberIds: string[] = [],
  bossNames: string[] = ["老板", "boss"],
): RoomMessage | undefined {
  const isGroup = roomKey.startsWith("group:");
  if (chat.role === "assistant") {
    const trimmed = chat.text.trim();
    const prefixEnd = leadingMentionLength(trimmed);
    const deliveries = prefixEnd === 0 ? [] : planRouting(trimmed, memberIds);
    const reachesOtherMember = hasBodyAfterPrefix(trimmed) && deliveries.some((delivery) => delivery.to !== member.memberId);
    const bossTargeted = parseMentions(trimmed, memberIds, bossNames).targets.includes(BOSS_ID);
    const fallback = isGroup && trimmed !== "" && (prefixEnd === 0 || (!reachesOtherMember && !bossTargeted));
    return {
      convId: member.convId,
      entryId: chat.id,
      roomKey,
      speaker: { kind: "employee", id: member.memberId, ...(member.alias === undefined ? {} : { alias: member.alias }) },
      text: fallback ? `@${bossNames[0]!} ${chat.text}` : chat.text,
      bossDirected: isGroup ? fallback || bossTargeted : true,
    };
  }
  if (chat.role === "user" && (chat.kind === "chat.message" || chat.kind === "pi.user")) {
    const author = authorOf(chat);
    if (author !== undefined && author !== BOSS_ID) {
      return {
        convId: member.convId,
        entryId: chat.id,
        roomKey,
        speaker: { kind: "employee", id: author },
        text: chat.text,
        bossDirected: isGroup ? parseMentions(chat.text.trim(), memberIds, bossNames).targets.includes(BOSS_ID) : true,
      };
    }
    return {
      convId: member.convId,
      entryId: chat.id,
      roomKey,
      speaker: { kind: "boss" },
      text: chat.text,
      bossDirected: false,
      ...bossDataOf(chat),
    };
  }
  return undefined;
}

export function mergeRoomMessages(
  roomKey: string,
  members: MemberTranscript[],
  memberIds: string[] = [],
  bossNames: string[] = ["老板", "boss"],
): RoomMessage[] {
  const all: RoomMessage[] = [];
  for (const member of members) {
    for (const chat of member.messages) {
      const message = normalizeChatMessage(roomKey, member, chat, memberIds, bossNames);
      if (message !== undefined) all.push(message);
    }
  }
  // 以下去重与排序逻辑保持不变
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/domain/config.test.ts tests/app/rooms.test.ts tests/domain/mention.test.ts`
Expected: PASS（含既有用例——默认参数保持旧行为）。

- [ ] **Step 5: 全量回归 + typecheck**

Run: `npm test && npm run typecheck`
Expected: 全绿（rooms 调用方暂未传 bossNames，默认参数兜底，无破坏）。

- [ ] **Step 6: Commit**

```bash
git add src/domain/config.ts src/app/rooms.ts tests/domain/config.test.ts tests/app/rooms.test.ts tests/domain/mention.test.ts
git commit -m "feat: 称谓双认基建——bossNamesFor、rooms 参数化（fallback 用当前称谓）"
```

---

### Task 2: 服务端接线（http / pump 消费双认）

**Files:**
- Modify: `src/server/http.ts`（handleRooms 的 merge 调用 ×3、unread 端点 ×2）
- Modify: `src/server/pump.ts`（#onEvent message 分支、#pushUnread）
- Test: `tests/server/http.test.ts`、`tests/server/pump-trigger.test.ts`

**Interfaces:**
- Consumes: `bossNamesFor(ws)`（Task 1）、`mergeRoomMessages(…, memberIds, bossNames)`
- Produces: 无新导出；行为：群回复 fallback 文案与 bossDirected 判定在 HTTP 拉取、未读重算、SSE 广播三条路径都用当前称谓。

- [ ] **Step 1: 写失败测试**

`tests/server/http.test.ts`：
1. 给 `startWithFaux` 增加第三参 `options: { bossName?: string } = {}`，内部把配置从常量改为局部变量：

```ts
async function startWithFaux(
  employeeIds: string[],
  groupMembers: string[],
  options: { bossName?: string } = {},
): Promise<{ base: string; close: () => Promise<void> }> {
  // …员工与项目 seed 逻辑不变…
  const config = { ...configured, ...(options.bossName === undefined ? {} : { bossName: options.bossName }) };
  // createHttpServer 的 getConfig 从 `() => configured` 改为 `() => config`
  // …其余不变…
}
```

2. 「房间 API」describe 内追加用例：

```ts
it("称谓自定义：群回复 fallback 用真称谓（@掌柜）", async () => {
  const { base, close } = await startWithFaux(["alice"], ["alice"], { bossName: "掌柜" });
  try {
    await fetch(`${base}/api/rooms/group:yt/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "@alice 你好" }),
    });
    const merged = await waitFor(async () => {
      const body = (await (await fetch(`${base}/api/rooms/group:yt/messages`)).json()) as { messages: { speaker: { kind: string }; text: string }[] };
      return body.messages.some((m) => m.speaker.kind === "employee") ? body : undefined;
    });
    expect(merged.messages.some((m) => m.text === "@掌柜 收到0")).toBe(true);
  } finally {
    await close();
  }
});
```

`tests/server/pump-trigger.test.ts` 追加用例（沿用该文件既有 seed 与 helpers）：

```ts
it("称谓自定义：pump 广播的 fallback 文本用真称谓（读 config）", async () => {
  seedEmployee("alice");
  const groupDir = path.join(root, "projects", "yt");
  fs.mkdirSync(groupDir, { recursive: true });
  fs.writeFileSync(path.join(groupDir, "members.md"), "# 成员\n- alice\n");
  fs.mkdirSync(path.join(root, ".openstaffs"), { recursive: true });
  fs.writeFileSync(path.join(root, ".openstaffs", "config.json"), JSON.stringify({ bossName: "掌柜" }));

  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
  faux.setResponses([fauxAssistantMessage("收到！")]);
  const models = createModels();
  models.setProvider(faux.provider);
  const ws = createWorkspace(root);
  const harness = createPiHarness({ root, sqlitePath: path.join(root, ".openstaffs", "state.sqlite"), models });
  await harness.open();

  const events: ServerEvent[] = [];
  const hub = {
    broadcast: (event: ServerEvent) => events.push(event),
    add: () => ({ pending: 0, close: () => {} }),
    size: 0,
  } as unknown as SseHub;
  const pump = new Pump({ ws, harness, hub });
  try {
    const aliceConv = await openGroup(ws, harness, "yt", "alice");
    await pump.register(aliceConv, { roomKey: "group:yt", memberId: "alice" });
    await harness.submit(aliceConv, "请回答");
    await waitFor(async () =>
      events.some((e) => e.type === "room.message" && e.message.speaker.kind === "employee") ? true : undefined,
    );
    const message = events.find((e) => e.type === "room.message" && e.message.speaker.kind === "employee");
    expect(message?.type === "room.message" ? message.message.text : "").toBe("@掌柜 收到！");
  } finally {
    await harness.close();
  }
}, 30_000);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/server/http.test.ts tests/server/pump-trigger.test.ts`
Expected: FAIL —— 两个新用例实际得到 `@老板 收到0` / `@老板 收到！`（传参未接）。

- [ ] **Step 3: 实现**

`src/server/http.ts`：
- import 增加 `bossNamesFor`（来自 `../domain/config.ts`，与现有 import 合并）。
- `handleRooms` 内 `const memberIds = ...` 一行下方加：

```ts
  const bossNames = bossNamesFor(deps.ws);
```

- 三处 `mergeRoomMessages(...)` 调用补第 4 参：
  - `json(res, 200, { roomKey, messages: mergeRoomMessages(roomKey, members, memberIds, bossNames) });`
  - read 端点：`const merged = mergeRoomMessages(roomKey, members, memberIds, bossNames);`
  - sessions messages 端点：`const messages = mergeRoomMessages(roomKey, [ … ], memberIds, bossNames);`
- unread 端点（`segments[1] === "unread"`）循环外读一次：

```ts
  const bossNames = bossNamesFor(deps.ws);
  // dm 循环：mergeRoomMessages(key, await roomTranscripts(...), [], bossNames)
  // group 循环：mergeRoomMessages(key, await roomTranscripts(...), parseMembers(deps.ws, project.id), bossNames)
```

（注意：group 循环维持既有「不传 memberIds」的行为不变，仅补第 3 参 `[]` + 第 4 参 `bossNames`。原有不传 memberIds 的语义属既有现状，不在本任务改动。）

`src/server/pump.ts`：
- import 增加 `bossNamesFor`。
- `#onEvent` 的 message 分支：

```ts
          const relation = parseRoomKey(ref.roomKey);
          const memberIds = relation?.kind === "group" ? parseMembers(this.#deps.ws, relation.project) : [];
          const member: MemberTranscript = { … };
          const message = normalizeChatMessage(ref.roomKey, member, event.message, memberIds, bossNamesFor(this.#deps.ws));
```

- `#pushUnread`：

```ts
      const memberIds = relation.kind === "group" ? parseMembers(this.#deps.ws, relation.project) : [];
      const members = await roomTranscripts(this.#deps.ws, this.#deps.harness, relation);
      const messages = mergeRoomMessages(roomKey, members, memberIds, bossNamesFor(this.#deps.ws));
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/server/http.test.ts tests/server/pump-trigger.test.ts`
Expected: PASS。

- [ ] **Step 5: 全量回归 + typecheck**

Run: `npm test && npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add src/server/http.ts src/server/pump.ts tests/server/http.test.ts tests/server/pump-trigger.test.ts
git commit -m "feat: 服务端消费称谓双认——HTTP 拉取、未读重算、SSE 广播统一用当前称谓"
```

---

### Task 3: UI 显示称谓（status.bossName → 发言人名）

**Files:**
- Modify: `src/server/http.ts`（status 端点加 `bossName`）
- Modify: `web/api.ts`、`web/state.ts`、`web/render.ts`、`web/main.ts`
- Test: `tests/server/http.test.ts`、`tests/web/state.test.ts`、`tests/web/render.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/status` 响应新增 `bossName: string`（未配置模式也返回，读不到配置即「老板」）
  - `web/state.ts`：`State.bossName: string`（initialState 默认 `"老板"`）；UiEvent `{ type: "status"; configured: boolean; bossName: string }`
  - `web/render.ts`：`messageHtml(message, bossName = "老板")`、`messagesHtml(messages, bossName = "老板")`

- [ ] **Step 1: 写失败测试**

`tests/server/http.test.ts`：
- 未配置 status 断言改为：`expect(await status.json()).toEqual({ configured: false, root: ws.root, port: 4319, bossName: "老板" });`
- 第二个骨架用例中追加：`expect(status.bossName).toBe("老板");`

`tests/web/state.test.ts`：
- 两处 `{ type: "status", configured: true }` 事件补 `bossName: "老板"`（`inRoom()` 与 selectView 用例）。
- 追加：

```ts
it("bossName 随 status 事件更新", () => {
  const state = reduce(initialState, { type: "status", configured: true, bossName: "掌柜" });
  expect(state.bossName).toBe("掌柜");
});
```

`tests/web/render.test.ts` 追加：

```ts
it("老板消息发言人名消费 bossName（默认「老板」）", () => {
  const boss: RoomMessage = { convId: "c1", entryId: "1", roomKey: "dm:a", speaker: { kind: "boss" }, text: "你好", bossDirected: false };
  expect(messageHtml(boss, "掌柜")).toContain("掌柜");
  expect(messageHtml(boss, "掌柜")).not.toContain(">老板<");
  expect(messageHtml(boss)).toContain("老板");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/server/http.test.ts tests/web/state.test.ts tests/web/render.test.ts`
Expected: FAIL —— status 无 bossName；state 恒「老板」；messageHtml 第二参被忽略。

- [ ] **Step 3: 实现**

`src/server/http.ts` status 分支（`segments[1] === "status"`）：

```ts
            json(res, 200, {
              configured: config !== undefined,
              root: deps.ws.root,
              port: deps.port,
              bossName: readBossName(deps.ws),
              ...(config === undefined ? {} : { model: config.model, providers: Object.keys(config.providers) }),
            });
```

（import 行合入 `readBossName`。）

`web/api.ts`：

```ts
export type Status = { configured: boolean; root: string; port: number; model?: string; providers?: string[]; bossName: string };
```

`web/state.ts`：

```ts
export type State = {
  configured: boolean;
  bossName: string;          // ← 新增
  employees: EmployeeSummary[];
  // …
};

export const initialState: State = {
  configured: false,
  bossName: "老板",           // ← 新增
  // …
};

export type UiEvent =
  | { type: "status"; configured: boolean; bossName: string }   // ← 加 bossName
  // …

// reduce 内：
    case "status":
      return { ...state, configured: event.configured, bossName: event.bossName };
```

`web/render.ts`：

```ts
export function messageHtml(message: RoomMessage, bossName = "老板"): string {
  const speaker = message.speaker;
  const boss = speaker.kind === "boss";
  const name = speaker.kind === "boss" ? bossName : (speaker.alias ?? speaker.id);
  // …其余不变…
}

export function messagesHtml(messages: RoomMessage[], bossName = "老板"): string {
  return messages.length === 0 ? `<div class="empty">还没有消息，发一条试试。</div>` : messages.map((message) => messageHtml(message, bossName)).join("");
}
```

`web/render.ts` 的 `chatHtml`：`<div id="messages-part">${messagesHtml(state.messages, state.bossName)}</div>`。

`web/main.ts`：
- `dispatch({ type: "status", configured: status.configured, bossName: status.bossName }, "all");`
- `openHistory`/`loadHistoryView` 中 `messagesHtml(messages)` → `messagesHtml(messages, state.bossName)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/server/http.test.ts tests/web/state.test.ts tests/web/render.test.ts`
Expected: PASS。

- [ ] **Step 5: 全量回归 + typecheck + bundle 守卫**

Run: `npm test && npm run typecheck`
Expected: 全绿（含 `tests/web/bundle.test.ts`）。

- [ ] **Step 6: Commit**

```bash
git add src/server/http.ts web/api.ts web/state.ts web/render.ts web/main.ts tests/server/http.test.ts tests/web/state.test.ts tests/web/render.test.ts
git commit -m "feat: UI 消费称谓——status.bossName 驱动发言人显示"
```

---

### Task 4: 工具文案消费称谓（room_history / send_message）

**Files:**
- Modify: `src/tools/registry.ts`（`speakerName`、`send_message` description/返回、`room_history` merge 传参）
- Test: `tests/tools/registry.test.ts`

**Interfaces:**
- Consumes: `readBossName`、`bossNamesFor`（Task 1）
- Produces: 行为——`room_history` 输出中 boss 发言用当前称谓（含 fallback 前缀）；`send_message` 返回 `已发给「<称谓>」（…）`；description 用中性词「负责人」。

- [ ] **Step 1: 写失败测试**

`tests/tools/registry.test.ts` 追加（新 describe）：

```ts
describe("称谓消费", () => {
  it("自定义 bossName：send_message 返回与 room_history 输出用真称谓", async () => {
    seedEmployee("alice");
    fs.mkdirSync(path.join(root, ".openstaffs"), { recursive: true });
    fs.writeFileSync(path.join(root, ".openstaffs", "config.json"), JSON.stringify({ bossName: "掌柜" }));
    const ws = createWorkspace(root);
    const harness = fauxHarness();
    await harness.open();
    try {
      const out = await tool("send_message").run({ target: "boss", text: "汇报一下" }, ctxFor(ws, "alice", dm("alice"), harness));
      expect(out).toContain("掌柜");

      const dmConv = await openDm(ws, harness, "alice");
      await harness.submit(dmConv, "任务Y", { kind: "chat.message", data: { author: "boss" } });
      await waitFor(async () => (await harness.transcript(dmConv)).some((m) => m.role === "assistant"));
      const history = await tool("room_history").run({}, ctxFor(ws, "alice", dm("alice"), harness));
      expect(history).toContain("掌柜：任务Y");
    } finally {
      await harness.close();
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/tools/registry.test.ts`
Expected: FAIL —— 输出仍是「老板」。

- [ ] **Step 3: 实现**

`src/tools/registry.ts`：
- import 行合入 `readBossName`（`../domain/config.ts`）、`bossNamesFor`。
- `speakerName`：

```ts
function speakerName(ws: Workspace, speaker: RoomSpeaker): string {
  if (speaker.kind === "boss") return readBossName(ws);
  return speaker.alias ?? displayName(ws, speaker.id);
}
```

- `send_message` description（静态、中性词）与返回：

```ts
    description:
      "发消息。target 三选一：boss（主动私聊负责人，会进其待办）；member:<成员id>（在**当前群聊**里触发该成员，即 @他）；project:<项目id>（投递到你在该项目群的会话）。text 为消息内容。",
```

```ts
      return `已发给「${readBossName(ctx.ws)}」（会显示在其待办里）。`;
```

- `room_history` 的 merge 调用补参：

```ts
    const merged = mergeRoomMessages(roomKeyOf(relation), transcripts, memberIds, bossNamesFor(ctx.ws));
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/tools/registry.test.ts`
Expected: PASS（既有「老板」断言随默认称谓保持通过）。

- [ ] **Step 5: 全量回归 + typecheck**

Run: `npm test && npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add src/tools/registry.ts tests/tools/registry.test.ts
git commit -m "feat: 工具文案消费称谓——room_history 发言人与 send_message 返回用真称谓"
```

---

### Task 5: 环境段模板措辞（dm.md / group.md）

**Files:**
- Modify: `src/prompts/dm.md`、`src/prompts/group.md`
- Test: `tests/domain/prompt.test.ts`

**Interfaces:**
- Produces: 渲染后的环境段——角色词「负责人」+ 真称谓；群聊 @ 语法教 `@<boss_name>`（`@老板`/`@boss` 仍注明有效）。

- [ ] **Step 1: 写失败测试**

`tests/domain/prompt.test.ts` 在「环境段渲染」describe 追加：

```ts
it("bossName 自定义：环境段用真称谓，@ 语法教真称谓", () => {
  seedEmployee("alice");
  seedProject("demo", ["alice"]);
  fs.mkdirSync(path.join(root, ".openstaffs"), { recursive: true });
  fs.writeFileSync(path.join(root, ".openstaffs", "config.json"), JSON.stringify({ bossName: "掌柜" }));
  const out = renderEnvironment(groupCtx("demo", "alice"));
  expect(out).toContain("「掌柜」");
  expect(out).toContain("把 `@掌柜` 写在最前面");
  expect(out).toContain("`@老板`、`@boss` 同样有效");
  expect(out).toContain("自动补 `@掌柜`");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/domain/prompt.test.ts`
Expected: FAIL —— 现行模板没有「把 `@掌柜` 写在最前面」。

- [ ] **Step 3: 实现（先读最新文件，保留隔壁「大内容走文件」改动）**

`src/prompts/dm.md` 第二行改为：

```
当前会话：与「{{boss_name}}」（你的负责人）的私聊。工作目录：{{workdir}}。
```

`src/prompts/group.md` 修改三处（其余行不动）：
- 第 2 行「老板「{{boss_name}}」是每个群的天然成员」→ 「「{{boss_name}}」（你的负责人）是每个群的天然成员」
- 规则行「发给老板（请示 / 汇报）：把 `@老板` 写在最前面——老板会看到，并计入他的待办红点。**…会被系统当作发给老板（自动补 `@老板`）。**」→

```
- 发给负责人（请示 / 汇报）：把 `@{{boss_name}}` 写在最前面（`@老板`、`@boss` 同样有效）——负责人会看到，并计入待办红点。**你的回复没写 @ 开头、或开头 @ 了但没解析出有效对象（写错 id、标点粘连、只有 @ 没正文）时，会被系统当作发给负责人（自动补 `@{{boss_name}}`）。**
```

- 末行「找老板也可以用 send_message（target=boss）」→ 「找负责人也可以用 send_message（target=boss）」

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/domain/prompt.test.ts`
Expected: PASS（含既有用例：默认称谓仍含「老板」字样）。

- [ ] **Step 5: Commit**

```bash
git add src/prompts/dm.md src/prompts/group.md tests/domain/prompt.test.ts
git commit -m "feat: 环境段模板——负责人角色词 + 真称谓 @ 语法"
```

---

### Task 6: 授权请求存储（permission-requests.ts）

**Files:**
- Create: `src/domain/permission-requests.ts`
- Test: `tests/domain/permission-requests.test.ts`

**Interfaces:**
- Produces:
  - `type PermissionRequest = { id: string; agentId: string; roomKey: string; paths: string[]; reason: string; createdAt: string }`
  - `requestsFile(ws): string` → `<root>/.openstaffs/permission-requests.json`
  - `readPermissionRequests(ws): PermissionRequest[]`（坏 JSON / 坏条目 → 降级）
  - `findDuplicate(requests, agentId, paths): PermissionRequest | undefined`（路径集合比较，顺序无关）
  - `class PermissionRequestStore`：`constructor(ws)`（load 一次）、`list()`（新在前）、`get(id)`、`findDuplicate(agentId, paths)`、`add({ agentId, roomKey, paths, reason })`（生成 `pr_<uuid>` 与 `createdAt`，头部插入）、`remove(id): boolean`；落盘失败仅记日志不抛。

- [ ] **Step 1: 写失败测试**

`tests/domain/permission-requests.test.ts`：

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import {
  PermissionRequestStore, readPermissionRequests, requestsFile,
} from "../../src/domain/permission-requests.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-pre-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function seedConfig(content: string) {
  fs.mkdirSync(path.join(root, ".openstaffs"), { recursive: true });
  fs.writeFileSync(path.join(root, ".openstaffs", "permission-requests.json"), content);
}

describe("授权请求存储", () => {
  it("缺失/坏 JSON/坏条目 → 安全降级", () => {
    const ws = createWorkspace(root);
    expect(readPermissionRequests(ws)).toEqual([]);
    seedConfig("{坏");
    expect(readPermissionRequests(ws)).toEqual([]);
    seedConfig(JSON.stringify({ requests: [{ id: "pr_1" }, { id: "pr_2", agentId: "a", roomKey: "dm:a", paths: ["/x"], reason: "r", createdAt: "t" }] }));
    const ok = readPermissionRequests(ws);
    expect(ok.map((r) => r.id)).toEqual(["pr_2"]); // 坏条目跳过，好条目保留
  });

  it("add：生成 id/createdAt、新在前、原子落盘可读回（无 .tmp 残留）", () => {
    const ws = createWorkspace(root);
    const store = new PermissionRequestStore(ws);
    const first = store.add({ agentId: "alice", roomKey: "dm:alice", paths: ["/a"], reason: "r1" });
    const second = store.add({ agentId: "bob", roomKey: "group:yt", paths: ["/b"], reason: "r2" });
    expect(first.id).toMatch(/^pr_/u);
    expect(second.id).toMatch(/^pr_/u);
    expect(second.id).not.toBe(first.id);
    expect(Number.isNaN(Date.parse(second.createdAt))).toBe(false);
    expect(store.list().map((r) => r.id)).toEqual([second.id, first.id]); // 新的在前
    expect(readPermissionRequests(ws).map((r) => r.id)).toEqual([second.id, first.id]);
    expect(fs.existsSync(`${requestsFile(ws)}.tmp`)).toBe(false);
    // 重启（新的 store 从盘恢复）
    expect(new PermissionRequestStore(ws).list()).toHaveLength(2);
  });

  it("remove：命中返回 true 并落盘；不存在返回 false", () => {
    const ws = createWorkspace(root);
    const store = new PermissionRequestStore(ws);
    const request = store.add({ agentId: "alice", roomKey: "dm:alice", paths: ["/a"], reason: "r" });
    expect(store.remove("pr_none")).toBe(false);
    expect(store.remove(request.id)).toBe(true);
    expect(store.list()).toEqual([]);
    expect(readPermissionRequests(ws)).toEqual([]);
  });

  it("findDuplicate：同 agent + 路径集合相同（顺序无关）；顺序不同命中、路径不同不命中", () => {
    const ws = createWorkspace(root);
    const store = new PermissionRequestStore(ws);
    store.add({ agentId: "alice", roomKey: "dm:alice", paths: ["/a", "/b"], reason: "r" });
    expect(store.findDuplicate("alice", ["/b", "/a"])?.agentId).toBe("alice");
    expect(store.findDuplicate("alice", ["/a"])).toBeUndefined();
    expect(store.findDuplicate("bob", ["/a", "/b"])).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/domain/permission-requests.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

`src/domain/permission-requests.ts`：

```ts
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stateDir, type Workspace } from "./paths.ts";

/** 一条待处理的授权申请（落盘于 .openstaffs/permission-requests.json）。 */
export type PermissionRequest = {
  id: string;         // "pr_" + uuid
  agentId: string;    // 发起者（= 授权受益者）
  roomKey: string;    // 来源房间：dm:<员工id> | group:<项目id>
  paths: string[];    // 绝对路径（≥1 条）
  reason: string;     // 简短理由（非空）
  createdAt: string;  // ISO
};

export function requestsFile(ws: Workspace): string {
  return path.join(stateDir(ws), "permission-requests.json");
}

function isValidRequest(value: unknown): value is PermissionRequest {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" && entry.id !== "" &&
    typeof entry.agentId === "string" && entry.agentId !== "" &&
    typeof entry.roomKey === "string" && entry.roomKey !== "" &&
    Array.isArray(entry.paths) && entry.paths.length > 0 && entry.paths.every((p) => typeof p === "string" && p !== "") &&
    typeof entry.reason === "string" &&
    typeof entry.createdAt === "string"
  );
}

/** 读请求列表：缺失/坏 JSON → []；坏条目跳过（不崩溃、不阻主流程）。 */
export function readPermissionRequests(ws: Workspace): PermissionRequest[] {
  let raw = "";
  try {
    raw = fs.readFileSync(requestsFile(ws), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { requests?: unknown };
    if (!Array.isArray(parsed.requests)) return [];
    return parsed.requests.filter(isValidRequest);
  } catch {
    return [];
  }
}

/** 路径集合键（顺序无关）。 */
function pathsKey(paths: string[]): string {
  return [...paths].sort().join("\u0000");
}

/** 同一 agent 且路径集合相同的已有请求（重复申请判定）。 */
export function findDuplicate(
  requests: PermissionRequest[],
  agentId: string,
  paths: string[],
): PermissionRequest | undefined {
  const key = pathsKey(paths);
  return requests.find((request) => request.agentId === agentId && pathsKey(request.paths) === key);
}

function writePermissionRequests(ws: Workspace, requests: PermissionRequest[]): void {
  fs.mkdirSync(stateDir(ws), { recursive: true });
  const file = requestsFile(ws);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ requests }, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** 内存单例：启动时 load 一次；add/remove 同步改内存并落盘（fs 同步调用，进程内无交错）。 */
export class PermissionRequestStore {
  readonly #ws: Workspace;
  #requests: PermissionRequest[];

  constructor(ws: Workspace) {
    this.#ws = ws;
    this.#requests = readPermissionRequests(ws);
  }

  list(): PermissionRequest[] {
    return [...this.#requests];
  }

  get(id: string): PermissionRequest | undefined {
    return this.#requests.find((request) => request.id === id);
  }

  findDuplicate(agentId: string, paths: string[]): PermissionRequest | undefined {
    return findDuplicate(this.#requests, agentId, paths);
  }

  add(input: { agentId: string; roomKey: string; paths: string[]; reason: string }): PermissionRequest {
    const request: PermissionRequest = {
      id: `pr_${randomUUID()}`,
      agentId: input.agentId,
      roomKey: input.roomKey,
      paths: [...input.paths],
      reason: input.reason,
      createdAt: new Date().toISOString(),
    };
    this.#requests = [request, ...this.#requests];
    this.#persist();
    return request;
  }

  remove(id: string): boolean {
    const before = this.#requests.length;
    this.#requests = this.#requests.filter((request) => request.id !== id);
    if (this.#requests.length === before) return false;
    this.#persist();
    return true;
  }

  #persist(): void {
    try {
      writePermissionRequests(this.#ws, this.#requests);
    } catch (error) {
      // 内存态为准：落盘失败不阻断主流程（重启后该请求可能重现/丢失，属可接受降级）。
      console.error(`[openstaffs] 授权请求落盘失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/domain/permission-requests.test.ts`
Expected: PASS。

- [ ] **Step 5: 全量回归 + typecheck**

Run: `npm test && npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add src/domain/permission-requests.ts tests/domain/permission-requests.test.ts
git commit -m "feat: 授权请求存储——模型、内存单例、原子落盘与安全降级"
```

---

### Task 7: 权限条目追加（appendPermissionPaths）

**Files:**
- Modify: `src/domain/permissions.ts`（文件末尾追加）
- Test: `tests/domain/permissions.test.ts`

**Interfaces:**
- Produces: `appendPermissionPaths(file: string, paths: string[]): void` —— 读现有条目 → 合并去重（保序）→ `mkdir -p` → 原子写（2 空格缩进 + 尾换行）；**文件存在但不可解析 / 非数组 / 含非字符串元素** → 复制 `.bak` 后覆盖；空 `paths` 直接返回（不建文件）。

- [ ] **Step 1: 写失败测试**

`tests/domain/permissions.test.ts` 追加（import 补 `appendPermissionPaths`）：

```ts
describe("appendPermissionPaths", () => {
  it("追加新条目并保留原有：JSON 数组、2 空格缩进、尾换行、无 .tmp 残留", () => {
    const f = path.join(root, "agents", "alice", "permission.json");
    write(f, JSON.stringify(["../shared/"], null, 2) + "\n");
    appendPermissionPaths(f, ["/abs/new"]);
    expect(readPermissionPaths(f)).toEqual(["../shared/", "/abs/new"]);
    const raw = fs.readFileSync(f, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain("  ");
    expect(fs.existsSync(`${f}.tmp`)).toBe(false);
  });

  it("已存在的条目（含归一后相同）不重复追加；父目录缺失自动创建；空 paths 不落文件", () => {
    const f = path.join(root, "deep", "nested", "permission.json");
    appendPermissionPaths(f, ["/x", "/y", "/x"]);
    expect(readPermissionPaths(f)).toEqual(["/x", "/y"]);
    appendPermissionPaths(f, ["/x"]);
    expect(readPermissionPaths(f)).toEqual(["/x", "/y"]);
    const g = path.join(root, "none.json");
    appendPermissionPaths(g, []);
    expect(fs.existsSync(g)).toBe(false);
  });

  it("坏文件（坏 JSON / 非数组 / 含非字符串）→ 备份 .bak 后覆盖为新数组", () => {
    const bad = path.join(root, "bad.json");
    write(bad, "{ 坏");
    appendPermissionPaths(bad, ["/a"]);
    expect(readPermissionPaths(bad)).toEqual(["/a"]);
    expect(fs.readFileSync(`${bad}.bak`, "utf8")).toBe("{ 坏");

    const obj = path.join(root, "obj.json");
    write(obj, JSON.stringify({ write: ["/x"] }));
    appendPermissionPaths(obj, ["/b"]);
    expect(readPermissionPaths(obj)).toEqual(["/b"]);
    expect(fs.existsSync(`${obj}.bak`)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/domain/permissions.test.ts`
Expected: FAIL —— `appendPermissionPaths` 未导出。

- [ ] **Step 3: 实现**

`src/domain/permissions.ts` 末尾追加：

```ts
/** 文件内容是否为"健康"的字符串数组（用于决定覆盖前是否需要备份）。 */
function isHealthyArray(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string");
  } catch {
    return false;
  }
}

/**
 * 追加写权限条目：合并去重（保序）、原子写。
 * 文件存在但不可解析/非数组/含非字符串元素 → 先备份 `<file>.bak` 再以新数组覆盖
 * （坏文件本就不生效，覆盖不改变安全性；备份留痕）。
 */
export function appendPermissionPaths(file: string, paths: string[]): void {
  const cleaned = paths.map((entry) => entry.trim()).filter((entry) => entry !== "");
  if (cleaned.length === 0) return;

  let existing: string[] = [];
  try {
    const raw = fs.readFileSync(file, "utf8");
    if (!isHealthyArray(raw)) fs.copyFileSync(file, `${file}.bak`);
    existing = readPermissionPaths(file);
  } catch {
    // 文件缺失：直接新建
  }
  const merged = [...existing];
  for (const entry of cleaned) {
    if (!merged.includes(entry)) merged.push(entry);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`);
  fs.renameSync(tmp, file);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/domain/permissions.test.ts`
Expected: PASS。

- [ ] **Step 5: 全量回归 + typecheck**

Run: `npm test && npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add src/domain/permissions.ts tests/domain/permissions.test.ts
git commit -m "feat: appendPermissionPaths——授权条目合并去重、坏文件备份后覆盖"
```

---

### Task 8: 处理编排（permission-flow.ts）

**Files:**
- Create: `src/app/permission-flow.ts`
- Test: `tests/app/permission-flow.test.ts`

**Interfaces:**
- Consumes: `PermissionRequestStore`（Task 6）、`appendPermissionPaths`（Task 7）、`sendToRoom`/`KeyedQueue`（既有）、`parseRoomKey`（既有）
- Produces:
  - `class PermissionRequestNotFoundError extends Error`
  - `type PermissionRequestView = PermissionRequest & { agentName: string }`
  - `permissionRequestView(ws, request): PermissionRequestView`（alias 失败回落 id）
  - `permissionFilePath(ws, agentId): string` → `agents/<id>/permission.json`
  - `resolvePermissionRequest(deps, id, decision): Promise<{ ok: true; warning?: string }>`
    - deps：`{ ws, harness, store, queue: KeyedQueue, defaults?: SessionDefaults, register?: (convId, ref) => Promise<void>, broadcast?: (id) => void }`
    - 未知/处理中 id → 抛 `PermissionRequestNotFoundError`；写盘失败 → 抛（请求保留）；投递失败 → 返回带 warning（授权仍生效、请求仍移除）。

- [ ] **Step 1: 写失败测试**

`tests/app/permission-flow.test.ts`（从 `tests/app/send.test.ts` 复制 FakePort 与 seed 模式）：

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { KeyedQueue } from "../../src/app/send.ts";
import { PermissionRequestStore, readPermissionRequests } from "../../src/domain/permission-requests.ts";
import { PermissionRequestNotFoundError, permissionFilePath, permissionRequestView, resolvePermissionRequest } from "../../src/app/permission-flow.ts";
import type { ChatMessage, ConversationSpec, HarnessPort, InputMeta } from "../../src/harness/port.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-flow-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function seedEmployee(id: string, alias?: string): void {
  const dir = path.join(root, "agents", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "AGENTS.md"), `你是 ${id}。`);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ model: "faux/faux-model", ...(alias === undefined ? {} : { alias }) }));
}

function seedGroup(project: string, members: string[]): void {
  const dir = path.join(root, "projects", project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "members.md"), ["# 成员", ...members.map((m) => `- ${m}`), ""].join("\n"));
}

class FakePort implements HarnessPort {
  readonly starts: ConversationSpec[] = [];
  readonly submits: { convId: string; text: string; meta?: InputMeta }[] = [];
  async open(): Promise<void> {}
  async close(): Promise<void> {}
  async startSession(spec: ConversationSpec): Promise<string> {
    this.starts.push(spec);
    return `conv-${this.starts.length}`;
  }
  async attach(convId: string): Promise<boolean> { return convId.startsWith("conv-"); }
  async append(): Promise<void> {}
  async abort(): Promise<void> {}
  sessionInfo(): undefined { return undefined; }
  async submit(convId: string, text: string, meta?: InputMeta): Promise<void> {
    this.submits.push({ convId, text, meta });
  }
  async watch(): Promise<() => Promise<void>> { return async () => {}; }
  async send(convId: string, text: string): Promise<ChatMessage> { return { id: "x", role: "assistant", text }; }
  async transcript(): Promise<ChatMessage[]> { return []; }
}

const defaults = { model: "faux/faux-model" };

function setup() {
  const ws = createWorkspace(root);
  const store = new PermissionRequestStore(ws);
  const port = new FakePort();
  const register = vi.fn(async () => {});
  const broadcast = vi.fn();
  const deps = { ws, harness: port, store, queue: new KeyedQueue(), defaults, register, broadcast };
  return { ws, store, port, register, broadcast, deps };
}

describe("授权请求处理", () => {
  it("accept：写员工 permission.json、投递「已完成授权」（老板形态 + 去重键）、清请求、广播", async () => {
    seedEmployee("alice", "爱丽丝");
    const { ws, store, port, register, broadcast, deps } = setup();
    const target = path.join(root, "outside", "shared");
    const request = store.add({ agentId: "alice", roomKey: "dm:alice", paths: [target], reason: "要写共享目录" });

    const result = await resolvePermissionRequest(deps, request.id, "accept");
    expect(result).toEqual({ ok: true });
    expect(JSON.parse(fs.readFileSync(permissionFilePath(ws, "alice"), "utf8"))).toEqual([target]);
    expect(port.submits).toHaveLength(1);
    expect(port.submits[0]!.text).toBe("已完成授权");
    expect(port.submits[0]!.meta?.kind).toBe("chat.message");
    expect(port.submits[0]!.meta?.requestId).toBe(`permission:${request.id}`);
    expect((port.submits[0]!.meta?.data as { author?: string }).author).toBe("boss");
    expect(register).toHaveBeenCalledWith("conv-1", { roomKey: "dm:alice", memberId: "alice" });
    expect(broadcast).toHaveBeenCalledWith(request.id);
    expect(store.list()).toEqual([]);
    expect(readPermissionRequests(ws)).toEqual([]);
  });

  it("reject：不写任何文件、投递「已拒绝授权」", async () => {
    seedEmployee("alice");
    const { ws, store, port, deps } = setup();
    const request = store.add({ agentId: "alice", roomKey: "dm:alice", paths: [path.join(root, "x")], reason: "r" });

    const result = await resolvePermissionRequest(deps, request.id, "reject");
    expect(result).toEqual({ ok: true });
    expect(fs.existsSync(permissionFilePath(ws, "alice"))).toBe(false);
    expect(port.submits[0]!.text).toBe("已拒绝授权");
    expect(store.list()).toEqual([]);
  });

  it("群聊：投递文本以 @<agentId> 开头（只触发该成员）", async () => {
    seedEmployee("alice");
    seedGroup("yt", ["alice"]);
    const { store, port, deps } = setup();
    const request = store.add({ agentId: "alice", roomKey: "group:yt", paths: [path.join(root, "x")], reason: "r" });

    await resolvePermissionRequest(deps, request.id, "accept");
    expect(port.submits[0]!.text).toBe("@alice 已完成授权");
  });

  it("未知 id / 并发同 id → PermissionRequestNotFoundError；并发只有一个成功", async () => {
    seedEmployee("alice");
    const { store, deps } = setup();
    await expect(resolvePermissionRequest(deps, "pr_none", "accept")).rejects.toThrow(PermissionRequestNotFoundError);

    const request = store.add({ agentId: "alice", roomKey: "dm:alice", paths: [path.join(root, "x")], reason: "r" });
    const first = resolvePermissionRequest(deps, request.id, "accept");
    const second = resolvePermissionRequest(deps, request.id, "accept");
    await expect(second).rejects.toThrow(PermissionRequestNotFoundError);
    await first;
  });

  it("写盘失败：抛错、请求保留、不投递、不广播", async () => {
    // agents/alice 是文件（不是目录）→ appendPermissionPaths 的 mkdir 失败
    fs.mkdirSync(path.join(root, "agents"), { recursive: true });
    fs.writeFileSync(path.join(root, "agents", "alice"), "not a dir");
    const { store, port, broadcast, deps } = setup();
    const request = store.add({ agentId: "alice", roomKey: "dm:alice", paths: [path.join(root, "x")], reason: "r" });

    await expect(resolvePermissionRequest(deps, request.id, "accept")).rejects.toThrow();
    expect(store.get(request.id)).toBeDefined();
    expect(port.submits).toEqual([]);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("投递失败：授权已生效、请求仍移除、返回 warning", async () => {
    seedEmployee("alice");
    const { ws, store, port, broadcast, deps } = setup();
    port.submit = async () => {
      throw new Error("投递炸了");
    };
    const target = path.join(root, "outside");
    const request = store.add({ agentId: "alice", roomKey: "dm:alice", paths: [target], reason: "r" });

    const result = await resolvePermissionRequest(deps, request.id, "accept");
    expect(result.ok).toBe(true);
    expect(result.warning).toContain("通知消息投递失败");
    expect(JSON.parse(fs.readFileSync(permissionFilePath(ws, "alice"), "utf8"))).toEqual([target]);
    expect(store.list()).toEqual([]);
    expect(broadcast).toHaveBeenCalledWith(request.id);
  });
});

describe("permissionRequestView", () => {
  it("补 agentName（alias 回落 id）", () => {
    const ws = createWorkspace(root);
    seedEmployee("bob", "Bob哥");
    const view = permissionRequestView(ws, { id: "pr_x", agentId: "bob", roomKey: "dm:bob", paths: ["/x"], reason: "r", createdAt: "t" });
    expect(view.agentName).toBe("Bob哥");
    const ghost = permissionRequestView(ws, { id: "pr_y", agentId: "ghost", roomKey: "dm:ghost", paths: ["/x"], reason: "r", createdAt: "t" });
    expect(ghost.agentName).toBe("ghost");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/app/permission-flow.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

`src/app/permission-flow.ts`：

```ts
import path from "node:path";
import { loadEmployee } from "../domain/employee.ts";
import { employeeDir, type Workspace } from "../domain/paths.ts";
import { appendPermissionPaths } from "../domain/permissions.ts";
import type { PermissionRequest, PermissionRequestStore } from "../domain/permission-requests.ts";
import type { HarnessPort } from "../harness/port.ts";
import type { SessionDefaults } from "./conversations.ts";
import { parseRoomKey } from "./rooms.ts";
import { sendToRoom, type KeyedQueue } from "./send.ts";

/** 请求不存在，或已在处理中（并发防重）。 */
export class PermissionRequestNotFoundError extends Error {}

/** 广播 / REST 输出用的视图（补发起者展示名）。 */
export type PermissionRequestView = PermissionRequest & { agentName: string };

export function permissionRequestView(ws: Workspace, request: PermissionRequest): PermissionRequestView {
  let agentName = request.agentId;
  try {
    agentName = loadEmployee(ws, request.agentId).alias ?? request.agentId;
  } catch {
    agentName = request.agentId;
  }
  return { ...request, agentName };
}

export function permissionFilePath(ws: Workspace, agentId: string): string {
  return path.join(employeeDir(ws, agentId), "permission.json");
}

export type PermissionFlowDeps = {
  ws: Workspace;
  harness: HarnessPort;
  store: PermissionRequestStore;
  queue: KeyedQueue;
  defaults?: SessionDefaults;
  /** best-effort 订阅新触发的会话（与 HTTP 发送同口径）。 */
  register?: (convId: string, ref: { roomKey: string; memberId: string }) => Promise<void>;
  /** 处理完成广播（SSE permission.resolved）。 */
  broadcast?: (id: string) => void;
};

/** 同 id 并发防重（进程内单例）。 */
const inFlight = new Set<string>();

/**
 * 处理一条授权请求：
 * accept → 写发起者员工级 permission.json；随后（两种决策）以老板消息投递结果、清请求、广播。
 * 写盘失败会抛出且请求保留；投递失败不抛（授权已生效），返回带 warning 的结果。
 */
export async function resolvePermissionRequest(
  deps: PermissionFlowDeps,
  id: string,
  decision: "accept" | "reject",
): Promise<{ ok: true; warning?: string }> {
  if (inFlight.has(id)) throw new PermissionRequestNotFoundError(`授权请求不存在或已处理：${id}`);
  inFlight.add(id);
  try {
    const request = deps.store.get(id);
    if (request === undefined) throw new PermissionRequestNotFoundError(`授权请求不存在或已处理：${id}`);

    if (decision === "accept") {
      appendPermissionPaths(permissionFilePath(deps.ws, request.agentId), request.paths);
    }

    const relation = parseRoomKey(request.roomKey);
    if (relation === undefined) throw new Error(`授权请求的房间键不合法：${request.roomKey}`);
    const verb = decision === "accept" ? "已完成授权" : "已拒绝授权";
    const text = relation.kind === "group" ? `@${request.agentId} ${verb}` : verb;

    let warning: string | undefined;
    try {
      const result = await sendToRoom(deps.ws, deps.harness, relation, text, {
        queue: deps.queue,
        ...(deps.defaults === undefined ? {} : { defaults: deps.defaults }),
        requestId: `permission:${id}`,
      });
      for (const delivery of result.deliveries) {
        try {
          await deps.register?.(delivery.convId, { roomKey: request.roomKey, memberId: delivery.memberId });
        } catch {
          // 订阅失败不影响投递（重启扫描兜底）
        }
      }
    } catch (error) {
      // 授权已落盘：审批结果不因投递失败而回滚（对齐既有 best-effort 语义）。
      console.error(`[openstaffs] 授权结果投递失败（${id}）：${error instanceof Error ? error.message : String(error)}`);
      warning = "已完成处理，但通知消息投递失败（详见服务端日志）";
    }

    deps.store.remove(id);
    deps.broadcast?.(id);
    return warning === undefined ? { ok: true } : { ok: true, warning };
  } finally {
    inFlight.delete(id);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/app/permission-flow.test.ts`
Expected: PASS。

- [ ] **Step 5: 全量回归 + typecheck**

Run: `npm test && npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add src/app/permission-flow.ts tests/app/permission-flow.test.ts
git commit -m "feat: 授权处理编排——写权限、投递结果、防重与降级"
```

---

### Task 9: request_permission 工具 + 扩展注入

**Files:**
- Modify: `src/tools/registry.ts`（ToolContext 增 `permissions`；新增工具；注册表数组）
- Modify: `src/tools/extension.ts`（注入 options.permissions）
- Test: `tests/tools/registry.test.ts`、`tests/tools/extension.test.ts`

**Interfaces:**
- Consumes: `PermissionRequestStore`（Task 6）、`relationCwd`（既有）、`roomKeyOf`（既有）、`readBossName`（既有）
- Produces:
  - `ToolContext.permissions?: { store: PermissionRequestStore; notify: (request: PermissionRequest) => void }`
  - 工具 `request_permission`：参数 `paths: string[]`（≥1，相对按会话 cwd 解析为绝对）、`reason: string`（非空白）；重复申请不新建；返回中文文案（含称谓、路径清单、等待说明）。

- [ ] **Step 1: 写失败测试**

`tests/tools/registry.test.ts`：
1. import 行补 `vi`（`import { afterEach, describe, expect, it, vi } from "vitest";`）、补 `import path` 已有、新增：

```ts
import { PermissionRequestStore, readPermissionRequests } from "../../src/domain/permission-requests.ts";
```

2. 追加 describe：

```ts
describe("request_permission", () => {
  function ctxWithStore(ws: Workspace, selfId: string, relation: Relation) {
    const store = new PermissionRequestStore(ws);
    const notify = vi.fn();
    return { ctx: { ...ctxFor(ws, selfId, relation), permissions: { store, notify } }, store, notify };
  }

  it("发起成功：相对路径按会话 cwd 归一为绝对并去重；store 落盘；notify 广播", async () => {
    seedEmployee("alice", "爱丽丝");
    const ws = createWorkspace(root);
    const { ctx, store, notify } = ctxWithStore(ws, "alice", dm("alice"));
    const out = await tool("request_permission").run(
      { paths: ["notes/a.md", "./notes/a.md", "/abs/x"], reason: "整理笔记" },
      ctx,
    );
    const expected = path.join(root, "agents", "alice", "notes", "a.md");
    expect(out).toContain("发起授权请求");
    expect(out).toContain("2 个地址");
    expect(out).toContain(expected);
    expect(out).toContain("/abs/x");
    expect(out).toContain("不要尝试写入这些路径或用其他方式绕过拦截");
    const requests = store.list();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.agentId).toBe("alice");
    expect(requests[0]!.roomKey).toBe("dm:alice");
    expect(requests[0]!.paths).toEqual([expected, "/abs/x"]);
    expect(requests[0]!.reason).toBe("整理笔记");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(readPermissionRequests(ws)).toHaveLength(1);
  });

  it("群聊：roomKey 与相对路径按项目目录解析", async () => {
    seedEmployee("alice");
    seedProject("demo", ["alice"]);
    const ws = createWorkspace(root);
    const { ctx, store } = ctxWithStore(ws, "alice", { kind: "group", project: "demo" });
    await tool("request_permission").run({ paths: ["data/x"], reason: "r" }, ctx);
    expect(store.list()[0]!.roomKey).toBe("group:demo");
    expect(store.list()[0]!.paths).toEqual([path.join(root, "projects", "demo", "data", "x")]);
  });

  it("校验：paths 空 / reason 空白 → 报错", async () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const { ctx } = ctxWithStore(ws, "alice", dm("alice"));
    await expect(tool("request_permission").run({ paths: [], reason: "r" }, ctx)).rejects.toThrow("paths 不能为空");
    await expect(tool("request_permission").run({ paths: ["  "], reason: "r" }, ctx)).rejects.toThrow("paths 不能为空");
    await expect(tool("request_permission").run({ paths: ["a"], reason: "" }, ctx)).rejects.toThrow("reason 不能为空");
  });

  it("重复申请：同路径集合不新建，返回提示；称谓进入文案", async () => {
    seedEmployee("alice");
    fs.mkdirSync(path.join(root, ".openstaffs"), { recursive: true });
    fs.writeFileSync(path.join(root, ".openstaffs", "config.json"), JSON.stringify({ bossName: "掌柜" }));
    const ws = createWorkspace(root);
    const { ctx, store, notify } = ctxWithStore(ws, "alice", dm("alice"));
    const first = await tool("request_permission").run({ paths: ["a", "b"], reason: "r" }, ctx);
    expect(first).toContain("「掌柜」");
    const second = await tool("request_permission").run({ paths: ["b", "a"], reason: "r2" }, ctx);
    expect(second).toContain("已有相同的授权请求");
    expect(store.list()).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
```

3. 「注册表」用例更新：

```ts
  it("暴露 6 个工具且名字唯一", () => {
    const names = openStaffsToolDefs.map((t) => t.name).sort();
    expect(names).toEqual(["member_profile", "new_session", "office_list", "request_permission", "room_history", "send_message"]);
  });
```

`tests/tools/extension.test.ts` 第一个用例断言更新为 6 个名字（加 `"request_permission"`，保持字母序）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/tools/registry.test.ts tests/tools/extension.test.ts`
Expected: FAIL —— 工具不存在、注册表数量不符。

- [ ] **Step 3: 实现**

`src/tools/registry.ts`：

1. import 区补：

```ts
import { readBossName, readConfig, bossNamesFor } from "../domain/config.ts";   // 合并既有 readConfig 行
import type { PermissionRequest, PermissionRequestStore } from "../domain/permission-requests.ts";
import { mergeRoomMessages, parseRoomKey, roomKeyOf, type RoomSpeaker } from "../app/rooms.ts";  // 合并既有
import { newSession, openDm, openGroup, relationCwd, roomTranscripts, type SessionDefaults } from "../app/conversations.ts";  // 合并既有
```

2. `ToolContext` 扩展：

```ts
/** 授权请求依赖（由装配层注入；未注入时 request_permission 报"不可用"）。 */
export type ToolPermissions = {
  store: PermissionRequestStore;
  notify: (request: PermissionRequest) => void;
};

/** 工具运行上下文：会话身份 + 编排依赖。 */
export type ToolContext = {
  ws: Workspace;
  harness: HarnessPort;
  selfId: string;
  relation: Relation;
  permissions?: ToolPermissions;
};
```

3. 新增工具（放在 `newSessionTool` 之后）：

```ts
/** 申请写权限（异步：负责人稍后在界面弹框中处理）。 */
const requestPermission: ToolDef = {
  name: "request_permission",
  description:
    "向负责人申请写入某些路径的权限。**异步**：工具立即返回；负责人稍后在界面弹框中接受或拒绝，结果会以一条新消息通知你——在此之前不要重复发起，也不要尝试写入这些路径或用其他方式绕过拦截。paths 为要申请的路径（目录或文件，可多个；相对路径按当前工作目录解析）；reason 为简短理由（必填，会展示给负责人）。",
  parameters: Type.Object({
    paths: Type.Array(Type.String(), { description: "要申请的路径（目录 / 文件，可多个）" }),
    reason: Type.String({ description: "简短理由：为什么需要这些路径（会展示给负责人）" }),
  }),
  async run(args, ctx) {
    const permissions = ctx.permissions;
    if (permissions === undefined) throw new Error("授权申请不可用：当前会话未装配该能力。");
    const cwd = relationCwd(ctx.ws, ctx.relation);
    const rawPaths = Array.isArray(args["paths"]) ? args["paths"] : [];
    const paths = [
      ...new Set(
        rawPaths
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter((value) => value !== "")
          .map((value) => path.resolve(cwd, value)),
      ),
    ];
    const bossName = readBossName(ctx.ws);
    if (paths.length === 0) throw new Error("paths 不能为空：至少给出一个要申请的路径。");
    const reason = String(args["reason"] ?? "").trim();
    if (reason === "") throw new Error(`reason 不能为空：用一两句话说明为什么要这些路径（会展示给「${bossName}」）。`);
    if (permissions.store.findDuplicate(ctx.selfId, paths) !== undefined) {
      return `已有相同的授权请求在等待「${bossName}」处理（${paths.length} 个地址），请勿重复发起。`;
    }
    const request = permissions.store.add({ agentId: ctx.selfId, roomKey: roomKeyOf(ctx.relation), paths, reason });
    permissions.notify(request);
    return [
      `已向「${bossName}」发起授权请求（${paths.length} 个地址）：`,
      ...paths.map((value) => `- ${value}`),
      "等待处理：请勿重复发起，也不要尝试写入这些路径或用其他方式绕过拦截；处理后你会收到新消息。",
    ].join("\n");
  },
};
```

4. 导出数组：

```ts
export const openStaffsToolDefs: readonly ToolDef[] = [officeList, memberProfile, roomHistory, sendMessage, newSessionTool, requestPermission];
```

`src/tools/extension.ts`：

```ts
import type { PermissionRequest, PermissionRequestStore } from "../domain/permission-requests.ts";

export function createOpenStaffsToolsExtension(options: {
  ws: Workspace;
  getHarness: () => HarnessPort;
  /** 授权请求依赖（装配层注入；缺省时 request_permission 不可用）。 */
  permissions?: { store: PermissionRequestStore; notify: (request: PermissionRequest) => void };
}): Extension {
  return defineExtension({
    name: "openstaffs-tools",
    tools: openStaffsToolDefs.map((def) =>
      defineTool({
        name: def.name,
        description: def.description,
        parameters: def.parameters,
        async execute(args, api) {
          const harness = options.getHarness();
          const info = harness.sessionInfo(String(api.conversationId));
          if (info === undefined) {
            return { output: [{ type: "text", text: "工具不可用：未注册的会话" }], isError: true };
          }
          const ctx: ToolContext = {
            ws: options.ws,
            harness,
            selfId: info.selfId,
            relation: info.relation,
            ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
          };
          try {
            return { output: [{ type: "text", text: await def.run(args as Record<string, unknown>, ctx) }] };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { output: [{ type: "text", text: `失败：${message}` }], isError: true };
          }
        },
      }),
    ),
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/tools/registry.test.ts tests/tools/extension.test.ts`
Expected: PASS。

- [ ] **Step 5: 全量回归 + typecheck**

Run: `npm test && npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add src/tools/registry.ts src/tools/extension.ts tests/tools/registry.test.ts tests/tools/extension.test.ts
git commit -m "feat: request_permission 工具——异步申请、按 cwd 归一、重复去重"
```

---

### Task 10: 拦截提示（access-extension）

**Files:**
- Modify: `src/harness/access-extension.ts`
- Test: `tests/harness/access-extension.test.ts`

**Interfaces:**
- Produces: `writeBlockMessage(target: string): string`（导出，供测试与复用）——文案含「可调用 request_permission 工具申请授权（异步，批准后会收到通知）」。

- [ ] **Step 1: 写失败测试**

`tests/harness/access-extension.test.ts` 追加：

```ts
import { writeBlockMessage } from "../../src/harness/access-extension.ts";

describe("越界提示", () => {
  it("拦截文案引导申请授权（异步说明）", () => {
    const message = writeBlockMessage("/etc/passwd");
    expect(message).toContain('不可写 "/etc/passwd"');
    expect(message).toContain("request_permission");
    expect(message).toContain("异步");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/harness/access-extension.test.ts`
Expected: FAIL —— `writeBlockMessage` 未导出。

- [ ] **Step 3: 实现**

`src/harness/access-extension.ts`：

```ts
import { ToolTask, defineExtension, hook, type Extension } from "@earendil-works/pi-durable";
import { isWriteAllowed, type AccessContext } from "../domain/access-control.ts";

/** 越界写拦截文案（引导走授权申请通道）。 */
export function writeBlockMessage(target: string): string {
  return `访问控制：不可写 "${target}"。如确需写入，可调用 request_permission 工具申请授权（异步，批准后会收到通知）。`;
}

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
              return { block: writeBlockMessage(target) };
            }
            return undefined;
          }
          return undefined;
        },
      }),
    ],
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/harness/access-extension.test.ts`
Expected: PASS（既有 ACL 用例行为不变）。

- [ ] **Step 5: 全量回归 + typecheck**

Run: `npm test && npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add src/harness/access-extension.ts tests/harness/access-extension.test.ts
git commit -m "feat: 越界拦截提示引导授权申请（异步）"
```

---

### Task 11: 服务端端点 / SSE / 装配

**Files:**
- Modify: `src/server/sse.ts`、`src/server/http.ts`、`src/server/main.ts`
- Test: `tests/server/http.test.ts`、`tests/server/sse.test.ts`

**Interfaces:**
- Consumes: `PermissionRequestStore`（Task 6）、`resolvePermissionRequest`/`permissionRequestView`（Task 8）
- Produces:
  - SSE：`{ type: "permission.request"; request: PermissionRequestView }`、`{ type: "permission.resolved"; id: string }`
  - REST：`GET /api/permission-requests` → `{ requests: PermissionRequestView[] }`；`POST /api/permission-requests/:id/resolve`（body `{ decision: "accept" | "reject" }`）→ 200 `{ ok: true, warning? }` / 400 / 404 / 503
  - `ServerDeps.permissionRequests?: PermissionRequestStore`
  - `main.ts` 装配：store 注入 tools（notify 广播 view）与 http

- [ ] **Step 1: 写失败测试**

`tests/server/http.test.ts`：
1. `startWithFaux` 返回值加 `store`：

```ts
  const ws = createWorkspace(root);
  const store = new PermissionRequestStore(ws);
  const server = createHttpServer({ ws, getConfig: () => config, getHarness: () => harness, queue: new KeyedQueue(), publicDir, port: 4319, permissionRequests: store });
  // …
  return { base, close, store };
```

（返回类型 `Promise<{ base: string; close: () => Promise<void>; store: PermissionRequestStore }>`；顶部 import 补 `PermissionRequestStore`。）

2. 追加用例：

```ts
describe("授权请求 API", () => {
  it("GET 列表（新在前、带 agentName）；accept 写权限并投递「已完成授权」；处理后列表清空", async () => {
    const { base, close, store } = await startWithFaux(["alice"], []);
    try {
      const target = path.join(root, "outside", "shared");
      const added = store.add({ agentId: "alice", roomKey: "dm:alice", paths: [target], reason: "要写共享目录" });

      const list = (await (await fetch(`${base}/api/permission-requests`)).json()) as {
        requests: { id: string; agentName: string; paths: string[]; reason: string }[];
      };
      expect(list.requests).toHaveLength(1);
      expect(list.requests[0]).toMatchObject({ id: added.id, agentName: "爱丽丝", paths: [target], reason: "要写共享目录" });

      const resolve = await fetch(`${base}/api/permission-requests/${added.id}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "accept" }),
      });
      expect(resolve.status).toBe(200);
      expect(await resolve.json()).toEqual({ ok: true });

      expect(JSON.parse(fs.readFileSync(path.join(root, "agents", "alice", "permission.json"), "utf8"))).toEqual([target]);
      await waitFor(async () => {
        const body = (await (await fetch(`${base}/api/rooms/dm:alice/messages`)).json()) as { messages: { speaker: { kind: string }; text: string }[] };
        return body.messages.some((m) => m.speaker.kind === "boss" && m.text === "已完成授权") ? body : undefined;
      });
      const after = (await (await fetch(`${base}/api/permission-requests`)).json()) as { requests: unknown[] };
      expect(after.requests).toEqual([]);
    } finally {
      await close();
    }
  });

  it("群聊 accept：消息以 @alice 已完成授权 开头（只触发该成员）", async () => {
    const { base, close, store } = await startWithFaux(["alice"], ["alice"]);
    try {
      const added = store.add({ agentId: "alice", roomKey: "group:yt", paths: [path.join(root, "outside")], reason: "r" });
      const resolve = await fetch(`${base}/api/permission-requests/${added.id}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "accept" }),
      });
      expect(resolve.status).toBe(200);
      const merged = await waitFor(async () => {
        const body = (await (await fetch(`${base}/api/rooms/group:yt/messages`)).json()) as { messages: { text: string }[] };
        return body.messages.some((m) => m.text === "@alice 已完成授权") ? body : undefined;
      });
      expect(merged.messages.some((m) => m.text === "@alice 已完成授权")).toBe(true);
    } finally {
      await close();
    }
  });

  it("reject 不写文件；未知 id 404；非法 decision 400", async () => {
    const { base, close, store } = await startWithFaux(["alice"], []);
    try {
      const added = store.add({ agentId: "alice", roomKey: "dm:alice", paths: [path.join(root, "outside")], reason: "r" });
      const reject = await fetch(`${base}/api/permission-requests/${added.id}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "reject" }),
      });
      expect(reject.status).toBe(200);
      expect(fs.existsSync(path.join(root, "agents", "alice", "permission.json"))).toBe(false);

      const bad = await fetch(`${base}/api/permission-requests/${added.id}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "maybe" }),
      });
      expect(bad.status).toBe(400);
      const missing = await fetch(`${base}/api/permission-requests/pr_ghost/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "accept" }),
      });
      expect(missing.status).toBe(404);
    } finally {
      await close();
    }
  });
});
```

`tests/server/sse.test.ts` 在「SseHub」describe 追加：

```ts
it("授权事件可序列化广播（permission.request / permission.resolved）", () => {
  const hub = new SseHub();
  const { res, writes } = fakeRes();
  hub.add({ on: () => {} } as never, res);
  hub.broadcast({
    type: "permission.request",
    request: { id: "pr_1", agentId: "alice", agentName: "爱丽丝", roomKey: "dm:alice", paths: ["/x"], reason: "r", createdAt: "t" },
  });
  hub.broadcast({ type: "permission.resolved", id: "pr_1" });
  expect(writes.some((w) => w.includes("permission.request"))).toBe(true);
  expect(writes.some((w) => w.includes("permission.resolved"))).toBe(true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/server/http.test.ts tests/server/sse.test.ts`
Expected: FAIL —— deps 无 `permissionRequests` 字段、端点 404、ServerEvent 类型未定义。

- [ ] **Step 3: 实现**

`src/server/sse.ts`（顶部加 type import 与两个事件）：

```ts
import type { PermissionRequestView } from "../app/permission-flow.ts";

export type ServerEvent =
  | { type: "room.message"; roomKey: string; message: RoomMessage }
  | { type: "room.delta"; roomKey: string; convId: string; memberId: string; channel: "text" | "thinking"; delta: string }
  | { type: "room.activity"; roomKey: string; convId: string; memberId: string; kind: "run" | "tool"; phase: "start" | "end"; name?: string }
  | { type: "room.failed"; roomKey: string; convId: string; memberId: string; message: string; kind?: string }
  | { type: "room.unread"; roomKey: string; count: number }
  | { type: "permission.request"; request: PermissionRequestView }
  | { type: "permission.resolved"; id: string };
```

注意：`MAX_PENDING` 溢出丢增量的逻辑只对 `room.delta` / `room.activity` 生效，授权事件即权威事件，自动保留——无需改动。

`src/server/http.ts`：
1. import 补：

```ts
import { PermissionRequestStore } from "../domain/permission-requests.ts";   // 仅类型即够：import type
import { permissionRequestView, resolvePermissionRequest, PermissionRequestNotFoundError } from "../app/permission-flow.ts";
```

2. `ServerDeps` 加字段：

```ts
  /** 授权请求存储（装配层注入；缺省时相关端点降级）。 */
  permissionRequests?: PermissionRequestStore;
```

3. 在 `segments[1] === "rooms"` 分支之后、`unread` 分支之前插入：

```ts
          if (segments[1] === "permission-requests" && harness !== undefined) {
            const store = deps.permissionRequests;
            if (segments.length === 2 && method === "GET") {
              const requests = store?.list() ?? [];
              json(res, 200, { requests: requests.map((request) => permissionRequestView(deps.ws, request)) });
              return;
            }
            if (segments.length === 4 && segments[2] !== undefined && segments[3] === "resolve" && method === "POST") {
              if (store === undefined) {
                json(res, 503, { error: "授权请求服务未启用" });
                return;
              }
              let id: string;
              try {
                id = decodeURIComponent(segments[2]);
              } catch {
                json(res, 404, { error: "授权请求不存在或已处理" });
                return;
              }
              const body = (await readJsonBody(req)) as { decision?: unknown } | undefined;
              const decision = body?.decision;
              if (decision !== "accept" && decision !== "reject") {
                json(res, 400, { error: "decision 必须是 accept 或 reject" });
                return;
              }
              try {
                const result = await resolvePermissionRequest(
                  {
                    ws: deps.ws,
                    harness,
                    store,
                    queue: deps.queue,
                    defaults: { model: config.model },
                    ...(deps.pump === undefined ? {} : { register: (convId, ref) => deps.pump!.register(convId, ref) }),
                    ...(deps.hub === undefined ? {} : { broadcast: (rid) => deps.hub!.broadcast({ type: "permission.resolved", id: rid }) }),
                  },
                  id,
                  decision,
                );
                json(res, 200, result);
              } catch (error) {
                if (error instanceof PermissionRequestNotFoundError) {
                  json(res, 404, { error: error.message });
                  return;
                }
                throw error;
              }
              return;
            }
          }
```

（`config` 在该作用域上方已解构存在，`harness` 变量已存在。注意本分支放在「配置 undefined → 409」之后，天然不允许未配置访问。）

`src/server/main.ts`：
1. import 补：

```ts
import { PermissionRequestStore } from "../domain/permission-requests.ts";
import { permissionRequestView } from "../app/permission-flow.ts";
```

2. `const queue = new KeyedQueue();` 附近：

```ts
  const permissionRequests = new PermissionRequestStore(ws);
```

3. tools 装配：

```ts
      const tools = createOpenStaffsToolsExtension({
        ws,
        getHarness: () => harness!,
        permissions: {
          store: permissionRequests,
          notify: (request) => hub.broadcast({ type: "permission.request", request: permissionRequestView(ws, request) }),
        },
      });
```

4. `createHttpServer({ ... })` 的 deps 里加 `permissionRequests,`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/server/http.test.ts tests/server/sse.test.ts`
Expected: PASS。

- [ ] **Step 5: 全量回归 + typecheck + 手动冒烟**

Run: `npm test && npm run typecheck && npm run build:web`
Expected: 全绿；bundle 可构建。

- [ ] **Step 6: Commit**

```bash
git add src/server/sse.ts src/server/http.ts src/server/main.ts tests/server/http.test.ts tests/server/sse.test.ts
git commit -m "feat: 授权请求 REST/SSE——列表、处理端点、事件广播与装配"
```

---

### Task 12: 前端卡片 UI（右下角堆叠）

**Files:**
- Modify: `web/api.ts`、`web/state.ts`、`web/render.ts`、`web/main.ts`、`web/styles.css`
- Test: `tests/web/state.test.ts`、`tests/web/render.test.ts`

**Interfaces:**
- Consumes: `GET/POST /api/permission-requests`（Task 11）、`PermissionRequestView` 类型（type-only import）
- Produces:
  - `web/api.ts`：`PermissionRequestView`（re-export 类型）、`api.permissionRequests()`、`api.resolvePermission(id, decision)`
  - `web/state.ts`：`PermissionRequestItem = PermissionRequestView & { busy?: boolean; error?: string }`；`State.permissionRequests`；UiEvent `{ type: "permissions"; list }`、`{ type: "permission-busy"; id; busy }`、`{ type: "permission-error"; id; error }`、`{ type: "permission-resolved"; id }`
  - `web/render.ts`：`permissionCardsHtml(state): string`
  - `web/main.ts`：全局拉取、SSE 接入、卡片渲染与点击处理

- [ ] **Step 1: 写失败测试**

`tests/web/state.test.ts` 追加：

```ts
it("授权请求：全量替换、SSE 增量去重（新在前）、busy/error 与本地移除", () => {
  const request = { id: "pr_1", agentId: "alice", agentName: "爱丽丝", roomKey: "dm:alice", paths: ["/x"], reason: "r", createdAt: "t" };
  let state = inRoom();
  state = reduce(state, { type: "permissions", list: [request] });
  expect(state.permissionRequests).toHaveLength(1);

  state = reduce(state, { type: "sse", event: { type: "permission.request", request } });
  expect(state.permissionRequests).toHaveLength(1); // 去重

  const second = { ...request, id: "pr_2" };
  state = reduce(state, { type: "sse", event: { type: "permission.request", request: second } });
  expect(state.permissionRequests.map((r) => r.id)).toEqual(["pr_2", "pr_1"]); // 新的在前

  state = reduce(state, { type: "permission-busy", id: "pr_2", busy: true });
  expect(state.permissionRequests[0]!.busy).toBe(true);
  state = reduce(state, { type: "permission-error", id: "pr_2", error: "写盘失败" });
  expect(state.permissionRequests[0]!.error).toBe("写盘失败");

  state = reduce(state, { type: "sse", event: { type: "permission.resolved", id: "pr_1" } });
  expect(state.permissionRequests.map((r) => r.id)).toEqual(["pr_2"]);
  state = reduce(state, { type: "permission-resolved", id: "pr_2" });
  expect(state.permissionRequests).toEqual([]);
});
```

`tests/web/render.test.ts` 追加（import 补 `permissionCardsHtml`）：

```ts
describe("授权卡片", () => {
  const request = {
    id: "pr_1", agentId: "alice", agentName: "爱丽丝<b>", roomKey: "group:yt",
    paths: ["/x/<script>"], reason: "整理素材", createdAt: "t",
  };

  it("卡片：发起人/来源/理由/路径转义、接受与拒绝按钮", () => {
    const state = { ...initialState, configured: true, projects: [{ id: "yt", alias: "演示", members: [] }], permissionRequests: [request] };
    const html = permissionCardsHtml(state);
    expect(html).toContain("授权请求");
    expect(html).toContain("爱丽丝&lt;b&gt;");
    expect(html).toContain("群聊「演示」");
    expect(html).toContain("理由：整理素材");
    expect(html).toContain("/x/&lt;script&gt;");
    expect(html).toContain('data-perm-accept="pr_1"');
    expect(html).toContain('data-perm-reject="pr_1"');
    expect(html).not.toContain("<script>");
  });

  it("处理中禁用按钮、错误行显示；私聊来源标签", () => {
    const state = {
      ...initialState,
      configured: true,
      permissionRequests: [{ ...request, roomKey: "dm:alice", busy: true, error: "写盘失败" }],
    };
    const html = permissionCardsHtml(state);
    expect(html).toMatch(/data-perm-accept="pr_1" disabled/u);
    expect(html).toContain("写盘失败");
    expect(html).toContain("私聊");
  });

  it("空列表 → 空容器", () => {
    expect(permissionCardsHtml(initialState)).toBe('<div class="perm-cards" id="perm-cards"></div>');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/web/state.test.ts tests/web/render.test.ts`
Expected: FAIL —— 类型/事件/渲染函数不存在。

- [ ] **Step 3: 实现**

`web/api.ts`：

```ts
import type { PermissionRequestView } from "../src/app/permission-flow.ts";
export type { PermissionRequestView } from "../src/app/permission-flow.ts";

// api 对象追加：
  permissionRequests: () => request<{ requests: PermissionRequestView[] }>("/api/permission-requests"),
  resolvePermission: (id: string, decision: "accept" | "reject") =>
    request<{ ok: boolean; warning?: string }>(`/api/permission-requests/${encodeURIComponent(id)}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    }),
```

`web/state.ts`：

```ts
import type { PermissionRequestView } from "./api.ts";

export type PermissionRequestItem = PermissionRequestView & { busy?: boolean; error?: string };

export type State = {
  configured: boolean;
  bossName: string;
  employees: EmployeeSummary[];
  projects: ProjectSummary[];
  permissionRequests: PermissionRequestItem[];   // ← 新增
  roomKey?: string;
  // …
};

export const initialState: State = {
  configured: false,
  bossName: "老板",
  employees: [],
  projects: [],
  permissionRequests: [],                        // ← 新增
  messages: [],
  // …
};

export type UiEvent =
  // …
  | { type: "permissions"; list: PermissionRequestView[] }
  | { type: "permission-busy"; id: string; busy: boolean }
  | { type: "permission-error"; id: string; error: string }
  | { type: "permission-resolved"; id: string }
  | { type: "sse"; event: ServerEvent };

// reduce 追加：
    case "permissions":
      return { ...state, permissionRequests: event.list };
    case "permission-busy":
      return { ...state, permissionRequests: state.permissionRequests.map((r) => (r.id === event.id ? { ...r, busy: event.busy } : r)) };
    case "permission-error":
      return { ...state, permissionRequests: state.permissionRequests.map((r) => (r.id === event.id ? { ...r, error: event.error } : r)) };
    case "permission-resolved":
      return { ...state, permissionRequests: state.permissionRequests.filter((r) => r.id !== event.id) };

// reduceSse 开头（room.unread 之后、state.roomKey 过滤之前——授权事件是全局的）：
  if (event.type === "permission.request") {
    if (state.permissionRequests.some((r) => r.id === event.request.id)) return state;
    return { ...state, permissionRequests: [event.request, ...state.permissionRequests] };
  }
  if (event.type === "permission.resolved") {
    const next = state.permissionRequests.filter((r) => r.id !== event.id);
    return next.length === state.permissionRequests.length ? state : { ...state, permissionRequests: next };
  }
```

`web/render.ts` 追加：

```ts
function roomLabel(state: State, roomKey: string): string {
  if (!roomKey.startsWith("group:")) return "私聊";
  const project = state.projects.find((p) => `group:${p.id}` === roomKey);
  return project === undefined ? roomKey : `群聊「${project.alias}」`;
}

/** 右下角授权卡片堆叠（新请求在前；空列表为空容器）。 */
export function permissionCardsHtml(state: State): string {
  const cards = state.permissionRequests
    .map((request) => {
      const flavour = request.busy === true ? " disabled" : "";
      const error = request.error === undefined ? "" : `<div class="perm-error">${escapeHtml(request.error)}</div>`;
      const paths = request.paths.map((p) => `<li><code>${escapeHtml(p)}</code></li>`).join("");
      return `<div class="perm-card">
        <div class="perm-title">授权请求</div>
        <div class="perm-meta">发起人：${escapeHtml(request.agentName)}（${escapeHtml(request.agentId)}） · 来自：${escapeHtml(roomLabel(state, request.roomKey))}</div>
        <div class="perm-reason">理由：${escapeHtml(request.reason)}</div>
        <ul class="perm-paths">${paths}</ul>
        <div class="perm-actions">
          <button data-perm-accept="${escapeHtml(request.id)}"${flavour}>接受</button>
          <button data-perm-reject="${escapeHtml(request.id)}"${flavour}>拒绝</button>
        </div>
        ${error}
      </div>`;
    })
    .join("");
  return `<div class="perm-cards" id="perm-cards">${cards}</div>`;
}

export function layoutHtml(state: State): string {
  return `<div class="layout">${sidebarHtml(state)}${chatHtml(state)}</div>${permissionCardsHtml(state)}`;
}
```

`web/main.ts`：
1. import 补 `permissionCardsHtml`（render 行）。
2. `renderAll` 后 `bindEvents()` 内追加 `bindPermCards()`。
3. `renderDynamic`：非 sse 分支先处理授权类事件；sse switch 加两个 case：

```ts
function renderDynamic(event: UiEvent): void {
  if (event.type !== "sse") {
    if (event.type === "permissions" || event.type === "permission-busy" || event.type === "permission-error" || event.type === "permission-resolved") {
      renderPermCards();
      return;
    }
    renderSidebar();
    return;
  }
  switch (event.event.type) {
    case "permission.request":
    case "permission.resolved":
      renderPermCards();
      return;
    // …既有 case 不变…
  }
}

function renderPermCards(): void {
  const holder = document.getElementById("perm-cards");
  if (holder === null) return; // setup 页 / 历史视图内无容器时跳过
  holder.outerHTML = permissionCardsHtml(state);
  bindPermCards();
}

function bindPermCards(): void {
  for (const button of app.querySelectorAll<HTMLButtonElement>("[data-perm-accept]")) {
    button.addEventListener("click", () => guard(resolvePermission(button.dataset.permAccept!, "accept")));
  }
  for (const button of app.querySelectorAll<HTMLButtonElement>("[data-perm-reject]")) {
    button.addEventListener("click", () => guard(resolvePermission(button.dataset.permReject!, "reject")));
  }
}

async function resolvePermission(id: string, decision: "accept" | "reject"): Promise<void> {
  dispatch({ type: "permission-busy", id, busy: true });
  try {
    const result = await api.resolvePermission(id, decision);
    dispatch({ type: "permission-resolved", id });
    if (result.warning !== undefined) window.alert(result.warning);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("不存在或已处理")) {
      dispatch({ type: "permission-resolved", id }); // 其他标签页已处理：本地同步移除
      return;
    }
    dispatch({ type: "permission-busy", id, busy: false });
    dispatch({ type: "permission-error", id, error: message });
  }
}
```

4. **历史视图同样有卡片容器**：`openHistory()` / `loadHistoryView()` 的 `app.innerHTML` 模板末尾同样追加 `${permissionCardsHtml(state)}`（spec §6.3：全局卡片在历史等只读视图期间也可见；返回聊天由 `renderAll` 重建）。

5. `refreshAll` 与 `main()` 拉取全量：

```ts
async function refreshAll(): Promise<void> {
  const [employees, projects, unread, permissions] = await Promise.all([
    api.employees(), api.projects(), api.unread(), api.permissionRequests(),
  ]);
  dispatch({ type: "employees", list: employees });
  dispatch({ type: "projects", list: projects });
  dispatch({ type: "unread", unread });
  dispatch({ type: "permissions", list: permissions.requests });
  // …既有当前房间重拉不变…
}
```

`main()` 里同理把 `api.permissionRequests()` 加入初次 Promise.all 并 dispatch `{ type: "permissions", list: permissions.requests }`。

`web/styles.css` 追加：

```css
/* 授权卡片（右下角堆叠，全局） */
.perm-cards { position: fixed; right: 16px; bottom: 16px; display: flex; flex-direction: column; gap: 10px; width: 340px; max-height: 70vh; overflow-y: auto; z-index: 100; }
.perm-card { background: #fff; border: 1px solid #e3e5e8; border-radius: 10px; box-shadow: 0 6px 24px rgba(15, 23, 42, 0.12); padding: 12px 14px; font-size: 13px; }
.perm-title { font-weight: 600; margin-bottom: 6px; }
.perm-meta { color: #8a9099; font-size: 12px; margin-bottom: 6px; }
.perm-reason { margin-bottom: 6px; word-break: break-word; }
.perm-paths { margin: 0 0 8px; padding-left: 18px; max-height: 120px; overflow-y: auto; }
.perm-paths code { font-size: 12px; word-break: break-all; }
.perm-actions { display: flex; gap: 8px; }
.perm-actions button { border: 0; border-radius: 6px; padding: 5px 14px; cursor: pointer; font-size: 13px; }
.perm-actions button[data-perm-accept] { background: #1677ff; color: #fff; }
.perm-actions button[data-perm-reject] { background: #f0f2f5; color: #1f2329; }
.perm-actions button:disabled { opacity: 0.5; cursor: default; }
.perm-error { color: #a8071a; font-size: 12px; margin-top: 6px; }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/web/state.test.ts tests/web/render.test.ts`
Expected: PASS。

- [ ] **Step 5: 全量回归 + typecheck + bundle 守卫**

Run: `npm test && npm run typecheck`
Expected: 全绿（含 bundle 守卫——web→src 的 type-only import 不得引入 node 内置）。

- [ ] **Step 6: 手动冒烟（可选但推荐）**

Run: `npm start -- <你的测试项目目录>` → 浏览器打开 → 用 `curl -X POST` 或直接手动造一条 `permission-requests.json` 看卡片出现、点击接受/拒绝生效。

- [ ] **Step 7: Commit**

```bash
git add web/api.ts web/state.ts web/render.ts web/main.ts web/styles.css tests/web/state.test.ts tests/web/render.test.ts
git commit -m "feat: 授权卡片 UI——右下角堆叠、接受/拒绝、处理态与错误反馈"
```

---

### Task 13: 文档同步（技能手册 / README / 手动验收）

**Files:**
- Modify: `src/skills/openstaffs/SKILL.md`、`src/skills/openstaffs-ops/SKILL.md`、`README.md`、`docs/手动验收清单.md`

**Interfaces:**
- 无代码接口；产出为文档。验证方式：人工阅读 + 关键句 grep。

- [ ] **Step 1: 更新 `src/skills/openstaffs/SKILL.md`**

1. 「你是谁、在哪工作」小节末尾（"优先相信环境段给出的事实"一行后）加：

```
> 本手册中的「老板」指你的负责人（办公室所有者）。负责人可自定义称谓（如「掌柜」），以环境段给出的为准；汇报与 `@` 写法同样以环境段为准（`@老板`、`@boss` 亦有效）。
```

2.「写权限边界（硬规则，越界会被工具层拦截）」小节中，"其它位置一律只读……"与引用 blockquote 之后加：

```
### 申请额外写权限（`request_permission`，异步）

超出上述边界的路径，用 `request_permission` 工具申请：

- 传入要写入的路径（可多条；相对路径按当前工作目录解析）+ **简短理由**（`reason`，必填——老板可能过一阵才看到弹框，凭它了解你的目的；一两句即可）。
- **这是异步申请**：工具立即返回"已发起"，老板稍后在界面的授权弹框中接受或拒绝。
- **发起后不要原地等待，也不要反复尝试写入这些路径**（权限未批，写了也会被拦）；不要重复发起同一请求。
- **等待期间不要"越狱"**：不得用 `bash`、改写权限文件、请其他成员代写等任何方式绕过拦截去写目标路径——bash 全开是给你干正事的，不是绕过授权的后门。
- 等待期间照常做别的：该干的活继续干，没事就结束本轮。
- 收到「已完成授权」消息 = 权限已就位，直接继续写；收到「已拒绝授权」则不要再试，除非有新的授权。
```

3.「可用工具（OpenStaffs 内置）」清单在 `new_session` 行前加：

```
- `request_permission`：向负责人申请写入某些路径的权限（**异步**：立即返回，负责人稍后在界面弹框中接受/拒绝；批准/拒绝后会以新消息通知你）。详见「写权限边界」一节的「申请额外写权限」。
```

- [ ] **Step 2: 更新 `src/skills/openstaffs-ops/SKILL.md`**

1. 「总原则」blockquote 后加映射句：

```
> 「老板」在本参考中同样指你的负责人（办公室所有者）：称谓可在全局配置里自定义（见下），以环境段与实际界面为准。
```

2. 「员工目录」表格 `permission.json` 行说明改为：

```
| `permission.json` | | 额外写权限：JSON 字符串数组；相对路径相对该文件所在目录。老板维护、你不可改写；**经授权弹框批准后由框架代写**（追加发起者申请通过的路径） |
```

3. 全局配置表 `bossName` 行改为：

```
| `bossName` | 可选：负责人称谓（缺省「老板」）。空值/缺失自动回落，**不可为空、不可移除**；界面、消息与工具文案统一消费此称谓 |
```

4. 「运维操作与授权」小节第 2 步（"向老板请求授权"）补充弹框通道：

```
2. **向老板请求授权**：用 `request_permission` 工具发起（老板在界面的授权弹框中整体接受/拒绝；批准后框架把路径写入你的 `permission.json` 并通知你）；也可以由老板手工把路径写进 `permission.json`（员工级或项目级）后直接完成。
```

5. 「常见故障对照」表追加两行：

```
| 点了授权弹框但员工没反应 | 通知消息投递失败（看服务端日志）；或该员工期间新开过会话——让他再尝试写入即可 |
| 授权弹框重启后还在 | 属预期：待处理请求落盘于 `.openstaffs/permission-requests.json`，处理完即删 |
```

- [ ] **Step 3: 更新 `README.md`**

config 字段说明（`model` 行后）加：

```
- `bossName`：可选，负责人称谓（缺省「老板」；空值自动回落，不可为空）。界面、消息与员工文案都用它。
```

- [ ] **Step 4: 更新 `docs/手动验收清单.md`**

1. 第 10 条 status 字段列表改为：`/api/status` 只含 `configured` / `root` / `port` / `model` / `providers`（供应商名单）/ `bossName`。
2. 末尾追加：

```
16. **授权弹框（接受）**：私聊让 alice 尝试写工作区外的路径（如 `/tmp/openstaffs-demo/x.md`）→ 被拦且提示可申请；alice 调 `request_permission`（带理由）→ 右下角出现卡片（发起人 / 理由 / 绝对路径）；点「接受」→ `agents/alice/permission.json` 出现该路径、alice 收到「已完成授权」并继续写入成功。
17. **授权弹框（拒绝）**：再申请一次 → 点「拒绝」→ 无文件写入；alice 收到「已拒绝授权」；再次写仍被拦。
18. **群里多弹框**：两名成员分别申请 → 两张卡片堆叠、各自处理；批准消息以 `@<该成员> 已完成授权` 开头出现在群里、只触发该成员。
19. **重启保留**：申请后不处理 → 重启服务 → 刷新页面 → 卡片仍在，可正常处理。
20. **称谓自定义**：`config` 写 `"bossName": "掌柜"` → 重启 → 界面发言人名 / 环境段 / 工具与弹框相关文案显示「掌柜」；成员回复 `@掌柜` 计入待办红点；`@老板` 仍有效；`bossName` 置空 → 回落「老板」。
21. **异步认知**：观察 alice 发起申请后的行为：不反复尝试写入、不重复发起；等待期间继续做其他工作或结束本轮；批准后以新一轮继续。
```

- [ ] **Step 5: 一致性检查**

Run: `grep -n "request_permission" src/skills/openstaffs/SKILL.md src/skills/openstaffs-ops/SKILL.md README.md | head; grep -n "bossName" src/skills/openstaffs-ops/SKILL.md README.md`
Expected: 技能手册与 README 均含新工具与新字段说明；无残留旧措辞（如「老板在 `agents/alice/permission.json` 里写」段落的上下文仍成立）。

- [ ] **Step 6: 全量回归**

Run: `npm test && npm run typecheck`

- [ ] **Step 7: Commit**

```bash
git add src/skills/openstaffs/SKILL.md src/skills/openstaffs-ops/SKILL.md README.md docs/手动验收清单.md
git commit -m "docs: 授权申请与称谓单源化同步——技能手册、运维参考、README、验收清单"
```

---

## Self-Review 记录（写计划时已执行）

- **Spec 覆盖**：§3→T6；§4→T9（异步三层：T9 工具描述/返回、T13 手册）；§5→T8/T11；§6→T12；§7.1→T7；§7.2→T8/T11；§8.1-8.2→T5；§8.3→T3；§8.4→T1/T2；§8.5→T4；§8.6→T13；§11 手动验收→T13。
- **类型一致性**：`PermissionRequest`/`PermissionRequestStore`（T6）→ `ToolPermissions`（T9）/`PermissionFlowDeps`（T8）→ `permissionRequestView`（T8）→ `ServerEvent`（T11）→ `PermissionRequestItem`（T12）——命名与字段逐处核对一致。
- **Review Focus 归属**：假成功→T8/T11；重复/并发→T7/T8/T11；越界提权→T7/T8；称谓回归→T1-T5；重启与坏文件→T6/T11。
- **已知取舍**：`access-extension` 拦截文案不出现称谓（避免给 `AccessContext` 增依赖）；前端 `composer` 的 @ 解析无需改（老板侧 @ 语义只作用于成员）；技能手册为静态文件，用术语映射而非运行时渲染。
