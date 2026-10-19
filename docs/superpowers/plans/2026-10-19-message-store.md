# 消息自有库（P1）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「消息真相」从基座（Pi）transcript 搬到 OpenStaffs 自有 SQLite 库；房间视图 / 历史改走库；群会话不再做读侧「合并 + 去重」。**Pi 会话保留**（上下文 / compaction 不变）。

**Architecture:** 新增 `src/store/` 模块（Node 内置 `node:sqlite` 的 `DatabaseSync`）承载 spec §13 的消息表。**写入**在「老板 / 员工输入」与「agent 回复（run 结束）」两处各落**一行**；**读取**把 `http` 的房间端点与 `pump` 的推送从「合并各成员 transcript」改为「查库」。`rooms.ts` 的 `mergeRoomMessages`（合并 + `roomMessageId` 去重）整体删除。

**Tech Stack:** Node 24 内置 `node:sqlite`（实验特性，**不新增外部依赖**）、Vitest、vanilla TS（`npm start` 直接跑 TS，strip-only）。

**Spec:** `docs/superpowers/specs/2026-10-18-agent-org-hierarchy-design.md`（§13 消息表 schema、D29/D30/D31）

## Global Constraints

- Node ≥ 22.19（本机 24.3.0）；`npm start` = `node src/server/main.ts`，**strip-only TS**：不得用参数属性（`constructor(private x)`），不得用 `enum` / 装饰器。
- 存储用**内置 `node:sqlite`**，不加依赖。运行时会打印 `ExperimentalWarning: SQLite ...`（可接受）。
- 消息 schema 严格按 **spec §13**：逻辑字段 `id / seq / sendTime / projectId / fromId / toIds / text / sessionId?`。保留参与者 id `__boss` / `__system`（前缀 `__`）。`text` **剥离头部 `@` 块**；**一次投递 = 一条记录**（不设 `roomMessageId`）。
- 数据库文件：`messagesDbFile(ws) = path.join(stateDir(ws), "messages.sqlite")`（P4 会把 `stateDir` 迁到 `openstaffs/.data/`，本计划不依赖其位置）。
- TDD：每任务**先写失败测试**；提交信息用简体中文祈使句。

## Review Focus

- **`text` 剥离 @ 的边界**：只剥**头部前缀块**；正文中 / 尾部的 `@` **保留**；「只有 @ 没有正文」「空正文」不落库。
- **私聊 vs 群聊**：私聊 `projectId = null`；群聊 = 项目 id；`type` **不落库**（由 `projectId` 派生）。
- **老板 / 系统参与者**：`__boss` / `__system` 出现在 `fromId` / `toIds`；不落 `isToBoss` 之类派生布尔。
- **`seq` 单调**：同一毫秒连发多条不串序。
- **空 / 坏库**：文件不存在时自动建表；读空房间返回 `[]`（不抛）。
- **群聊一次发 N 人 = 1 行**（`toIds=[...]`），不是 N 行。

---

## File Structure

- **Create** `src/store/row.ts` — `StoredMessage` 类型 + `roomKeyOfMessage`（派生索引键）。
- **Create** `src/store/messages.ts` — `MessageStore`（`openMessageStore` / `append` / `listByRoom` / `close`）。
- **Create** `src/app/message-row.ts` — 归一化：把「一次发言」转成 `StoredMessage`（剥离 `@`、算 `toIds`）。
- **Modify** `src/domain/paths.ts` — 新增 `messagesDbFile(ws)`。
- **Modify** `src/app/rooms.ts` — 删除 `mergeRoomMessages`；保留 `RoomMessage`（UI 形态），新增 `toRoomMessage(stored)` 映射。
- **Modify** `src/app/send.ts` — `sendToRoom` / `triggerFromGroupReply` 落库。
- **Modify** `src/server/pump.ts` — agent `message`（assistant）落库；推送改为推 `StoredMessage`→`RoomMessage`。
- **Modify** `src/server/http.ts` — 房间消息端点改查库。
- **Modify** `src/server/sse.ts` — `room.message` 载荷不变（仍是 `RoomMessage`）。
- **Modify** `web/state.ts` — 去掉 `roomMessageId` 去重分支。
- **Tests** `tests/store/messages.test.ts`、`tests/app/message-row.test.ts`、`tests/app/send.test.ts`（补）、`tests/server/pump.test.ts`（补）。

