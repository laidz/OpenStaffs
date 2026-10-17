import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { afterEach, describe, expect, it } from "vitest";
import { createPiHarness, mapPiEvent } from "../../src/harness/pi-durable.ts";
import type { ConversationSpec, HarnessEvent, HarnessPort } from "../../src/harness/port.ts";
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
  it("sessionInfo：私聊/群聊各归其位（startSession 与 attach 都登记）", async () => {
    const { models } = fauxModels([fauxAssistantMessage("ok")]);
    const harness = createPiHarness({ root, sqlitePath: path.join(root, ".openstaffs", "state-sinfo.sqlite"), models });
    await harness.open();
    try {
      const dmCwd = path.join(root, "agents", "alice");
      const groupCwd = path.join(root, "projects", "demo");
      fs.mkdirSync(dmCwd, { recursive: true });
      fs.mkdirSync(groupCwd, { recursive: true });

      const dmConv = await harness.startSession(spec(dmCwd));
      expect(harness.sessionInfo(dmConv)).toEqual({ selfId: "alice", relation: { kind: "dm", employeeId: "alice" } });

      const groupSpec: ConversationSpec = { ...spec(groupCwd), cwd: groupCwd, access: { ...access(groupCwd), cwd: groupCwd } };
      const groupConv = await harness.startSession(groupSpec);
      expect(harness.sessionInfo(groupConv)).toEqual({ selfId: "alice", relation: { kind: "group", project: "demo" } });

      expect(await harness.attach(dmConv, access(dmCwd))).toBe(true);
      expect(harness.sessionInfo(dmConv)).toEqual({ selfId: "alice", relation: { kind: "dm", employeeId: "alice" } });
      expect(harness.sessionInfo("conv:不存在")).toBeUndefined();
    } finally {
      await harness.close();
    }
  });
});

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

  it("append：落一条被动消息（transcript 可见）且不触发模型回答", async () => {
    const { models } = fauxModels([fauxAssistantMessage("不该被用到")]);
    const harness = createPiHarness({ root, sqlitePath: path.join(root, ".openstaffs", "state-append.sqlite"), models });
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
    harness = createPiHarness({ root, sqlitePath: path.join(root, ".openstaffs", "state-echo.sqlite"), models });
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
    const harness = createPiHarness({ root, sqlitePath: path.join(root, ".openstaffs", "state-abort.sqlite"), models });
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

  it("mapPiEvent：task_failed 透传 kind（失败类别，供前端/排障区分）", () => {
    const mapped = mapPiEvent(
      { type: "task_failed", taskId: 7, kind: "model", message: "模型不可用" } as unknown as Parameters<typeof mapPiEvent>[0],
      "c1",
    );
    expect(mapped).toEqual([{ type: "failed", convId: "c1", kind: "model", message: "模型不可用" }]);
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
