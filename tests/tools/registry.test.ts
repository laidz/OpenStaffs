import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspace, messagesDbFile, stateDir, type Workspace } from "../../src/domain/paths.ts";
import { readChain } from "../../src/domain/conversation-chain.ts";
import { PermissionRequestStore, readPermissionRequests } from "../../src/domain/permission-requests.ts";
import { createPiHarness } from "../../src/harness/pi-durable.ts";
import type { HarnessPort } from "../../src/harness/port.ts";
import { openDm, openGroup } from "../../src/app/conversations.ts";
import type { RoomMessage } from "../../src/app/rooms.ts";
import { openMessageStore } from "../../src/store/messages.ts";
import { openStaffsToolDefs, type ToolContext } from "../../src/tools/registry.ts";
import type { Relation } from "../../src/domain/types.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-tools-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function seedEmployee(id: string, alias?: string, prompt = `你是 ${id}。`): void {
  fs.mkdirSync(path.join(root, "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "agents", `${id}.agent.config.json`),
    JSON.stringify({ model: "faux/faux-model", prompt, ...(alias === undefined ? {} : { alias }) }),
  );
}

function seedProject(id: string, memberIds: string[], alias?: string): void {
  const dir = path.join(root, "projects", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "members.md"), memberIds.map((m) => `- ${m}`).join("\n") + "\n");
  if (alias !== undefined) fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ alias }));
}

function fauxHarness(count = 4) {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
  faux.setResponses(Array.from({ length: count }, (_, i) => fauxAssistantMessage(`答${i}`)));
  const models = createModels();
  models.setProvider(faux.provider);
  return createPiHarness({ root, sqlitePath: path.join(root, ".openstaffs", "state.sqlite"), models });
}

function tool(name: string) {
  const found = openStaffsToolDefs.find((t) => t.name === name);
  if (found === undefined) throw new Error(`工具不存在：${name}`);
  return found;
}

function ctxFor(ws: Workspace, selfId: string, relation: Relation, harness = {} as HarnessPort): ToolContext {
  return { ws, harness, selfId, relation };
}

/** 往自有消息库塞行（room_history 读库）：先建 stateDir，开库写完即关。 */
function seedStore(
  ws: Workspace,
  rows: { projectId: string | null; fromId: string; toIds: string[]; text: string }[],
): void {
  fs.mkdirSync(stateDir(ws), { recursive: true });
  const store = openMessageStore(messagesDbFile(ws));
  try {
    for (const row of rows) store.append({ sendTime: new Date().toISOString(), ...row });
  } finally {
    store.close();
  }
}

/** 读自有库某房间的行（写完即关；调用方保证 stateDir 已存在）。 */
function rowsOf(ws: Workspace, room: string) {
  const store = openMessageStore(messagesDbFile(ws));
  try {
    return store.listByRoom(room);
  } finally {
    store.close();
  }
}

const dm = (employeeId: string): Relation => ({ kind: "dm", employeeId });

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("waitFor 超时");
}

describe("office_list", () => {
  it("列出成员与项目，并标出我在不在群里", async () => {
    seedEmployee("alice", "爱丽丝");
    seedEmployee("bob");
    seedProject("demo", ["alice", "bob"], "演示项目");
    const out = await tool("office_list").run({}, ctxFor(createWorkspace(root), "alice", dm("alice")));
    expect(out).toContain("爱丽丝");
    expect(out).toContain("演示项目");
    expect(out).toContain("bob");
    expect(out).toContain("true"); // demo 含 alice
    expect(out).toContain("（办公室直属）"); // 人在 agents/ 根 → 直属
  });
});

describe("member_profile", () => {
  it("读成员展示名 + prompt 正文", async () => {
    seedEmployee("bob", "Bob", "职责：后端工程师。");
    const out = await tool("member_profile").run({ member: "bob" }, ctxFor(createWorkspace(root), "alice", dm("alice")));
    expect(out).toContain("Bob");
    expect(out).toContain("后端工程师");
  });
});

