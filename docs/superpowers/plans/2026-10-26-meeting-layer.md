# Meeting 层（框架自持会话 ID）实施计划

> **2026-10-26 后续口径变更**：会议**不再有「结束」/只读**——`closed_at` 与 `participants` 快照已移除（迁移保留全部会议行），同一主题可有多场且随时可继续聊；成员实时按当前项目 members 算；老板可删除会议（消息/会话/pin 一并删）；agent 的 `new_meeting` 工具已移除。本计划中「拒绝向已结束会议发送」（RF4）与「新建会议 = 结束上一场」的描述已过时，以 `TODO.md`「已定口径」为准。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「房间名字派生的字符串」换成框架自持的 `meeting_id`：会议是会话容器（私聊 1:1、群聊 1:N），投递/回显/Web 路由全部以 meeting 为单位。

**Architecture:** 新表 `meetings(meeting_id, kind, subject_id, participants 快照, title, closed_at)`；`sessions` 退化为 `(meeting_id, member_id) → conv_id`；`messages` 只带 `meeting_id`。投递唯一入口 `sendToMeeting`，`resolveSession(meeting, memberId)` 是 conv 的唯一解析口。Web 用 `?meeting=<id>` / `?subject=<key>` 三态路由。

**Tech Stack:** TypeScript（Node strip-only，不得用参数属性/枚举）、`node:sqlite` `DatabaseSync`、vitest、esbuild（`npm run build:web`）。

**Spec:** `work/openstaffs-dev/design-meeting-layer.md`（老板已批准：B 方案 + 串行）

## Global Constraints

- 开发阶段：**破坏性更新可接受**。旧库（`messages` / `sessions`）一律 `DROP` 重建，不写迁移、不留兼容分支。
- `conv_id` 永远是 Pi 的 conversation id，不做二次映射。
- Node >= 22.19；TS 是 strip-only 模式：禁止构造函数参数属性、`enum`、装饰器。
- 所有「房间」概念（`roomKey` / `parseRoomKey` / `roomKeyOf` / `relationKey` / `sessionStart` / `currentWindow`）在本计划结束时**必须从代码里消失**。
- 提交格式 `<type>(<scope>): <中文描述>`；每个 task 至少一提交。
- 验证命令：`npm run typecheck`、`npx vitest run`、`npm run build:web`（前端改动必须跑）。

## Review Focus

1. **pending 新会议时连发两条**：第一条建会议并投递，第二条必须落**同一场**会议（不能又建一场、也不能丢）。
2. **群聊 @ 不到任何人**（只 @ 了不存在的人 / 只有 @ 没正文）：返回 400，不落消息、不建会议。
3. **会议中途成员被移出项目**：该会议仍显示其历史发言，但不再向它投递（participants 快照 vs 当前成员）。
4. **回看已结束的会议**（`?meeting=<旧 id>`）：发送必须被拒绝（403/409 + 明确文案），不能把消息投进 closed 会议。
5. **单个 conv 在 Pi 端失效**（attach 返回 false）：只重建该成员的 conv，其余成员与该会议不受影响；重启后仍订阅得到。

---

### Task 0: 建分支与基线

**Files:** 无（仅 git）

**Interfaces:**
- Consumes: 无
- Produces: 分支 `feat/meeting-layer`，基线绿。

- [ ] **Step 1: 建分支**

```bash
cd /Users/laidezhong/Desktop/OpenStaffs && git checkout -b feat/meeting-layer
```

- [ ] **Step 2: 基线验证**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck 无输出错误；测试全过（当前 98+ 项）。若基线不绿，先停下报告，不要开始改造。

---

### Task 1: `store/meetings.ts`（新表 + 存储层）

