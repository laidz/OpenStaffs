import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace, type Workspace } from "../../src/domain/paths.ts";
import { readChain } from "../../src/domain/conversation-chain.ts";
import { createPiHarness } from "../../src/harness/pi-durable.ts";
import type { HarnessPort } from "../../src/harness/port.ts";
import { openDm, openGroup } from "../../src/app/conversations.ts";
import { openStaffsToolDefs, type ToolContext } from "../../src/tools/registry.ts";
import type { Relation } from "../../src/domain/types.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-tools-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function seedEmployee(id: string, alias?: string): void {
  const dir = path.join(root, "agents", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "AGENTS.md"), `你是 ${id}。`);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ model: "faux/faux-model", ...(alias === undefined ? {} : { alias }) }));
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
  });
});

describe("member_profile", () => {
  it("读成员展示名 + profile.md 正文", async () => {
    seedEmployee("bob", "Bob");
    fs.writeFileSync(path.join(root, "agents", "bob", "profile.md"), "职责：后端工程师。");
    const out = await tool("member_profile").run({ member: "bob" }, ctxFor(createWorkspace(root), "alice", dm("alice")));
    expect(out).toContain("Bob");
    expect(out).toContain("后端工程师");
  });
});

describe("room_history", () => {
  it("读指定房间的合并记录，标注发言人", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    seedProject("demo", ["alice", "bob"], "演示项目");
    const ws = createWorkspace(root);
    const harness = fauxHarness();
    await harness.open();
    try {
      const aliceConv = await openGroup(ws, harness, "demo", "alice");
      await harness.submit(aliceConv, "任务X", { kind: "chat.message", data: { author: "boss" } });
      await waitFor(async () => (await harness.transcript(aliceConv)).some((m) => m.role === "assistant"));
      const out = await tool("room_history").run({ room: "group:demo" }, ctxFor(ws, "alice", { kind: "group", project: "demo" }, harness));
      expect(out).toContain("老板：任务X");
      expect(out).toContain("alice：答0");
    } finally {
      await harness.close();
    }
  });

  it("room 缺省 = 当前房间；非法键报错", async () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const harness = fauxHarness();
    await harness.open();
    try {
      const out = await tool("room_history").run({}, ctxFor(ws, "alice", dm("alice"), harness));
      expect(out).toBe("（暂无消息）");
      await expect(tool("room_history").run({ room: "bogus" }, ctxFor(ws, "alice", dm("alice"), harness))).rejects.toThrow("房间键");
    } finally {
      await harness.close();
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
      expect(history.some((m) => m.role === "assistant")).toBe(false);
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
      const chain = readChain(path.join(root, "agents", "alice", "conversation_ids.md"));
      expect(chain).toHaveLength(2);
      expect(chain[1]!.previous).toBe(before);
    } finally {
      await harness.close();
    }
  });
});

describe("注册表", () => {
  it("暴露 5 个工具且名字唯一", () => {
    const names = openStaffsToolDefs.map((t) => t.name).sort();
    expect(names).toEqual(["member_profile", "new_session", "office_list", "room_history", "send_message"]);
  });
});