describe("room_history", () => {
  it("读指定房间的历史（自有库），群聊按 toIds 重建头部 @、标注发言人", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    seedProject("demo", ["alice", "bob"], "演示项目");
    const ws = createWorkspace(root);
    seedStore(ws, [
      { projectId: "demo", fromId: "__boss", toIds: ["alice"], text: "任务X" },
      { projectId: "demo", fromId: "alice", toIds: ["__boss"], text: "答0" },
    ]);
    const out = await tool("room_history").run({ room: "group:demo" }, ctxFor(ws, "alice", { kind: "group", project: "demo" }));
    // 群聊展示时由收件人重建头部 @（任务X 是 @alice 的）
    expect(out).toContain("老板：@alice 任务X");
    expect(out).toContain("alice：@老板 答0");
  });

  it("limit 取最近若干条；room 缺省 = 当前房间；非法键报错", async () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const harness = fauxHarness();
    await harness.open();
    try {
      const out = await tool("room_history").run({}, ctxFor(ws, "alice", dm("alice"), harness));
      expect(out).toBe("（暂无消息）");
      await expect(tool("room_history").run({ room: "bogus" }, ctxFor(ws, "alice", dm("alice"), harness))).rejects.toThrow("房间键");

      seedStore(ws, [
        { projectId: null, fromId: "__boss", toIds: ["alice"], text: "一" },
        { projectId: null, fromId: "alice", toIds: ["__boss"], text: "二" },
        { projectId: null, fromId: "__boss", toIds: ["alice"], text: "三" },
      ]);
      expect(await tool("room_history").run({ limit: 2 }, ctxFor(ws, "alice", dm("alice"), harness))).toBe("alice：二\n老板：三");
    } finally {
      await harness.close();
    }
  });

  it("`.openstaffs` 尚未创建（stateDir 不存在）→ 返回「（暂无消息）」，不抛「unable to open database file」", async () => {
    const freshRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-tools-nostate-"));
    try {
      expect(fs.existsSync(stateDir(createWorkspace(freshRoot)))).toBe(false);
      const out = await tool("room_history").run({}, ctxFor(createWorkspace(freshRoot), "alice", dm("alice")));
      expect(out).toBe("（暂无消息）");
    } finally {
      fs.rmSync(freshRoot, { recursive: true, force: true });
    }
  });
});

