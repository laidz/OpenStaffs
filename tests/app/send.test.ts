import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { EmptyGroupError, KeyedQueue, NoTargetsError, sendToRoom, triggerFromGroupReply } from "../../src/app/send.ts";
import type { ChatMessage, ConversationSpec, HarnessPort, InputMeta } from "../../src/harness/port.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-send-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function seedEmployee(id: string, alias?: string) {
  const dir = path.join(root, "agents", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "AGENTS.md"), `你是 ${id}。`);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ model: "faux/faux-model", ...(alias === undefined ? {} : { alias }) }));
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
  async append(): Promise<void> {}
  async abort(): Promise<void> {}
  sessionInfo(): undefined {
    return undefined;
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

const defaults = { model: "faux/faux-model" };

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

  it("群聊 @alice：只投递 alice，正文保留 @；多 @：各一份同 roomMessageId", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    seedGroup("yt", ["alice", "bob"]);
    const ws = createWorkspace(root);
    const port = new FakePort();
    const queue = new KeyedQueue();

    const mentioned = await sendToRoom(ws, port, { kind: "group", project: "yt" }, "@alice 做视频", { queue, defaults });
    expect(mentioned.deliveries.map((d) => d.memberId)).toEqual(["alice"]);
    expect(port.submits[0]!.text).toBe("@alice 做视频");

    port.submits.length = 0;
    const both = await sendToRoom(ws, port, { kind: "group", project: "yt" }, "@alice @bob 全体汇报", { queue, defaults });
    expect(both.deliveries.map((d) => d.memberId).sort()).toEqual(["alice", "bob"]);
    const rids = new Set(port.submits.map((s) => (s.meta?.data as { roomMessageId?: string } | undefined)?.roomMessageId));
    expect(rids).toEqual(new Set([both.roomMessageId]));
  });

  it("群聊不 @ 到任何成员（含只 @老板）：抛 NoTargetsError，不 submit", async () => {
    seedEmployee("alice");
    seedGroup("yt", ["alice"]);
    const ws = createWorkspace(root);
    const port = new FakePort();
    const queue = new KeyedQueue();
    await expect(
      sendToRoom(ws, port, { kind: "group", project: "yt" }, "全体汇报", { queue, defaults }),
    ).rejects.toThrow(NoTargetsError);
    await expect(
      sendToRoom(ws, port, { kind: "group", project: "yt" }, "@老板 收到", { queue, defaults }),
    ).rejects.toThrow(NoTargetsError);
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
    const p = sendToRoom(ws, port, { kind: "group", project: "yt" }, "@alice @bob 全体动起来", { queue: new KeyedQueue(), defaults });
    const started = Date.now();
    while (port.submits.length < 2 && Date.now() - started < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(port.submits).toHaveLength(2); // 两个成员都在 submit 中等待
    release();
    await p;
  });
});

describe("群回复的 @触发（agent ↔ agent / 发给老板的口径）", () => {
  it("投递给被 @ 到的成员：发送者标注 + chat.mention + 去重键；不含发送者自己与老板", async () => {
    seedEmployee("alice", "爱丽丝");
    seedEmployee("bob");
    seedGroup("yt", ["alice", "bob"]);
    const ws = createWorkspace(root);
    const port = new FakePort();
    const reports = await triggerFromGroupReply(ws, port, {
      queue: new KeyedQueue(),
      defaults,
      project: "yt",
      senderId: "alice",
      convId: "conv-a",
      entryId: "42",
      text: "@bob @alice @老板 请评审：方案 A",
    });
    expect(reports.map((r) => r.memberId)).toEqual(["bob"]);
    expect(port.submits).toHaveLength(1);
    expect(port.submits[0]!.text).toBe("爱丽丝（alice）：@bob @alice @老板 请评审：方案 A");
    expect(port.submits[0]!.meta?.kind).toBe("chat.mention");
    const data = port.submits[0]!.meta?.data as { author?: string; source?: string };
    expect(data.author).toBe("alice");
    expect(data.source).toBe("conv-a:42");
    expect(port.submits[0]!.meta?.requestId).toBe("mention:conv-a:42");
  });

  it("无 alias 用 id 标注；无 @ 开头 / 只 @老板 / @非成员 / 只 @自己 → 不投递", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    seedGroup("yt", ["alice", "bob"]);
    const ws = createWorkspace(root);
    const port = new FakePort();
    const queue = new KeyedQueue();
    const run = (text: string) =>
      triggerFromGroupReply(ws, port, { queue, defaults, project: "yt", senderId: "alice", convId: "c", entryId: "1", text });

    const reports = await run("@bob 你好");
    expect(reports.map((r) => r.memberId)).toEqual(["bob"]);
    expect(port.submits[0]!.text).toBe("alice：@bob 你好");
    port.submits.length = 0;

    expect(await run("好的，已完成")).toEqual([]);
    expect(await run("@老板 已汇报")).toEqual([]);
    expect(await run("@ghost 你好")).toEqual([]);
    expect(await run("@alice 我自己")).toEqual([]);
    expect(port.submits).toEqual([]);
  });
});
