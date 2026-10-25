# 原生记忆能力实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把记忆做成框架原生能力：常驻 profile + 索引注入 + 新鲜度续期 + 90 天自动遗忘，并用 `memory: true/false` 开关控制（空间默认 + 员工覆盖）。

**Architecture:** 每个员工记忆落在 `work/<id>/memory/`（profile.md + 实体 md + `.state.json` 侧车），不依赖任何外部项目。域层拆成 frontmatter / store / view 三个模块；工具层提供 6 个 `memory_*` 工具；会话装配时同步读取并固化进 instructions。

**Tech Stack:** Node ≥ 22.19 + TypeScript（直接运行，无编译）、vitest、typebox。

**Spec:** `docs/superpowers/specs/2026-10-25-native-memory-design.md`

## Global Constraints

- 所有新代码沿用仓库风格：2 空格缩进、双引号、分号、`.ts` 扩展名导入。
- 记忆目录固定为 `work/<员工 id>/memory/`；不碰 `agents/`。
- 阈值固定：TTL 90 天、索引 40 条 / 16384 字节、profile 8192 字节、标题 40 字、简介 80 字。
- 不做旧格式兼容与迁移；不引入外部依赖；不改 WebUI。
- 写操作使用「临时文件 + rename」原子替换；文件 IO 同步。
- 执行前先确认在功能分支 `feat/native-memory` 上。

## Review Focus

- **损坏的实体文件**（坏 frontmatter / id 与文件名不一致 / 超长）：必须跳过且不影响其他记忆与会话，不能抛到会话创建。
- **索引上限**：非 pinned 条目超 40 条 / 16 KiB 时只截断注入内容，`memory_list` 仍应看到全部，且提示被截断数量。
- **淘汰边界**：正好 90 天不淘汰，超过才淘汰；pinned 永不淘汰；淘汰后 `memory_get` 仍可取到并自动复活。
- **开关关闭**：不注入任何记忆，工具统一报“记忆未启用”，已有文件不被删除。
- **重复/危险 id**：空、`.`、`..`、含 `/` `\` 或控制字符的 id 一律拒绝；标题生成冲突自动加序号。

---

### Task 1: 记忆域基础（类型 + frontmatter）

**Files:**
- Create: `src/domain/memory/types.ts`
- Create: `src/domain/memory/frontmatter.ts`
- Test: `tests/domain/memory/frontmatter.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `MemMeta` / `MemEntity` / `MemEntry` / `MemSettings` 类型与阈值常量；`nowIso(d?)`、`memSlug(s)`、`parseFrontmatter(text)`、`serializeEntity(meta, body)`、`validateMeta(meta, fileId)`。

- [ ] **Step 1: 写失败测试**