describe("send_message", () => {
  it("target=boss：向老板私聊投递一条（归属自己），不触发自己再回答", async () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const harness = fauxHarness();
    await harness.open();
    try {
      const out = await tool("send_message").run({ target: "boss", text: "汇报一下" }, ctxFor(ws, "alice", dm("alice"), harness));
      expect(out).toContain("老板");
      const dmConv = await openDm(ws, harness, "alice");
      const history = await harness.transcript(dmConv);
      const posted = history.find((m) => m.text === "汇报一下");
      expect((posted?.data as { author?: string } | undefined)?.author).toBe("alice");
      // 不触发模型回答：append 只有 chat.message 条目，没有模型产出的 pi.assistant 条目。
      expect(history.some((m) => m.kind === "pi.assistant")).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("target=member：在当前群里触发该成员（投递到他的群会话）", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    seedProject("demo", ["alice", "bob"], "演示项目");
    const ws = createWorkspace(root);
    const harness = fauxHarness();
    await harness.open();
    try {
      await tool("send_message").run({ target: "member:bob", text: "bob 帮我看下" }, ctxFor(ws, "alice", { kind: "group", project: "demo" }, harness));
      const bobConv = await openGroup(ws, harness, "demo", "bob");
      const history = await harness.transcript(bobConv);
      const delivered = history.find((m) => m.text === "bob 帮我看下");
      expect((delivered?.data as { author?: string } | undefined)?.author).toBe("alice");
      await waitFor(async () => (await harness.transcript(bobConv)).some((m) => m.role === "assistant"));
    } finally {
      await harness.close();
    }
  });

  it("target=member：私聊里用 / 非群成员 → 报错", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    seedProject("demo", ["alice"], "演示项目");
    const ws = createWorkspace(root);
    await expect(tool("send_message").run({ target: "member:bob", text: "x" }, ctxFor(ws, "alice", dm("alice")))).rejects.toThrow("群聊");
    await expect(
      tool("send_message").run({ target: "member:bob", text: "x" }, ctxFor(ws, "alice", { kind: "group", project: "demo" })),
    ).rejects.toThrow("不是本群成员");
  });

  it("无法识别的 target → 报错", async () => {
    seedEmployee("alice");
    await expect(tool("send_message").run({ target: "wat", text: "x" }, ctxFor(createWorkspace(root), "alice", dm("alice")))).rejects.toThrow("target");
  });

  it("target=boss：落一行到 dm:<自己>（不是 dm:）并广播库行（键 store:<seq>）", async () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    seedStore(ws, []); // 建 stateDir（openMessageStore 不建父目录）
    const harness = fauxHarness();
    await harness.open();
    const broadcasts: { roomKey: string; message: RoomMessage }[] = [];
    try {
      const ctx = { ...ctxFor(ws, "alice", dm("alice"), harness), broadcast: (roomKey: string, message: RoomMessage) => broadcasts.push({ roomKey, message }) };
      await tool("send_message").run({ target: "boss", text: "@老板 汇报进展" }, ctx);

      const rows = rowsOf(ws, "dm:alice");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ room: "dm:alice", projectId: null, fromId: "alice", toIds: ["__boss"], text: "汇报进展" });
      expect(rows[0]!.room).not.toBe("dm:"); // 私聊房间必须带上自己（不得退化成 dm:）

      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0]!.roomKey).toBe("dm:alice");
      expect(broadcasts[0]!.message).toMatchObject({
        convId: "store",
        entryId: String(rows[0]!.seq),
        speaker: { kind: "employee", id: "alice" },
        text: "汇报进展",
      });
    } finally {
      await harness.close();
    }
  });

  it("target=member：在群房间落一行并广播库行", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    seedProject("demo", ["alice", "bob"], "演示项目");
    const ws = createWorkspace(root);
    seedStore(ws, []);
    const harness = fauxHarness();
    await harness.open();
    const broadcasts: { roomKey: string; message: RoomMessage }[] = [];
    try {
      const ctx = { ...ctxFor(ws, "alice", { kind: "group", project: "demo" }, harness), broadcast: (roomKey: string, message: RoomMessage) => broadcasts.push({ roomKey, message }) };
      await tool("send_message").run({ target: "member:bob", text: "@bob 帮我看下" }, ctx);

      const rows = rowsOf(ws, "group:demo");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ room: "group:demo", projectId: "demo", fromId: "alice", toIds: ["bob"], text: "帮我看下" });
      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0]!.roomKey).toBe("group:demo");
      expect(broadcasts[0]!.message).toMatchObject({ convId: "store", entryId: String(rows[0]!.seq), text: "@bob 帮我看下" });
    } finally {
      await harness.close();
    }
  });

  it("target=project：在该项目群房间落一行（toIds 空，不伪造收件人）并广播库行", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    seedProject("demo", ["alice", "bob"], "演示项目");
    const ws = createWorkspace(root);
    seedStore(ws, []);
    const harness = fauxHarness();
    await harness.open();
    const broadcasts: { roomKey: string; message: RoomMessage }[] = [];
    try {
      const ctx = { ...ctxFor(ws, "alice", { kind: "group", project: "demo" }, harness), broadcast: (roomKey: string, message: RoomMessage) => broadcasts.push({ roomKey, message }) };
      await tool("send_message").run({ target: "project:demo", text: "同步一下进度" }, ctx);

      const rows = rowsOf(ws, "group:demo");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ room: "group:demo", projectId: "demo", fromId: "alice", toIds: [], text: "同步一下进度" });
      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0]!.roomKey).toBe("group:demo");
      expect(broadcasts[0]!.message).toMatchObject({ convId: "store", entryId: String(rows[0]!.seq), text: "同步一下进度" });
    } finally {
      await harness.close();
    }
  });

  it("空正文（剥头后为空）不落行、不广播", async () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    seedStore(ws, []);
    const harness = fauxHarness();
    await harness.open();
    const broadcasts: unknown[] = [];
    try {
      const ctx = { ...ctxFor(ws, "alice", dm("alice"), harness), broadcast: (roomKey: string, message: RoomMessage) => broadcasts.push({ roomKey, message }) };
      await tool("send_message").run({ target: "boss", text: "@老板" }, ctx);
      expect(rowsOf(ws, "dm:alice")).toEqual([]);
      expect(broadcasts).toEqual([]);
    } finally {
      await harness.close();
    }
  });
});

describe("new_session", () => {
  it("结束当前会话、开新条（链变长）", async () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const harness = fauxHarness();
    await harness.open();
    try {
      const before = await openDm(ws, harness, "alice");
      await tool("new_session").run({}, ctxFor(ws, "alice", dm("alice"), harness));
      const chain = readChain(path.join(root, "work", "alice", "conversation_ids.md"));
      expect(chain).toHaveLength(2);
      expect(chain[1]!.previous).toBe(before);
    } finally {
      await harness.close();
    }
  });
});

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
    const expected = path.join(root, "work", "alice", "notes", "a.md");
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

describe("注册表", () => {
  it("暴露 6 个工具且名字唯一", () => {
    const names = openStaffsToolDefs.map((t) => t.name).sort();
    expect(names).toEqual(["member_profile", "new_session", "office_list", "request_permission", "room_history", "send_message"]);
  });
});

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

      seedStore(ws, [{ projectId: null, fromId: "__boss", toIds: ["alice"], text: "任务Y" }]);
      const history = await tool("room_history").run({}, ctxFor(ws, "alice", dm("alice"), harness));
      expect(history).toContain("掌柜：任务Y");
    } finally {
      await harness.close();
    }
  });
});
