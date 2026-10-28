import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { afterEach, describe, expect, it } from "vitest";
import { argsHint, createPiHarness, mapPiEvent } from "../../src/harness/pi-durable.ts";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { ConversationSpec, HarnessEvent, HarnessPort } from "../../src/harness/port.ts";
import type { AccessContext } from "../../src/domain/access-control.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-harness-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function spec(cwd: string): ConversationSpec {
  return {
    cwd,
    meetingId: "mtg_test",
    relation: { kind: "dm", employeeId: "alice" },
    instructions: "你是测试员工。",
    model: { provider: "faux", modelId: "faux-model" },
    access: { root, cwd, selfId: "alice", permissions: { write: [cwd], read: [cwd], bash: [cwd] } },
  };
}

function access(cwd: string): AccessContext {
  return { root, cwd, selfId: "alice", permissions: { write: [cwd], read: [cwd], bash: [cwd] } };
}

function fauxModels(
  responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0],
  /** tokensPerSecond/tokenSize：放慢流式输出，使 delta 跨过 pi-durable 的 100ms partial 落盘窗口。 */
  options?: { tokensPerSecond?: number; tokenSize?: { min?: number; max?: number } },
) {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }], ...options });
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, faux };
}

/** 从请求上下文里提取全部 system 文本（faux 响应工厂用）。pi-durable 1.3 把 instructions 放在 SystemMessage.sections 而非 content，故整条序列化。 */
function systemTextOf(messages: readonly { role: string; content: unknown }[]): string {
  return messages
    .filter((m) => m.role === "system")
    .map((m) => JSON.stringify(m))
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
    const harness = createPiHarness({ root, sqlitePath: path.join(root, "openstaffs/.data", "state.sqlite"), models });
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

  it("sessionUsage：读会话实际模型 / 思考强度 / 上下文用量 / 模型窗口与能力表", async () => {
    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model", reasoning: true }] });
    faux.setResponses([fauxAssistantMessage("ok")]);
    const models = createModels();
    models.setProvider(faux.provider);
    const harness = createPiHarness({ root, sqlitePath: path.join(root, "openstaffs/.data", "state-usage.sqlite"), models });
    await harness.open();
    try {
      const cwd = path.join(root, "agents", "alice");
      fs.mkdirSync(cwd, { recursive: true });
      const convId = await harness.startSession({ ...spec(cwd), thinkingLevel: "high" });
      const usage = await harness.sessionUsage(convId);
      expect(usage).toMatchObject({
        model: { provider: "faux", modelId: "faux-model" },
        thinkingLevel: "high",
        contextWindow: 128000,
        supportedThinkingLevels: ["off", "minimal", "low", "medium", "high"], // 无 map：xhigh / max 不支持
      });
      expect(usage!.contextUsed).toBeGreaterThanOrEqual(0);

      // 发送后上下文增长；窗口不变
      await harness.send(convId, "你好");
      const after = await harness.sessionUsage(convId);
      expect(after!.contextUsed).toBeGreaterThan(0);
      expect(after!.contextUsed).toBeGreaterThanOrEqual(usage!.contextUsed);

      await expect(harness.sessionUsage("conv:不存在")).rejects.toThrow();
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
    const harness = createPiHarness({ root, sqlitePath: path.join(root, "openstaffs/.data", "state.sqlite"), models });
    await harness.open();
    try {
      const cwd = path.join(root, "agents", "alice");
      fs.mkdirSync(cwd, { recursive: true });
      const convId = await harness.startSession(spec(cwd));
      expect(await harness.attach(convId, access(cwd), { kind: "dm", employeeId: "alice" }, "mtg_test")).toBe(true);
      await harness.send(convId, "你好");
      expect(seenSystem).toContain("你是测试员工。");

      const other = createPiHarness({ root, sqlitePath: path.join(root, "openstaffs/.data", "state2.sqlite"), models });
      await other.open();
      try {
        expect(await other.attach(convId, access(cwd), { kind: "dm", employeeId: "alice" }, "mtg_test")).toBe(false);
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
    const harness = createPiHarness({ root, sqlitePath: path.join(root, "openstaffs/.data", "state.sqlite"), models });
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
    const harness = createPiHarness({ root, sqlitePath: path.join(root, "openstaffs/.data", "state.sqlite"), models });
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
    const harness = createPiHarness({ root, sqlitePath: path.join(root, "openstaffs/.data", "state.sqlite"), models });
    await harness.open();
    try {
      const cwd = path.join(root, "agents", "nobody");
      fs.mkdirSync(cwd, { recursive: true });
      const empty: ConversationSpec = {
        cwd,
        meetingId: "mtg_test",
        relation: { kind: "dm", employeeId: "nobody" },
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
  it("sessionInfo：房间归属由会话显式给出（同一 cwd 也能分清私聊 / 群聊），attach 与 bindSession 都登记", async () => {
    const { models } = fauxModels([fauxAssistantMessage("ok")]);
    const harness = createPiHarness({ root, sqlitePath: path.join(root, "openstaffs/.data", "state-sinfo.sqlite"), models });
    await harness.open();
    try {
      // 关键：群聊与私聊的 cwd 是同一个（员工自己的工作目录）——靠 cwd 推断房间就是串台。
      const cwd = path.join(root, "work", "alice");
      fs.mkdirSync(cwd, { recursive: true });

      const dmConv = await harness.startSession(spec(cwd));
      expect(harness.sessionInfo(dmConv)).toEqual({ selfId: "alice", relation: { kind: "dm", employeeId: "alice" }, meetingId: "mtg_test" });

      const groupConv = await harness.startSession({ ...spec(cwd), relation: { kind: "group", project: "demo" } });
      expect(harness.sessionInfo(groupConv)).toEqual({ selfId: "alice", relation: { kind: "group", project: "demo" }, meetingId: "mtg_test" });

      expect(await harness.attach(dmConv, access(cwd), { kind: "dm", employeeId: "alice" }, "mtg_test")).toBe(true);
      expect(harness.sessionInfo(dmConv)).toEqual({ selfId: "alice", relation: { kind: "dm", employeeId: "alice" }, meetingId: "mtg_test" });

      // 重启后 pump 只订阅不停 attach：靠 bindSession 补登记（房间由会话链推出）
      harness.bindSession("conv:restart", { selfId: "alice", relation: { kind: "group", project: "demo" }, meetingId: "mtg_restart", access: access(cwd) });
      expect(harness.sessionInfo("conv:restart")).toEqual({ selfId: "alice", relation: { kind: "group", project: "demo" }, meetingId: "mtg_restart" });
      expect(harness.sessionInfo("conv:不存在")).toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it("重启后 bindSession 必须把访问上下文一起补登记，否则工具全被「未注册的会话」拦掉", async () => {
    // 场景：进程重启 → pump 只订阅不 attach；会话的 access 是内存态，重启就丢了。
    // 回归：bindSession 曾只补身份不补 access → 员工每个工具调用都被访问控制钩子拦下。
    const cwd = path.join(root, "agents", "alice");
    fs.mkdirSync(cwd, { recursive: true });
    const sqlitePath = path.join(root, "openstaffs/.data", "state-restart-access.sqlite");

    const first = createPiHarness({ root, sqlitePath, models: fauxModels([fauxAssistantMessage("ok")]).models });
    await first.open();
    const convId = await first.startSession(spec(cwd));
    await first.close();

    // 「重启」：新 harness 打开同一库，不 attach；按 pump 重启路径只 bindSession（带 access）
    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "restarted.md", content: "ok" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("完成"),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const second = createPiHarness({ root, sqlitePath, models });
    await second.open();
    try {
      second.bindSession(convId, { selfId: "alice", relation: { kind: "dm", employeeId: "alice" }, meetingId: "mtg_test", access: access(cwd) });
      await second.send(convId, "写个文件");
    } finally {
      await second.close();
    }
    expect(fs.existsSync(path.join(cwd, "restarted.md"))).toBe(true);
  });
});

describe("提交与推流", () => {
  it("submit 写入自定义 entry（kind/data），transcript 读回", async () => {
    const { models } = fauxModels([fauxAssistantMessage("收到")]);
    const harness = createPiHarness({ root, sqlitePath: path.join(root, "openstaffs/.data", "state-submit.sqlite"), models });
    await harness.open();
    try {
      const cwd = path.join(root, "agents", "alice");
      fs.mkdirSync(cwd, { recursive: true });
      const convId = await harness.startSession(spec(cwd));
      await harness.submit(convId, "做X", { kind: "chat.message", data: { author: "boss", messageId: "rm_1" } });
      await waitFor(async () => (await harness.transcript(convId)).some((m) => m.role === "assistant"));
      const boss = (await harness.transcript(convId)).find((m) => m.role === "user");
      expect(boss?.kind).toBe("chat.message");
      expect(boss?.text).toBe("做X");
      expect((boss?.data as { messageId?: string } | undefined)?.messageId).toBe("rm_1");
    } finally {
      await harness.close();
    }
  });

  it("append：落一条被动消息（transcript 可见）且不触发模型回答", async () => {
    const { models } = fauxModels([fauxAssistantMessage("不该被用到")]);
    const harness = createPiHarness({ root, sqlitePath: path.join(root, "openstaffs/.data", "state-append.sqlite"), models });
    await harness.open();
    try {
      const cwd = path.join(root, "agents", "alice");
      fs.mkdirSync(cwd, { recursive: true });
      const convId = await harness.startSession(spec(cwd));
      await harness.append(convId, { kind: "chat.message", text: "我主动说一句", data: { author: "alice" } });
      await waitFor(async () => (await harness.transcript(convId)).some((m) => m.text === "我主动说一句"));
      const history = await harness.transcript(convId);
      const posted = history.find((m) => m.text === "我主动说一句");
      expect(posted?.kind).toBe("chat.message");
      expect((posted?.data as { author?: string } | undefined)?.author).toBe("alice");
      // 不触发模型回答：append 只有 chat.message 条目，没有模型产出的 pi.assistant 条目。
      expect(history.some((m) => m.kind === "pi.assistant")).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("append 的员工发言在后续模型上下文中是 assistant 形态（防自我回显）", async () => {
    // 回归：曾以 user 形态落盘 → 下一轮生成把它当用户新输入，模型复读自己的消息（「回显」）。
    const seen: { role: string; text: string }[] = [];
    let harness: HarnessPort | undefined;
    let convId = "";
    let appended = false;
    const contextText = (content: unknown): string => {
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return content.flatMap((b: { type?: string; text?: string }) => (b?.type === "text" ? [b.text ?? ""] : [])).join("");
    };
    const { models } = fauxModels([
      async () => {
        if (!appended) {
          appended = true;
          // 与 send_message 的真实路径一致：run 进行中调用（busy → 排队，postTools boundary 后进入上下文）。
          await harness!.append(convId, { kind: "chat.message", text: "我主动说一句", data: { author: "alice" } });
        }
        return fauxAssistantMessage(fauxToolCall("bash", { command: "echo ok" }), { stopReason: "toolUse" });
      },
      (context: { messages: readonly { role: string; content: unknown }[] }) => {
        for (const message of context.messages) {
          if (contextText(message.content).includes("我主动说一句")) seen.push({ role: message.role, text: "我主动说一句" });
        }
        return fauxAssistantMessage("完成");
      },
    ]);
    harness = createPiHarness({ root, sqlitePath: path.join(root, "openstaffs/.data", "state-echo.sqlite"), models });
    await harness.open();
    try {
      const cwd = path.join(root, "agents", "alice");
      fs.mkdirSync(cwd, { recursive: true });
      convId = await harness.startSession(spec(cwd));
      const reply = await harness.send(convId, "干活");
      expect(reply.text).toBe("完成");
      // 必须以「己方发言」（assistant）进入上下文；若以 user 进入，模型会把这条当输入再回复一次（回显）。
      expect(seen).toEqual([{ role: "assistant", text: "我主动说一句" }]);
    } finally {
      await harness.close();
    }
  });

  it("abort：中止在跑的生成（不再出 delta）并回到空闲，可继续发下一条", async () => {
    const { models } = fauxModels(
      [
        fauxAssistantMessage("这是一段会慢慢流出来的很长很长的回答，用来验证中途中断是否生效。"),
        fauxAssistantMessage("中断后仍能回答"),
      ],
      { tokensPerSecond: 20, tokenSize: { min: 1, max: 1 } },
    );
    const harness = createPiHarness({ root, sqlitePath: path.join(root, "openstaffs/.data", "state-abort.sqlite"), models });
    await harness.open();
    try {
      const cwd = path.join(root, "agents", "alice");
      fs.mkdirSync(cwd, { recursive: true });
      const convId = await harness.startSession(spec(cwd));
      const events: HarnessEvent[] = [];
      const unsubscribe = await harness.watch(convId, (e) => events.push(e));
      try {
        await harness.submit(convId, "写一段长文");
        await waitFor(() => events.some((e) => e.type === "delta" && e.delta.length > 0));
        await harness.abort(convId);
        await new Promise((r) => setTimeout(r, 80)); // 让中止前已在途的事件排干
        const settled = events.filter((e) => e.type === "delta").length;
        await new Promise((r) => setTimeout(r, 400));
        expect(events.filter((e) => e.type === "delta").length).toBe(settled); // 生成已停
        expect(events.some((e) => e.type === "run" && e.phase === "end")).toBe(true);

        const reply = await harness.send(convId, "还在吗"); // 空闲 → 能继续
        expect(reply.text).toBe("中断后仍能回答");
      } finally {
        await unsubscribe();
      }
    } finally {
      await harness.close();
    }
  });

  it("watch 推送 delta / 落盘消息 / run 起止", async () => {
    const { models } = fauxModels([fauxAssistantMessage("你好呀，我是 alice，很高兴见到你，今天有什么可以帮你的吗？")], {
      tokensPerSecond: 20,
      tokenSize: { min: 1, max: 1 },
    });
    const harness = createPiHarness({ root, sqlitePath: path.join(root, "openstaffs/.data", "state-watch.sqlite"), models });
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

  it("mapPiEvent：task_failed 透传 kind（失败类别，供前端/排障区分）", () => {
    const mapped = mapPiEvent(
      { type: "task_failed", taskId: 7, kind: "model", message: "模型不可用" } as unknown as Parameters<typeof mapPiEvent>[0],
      "c1",
    );
    expect(mapped).toEqual([{ type: "failed", convId: "c1", kind: "model", message: "模型不可用" }]);
  });

  it("submit 回执与 submission 事件：忙时 queued；withdrawSubmission 撤回后不进 transcript；已 placed 撤不回", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { models } = fauxModels([
      async () => {
        await gate; // 第一轮卡住不返回 → 会话保持忙
        return fauxAssistantMessage("第一轮完成");
      },
      fauxAssistantMessage("第二轮完成"),
    ]);
    const harness = createPiHarness({ root, sqlitePath: path.join(root, "openstaffs/.data", "state-queue.sqlite"), models });
    await harness.open();
    try {
      const cwd = path.join(root, "agents", "alice");
      fs.mkdirSync(cwd, { recursive: true });
      const convId = await harness.startSession(spec(cwd));
      const events: HarnessEvent[] = [];
      const unsubscribe = await harness.watch(convId, (e) => events.push(e));
      try {
        const first = await harness.submit(convId, "第一轮");
        expect(first.status).toBe("placed"); // 空闲：直接进 transcript
        await waitFor(() => events.some((e) => e.type === "submission" && e.id === first.id));

        const second = await harness.submit(convId, "第二轮");
        expect(second.status).toBe("queued"); // 忙：进了 Pi 的 inbox，还没进 transcript
        await waitFor(() => events.some((e) => e.type === "submission" && e.id === second.id && e.status === "queued"));
        expect((await harness.transcript(convId)).some((m) => m.text === "第二轮")).toBe(false);

        expect(await harness.withdrawSubmission(convId, second.id)).toBe(true); // 撤回：不投递给员工
        await waitFor(() => events.some((e) => e.type === "submission" && e.id === second.id && e.status === "unanswered"));

        release();
        await waitFor(async () => (await harness.transcript(convId)).some((m) => m.role === "assistant"));
        const users = (await harness.transcript(convId)).filter((m) => m.role === "user");
        expect(users.map((m) => m.text)).toEqual(["第一轮"]);

        const third = await harness.submit(convId, "第三轮");
        expect(third.status).toBe("placed");
        expect(await harness.withdrawSubmission(convId, third.id)).toBe(false); // 已开始：撤不回（那是中断语义）
        expect(await harness.withdrawSubmission(convId, "sub-不存在")).toBe(false);
      } finally {
        await unsubscribe();
        release();
      }
    } finally {
      await harness.close();
    }
  });

  it("mapPiEvent：submission 事件透传 id 与状态（待发队列的真相源）", () => {
    const mapped = mapPiEvent(
      { type: "submission", record: { id: 42, conversationId: 1, type: "input", status: "queued" } } as unknown as Parameters<typeof mapPiEvent>[0],
      "c1",
    );
    expect(mapped).toEqual([{ type: "submission", convId: "c1", id: "42", status: "queued" }]);
  });

  it("同 requestId 重复提交不产生重复输入（Pi 去重语义）", async () => {
    const { models } = fauxModels([fauxAssistantMessage("一"), fauxAssistantMessage("二")]);
    const harness = createPiHarness({ root, sqlitePath: path.join(root, "openstaffs/.data", "state-request.sqlite"), models });
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

  it("MCP 扩展不默认选中；mcpExtensions 指定的会话才拿到工具", async () => {
    const probeFile = path.join(root, "probe-tools.json");
    const probe = defineExtension({
      name: "probe",
      tools: [
        defineTool({
          name: "probe_tools",
          description: "记录当前会话可见的工具名",
          parameters: Type.Object({}),
          async execute(_args, api, context) {
            const agent = await api.agent(context);
            fs.writeFileSync(probeFile, JSON.stringify(agent.tools.map((tool) => tool.name)));
            return { output: [{ type: "text", text: "ok" }] };
          },
        }),
      ],
    });
    const hidden = defineExtension({
      name: "mcp:system:hidden",
      tools: [
        defineTool({
          name: "mcp__hidden__echo",
          description: "隐藏工具",
          parameters: Type.Object({ text: Type.String() }),
          async execute(args) {
            return { output: [{ type: "text", text: `hidden:${args.text}` }] };
          },
        }),
      ],
    });

    const { models } = fauxModels([
      fauxAssistantMessage(fauxToolCall("probe_tools", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
      fauxAssistantMessage(fauxToolCall("probe_tools", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const harness = createPiHarness({
      root,
      sqlitePath: path.join(root, "openstaffs/.data", "state.sqlite"),
      models,
      extensions: [probe],
      mcpExtensions: [hidden],
    });
    await harness.open();
    try {
      const cwd = path.join(root, "agents", "alice");
      fs.mkdirSync(cwd, { recursive: true });

      const plain = await harness.startSession(spec(cwd));
      await harness.send(plain, "probe");
      const without = JSON.parse(fs.readFileSync(probeFile, "utf8")) as string[];
      expect(without).not.toContain("mcp__hidden__echo");
      expect(without).toContain("probe_tools");

      const withMcp = await harness.startSession({ ...spec(cwd), mcpExtensions: ["mcp:system:hidden"] });
      await harness.send(withMcp, "probe");
      const withTools = JSON.parse(fs.readFileSync(probeFile, "utf8")) as string[];
      expect(withTools).toContain("mcp__hidden__echo");
    } finally {
      await harness.close();
    }
  });
});

describe("Pi 事件映射", () => {
  it("snapshot 带 run → 补发 run start（订阅晚于投递时不漏运行态）", () => {
    expect(mapPiEvent({ type: "snapshot", entries: [], run: { inputs: [] } } as never, "c1")).toEqual([
      { type: "run", convId: "c1", phase: "start" },
    ]);
    expect(mapPiEvent({ type: "snapshot", entries: [] } as never, "c1")).toEqual([]);
  });

  it("toolcall_start → toolCall（模型开始生成工具调用）；toolcall_delta 不进事件流", () => {
    const block = { type: "toolCall", id: "t1", name: "bash", arguments: {} };
    expect(
      mapPiEvent({ type: "message_update", changes: [{ type: "toolcall_start", contentIndex: 0, block }] } as never, "c1"),
    ).toEqual([{ type: "toolCall", convId: "c1", name: "bash" }]);
    expect(
      mapPiEvent(
        { type: "message_update", changes: [{ type: "toolcall_delta", contentIndex: 0, path: ["command"], delta: "ls" }] } as never,
        "c1",
      ),
    ).toEqual([]);
  });

  it("argsHint：取最像人话的参数字段并截断（无字符串字段则不塞提示）", () => {
    expect(argsHint({ command: "ls  -la\n/tmp" })).toBe("ls -la /tmp");
    expect(argsHint({ path: "a/b.md" })).toBe("a/b.md");
    expect(argsHint({ command: "x".repeat(80) })).toBe(`${"x".repeat(60)}…`);
    expect(argsHint({ count: 3, nested: { a: 1 } })).toBeUndefined();
    expect(argsHint({ path: "   " })).toBeUndefined();
    expect(argsHint(null)).toBeUndefined();
    expect(argsHint([1, 2])).toBeUndefined();
  });

  it("真实跑一个工具：tool 事件 start 带参数提示（命令 / 路径），end 不带", async () => {
    const workdir = path.join(root, "work", "alice");
    fs.mkdirSync(workdir, { recursive: true });
    fs.writeFileSync(path.join(workdir, "hello.txt"), "hi\n");
    const { models } = fauxModels([
      fauxAssistantMessage(fauxToolCall("bash", { command: "echo hi" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("跑完了"),
    ]);
    const harness = createPiHarness({ root, sqlitePath: path.join(root, "openstaffs/.data", "tool-hint.sqlite"), models });
    await harness.open();
    try {
      const convId = await harness.startSession(spec(workdir));
      const events: HarnessEvent[] = [];
      const unsubscribe = await harness.watch(convId, (event) => events.push(event));
      try {
        await harness.send(convId, "跑一下");
      } finally {
        await unsubscribe();
      }
      const start = events.find((event) => event.type === "tool" && event.phase === "start");
      expect(start?.type === "tool" ? start.name : "").toBe("bash");
      expect(start?.type === "tool" ? start.hint : "").toBe("echo hi");
      const end = events.find((event) => event.type === "tool" && event.phase === "end");
      expect(end?.type === "tool" ? end.hint : undefined).toBeUndefined();
    } finally {
      await harness.close();
    }
  });
});

describe("会话完整上下文（context）", () => {
  it("返回 instructions + 模型上下文（含工具调用与工具结果）", async () => {
    const workdir = path.join(root, "work", "alice");
    fs.mkdirSync(workdir, { recursive: true });
    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "note.md", content: "hi" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("完成"),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const harness = createPiHarness({ root, sqlitePath: path.join(root, "openstaffs/.data/ctx.sqlite"), models });
    await harness.open();
    try {
      const convId = await harness.startSession({
        cwd: workdir,
        meetingId: "mtg_test",
        relation: { kind: "dm", employeeId: "alice" },
        instructions: "你是 alice。",
        model: { provider: "faux", modelId: "faux-model" },
        access: { root, cwd: workdir, selfId: "alice", permissions: { write: [workdir], read: [workdir], bash: [] } },
      });
      await harness.send(convId, "写个文件");
      const ctx = await harness.context(convId);
      expect(ctx.instructions).toContain("你是 alice。");
      expect(ctx.items.some((item) => item.role === "user" && item.text.includes("写个文件"))).toBe(true);
      const withTools = ctx.items.find((item) => item.role === "assistant" && (item.toolCalls?.length ?? 0) > 0);
      expect(withTools?.toolCalls?.[0]?.name).toBe("write");
      // 工具调用带 id（会话详情里用来把调用与结果合成一条）
      expect(withTools?.toolCalls?.[0]?.id).toBeTruthy();
      // 每条消息带时间戳（ISO）：会话详情逐步显时间
      expect(Number.isNaN(Date.parse(withTools?.at ?? ""))).toBe(false);
      expect(ctx.items.every((item) => item.at !== undefined)).toBe(true);
      expect(ctx.items.some((item) => item.role === "tool" && item.toolName === "write")).toBe(true);
      expect(ctx.items.some((item) => item.role === "assistant" && item.text.includes("完成"))).toBe(true);
    } finally {
      await harness.close();
    }
  });
});