---

## Task 1: `MessageStore`（自有库骨架）

**Files:**
- Create: `src/domain/paths.ts`（追加 `messagesDbFile`）
- Create: `src/store/row.ts`
- Create: `src/store/messages.ts`
- Test: `tests/store/messages.test.ts`

**Interfaces:**
- Produces:
  - `messagesDbFile(ws: Workspace): string`
  - `type StoredMessage = { id: string; seq: number; sendTime: string; room: string; projectId: string | null; fromId: string; toIds: string[]; text: string; sessionId?: string }`
  - `roomKeyOfMessage(m: Omit<StoredMessage,"room">): string`（`projectId===null ? "dm:"+other(agent) : "group:"+projectId`）
  - `openMessageStore(file: string): MessageStore`，`MessageStore = { append(input: Omit<StoredMessage,"id"|"seq"|"room">): StoredMessage; listByRoom(room: string): StoredMessage[]; close(): void }`

- [ ] **Step 1: 写失败测试**

```ts
// tests/store/messages.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { openMessageStore, type MessageStore } from "../../src/store/messages.ts";

let dir: string;
let store: MessageStore;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "os-msg-"));
  store = openMessageStore(path.join(dir, "messages.sqlite"));
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const base = {
  sendTime: "2026-10-19T10:00:00.000Z",
  projectId: "seo" as string | null,
  fromId: "__boss",
  toIds: ["alice"],
  text: "你好",
};

test("append 返回带自增 seq 与 id 的整行；listByRoom 按 seq 升序", () => {
  const a = store.append({ ...base, projectId: null, toIds: ["alice"], text: "一" });
  const b = store.append({ ...base, projectId: null, toIds: ["alice"], text: "二" });
  expect(a.id).not.toBe(b.id);
  expect(b.seq).toBeGreaterThan(a.seq);
  const rows = store.listByRoom("dm:alice");
  expect(rows.map((r) => r.text)).toEqual(["一", "二"]);
});

test("群聊：projectId 非空 → room = group:<projectId>；不同房间互不串", () => {
  store.append({ ...base, text: "群里的话" });
  store.append({ ...base, projectId: null, toIds: ["alice"], text: "私聊的话" });
  expect(store.listByRoom("group:seo").map((r) => r.text)).toEqual(["群里的话"]);
  expect(store.listByRoom("dm:alice").map((r) => r.text)).toEqual(["私聊的话"]);
});

test("toIds 以 JSON 往返，多收件人保序", () => {
  store.append({ ...base, toIds: ["alice", "bob", "__boss"] });
  expect(store.listByRoom("group:seo")[0]!.toIds).toEqual(["alice", "bob", "__boss"]);
});

test("空房间返回 []（不抛）", () => {
  expect(store.listByRoom("group:nope")).toEqual([]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/store/messages.test.ts`
Expected: FAIL —— `openMessageStore` 未定义（模块不存在）。

- [ ] **Step 3: 实现 `paths.ts` 追加**

```ts
// src/domain/paths.ts  （文件末尾追加）
/** 自有消息库（P1）；`stateDir` 的迁移（P4）不影响本函数语义。 */
export function messagesDbFile(ws: Workspace): string {
  return path.join(stateDir(ws), "messages.sqlite");
}
```

- [ ] **Step 4: 实现 `src/store/row.ts`**