```ts
// tests/domain/memory/frontmatter.test.ts
import { describe, expect, it } from "vitest";
import { memSlug, nowIso, parseFrontmatter, serializeEntity, validateMeta } from "../../../src/domain/memory/frontmatter.ts";
import { DESC_MAX, TITLE_MAX, type MemMeta } from "../../../src/domain/memory/types.ts";

const meta: MemMeta = {
  id: "vip-policy", title: "VIP 口径", description: "谈 VIP 时先看",
  pinned: false, created: "2026-10-25T10:00:00+08:00", updated: "2026-10-25T10:00:00+08:00",
};

describe("frontmatter", () => {
  it("序列化后能原样解析回来", () => {
    const parsed = parseFrontmatter(serializeEntity(meta, "正文第一行\n第二行"));
    expect(parsed.error).toBeUndefined();
    expect(parsed.meta).toEqual(meta);
    expect(parsed.body).toBe("正文第一行\n第二行");
  });

  it("pinned 只认 true", () => {
    const parsed = parseFrontmatter(["---", "id: a", "title: t", "description: d", "pinned: true", "---", "", "x"].join("\n"));
    expect(parsed.meta?.pinned).toBe(true);
    expect(parseFrontmatter(["---", "id: a", "title: t", "description: d", "pinned: yes", "---", "", "x"].join("\n")).meta?.pinned).toBe(false);
  });

  it("缺 frontmatter / 未闭合 / 坏行 → error", () => {
    expect(parseFrontmatter("没有头").error).toContain("缺少 frontmatter");
    expect(parseFrontmatter("---\nid: a").error).toContain("未闭合");
    expect(parseFrontmatter("---\n坏行\n---\n").error).toContain("格式错误");
  });

  it("校验 id 一致与标题/简介长度", () => {
    expect(validateMeta(meta, "vip-policy")).toEqual([]);
    expect(validateMeta({ ...meta, id: "other" }, "vip-policy")[0]).toContain("不一致");
    expect(validateMeta({ ...meta, title: "字".repeat(TITLE_MAX + 1) }, "vip-policy")[0]).toContain("title 超过");
    expect(validateMeta({ ...meta, description: "字".repeat(DESC_MAX + 1) }, "vip-policy")[0]).toContain("description 超过");
  });

  it("memSlug 保留中文、折叠符号、限长", () => {
    expect(memSlug("VIP 客户 口径")).toBe("vip-客户-口径");
    expect(memSlug("  --你好!!  ")).toBe("你好");
    expect(memSlug("字".repeat(60))).toHaveLength(40);
  });

  it("nowIso 是本地时区秒级 ISO", () => {
    expect(nowIso(new Date("2026-10-25T02:03:04Z"))).toMatch(/^2026-10-25T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — `npm test -- tests/domain/memory/frontmatter.test.ts`，期望模块不存在。

- [ ] **Step 3: 写 `types.ts`**

```ts
export type MemMeta = {
  id: string; title: string; description: string; pinned: boolean; created: string; updated: string;
};
export type MemEntity = MemMeta & { body: string; path: string };
export type MemEntry = {
  id: string; title: string; description: string; pinned: boolean;
  updated: string; lastUsed: string; remainingDays: number; evicted?: true;
};
export type MemSettings = { ttlDays: number; maxEntries: number; maxBytes: number };

export const PROFILE_FILE = "profile.md";
export const PROFILE_MAX_BYTES = 8192;
export const TITLE_MAX = 40;
export const DESC_MAX = 80;
export const TTL_DAYS = 90;
export const INDEX_MAX_ENTRIES = 40;
export const INDEX_MAX_BYTES = 16384;
export const DEFAULT_MEM_SETTINGS: MemSettings = {
  ttlDays: TTL_DAYS, maxEntries: INDEX_MAX_ENTRIES, maxBytes: INDEX_MAX_BYTES,
};
```

- [ ] **Step 4: 写 `frontmatter.ts`**（解析 / 序列化 / 校验 / slug / nowIso，逻辑照 spec §3 的字段，不引入 tags/author/kind）

- [ ] **Step 5: 跑测试确认通过** — `npm test -- tests/domain/memory/frontmatter.test.ts`

- [ ] **Step 6: 提交** — `git add src/domain/memory tests/domain/memory && git commit -m "feat(memory): 记忆实体格式与校验"`

---

### Task 2: 存储层（路径 / 扫描 / 增删改 / 状态 / profile）

**Files:**
- Create: `src/domain/memory/store.ts`
- Test: `tests/domain/memory/store.test.ts`

**Interfaces:**
- Consumes: Task 1 的 frontmatter 与 types。
- Produces: `memoryDir` / `profileFile` / `entityFile` / `archiveDir` / `archiveFile` / `stateFile` / `gitignoreFile`；`loadMemory(ws, agentId)`、`findEntity(ws, agentId, id)`、`readState`、`touch`、`forgetState`、`readProfile`、`writeProfile`、`createEntity`、`updateEntity`、`removeEntity`。

- [ ] **Step 1: 写失败测试**

```ts
// tests/domain/memory/store.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace, workDir } from "../../../src/domain/paths.ts";
import {
  archiveDir, createEntity, findEntity, loadMemory, memoryDir, readProfile, readState,
  removeEntity, touch, updateEntity, writeProfile,
} from "../../../src/domain/memory/store.ts";
import { PROFILE_MAX_BYTES } from "../../../src/domain/memory/types.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-mem-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const ws = createWorkspace(root);

