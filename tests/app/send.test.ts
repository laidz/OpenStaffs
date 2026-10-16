import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { EmptyGroupError, KeyedQueue, sendToRoom } from "../../src/app/send.ts";
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
    this.submits.push({ convId, text, meta }); // 先记录"进入 submit"，再被 gate 阻塞（模拟 admission 在途）
    if (this.gate !== undefined) await this.gate;
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
});