**Files:**
- Create: `src/store/meetings.ts`
- Test: `tests/store/meetings.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
```ts
export type MeetingKind = "dm" | "group";
export type TitleSource = "fallback" | "auto" | "manual";
export type MeetingRecord = {
  meetingId: string; kind: MeetingKind; subjectId: string; subjectLabel: string;
  participants: string[]; title?: string; titleSource?: TitleSource;
  createdAt: string; closedAt: string | null;
};
export type MeetingStore = {
  create(input: { kind: MeetingKind; subjectId: string; subjectLabel: string; participants: string[]; now: string }): MeetingRecord;
  current(kind: MeetingKind, subjectId: string): MeetingRecord | undefined;
  get(meetingId: string): MeetingRecord | undefined;
  getMany(meetingIds: readonly string[]): Map<string, MeetingRecord>;
  list(kind: MeetingKind, subjectId: string): MeetingRecord[];
  listCurrent(): MeetingRecord[];
  setTitle(meetingId: string, title: string, source: TitleSource): MeetingRecord;
  close(meetingId: string, now: string): void;
  close(): void;
};
export function openMeetingStore(file: string): MeetingStore;
```
`create` 内部生成 `mtg_${randomUUID()}`，并**同事务**把同 `(kind, subject_id)` 未结束的会议置 `closed_at`。
`list` 按 `created_at DESC`。

- [ ] **Step 1: 写失败测试** `tests/store/meetings.test.ts`

```ts
// 每个 case 用独立临时目录：mkdtempSync(join(tmpdir(), "os-meetings-"))
it("create 落一行：id 前缀 mtg_、participants 原样、closedAt 为 null", ...)
it("同 subject 再 create：旧的 closedAt 非空，current() 是新的", ...)
it("不同 subject 互不影响：dm:alice 与 group:yt 各自 current", ...)
it("list 按 created_at 倒序且含历史；listCurrent 只含未结束", ...)
it("setTitle 覆盖规则：manual 恒覆盖；auto 不盖 manual；fallback 可被 auto 覆盖", ...)
it("close 后 current 为 undefined，行仍在 list 里", ...)
it("重开库后数据仍在（close 再 openMeetingStore）", ...)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/store/meetings.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/store/meetings.ts`**

建表 SQL（`openMeetingStore` 内 `exec`）：
```sql
CREATE TABLE IF NOT EXISTS meetings (
  meeting_id TEXT PRIMARY KEY, kind TEXT NOT NULL, subject_id TEXT NOT NULL,
  subject_label TEXT NOT NULL, participants TEXT NOT NULL,
  title TEXT, title_source TEXT,
  created_at TEXT NOT NULL, closed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_meetings_current ON meetings(kind, subject_id) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_meetings_subject ON meetings(kind, subject_id, created_at);
```
`setTitle` 的条件覆盖沿用 `store/sessions.ts` 现有写法（`manual` 恒覆盖；`fallback`/`auto` 只盖空或 `fallback`）。
`create` 事务：`UPDATE ... SET closed_at=? WHERE kind=? AND subject_id=? AND closed_at IS NULL` → `INSERT`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/store/meetings.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/store/meetings.ts tests/store/meetings.test.ts
git commit -m "feat(store): meetings 表（会议即会话容器）"
```

---

### Task 2: `store/sessions.ts` 退化为 conv 映射

**Files:**
- Modify: `src/store/sessions.ts`（整篇重写）
- Test: `tests/store/sessions.test.ts`（整篇重写）

**Interfaces:**
- Consumes: Task 1 的 `meetings` 表（同库文件，`listActive` 用 JOIN）。
- Produces:
```ts
export type SessionRecord = { convId: string; meetingId: string; memberId: string; started: string };
export type SessionStore = {
  open(input: SessionRecord): SessionRecord;              // UPSERT by (meeting_id, member_id)
  convOf(meetingId: string, memberId: string): SessionRecord | undefined;
  listByMeeting(meetingId: string): SessionRecord[];
  listActive(): SessionRecord[];                          // JOIN meetings ON closed_at IS NULL
  owner(convId: string): { meetingId: string; memberId: string } | undefined;
  get(convId: string): SessionRecord | undefined;
  remove(convId: string): void;
  close(): void;
};
export function openSessionStore(file: string): SessionStore;
```
删除：`room` / `kind` / `ended` / `previous` / `title` / `titleSource` / `active` / `list` / `closeAt` / `setTitle` / `getMany` / `relationOfRoom`。

- [ ] **Step 1: 写失败测试**（重写 `tests/store/sessions.test.ts`）

```ts
it("open 落一行；convOf 按 (meeting, member) 取回", ...)
it("同 (meeting, member) 再 open：UPSERT 换 convId，行数仍 1", ...)
it("listByMeeting 按成员返回该会议全部 conv", ...)
it("listActive 只返回会议未结束的 conv（closed_at 非空的会议被排除）", ...)
it("owner(convId) 返回 meetingId + memberId；未知 conv 返回 undefined", ...)
it("remove(convId) 删行后 owner 为 undefined", ...)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/store/sessions.test.ts`
Expected: FAIL（类型/方法不存在）

- [ ] **Step 3: 重写 `src/store/sessions.ts`**

```sql
-- 开库即破坏性重建（旧结构不再兼容）
DROP TABLE IF EXISTS sessions;
CREATE TABLE sessions (
  conv_id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, member_id TEXT NOT NULL,
  started TEXT NOT NULL, UNIQUE(meeting_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_meeting ON sessions(meeting_id);
```
`open` 用 `INSERT ... ON CONFLICT(meeting_id, member_id) DO UPDATE SET conv_id=excluded.conv_id, started=excluded.started`。
`listActive`：`SELECT s.* FROM sessions s JOIN meetings m ON m.meeting_id = s.meeting_id WHERE m.closed_at IS NULL`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/store/sessions.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/store/sessions.ts tests/store/sessions.test.ts
git commit -m "refactor(store): sessions 退化为 (meeting, member) → conv 映射"
```

---

### Task 3: `store/messages.ts` + `store/row.ts` 换 meeting_id

**Files:**
- Modify: `src/store/messages.ts`
- Modify: `src/store/row.ts`
- Test: `tests/store/messages.test.ts`（整篇重写）

**Interfaces:**
- Consumes: 无
- Produces:
```ts
// store/row.ts
export type StoredMessage = {
  id: string; seq: number; sendTime: string; meetingId: string;
  fromId: string; toIds: string[]; text: string;
};
export const BOSS_PARTICIPANT = "__boss";
export const SYSTEM_PARTICIPANT = "__system";
// 删除 roomKeyOfMessage / StoredMessage.room / projectId / sessionStart

// store/messages.ts
export type MessageStore = {
  append(input: Omit<StoredMessage, "id" | "seq">): StoredMessage;
  byMeeting(meetingId: string): StoredMessage[];
  close(): void;
};
```
删除 `listByRoom` / `currentWindow`。

- [ ] **Step 1: 写失败测试**（重写 `tests/store/messages.test.ts`）

```ts
it("append 落一行：seq 从 1 递增，meetingId 原样", ...)
it("byMeeting 只返回该会议的行，按 seq 升序", ...)
it("两个会议混写：各自取回互不串台", ...)
it("老库带 room/session_start 列时开库直接重建（写一行后 PRAGMA 里没有 room 列）", ...)
```

- [ ] **Step 2: 跑测试确认失败** → Run: `npx vitest run tests/store/messages.test.ts`，Expected: FAIL

- [ ] **Step 3: 实现**

```sql
DROP TABLE IF EXISTS messages;
CREATE TABLE messages (
  id TEXT PRIMARY KEY, seq INTEGER NOT NULL, send_time TEXT NOT NULL,
  meeting_id TEXT NOT NULL, from_id TEXT NOT NULL, to_ids TEXT NOT NULL, text TEXT NOT NULL
);
CREATE INDEX idx_messages_meeting_seq ON messages(meeting_id, seq);
```
保留现有 `nextSeq = SELECT COALESCE(MAX(seq),0)+1` 的写法；`append` 不再计算 room。

- [ ] **Step 4: 跑测试确认通过**，Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/store/messages.ts src/store/row.ts tests/store/messages.test.ts
git commit -m "refactor(store): 消息行只带 meeting_id（删 room / session_start / 窗口查询）"
```

---

### Task 4: `app/meetings.ts`（新）+ 消息视图改名

**Files:**
- Create: `src/app/meetings.ts`
- Rename/Modify: `src/app/rooms.ts` → `src/app/meeting-messages.ts`
- Test: `tests/app/meetings.test.ts`（新）、`tests/app/meeting-messages.test.ts`（由 `tests/app/rooms.test.ts` 改名改内容）

**Interfaces:**
- Consumes: Task 1 `MeetingStore`/`MeetingRecord`；Task 3 `StoredMessage`。
- Produces:
```ts
// src/app/meetings.ts
export type MeetingView = {
  meetingId: string; kind: MeetingKind; subjectId: string; subjectLabel: string;
  participants: string[]; title?: string; createdAt: string; closedAt: string | null;
};
export function subjectKeyOf(relation: Relation): string;              // "dm:<id>" | "group:<id>"（仅 API/UI 用，不是身份）
export function parseSubjectKey(key: string): Relation | undefined;
export function subjectLabel(ws: Workspace, relation: Relation): string;
export function participantIds(ws: Workspace, relation: Relation): string[];
export function subjectOf(meeting: MeetingRecord): Relation;
export function meetingView(meeting: MeetingRecord): MeetingView;
export function ensureMeeting(deps: { ws: Workspace; meetings: MeetingStore }, relation: Relation, now: Date): MeetingRecord;
export function createNewMeeting(deps: { ws: Workspace; meetings: MeetingStore }, relation: Relation, now: Date): MeetingRecord;

// src/app/meeting-messages.ts（原 rooms.ts）
export type MeetingMessage = {
  convId: string; entryId: string; speaker: RoomSpeaker; text: string;
  roomMessageId?: string; bossDirected: boolean;
};   // 字段 roomKey 删除；RoomSpeaker 保留
export function toMeetingMessage(stored: StoredMessage, kind: MeetingKind, bossName: string, ws?: Workspace): MeetingMessage;
export function normalizeChatMessage(kind: MeetingKind, member: MemberTranscript, chat: ChatMessage, memberIds?: string[], bossNames?: string[]): MeetingMessage | undefined;
export function roomMessagesOfTranscript(...)  // 改名 transcriptMessages(kind, member, memberIds, bossNames)
```
`ensureMeeting` = `current(kind, subjectId)` 或 `createNewMeeting`（首条消息落会议用）。
`createNewMeeting` 内部取 `participantIds` + `subjectLabel` 快照。

- [ ] **Step 1: 写失败测试**

`tests/app/meetings.test.ts`：
```ts
it("ensureMeeting：无当前会议时建一场，participants 取自项目成员快照", ...)
it("ensureMeeting：已有当前会议时复用同一 meetingId（不新建）", ...)
it("createNewMeeting：结束上一场，新的 participants/label 是新快照", ...)
it("subjectKeyOf / parseSubjectKey 往返；非法键返回 undefined", ...)
it("meetingView 只暴露视图字段（不含内部列）", ...)
```
`tests/app/meeting-messages.test.ts`（原 rooms 用例迁移）：
```ts
it("toMeetingMessage：群聊按 toIds 重建头部 @；私聊不加头", ...)
it("toMeetingMessage：kind=group 且 toIds 含 __boss → bossDirected=true", ...)
it("normalizeChatMessage：群聊 assistant 无 @ 时补 @老板；私聊恒 bossDirected", ...)
```

- [ ] **Step 2: 跑测试确认失败** → `npx vitest run tests/app/meetings.test.ts tests/app/meeting-messages.test.ts`，Expected: FAIL

- [ ] **Step 3: 实现**

`subjectLabel`：dm → 员工 alias（取不到用 id）；group → 项目 alias（取不到用 id）。
`participantIds`：dm → `[employeeId]`；group → `parseMembers(ws, project)`。
`toMeetingMessage` 里 `isGroup` 由 `kind === "group"` 决定（不再从字符串前缀猜）。

- [ ] **Step 4: 跑测试确认通过**，Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/app/meetings.ts src/app/meeting-messages.ts tests/app/meetings.test.ts tests/app/meeting-messages.test.ts
git rm --cached src/app/rooms.ts tests/app/rooms.test.ts
git commit -m "feat(app): meeting 解析层（subject ↔ meeting）+ 消息视图去 roomKey"
```

---

### Task 5: `app/conversations.ts` 按 meeting 解析 conv

**Files:**
- Modify: `src/app/conversations.ts`
- Test: `tests/app/conversations.test.ts`（整篇重写）

**Interfaces:**
- Consumes: Task 1/2/4；`HarnessPort.attach/startSession`（`ConversationSpec` 增加必填 `meetingId`）。
- Produces:
```ts
export type SessionDeps = { ws: Workspace; harness: HarnessPort; sessions: SessionStore; defaults?: SessionDefaults; mcp?: McpSessionResolver };
export function queueKey(meetingId: string, memberId: string): string;        // `${meetingId}:${memberId}`
export async function resolveSession(deps: SessionDeps, meeting: MeetingRecord, memberId: string): Promise<OpenResult>;
export function meetingParticipants(sessions: SessionStore, meeting: MeetingRecord): { memberId: string; convId?: string }[];
export async function meetingSessionInfo(ws, harness, sessions, meeting): Promise<RoomSessionInfo[]>;
export async function interruptMeeting(ws, harness, sessions, meeting): Promise<{ aborted: string[] }>;
export function employeeActiveSessions(ws, meetings: MeetingStore, sessions: SessionStore, employeeId: string): { meetingId: string; kind: MeetingKind; convId: string }[];
```
删除：`relationKey` / `sessionList` / `activeMemberSessions` / `roomSessionInfo` / `interruptRoom` / `findSessionOwner` / `memberIdsOf`。
`specFor` 增加 `meetingId` 字段进 `ConversationSpec`（`harness/port.ts` 同步加必填 `meetingId`，`bindSession`/`sessionInfo` 的 payload 变 `{ selfId, relation, meetingId }`）。

- [ ] **Step 1: 写失败测试**

```ts
it("resolveSession：meeting 内无 conv → startSession 一次并落库（created=true）", ...)
it("resolveSession：已有 conv 且 attach 成功 → 复用（created=false），不再 startSession", ...)
it("resolveSession：attach 失败 → 重建新 conv 并 UPSERT 覆盖该成员映射", ...)
it("meetingParticipants：按 participants 顺序返回，未建 conv 的成员 convId 为 undefined", ...)
it("interruptMeeting：坏 conv 跳过，其余照常 abort", ...)
it("employeeActiveSessions：把该人所在各项目的进行中会议列出来", ...)
```

- [ ] **Step 2: 跑测试确认失败** → Expected: FAIL

- [ ] **Step 3: 实现**

`resolveSession` 主体：`const relation = subjectOf(meeting)` → `specFor(ws, relation, speaker, meeting.meetingId, defaults, mcp)`；
`const existing = deps.sessions.convOf(meeting.meetingId, memberId)`；attach 成功即 `{ convId, created: false }`；
否则 `startSession` → `deps.sessions.open({ convId, meetingId: meeting.meetingId, memberId, started: now })`。

- [ ] **Step 4: 跑测试确认通过** → PASS

- [ ] **Step 5: 提交**

```bash
git add src/app/conversations.ts src/harness/port.ts tests/app/conversations.test.ts
git commit -m "refactor(app): resolveSession 以 (meeting, member) 为唯一入口"
```

---

### Task 6: `app/send.ts` → 会议内投递

**Files:**
- Modify: `src/app/send.ts`
- Modify: `src/app/sessions.ts`（标题通道改到 meeting）
- Test: `tests/app/send.test.ts`、`tests/app/sessions.test.ts`

**Interfaces:**
- Consumes: Task 4/5。
- Produces:
```ts
export async function sendToMeeting(
  ws: Workspace, harness: HarnessPort, meeting: MeetingRecord, text: string,
  options: { queue: KeyedQueue; sessions: SessionStore; store?: MessageStore; defaults?: SessionDefaults; mcp?: McpSessionResolver; requestId?: string; titles?: MeetingTitleDeps },
): Promise<{ roomMessageId: string; deliveries: DeliveryReport[]; recorded?: StoredMessage }>;

export async function triggerFromMeetingReply(ws, harness, options: {
  queue; sessions; defaults?; mcp?; meeting: MeetingRecord; senderId: string; convId: string; entryId: string; text: string;
}): Promise<DeliveryReport[]>;

// app/sessions.ts → app/meeting-titles.ts
export type MeetingTitleDeps = { store: Pick<MeetingStore, "setTitle" | "get">; notify?: (e: { meetingId: string; title: string }) => void; namer?: Namer };
export function renameMeeting(deps: MeetingTitleDeps, meetingId: string, title: string, source: TitleSource): MeetingRecord;
export function nameNewMeeting(deps: MeetingTitleDeps, meetingId: string, firstMessage: string): void;
```
删除 `sendToRoom` / `triggerFromGroupReply` / `nameNewSession` / `renameSession` / `SessionTitleDeps` / `TitleEvent`；`newSession` 选项删除（新会议由调用方先建）。
投递目标（targets）：`dm` → `[meeting.subjectId]`；`group` → `planRouting(body, meeting.participants)`。
落库：`store.append({ sendTime, meetingId, fromId: BOSS_PARTICIPANT, toIds, text })`。
**投给老板**（`__boss`）不再单独落别的房间——它只是 `toIds` 里的参与者。

- [ ] **Step 1: 写失败测试**

```ts
it("sendToMeeting（dm）：投递给该员工一条 conv，落一行 meeting_id 正确的消息", ...)
it("sendToMeeting（group）：按 @ 前缀各投一份，deliveries 数与 @ 数一致", ...)
it("群聊 @ 不到任何人 → 抛 NoTargetsError，且不落消息", ...)
it("群聊 @ 老板：toIds 含 __boss，deliveries 为空，消息仍落本会议", ...)   // Review Focus 的根因用例
it("sendToMeeting：会议已 closed → 抛 MeetingClosedError", ...)             // Review Focus 4
it("triggerFromMeetingReply：只投给本会议内被 @ 的其他成员，且不落库", ...)
it("nameNewMeeting：先落时间标题（fallback），命名成功后走同一通道改写成 auto", ...)
```

- [ ] **Step 2: 跑测试确认失败** → Expected: FAIL

- [ ] **Step 3: 实现**

`MeetingClosedError extends Error`（`closedAt !== null` 时抛，HTTP 层映射 409）。
`options.queue.run(queueKey(meeting.meetingId, target.memberId), ...)` → `resolveSession(deps, meeting, memberId)` → `harness.submit(convId, body, { kind: "chat.message", data: { author: "boss", roomMessageId }, requestId? })`。
`opened.created && titles` → `nameNewMeeting(titles, meeting.meetingId, body)`。

- [ ] **Step 4: 跑测试确认通过** → PASS

- [ ] **Step 5: 提交**

```bash
git add src/app/send.ts src/app/sessions.ts src/app/meeting-titles.ts tests/app/send.test.ts tests/app/sessions.test.ts
git commit -m "feat(app): 投递收口到 sendToMeeting（目标只决定 conv，不决定消息归属）"
```

---

### Task 7: pins / outbox / permission-flow 换 meeting_id

**Files:**
- Modify: `src/app/pins.ts`、`src/app/outbox.ts`、`src/app/permission-flow.ts`、`src/domain/permission-requests.ts`
- Test: `tests/app/pins.test.ts`、`tests/app/outbox.test.ts`、`tests/app/permission-flow.test.ts`、`tests/domain/permission-requests.test.ts`

**Interfaces:**
- Consumes: Task 1/4/6。
- Produces:
```ts
// pins.ts
export function readPins(ws: Workspace): { pins: Record<string, string[]> };      // 键 = meetingId
export function setPin(ws: Workspace, meetingId: string, key: string, pinned: boolean): { pins: Record<string, string[]> };
export function pinCounts(meetings: { meetingId: string; messages: MeetingMessage[] }[], state): { total: number; meetings: Record<string, number> };

// outbox.ts：QueuedDelivery / QueuedItemView 的 roomKey → meetingId；list/byRoomMessage/roomMessageIdByStoreSeq 参数改 meetingId
// permission-requests.ts：PermissionRequest.roomKey → meetingId
// permission-flow.ts：deps.register(convId, { meetingId, memberId })；broadcastMessage(meetingId, message)；投递走 meeting + sendToMeeting
```
`pins` 存储键变更为 meetingId → 老 `state.json` 的 pins 直接丢弃（破坏性，不迁移：`readPins` 读到的键不再匹配任何 meeting，自然不会显示）。

- [ ] **Step 1: 写失败测试**

```ts
it("pins：按 meetingId 存/取；pinCounts 只数该会议当前消息里的键", ...)
it("outbox：list(meetingId) 只返回该会议条目；byRoomMessage 按 meetingId + roomMessageId 过滤", ...)
it("permission-flow：accept 后以老板身份投递到该会议的发起者 conv，并落一行 meeting_id 正确", ...)
it("permission-flow：请求的 meeting 已 closed → 返回 warning，不抛（授权已落盘）", ...)
```

- [ ] **Step 2–4: 红 → 实现 → 绿**（`npx vitest run tests/app/pins.test.ts tests/app/outbox.test.ts tests/app/permission-flow.test.ts tests/domain/permission-requests.test.ts`）

- [ ] **Step 5: 提交**

```bash
git add -A src/app src/domain tests/app tests/domain
git commit -m "refactor(app): pins / outbox / 授权流转都按 meeting_id 定位"
```

---

### Task 8: 服务端 HTTP / SSE / Pump

**Files:**
- Modify: `src/server/http.ts`、`src/server/sse.ts`、`src/server/pump.ts`、`src/server/main.ts`、`src/server/bootstrap.ts`、`src/tools/extension.ts`
- Test: `tests/server/http.test.ts`、`tests/server/sse.test.ts`、`tests/server/pump.test.ts`、`tests/server/pump-trigger.test.ts`、`tests/server/store-wiring.test.ts`

**Interfaces:**
- Consumes: Task 1–7。
- Produces:
```
GET    /api/subjects/<subjectKey>                 → { subject, current?: MeetingView, meetings: MeetingView[] }
POST   /api/subjects/<subjectKey>/messages        → { meetingId, roomMessageId, deliveries[] }
        body { text, requestId, newMeeting?: boolean }    // newMeeting=true = 先建新会议（「新建会议」+首条）
GET    /api/meetings/<id>                         → MeetingView
GET    /api/meetings/<id>/messages                → { meetingId, messages, pinned, queued }
POST   /api/meetings/<id>/queue/cancel            → { cancelled[] }
GET    /api/meetings/<id>/sessions                → { participants: { memberId, convId? }[] }
GET    /api/meetings/<id>/sessions/info           → { sessions: RoomSessionInfo[] }
PATCH  /api/meetings/<id>/title                   → { meetingId, title, titleSource }
POST   /api/meetings/<id>/interrupt               → { aborted[] }
POST   /api/meetings/<id>/pin                     → { ok, count }
GET    /api/pins                                  → { total, subjects: Record<subjectKey, number> }   // 服务端已把会议计数折叠到主题键（侧栏行 = 主题）
GET    /api/employees/<id>/sessions/<convId>/context   （不变）
GET    /api/meetings/<id>/sessions/<convId>/messages   （会话原文，替代原 rooms/<roomKey>/sessions/<conv>/messages）
```
SSE `ServerEvent`：`roomKey` 字段全部改名 `meetingId`；事件名 `room.*` → `meeting.*`；`session.title` → `meeting.title`（`{ meetingId, title }`）。
`Pump.register(convId, { meetingId, memberId })`；`bindSession(convId, { selfId, relation, meetingId })`（relation 由 `meetings.get(meetingId)` → `subjectOf` 得到）；`listActive()` 产出 `{ convId, meetingId, memberId }`。

- [ ] **Step 1: 写失败测试**

```ts
// http
it("POST /api/subjects/group:yt/messages：newMeeting=true 建新会议并返回 meetingId", ...)
it("POST .../messages：已有当前会议时复用同一 meetingId（第二条不新建）", ...)      // Review Focus 1
it("POST .../messages：@ 不到任何人 → 400，且没有新建会议", ...)                     // Review Focus 2
it("GET /api/meetings/<closed>/messages：仍可读（历史回看）", ...)
it("POST /api/meetings/<closed>/messages：409 meeting closed", ...)                  // Review Focus 4
it("GET /api/subjects/group:yt：返回 current 与历史会议列表（倒序）", ...)
// sse
it("事件字段是 meetingId，没有 roomKey", ...)
// pump
it("register 时用 meetings 表反查 relation 并 bindSession（含 meetingId）", ...)
it("registerAll：会议已结束的 conv 不再订阅", ...)
```

- [ ] **Step 2–4: 红 → 实现 → 绿**

Run: `npx vitest run tests/server`
Expected: PASS（旧 room 路由用例同步删除或改写）

- [ ] **Step 5: 提交**

```bash
git add src/server src/tools/extension.ts tests/server
git commit -m "feat(server): HTTP/SSE/Pump 全面改为 meeting 维度"
```

---

### Task 9: 员工工具改会议口径

**Files:**
- Modify: `src/tools/registry.ts`
- Test: `tests/tools/registry.test.ts`、`tests/tools/gate.test.ts`

**Interfaces:**
- Consumes: Task 4/6/8（`ToolContext.meetingId`）。
- Produces:
```
send_message { target: "boss" | "member:<id>", text }
  → 两者都投进**当前会议**：boss = 本会议 toIds 加 __boss；member = 本会议内该成员 conv。
    删除 target=project:（会议内投递无意义）。
meeting_history { meeting?: string, limit?: number }        // 替代 room_history；缺省 = 本会议
new_meeting {}                                              // 替代 new_session：结束本会议，同一 subject 开新会议
request_permission { ... }                                  // 内部用 meetingId 落请求
```
`ToolContext` 增加必填 `meetingId: string`（由 `extension.ts` 从 `sessionInfo(convId).meetingId` 注入）。

- [ ] **Step 1: 写失败测试**

```ts
it("send_message boss：落在当前会议，toIds 含 __boss（不再搬家到私聊）", ...)
it("send_message member：x 必须是本会议 members，否则报错", ...)
it("send_message：非 group 会议用 member: → 报错", ...)
it("meeting_history：缺省读本会议，limit 生效", ...)
it("new_meeting：旧会议 closed，新会议 participants 快照是当前项目成员", ...)
```

- [ ] **Step 2–4: 红 → 实现 → 绿**，Run: `npx vitest run tests/tools`

- [ ] **Step 5: 提交**

```bash
git add src/tools tests/tools
git commit -m "refactor(tools): send_message / meeting_history / new_meeting 只在本会议内"
```

---

### Task 10: 提示词与文案

**Files:**
- Modify: `src/prompts/group.md`、`src/prompts/dm.md`、`src/capabilities/system-prompt.ts`（若有 room 措辞）
- Test: `tests/capabilities/system-prompt.test.ts`（如涉及）

**Interfaces:** 无（纯文案）

- [ ] **Step 1: 改文案**
  - `group.md`：删掉「找负责人也可以用 `send_message`（target=boss）」，改为：**「回告老板就在群里直接回（消息落在这场会议里，不需要另发）；要私聊老板，让老板开一场私聊会议。」**
  - `group.md` 标题句改为「你正在项目群聊「{{project_name}}」的一场会议里…」。
  - `dm.md`：「这段对话只有你们两人能看到」→「这场会议只有你们两人能看到」。

- [ ] **Step 2: 验证** `npx vitest run tests/capabilities`，Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add src/prompts src/capabilities
git commit -m "docs(prompts): 群聊/私聊措辞改为会议口径（删 target=boss 引导）"
```

---

### Task 11: Web（meeting 状态 + URL 路由 + 新建会议）

**Files:**
- Modify: `web/state.ts`、`web/api.ts`、`web/main.ts`、`web/render.ts`、`web/sse.ts`、`web/drafts.ts`、`web/composer.ts`（如需）
- Test: `tests/web/state.test.ts`、`tests/web/render.test.ts`、`tests/web/api.test.ts`、`tests/web/drafts.test.ts`

**Interfaces:**
- Consumes: Task 8 的 HTTP/SSE；Task 4 `MeetingMessage`。
- Produces:
```ts
// state.ts
export type State = {
  ...现有字段（删 hiddenMessages / freshSession）;
  subjectKey?: string;      // "dm:<id>" | "group:<id>"
  meetingId?: string;       // 有 = 正在看某场会议；无 = 待建（pending）
  freshMeeting: boolean;    // 「新建会议」已点、尚未发第一条
  meetings: MeetingView[];  // 该 subject 的会议列表（含 current，倒序）
  pins: Record<string, number>;   // 键 subjectKey（服务端 /api/pins 的 subjects；侧栏按主题 = 一行）
};
type UiEvent = ... | { type: "subject"; subjectKey: string; current?: MeetingView; meetings: MeetingView[] }
                  | { type: "meeting"; meetingId: string; messages: MeetingMessage[]; pinned: string[]; queued: QueuedItemView[] }
                  | { type: "new-meeting"; on: boolean };
// api.ts
api.subject(key) / api.sendToSubject(key, text, requestId, newMeeting) / api.meetingMessages(id) / api.meeting(id)
api.renameMeeting(id, title) / api.pin(id, convId, entryId, pinned) / api.interrupt(id) / api.pins()
// 路由（web/main.ts）
readRoute(): { meetingId?: string; subjectKey?: string }   // ?meeting=… / ?subject=…
navigate(to): void                                          // pushState
```
UI 文案：按钮「新开会话」→「**新建会议**」；点它 = `dispatch({ type: "new-meeting", on: true })`（清空聊天区 + 显示「暂无记录」+ URL 停在 `?subject=`）；发第一条 → `api.sendToSubject(key, text, id, true)` → 用返回的 `meetingId` `replaceState` 到 `?meeting=<id>`。
删除 `freshSessionHint`、`hiddenMessagesHtml`、`log-divider` 相关渲染与 `fresh-hint` 样式。

- [ ] **Step 1: 写失败测试**

```ts
// state.test.ts
it("subject 事件：存 subjectKey/current/meetings；没有 current 时 meetingId 为 undefined", ...)
it("meeting 事件：换会议就 reset messages/pinned/queued，并清 live", ...)
it("new-meeting：置 freshMeeting 并清空 messages（上一场不显示）", ...)
it("迟到的 meeting 消息（meetingId 不匹配）被丢弃", ...)
// render.test.ts
it("侧栏选中项按 subjectKey 高亮；按钮文案是「新建会议」", ...)
it("freshMeeting 时消息区只有「暂无记录」，没有提示条", ...)
it("历史面板按 meetings 列表渲染（标题 + 时间），点条目生成 ?meeting=<id> 链接", ...)
// drafts.test.ts
it("草稿键用 subjectKey（同一 subject 换会议不丢草稿）", ...)
// pins.test.ts（回归：曾把服务端 subjects 读成 meetings → 侧栏 pin 变 undefined → 整页「服务不可用」）
it("pins 事件照存 subjects；pin / SSE meeting.pins 只更新当前主题红点（不写 meetingId 键）；侧栏不抛", ...)
```

- [ ] **Step 2–4: 红 → 实现 → 绿**，Run: `npx vitest run tests/web && npm run typecheck`

- [ ] **Step 5: 重建前端**

Run: `npm run build:web`
Expected: `[build-web] public/ 已生成`；`python3` 检查 `public/app.js` 里不再出现 `newSession`/`roomKey` 字样。

- [ ] **Step 6: 提交**

```bash
git add web tests/web public
git commit -m "feat(web): meeting 状态 + ?meeting/?subject 路由 + 新建会议"
```

---

### Task 12: 清理退役代码 + 实跑验证

**Files:**
- Delete: `src/store/chain-import.ts`、`tests/store/chain-import.test.ts`（若仍存在）
- Modify: `src/server/bootstrap.ts`（去掉 chain-import 调用）、`docs/superpowers/plans/…`（勾选完成）
- Test: 全量

**Interfaces:** 无

- [ ] **Step 1: 删退役代码**

```bash
git rm src/store/chain-import.ts tests/store/chain-import.test.ts
grep -rn "chain-import\|legacy-chains" src tests   # 必须无残留（除注释说明）
```

- [ ] **Step 2: 全量验证**

Run: `npm run typecheck && npx vitest run && npm run build:web`
Expected: 全绿。

- [ ] **Step 3: 词汇清扫（反目标检查）**

Run: `grep -rn "roomKey\|parseRoomKey\|roomKeyOf\|relationKey\|sessionStart\|currentWindow\|freshSession\|新开会话" src web tests`
Expected: 0 命中（`docs/` 与迁移说明除外）。有命中就改到 0。

- [ ] **Step 4: 实跑验证**（服务端有改动 → 必须重启）

```bash
# 重启实跑空间（老板授权的方式：start.sh 或 npm start -- <空间目录>）
# 老库备份：.data/openstaffs.sqlite 已经被新 schema 重建（破坏性，可接受）
```
手工验收清单：
1. 私聊某员工 → 发一句 → 消息出现；URL 变成 `?meeting=mtg_...`；刷新仍是这场会议。
2. 点「新建会议」→ 聊天区「暂无记录」；发第一条 → 新 meetingId、旧会议进「历史」。
3. 群聊 → @ 某成员 + 正文 → 该成员被唤醒；群里回告老板 → **消息就在群里**（不再出现在私聊）。
4. 群里 @ 老板：老板待办有红点；消息落在本群会议。
5. 「历史」点开旧会议 → 只读回看，发送被拒（提示「这场会议已结束」）。
6. 重启进程 → 进行中的会议仍能推流（pump registerAll）。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "chore: 删除链文件迁移遗留 + meeting 层实跑验证"
```

---

## 自检记录

- Spec 覆盖：meetings/sessions/messages 三表 → Task 1–3；subject↔meeting 解析 → Task 4；投递收口 → Task 5–6；回显（HTTP/SSE/前端）→ Task 8、11；Web 路由三态 → Task 11；「新建会话=新建会议」→ Task 6+11；提示词口径 → Task 10；旧概念清零 → Task 12。
- 类型一致性：`MeetingRecord`（store）→ `MeetingView`（app）→ SSE/HTTP → `State.meetings`（web）同名字段；`queueKey(meetingId, memberId)` 在 Task 5 定义、Task 6 使用；`MeetingMessage` 在 Task 4 定义、Task 7/8/11 使用。
- Review Focus 五条各自有主：RF1 → Task 8 测试 2；RF2 → Task 6/8；RF3 → Task 4（participants 快照）+ Task 6（投递按快照）；RF4 → Task 6 `MeetingClosedError` + Task 8 409；RF5 → Task 5 attach 失败重建 + Task 8 registerAll。