describe("记忆存储", () => {
  it("创建：生成 id、落盘、续期；同名自动加序号", () => {
    const a = createEntity(ws, "alice", { title: "VIP 口径", description: "谈 VIP 时先看", body: "内容" });
    expect(a.id).toBe("vip-口径");
    expect(fs.existsSync(path.join(memoryDir(ws, "alice"), "vip-口径.md"))).toBe(true);
    expect(readState(ws, "alice")["vip-口径"]).toBeTruthy();
    const b = createEntity(ws, "alice", { title: "VIP 口径", description: "第二条", body: "内容" });
    expect(b.id).toBe("vip-口径-2");
  });

  it("创建校验：标题为空 / 正文为空 → 报错", () => {
    expect(() => createEntity(ws, "alice", { title: "!!!", description: "d", body: "b" })).toThrow("标题无法生成合法 id");
    expect(() => createEntity(ws, "alice", { title: "ok", description: "d", body: "  " })).toThrow("正文不能为空");
  });

  it("更新：改简介、追加正文、置顶；无变更 → 报错；body 与 append 互斥", () => {
    const e = createEntity(ws, "alice", { title: "a", description: "d", body: "第一行" });
    const u = updateEntity(ws, "alice", e.id, { description: "新简介", append: "第二行", pinned: true });
    expect(u.description).toBe("新简介");
    expect(u.body).toBe("第一行\n第二行");
    expect(u.pinned).toBe(true);
    expect(() => updateEntity(ws, "alice", e.id, {})).toThrow("没有要更新的内容");
    expect(() => updateEntity(ws, "alice", e.id, { body: "x", append: "y" })).toThrow("不能同时使用");
  });

  it("归档：pinned 先取消；归档不占用 id", () => {
    const e = createEntity(ws, "alice", { title: "a", description: "d", body: "b", pinned: true });
    expect(() => removeEntity(ws, "alice", e.id)).toThrow("已置顶");
    updateEntity(ws, "alice", e.id, { pinned: false });
    removeEntity(ws, "alice", e.id);
    expect(findEntity(ws, "alice", e.id)).toBeUndefined();
    expect(fs.existsSync(path.join(archiveDir(ws, "alice"), `${e.id}.md`))).toBe(true);
    expect(createEntity(ws, "alice", { title: "a", description: "d", body: "b" }).id).toBe(e.id);
  });

  it("扫描跳过坏文件；状态损坏按空处理", () => {
    createEntity(ws, "alice", { title: "ok", description: "d", body: "b" });
    fs.writeFileSync(path.join(memoryDir(ws, "alice"), "broken.md"), "没有头");
    fs.writeFileSync(path.join(memoryDir(ws, "alice"), "bad-id.md"), "---\nid: other\ntitle: t\ndescription: d\n---\n\nx");
    fs.writeFileSync(path.join(memoryDir(ws, "alice"), ".state.json"), "{坏");
    const loaded = loadMemory(ws, "alice");
    expect(loaded.entities.map((e) => e.title)).toEqual(["ok"]);
    expect(loaded.errors).toHaveLength(2);
    expect(readState(ws, "alice")).toEqual({});
  });

  it("profile：读写 trim、空正文拒绝、超上限拒绝", () => {
    expect(readProfile(ws, "alice")).toBe("");
    expect(writeProfile(ws, "alice", "  身份  ")).toBe(Buffer.byteLength("身份"));
    expect(readProfile(ws, "alice")).toBe("身份");
    expect(() => writeProfile(ws, "alice", "   ")).toThrow("不能为空");
    expect(() => writeProfile(ws, "alice", "x".repeat(PROFILE_MAX_BYTES + 1))).toThrow("超过上限");
  });

  it("touch 写状态，forgetState 删除", () => {
    touch(ws, "alice", "x", "2026-01-01T00:00:00+08:00");
    expect(readState(ws, "alice")["x"]).toBe("2026-01-01T00:00:00+08:00");
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — `npm test -- tests/domain/memory/store.test.ts`

- [ ] **Step 3: 写 `store.ts`**（路径函数、同步读写、原子写、扫描、增删改、状态、profile；见 spec §8）

- [ ] **Step 4: 跑测试确认通过** — `npm test -- tests/domain/memory/store.test.ts`

- [ ] **Step 5: 提交** — `git add src/domain/memory tests/domain/memory && git commit -m "feat(memory): 记忆存储与新鲜度侧车"`

---

### Task 3: 视图层（新鲜度 / 索引 / 注入文本）

**Files:**
- Create: `src/domain/memory/view.ts`
- Test: `tests/domain/memory/view.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `loadMemory` / `readState` / `readProfile`；Task 1 的类型与阈值。
- Produces: `evaluate(...)`、`buildIndex(...)`、`renderEntry(entry)`、`renderMemoryBlock(ws, agentId)`。

- [ ] **Step 1: 写失败测试**

```ts
// tests/domain/memory/view.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../../src/domain/paths.ts";
import { createEntity, touch, writeProfile } from "../../../src/domain/memory/store.ts";
import { buildIndex, evaluate, renderMemoryBlock } from "../../../src/domain/memory/view.ts";
import type { MemEntity } from "../../../src/domain/memory/types.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-memview-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const ws = createWorkspace(root);

const entity = (over: Partial<MemEntity> = {}): MemEntity => ({
  id: "a", title: "A", description: "简介", pinned: false,
  created: "2026-01-01T00:00:00+08:00", updated: "2026-01-01T00:00:00+08:00",
  body: "正文", path: "/tmp/a.md", ...over,
});

describe("新鲜度", () => {
  it("正好 90 天不淘汰，超过才淘汰；pinned 永不淘汰", () => {
    const now = new Date("2026-04-01T00:00:00+08:00"); // 2026-01-01 起正好 90 天
    expect(evaluate(entity(), undefined, 90, now).evicted).toBe(false);
    const later = new Date("2026-04-02T00:00:00+08:00");
    expect(evaluate(entity(), undefined, 90, later).evicted).toBe(true);
    expect(evaluate(entity({ pinned: true }), undefined, 90, later).evicted).toBe(false);
  });

  it("lastUsed 优先于 updated", () => {
    const now = new Date("2026-04-02T00:00:00+08:00");
    const f = evaluate(entity(), "2026-03-31T00:00:00+08:00", 90, now);
    expect(f.evicted).toBe(false);
    expect(f.remainingDays).toBe(88);
  });
});

describe("索引", () => {
  it("pinned 置顶，其余按最近使用排序", () => {
    const state = { b: "2026-03-01T00:00:00+08:00", c: "2026-02-01T00:00:00+08:00" };
    const index = buildIndex([
      entity({ id: "a", title: "A" }),
      entity({ id: "b", title: "B" }),
      entity({ id: "c", title: "C", pinned: true }),
    ], state, { ttlDays: 90, maxEntries: 40, maxBytes: 16384 }, { now: new Date("2026-03-02T00:00:00+08:00") });
    expect(index.entries.map((e) => e.id)).toEqual(["c", "b", "a"]);
  });

  it("非 pinned 超过条数上限只截断注入，pinned 不受限", () => {
    const many = Array.from({ length: 45 }, (_, i) => entity({ id: `m${i}`, title: `M${i}`, pinned: i === 0 }));
    const index = buildIndex(many, {}, { ttlDays: 90, maxEntries: 40, maxBytes: 16384 }, { now: new Date("2026-01-01T00:00:00+08:00") });
    expect(index.entries).toHaveLength(41);
    expect(index.truncated).toBe(4);
  });

  it("超过字节上限按顺序截断", () => {
    const many = Array.from({ length: 10 }, (_, i) => entity({ id: `m${i}`, title: `M${i}`, description: "字".repeat(80) }));
    const index = buildIndex(many, {}, { ttlDays: 90, maxEntries: 40, maxBytes: 600 }, { now: new Date("2026-01-01T00:00:00+08:00") });
    expect(index.entries.length).toBeLessThan(10);
    expect(index.truncated).toBeGreaterThan(0);
  });
});

describe("注入文本", () => {
  it("空记忆 → 空串", () => {
    expect(renderMemoryBlock(ws, "alice")).toBe("");
  });

  it("profile + 索引 + 截断提示", () => {
    writeProfile(ws, "alice", "身份是测试");
    createEntity(ws, "alice", { title: "A", description: "做 A 时看", body: "正文" });
    touch(ws, "alice", "a", "2026-10-25T10:00:00+08:00");
    const text = renderMemoryBlock(ws, "alice");
    expect(text).toContain("## 你的记忆");
    expect(text).toContain("### 常驻 profile（全文）");
    expect(text).toContain("身份是测试");
    expect(text).toContain("### 记忆索引（需要正文时用 memory_get <id>）");
    expect(text).toContain("- a · A — 做 A 时看（剩 90 天）");
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — `npm test -- tests/domain/memory/view.test.ts`

- [ ] **Step 3: 写 `view.ts`**（evaluate / buildIndex / renderEntry / renderMemoryBlock；截断只统计非 pinned；`evicted` 条目不进默认索引）

- [ ] **Step 4: 跑测试确认通过** — `npm test -- tests/domain/memory/view.test.ts`

- [ ] **Step 5: 提交** — `git add src/domain/memory tests/domain/memory && git commit -m "feat(memory): 记忆索引与注入文本"`

---

### Task 4: 配置开关 + 员工解析

**Files:**
- Modify: `src/config/schema.ts`（`ConfigFields.memory?: boolean` + 解析）
- Modify: `src/domain/config.ts`（`readMemoryFlag`）
- Modify: `src/domain/employee.ts`（新增 `memoryEnabled`；旧字段暂留到 Task 5）
- Test: `tests/config/schema.test.ts`、`tests/domain/employee.test.ts`

**Interfaces:**
- Consumes: Task 1-3 无直接依赖。
- Produces: `Employee.memoryEnabled: boolean`；`readMemoryFlag(ws): boolean | undefined`。

- [ ] **Step 1: 写失败测试**（在 `tests/config/schema.test.ts` 末尾追加）

```ts
test("memory：布尔值解析，非布尔值忽略并记 issue", () => {
  expect(parseConfigFields({ memory: true }).fields.memory).toBe(true);
  expect(parseConfigFields({ memory: false }).fields.memory).toBe(false);
  expect(parseConfigFields({}).fields.memory).toBeUndefined();
  const bad = parseConfigFields({ memory: "yes" });
  expect(bad.fields.memory).toBeUndefined();
  expect(bad.issues).toContain("memory 必须是布尔值（已忽略）");
});
```

- [ ] **Step 2: 写失败测试**（在 `tests/domain/employee.test.ts` 追加；`seed` 已存在）

```ts
it("memoryEnabled：员工显式值覆盖空间默认；缺省为 true", () => {
  seed("alice", {});
  const ws = createWorkspace(tmp);
  expect(loadEmployee(ws, "alice").memoryEnabled).toBe(true);

  seed("alice", { memory: false });
  expect(loadEmployee(ws, "alice").memoryEnabled).toBe(false);

  seed("alice", {});
  fs.mkdirSync(path.join(tmp, "openstaffs", ".data"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "openstaffs", ".data", "config.json"), JSON.stringify({ memory: false }));
  expect(loadEmployee(ws, "alice").memoryEnabled).toBe(false);

  seed("alice", { memory: true });
  expect(loadEmployee(ws, "alice").memoryEnabled).toBe(true);
});
```

- [ ] **Step 3: 跑测试确认失败** — `npm test -- tests/config/schema.test.ts tests/domain/employee.test.ts`

- [ ] **Step 4: 实现** — schema 解析布尔值；`readMemoryFlag` 只读原始 JSON（不依赖 providers/model）；`loadEmployee` 增加 `memoryEnabled`（员工 → 空间 → true）。

- [ ] **Step 5: 跑测试确认通过** — `npm test -- tests/config/schema.test.ts tests/domain/employee.test.ts`

- [ ] **Step 6: 提交** — `git add src/config/schema.ts src/domain/config.ts src/domain/employee.ts tests && git commit -m "feat(memory): 记忆开关（空间默认 + 员工覆盖）"`

---

### Task 5: 会话注入替换 + 删除旧记忆实现

**Files:**
- Modify: `src/app/conversations.ts`
- Modify: `src/domain/employee.ts`
- Modify: `src/domain/paths.ts`
- Modify: `src/prompts/space.md`
- Modify: `tests/app/conversations.test.ts`、`tests/domain/paths.test.ts`、`tests/domain/employee.test.ts`

**Interfaces:**
- Consumes: `renderMemoryBlock`、`Employee.memoryEnabled`。
- Produces: `instructionsFor(...)` 在 prompt 链与技能清单之间插入记忆块；`Employee` 不再有 `memory` 字段；`paths` 不再有旧记忆路径。

- [ ] **Step 1: 更新测试**

`tests/app/conversations.test.ts`：

```ts
it("新会话注入 profile + 索引；关闭开关则不注入", async () => {
  seedEmployee("alice");
  const ws = createWorkspace(root);
  writeProfile(ws, "alice", "我是 alice");
  createEntity(ws, "alice", { title: "VIP 口径", description: "谈 VIP 时看", body: "正文" });
  const text = instructionsFor(ws, { kind: "dm", employeeId: "alice" }, loadEmployee(ws, "alice"));
  expect(text).toContain("我是 alice");
  expect(text).toContain("vip-口径 · VIP 口径 — 谈 VIP 时看");

  seedOffice(root, { agents: [{ id: "bob", model: "faux/faux-model", memory: false }] });
  writeProfile(ws, "bob", "不该出现");
  expect(instructionsFor(ws, { kind: "dm", employeeId: "bob" }, loadEmployee(ws, "bob"))).not.toContain("不该出现");
});
```

- 删除“自动补建旧记忆文件”的整段测试。
- `tests/domain/paths.test.ts` 删除旧记忆路径函数的 import 与用例。
- `tests/domain/employee.test.ts` 删除“读 memory 字段”的用例，保留 Task 4 的开关用例。

- [ ] **Step 2: 跑测试确认失败/报错** — `npm test -- tests/app/conversations.test.ts tests/domain/paths.test.ts tests/domain/employee.test.ts`

- [ ] **Step 3: 实现**

- `conversations.ts`：`instructionsFor` 里 `speaker.memoryEnabled` 时调用 `renderMemoryBlock(ws, speaker.id)` 并 push；删除 `ensureMemory` 调用与 import。
- `employee.ts`：删除 `memory` 字段、`readText`、`ensureMemory`、`memoryFile` import。
- `paths.ts`：删除旧记忆文件路径函数。
- `space.md`：最后一句改为使用 `memory_profile` / `memory_add` / `memory_get` 的说明。
- 注意：`seedOffice` 的 `agents` 类型需要加 `memory?: boolean`（直接透传配置）。

- [ ] **Step 4: 跑测试确认通过** — `npm test -- tests/app/conversations.test.ts tests/domain/paths.test.ts tests/domain/employee.test.ts`

- [ ] **Step 5: 提交** — `git add -A && git commit -m "feat(memory): 新会话注入记忆，移除旧文件记忆"`

---

### Task 6: 记忆工具

**Files:**
- Create: `src/tools/memory.ts`
- Modify: `src/tools/registry.ts`（汇总 `memoryTools`）
- Test: `tests/tools/memory.test.ts`

**Interfaces:**
- Consumes: 所有记忆域函数。
- Produces: 6 个 `ToolDef`：`memory_list` / `memory_get` / `memory_add` / `memory_update` / `memory_remove` / `memory_profile`。

- [ ] **Step 1: 写失败测试**

```ts
// tests/tools/memory.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { openStaffsToolDefs, type ToolContext } from "../../src/tools/registry.ts";
import { seedOffice } from "../helpers/office.ts";
import type { Relation } from "../../src/domain/types.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-memtools-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function ctx(employee = "alice"): ToolContext {
  seedOffice(root, { agents: [{ id: "alice", model: "faux/faux-model" }, { id: "bob", model: "faux/faux-model", memory: false }] });
  const ws = createWorkspace(root);
  return { ws, selfId: employee, relation: { kind: "dm", employeeId: employee } as Relation, harness: {} as never };
}
function tool(name: string) {
  const found = openStaffsToolDefs.find((t) => t.name === name);
  if (found === undefined) throw new Error(`工具不存在：${name}`);
  return found;
}

describe("memory_* 工具", () => {
  it("add → list → get → update → remove", async () => {
    const c = ctx();
    const added = await tool("memory_add").run({ title: "VIP 口径", description: "谈 VIP 时看", body: "正文" }, c);
    expect(added).toContain("vip-口径");
    expect(await tool("memory_list").run({}, c)).toContain("VIP 口径");
    const got = await tool("memory_get").run({ id: "vip-口径" }, c);
    expect(got).toContain("正文");
    await tool("memory_update").run({ id: "vip-口径", append: "追加" }, c);
    expect(await tool("memory_get").run({ id: "vip-口径" }, c)).toContain("追加");
    await tool("memory_remove").run({ id: "vip-口径" }, c);
    expect(await tool("memory_list").run({}, c)).toBe("（暂无记忆）");
  });

  it("profile show/set", async () => {
    const c = ctx();
    expect(await tool("memory_profile").run({ action: "show" }, c)).toBe("（还没有 profile）");
    expect(await tool("memory_profile").run({ action: "set", body: "我是 alice" }, c)).toContain("已写入 profile");
    expect(await tool("memory_profile").run({ action: "show" }, c)).toBe("我是 alice");
  });

  it("查询过滤、无变更报错、找不到报错", async () => {
    const c = ctx();
    await tool("memory_add").run({ title: "A", description: "做 A", body: "x" }, c);
    await tool("memory_add").run({ title: "B", description: "做 B", body: "y" }, c);
    expect(await tool("memory_list").run({ query: "做 b" }, c)).toContain("B");
    expect(await tool("memory_list").run({ query: "做 b" }, c)).not.toContain("A");
    await expect(tool("memory_update").run({ id: "a" }, c)).rejects.toThrow("没有要更新的内容");
    await expect(tool("memory_get").run({ id: "nope" }, c)).rejects.toThrow("找不到记忆");
  });

  it("关闭开关 → 统一报错", async () => {
    const c = ctx("bob");
    await expect(tool("memory_list").run({}, c)).rejects.toThrow("记忆未启用");
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — `npm test -- tests/tools/memory.test.ts`

- [ ] **Step 3: 写 `src/tools/memory.ts` + 注册**（6 个工具；统一 `requireEnabled`；描述写清使用时机；`memory_profile` 用 `action: show|set`）

- [ ] **Step 4: 跑测试确认通过** — `npm test -- tests/tools/memory.test.ts`

- [ ] **Step 5: 跑全量测试** — `npm test`

- [ ] **Step 6: 提交** — `git add src/tools tests/tools && git commit -m "feat(memory): 6 个原生记忆工具"`

---

### Task 7: 文档同步 + 全量验证

**Files:**
- Modify: `src/skills/openstaffs/SKILL.md`
- Modify: `src/skills/openstaffs-ops/SKILL.md`
- Modify: `README.md`
- Modify: `docs/产品规划.md`

- [ ] **Step 1: 更新员工技能** — 把记忆段落改成：profile / 索引 / 续期 / 90 天遗忘 / 6 个工具 / 不要直改文件。
- [ ] **Step 2: 更新运维技能** — 目录树 `work/<名字>/memory/`；开关两层与默认值；阈值；注入快照；排障（坏文件跳过、淘汰、归档、pinned）。
- [ ] **Step 3: 更新 README** — 员工配置示例加 `"memory": true|false`；工作目录说明改成 `work/<id>/memory/`。
- [ ] **Step 4: 更新产品规划** — 已落地 profile + 索引 + 遗忘；自动总结 / 自动进化仍属后续。
- [ ] **Step 5: 全量验证**

```bash
npm run typecheck
npm test
grep -rn "旧记忆文件名" src README.md docs || true
```

期望：typecheck 0 错误、测试全绿、当前代码与文档无旧记忆文件残留（历史计划除外）。

- [ ] **Step 6: 提交** — `git add -A && git commit -m "docs(memory): 记忆能力文档同步"`

---

## 完成标准

- `npm run typecheck` 通过。
- `npm test` 全绿。
- 新开会话时能看到 `## 你的记忆`（有 profile 或索引时）。
- 关闭 `memory` 后，新会话无记忆块、工具报“记忆未启用”。
- 文档（员工技能 / 运维技能 / README / 产品规划）与实际行为一致。