```ts
// src/store/row.ts
export type StoredMessage = {
  id: string;
  seq: number;
  /** ISO 时间戳（只落库；喂模型不带时间）。 */
  sendTime: string;
  /** 派生索引键：'dm:<agentId>' | 'group:<projectId>'。 */
  room: string;
  /** 群聊 = 项目 id；私聊 = null。 */
  projectId: string | null;
  /** 参与者 id：agent id，或保留 id '__boss' / '__system'。 */
  fromId: string;
  /** 参与者 id 列表（可含 '__boss' / '__system'）。 */
  toIds: string[];
  /** 已剥离头部 @ 块的内容。 */
  text: string;
  sessionId?: string;
};

export const BOSS_PARTICIPANT = "__boss";
export const SYSTEM_PARTICIPANT = "__system";

/** 由 projectId 与参与者推出房间键（私聊取非 boss/system 的一方）。 */
export function roomKeyOfMessage(m: { projectId: string | null; fromId: string; toIds: string[] }): string {
  if (m.projectId !== null) return `group:${m.projectId}`;
  const agent = [m.fromId, ...m.toIds].find((id) => id !== BOSS_PARTICIPANT && id !== SYSTEM_PARTICIPANT);
  return `dm:${agent ?? ""}`;
}
```

- [ ] **Step 5: 实现 `src/store/messages.ts`**

```ts
// src/store/messages.ts
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { roomKeyOfMessage, type StoredMessage } from "./row.ts";

export type MessageStore = {
  append(input: Omit<StoredMessage, "id" | "seq" | "room">): StoredMessage;
  listByRoom(room: string): StoredMessage[];
  close(): void;
};

type Row = { id: string; seq: number; send_time: string; room: string; project_id: string | null; from_id: string; to_ids: string; text: string; session_id: string | null };

function toStored(r: Row): StoredMessage {
  return {
    id: r.id,
    seq: r.seq,
    sendTime: r.send_time,
    room: r.room,
    projectId: r.project_id,
    fromId: r.from_id,
    toIds: JSON.parse(r.to_ids) as string[],
    text: r.text,
    ...(r.session_id === null ? {} : { sessionId: r.session_id }),
  };
}

export function openMessageStore(file: string): MessageStore {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL,
      send_time TEXT NOT NULL,
      room TEXT NOT NULL,
      project_id TEXT,
      from_id TEXT NOT NULL,
      to_ids TEXT NOT NULL,
      text TEXT NOT NULL,
      session_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_room_seq ON messages(room, seq);
  `);
  const nextSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages");
  const insert = db.prepare(
    "INSERT INTO messages (id, seq, send_time, room, project_id, from_id, to_ids, text, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const selectRoom = db.prepare("SELECT * FROM messages WHERE room = ? ORDER BY seq ASC");
  return {
    append(input) {
      const id = `m_${randomUUID()}`;
      const seq = (nextSeq.get() as { seq: number }).seq;
      const room = roomKeyOfMessage(input);
      insert.run(id, seq, input.sendTime, room, input.projectId, input.fromId, JSON.stringify(input.toIds), input.text, input.sessionId ?? null);
      return { id, seq, room, ...input };
    },
    listByRoom(room) {
      return (selectRoom.all(room) as Row[]).map(toStored);
    },
    close() { db.close(); },
  };
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run tests/store/messages.test.ts`
Expected: PASS（4 passed）。

- [ ] **Step 7: 提交**

```bash
git add src/domain/paths.ts src/store/row.ts src/store/messages.ts tests/store/messages.test.ts
git commit -m "feat(store): 新增自有消息库（node:sqlite；spec §13 表结构）"
```

---

## Task 2: 归一化 `message-row`（一次发言 → 一行）

**Files:**
- Create: `src/app/message-row.ts`
- Test: `tests/app/message-row.test.ts`

**Interfaces:**
- Consumes: `leadingMentionLength`（`src/domain/mention.ts`）、`BOSS_PARTICIPANT`（`src/store/row.ts`）
- Produces:
  - `stripLeadingMentions(text: string): string`（剥头部 `@` 前缀块）
  - `type OutgoingInput = { projectId: string | null; fromId: string; toIds: string[]; text: string; sessionId?: string; hasBody: boolean }`
  - `parseAgentReply(raw: string, memberIds: string[], bossNames: string[]): { toIds: string[]; text: string }`（从 agent 回复解析收件人 + 剥头）

- [ ] **Step 1: 写失败测试**

```ts
// tests/app/message-row.test.ts
import { expect, test } from "vitest";
import { parseAgentReply, stripLeadingMentions } from "../../src/app/message-row.ts";

test("只剥头部 @ 前缀块；中 / 尾部 @ 保留", () => {
  expect(stripLeadingMentions("@alice @bob 请开始")).toBe("请开始");
  expect(stripLeadingMentions("你好 @alice")).toBe("你好 @alice");
  expect(stripLeadingMentions("@alice")).toBe("");
  expect(stripLeadingMentions("  @alice   干活  ")).toBe("干活");
});

test("agent 回复：@成员 → toIds 命中；否则视为发给老板", () => {
  expect(parseAgentReply("@bob 我做完了", ["alice", "bob"], ["老板"])).toEqual({ toIds: ["bob"], text: "我做完了" });
  expect(parseAgentReply("我做完了", ["alice", "bob"], ["老板"])).toEqual({ toIds: ["__boss"], text: "我做完了" });
  expect(parseAgentReply("@老板 汇报", ["alice", "bob"], ["老板"])).toEqual({ toIds: ["__boss"], text: "汇报" });
});

test("agent 只 @ 没正文 → 空 toIds + 空 text（调用方据此不落库）", () => {
  expect(parseAgentReply("@bob", ["alice", "bob"], ["老板"])).toEqual({ toIds: [], text: "" });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/app/message-row.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 `src/app/message-row.ts`**

```ts
// src/app/message-row.ts
import { BOSS_ID, leadingMentionLength, parseMentions } from "../domain/mention.ts";
import { BOSS_PARTICIPANT } from "../store/row.ts";

/** 剥离正文开头的 @ 前缀块；返回剩余正文（trim）。 */
export function stripLeadingMentions(text: string): string {
  return text.slice(leadingMentionLength(text)).trim();
}

/** agent 回复 → 收件人 + 纯正文；只 @ 无正文 → toIds=[]。 */
export function parseAgentReply(
  raw: string,
  memberIds: string[],
  bossNames: string[],
): { toIds: string[]; text: string } {
  const text = stripLeadingMentions(raw);
  const targets = parseMentions(raw, memberIds, bossNames).targets;
  const toIds = targets.map((t) => (t === BOSS_ID ? BOSS_PARTICIPANT : t));
  if (text === "") return { toIds: [], text: "" };
  return { toIds: toIds.length === 0 ? [BOSS_PARTICIPANT] : toIds, text };
}
```

> 注：`BOSS_ID` 现为 `"boss"`；本任务**不改**它（P3 再统一为 `__boss`）。这里只把解析出的 boss 目标映射成参与者保留 id。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/app/message-row.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/app/message-row.ts tests/app/message-row.test.ts
git commit -m "feat(app): 新增消息归一化（剥离头部 @、推导收件人）"
```

---

## Task 3: 写入路径 —— 老板 / 员工输入落库

**Files:**
- Modify: `src/app/send.ts`
- Test: `tests/app/send.test.ts`（补用例）

**Interfaces:**
- Consumes: `MessageStore`（Task 1）、`stripLeadingMentions`（Task 2）
- Produces: `sendToRoom(..., deps)` 新增 `store?: MessageStore`；命中即落**一行**（`fromId="__boss"`，`toIds` = 路由到的成员；`projectId` = 群聊项目 id / 私聊 null）。`triggerFromGroupReply` 同理（`fromId` = 发言 agent，`toIds` = 被 @ 成员）。

- [ ] **Step 1: 写失败测试**（`tests/app/send.test.ts` 追加）

```ts
test("群聊一次 @ 两人：落一行、toIds 两人、text 已剥离 @", async () => {
  const store = openMessageStore(path.join(mkdtempSync(path.join(tmpdir(), "os-send-")), "m.db"));
  try {
    await sendToRoom(ws, fakeHarness, { kind: "group", project: "seo" }, "@alice @bob 开工", { queue: new KeyedQueue(), store });
    const rows = store.listByRoom("group:seo");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fromId).toBe("__boss");
    expect(rows[0]!.toIds).toEqual(["alice", "bob"]);
    expect(rows[0]!.text).toBe("开工");
  } finally { store.close(); }
});
```

> `fakeHarness` 用现有测试里的桩（`submit` 返回 `{ id, status: "queued" }`）；`ws` 用现有测试的临时空间夹具。**照抄既有测试的搭法**，不要新造。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/app/send.test.ts -t "落一行"`
Expected: FAIL —— `sendToRoom` 不落库（查库得空）。

- [ ] **Step 3: 实现（`sendToRoom`）**

在 `sendToRoom` 的 `options` 增加 `store?: MessageStore`；在算出 `targets` 之后、投递之前插入：

```ts
if (options.store !== undefined && body !== "") {
  const memberIds = relation.kind === "group" ? parseMembers(ws, relation.project) : [relation.employeeId];
  const raw = body;
  const text = stripLeadingMentions(raw);
  const targets2 = parseMentions(raw, memberIds, bossNamesFor(ws)).targets;
  const toIds = relation.kind === "dm"
    ? [relation.employeeId]
    : (text === "" ? [] : (targets2.length === 0 ? [BOSS_PARTICIPANT] : targets2.map((t) => (t === BOSS_ID ? BOSS_PARTICIPANT : t))));
  if (toIds.length > 0) {
    options.store.append({
      sendTime: new Date().toISOString(),
      projectId: relation.kind === "group" ? relation.project : null,
      fromId: BOSS_PARTICIPANT,
      toIds,
      text,
    });
  }
}
```

（补 import：`stripLeadingMentions`、`parseMentions`、`BOSS_ID`、`BOSS_PARTICIPANT`、`bossNamesFor`。）

- [ ] **Step 4: `triggerFromGroupReply` 同样落一行**（`fromId` = `options.senderId`，`toIds` = 被 @ 成员，`projectId` = 项目，`text` 已剥离）

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/app/send.test.ts`
Expected: PASS（含既有用例）。

- [ ] **Step 6: 提交**

```bash
git add src/app/send.ts tests/app/send.test.ts
git commit -m "feat(send): 老板/员工投递时落一行到自有消息库"
```

---

## Task 4: 写入路径 —— agent 回复（run 结束）落一行

**Files:**
- Modify: `src/server/pump.ts`
- Test: `tests/server/pump.test.ts`（补用例）

**Interfaces:**
- Consumes: `parseAgentReply`（Task 2）、`MessageStore`（Task 1）
- Produces: `Pump` 依赖新增 `store: MessageStore`；`#onEvent` 的 `message` 分支（assistant）落一行：`fromId=ref.memberId`、`toIds/text` 由 `parseAgentReply` 得、`projectId` = 群聊项目 / null；`text===""` 不落。同分支仍广播 `room.message`。

- [ ] **Step 1: 写失败测试**（`tests/server/pump.test.ts` 追加）：桩 harness 触发 `message`（assistant `"@bob 完成"`）事件 → 断言 `store.listByRoom("group:seo")` 出现一行 `fromId="alice"`、`toIds=["bob"]`、`text="完成"`。

- [ ] **Step 2: 跑测试确认失败**：`npx vitest run tests/server/pump.test.ts -t "落一行"` → FAIL。

- [ ] **Step 3: 实现**：`#onEvent` 的 `case "message"` 里，`normalizeChatMessage` 之后、广播之前，对 `event.message.role === "assistant"` 调 `parseAgentReply` 落库（`boardNamesFor` 取当前称谓）。

- [ ] **Step 4: 跑测试确认通过**：`npx vitest run tests/server/pump.test.ts` → PASS。

- [ ] **Step 5: 提交**

```bash
git add src/server/pump.ts tests/server/pump.test.ts
git commit -m "feat(pump): agent 回复（run 结束）落一行到自有消息库"
```

---

## Task 5: 读取路径 —— 房间视图 / 历史改走库

**Files:**
- Modify: `src/app/rooms.ts`（删 `mergeRoomMessages`，加 `toRoomMessage`）
- Modify: `src/server/http.ts`（房间消息端点改查库）
- Test: `tests/server/http.test.ts`（补用例）

**Interfaces:**
- Produces: `toRoomMessage(m: StoredMessage, bossName: string): RoomMessage`（`speaker` 由 `fromId` 推：`__boss`/`__system` → boss 形态；否则 employee）。
- 删除：`mergeRoomMessages`、`MemberTranscript` 的合并用途（`roomTranscripts` 保留给「会话信息条」不用它）。

- [ ] **Step 1: 写失败测试**：向 store 塞两行（老板一句、alice 一句）→ `GET /api/rooms/group:seo/messages` 按 seq 顺序返回两条 `RoomMessage`，`speaker.kind` 分别为 `boss` / `employee`。

- [ ] **Step 2: 跑测试确认失败**：`npx vitest run tests/server/http.test.ts -t "自有库"` → FAIL。

- [ ] **Step 3: 实现**：`http.ts` 该端点从 `roomTranscripts + mergeRoomMessages` 改为 `store.listByRoom(roomKey).map((m) => toRoomMessage(m, bossName))`。

- [ ] **Step 4: 跑测试确认通过** → PASS。

- [ ] **Step 5: 提交**

```bash
git add src/app/rooms.ts src/server/http.ts tests/server/http.test.ts
git commit -m "feat(rooms): 房间视图/历史改读自有消息库（删除读侧合并）"
```

---

## Task 6: 清理读侧去重 + 收尾

**Files:**
- Modify: `web/state.ts`（删 `roomMessageId` 去重分支）
- Modify: `src/app/rooms.ts`（删已无用的 `mergeRoomMessages` 及其类型引用）
- Modify: `src/skills/openstaffs-ops/SKILL.md`（补「消息真相在自有库」的口径）

- [ ] **Step 1: 改 `web/state.ts`**：`appendMessage` 去掉 `roomMessageId` 去重判断，仅按 `messageKey` 去重。
- [ ] **Step 2: 跑全量**：`npm test && npm run typecheck`
  Expected: 全绿；无 `mergeRoomMessages` / `roomMessageId` 残留引用（`grep -rn "mergeRoomMessages\|roomMessageId" src web` 为空）。
- [ ] **Step 3: 手动冒烟**（按仓库惯例，真实链路自测）：起服务 → 私聊发一句、群聊 @ 两人 → 刷新「历史」仍在；重启服务后历史不丢。
- [ ] **Step 4: 文档同步**：`src/skills/openstaffs-ops/SKILL.md` 目录结构 / 生效时机处补一行「消息真相：自有库 `stateDir/messages.sqlite`，与基座 transcript 无关」。
- [ ] **Step 5: 提交**

```bash
git add web/state.ts src/app/rooms.ts src/skills/openstaffs-ops/SKILL.md
git commit -m "refactor: 移除读侧去重（消息真相已归自有库）；同步运维手册"
```

---

## Self-Review 记录

- **Spec 覆盖**：§13 schema→Task 1/2；D29/D31（真假相归库、群无需去重）→Task 3/4/5/6；D30（run 结束落一条、崩溃不处理、不迁移）→Task 4（仅 run 结束落）。
- **类型一致**：`StoredMessage`（Task 1）↔ `toRoomMessage`（Task 5）↔ `parseAgentReply` 返回 `{toIds,text}`（Task 2/4）。
- **刻意留到后续**：`BOSS_ID` 常量仍为 `"boss"`（P3 统一为 `__boss`）；`.openstaffs/` → `openstaffs/.data/` 迁移（P4）；`sessionId` 列本期只建不填（P2 组织落地时补）。
