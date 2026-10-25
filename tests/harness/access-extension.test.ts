import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { ToolTask, type HookRegistration } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { createPiHarness } from "../../src/harness/pi-durable.ts";
import type { ConversationSpec } from "../../src/harness/port.ts";
import { createAccessExtension } from "../../src/harness/access-extension.ts";
import { writeBlockMessage } from "../../src/tools/gate.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-hook-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const aliceCwd = path.join(root, "agents", "alice");

function spec(): ConversationSpec {
  return {
    cwd: aliceCwd,
    instructions: "你是 alice。",
    model: { provider: "faux", modelId: "faux-model" },
    access: { root, cwd: aliceCwd, selfId: "alice", permissions: { write: [aliceCwd], read: [aliceCwd], bash: [aliceCwd] } },
  };
}

describe("访问控制钩子", () => {
  it("界内 write 生效，界外 write 被拦", async () => {
    fs.mkdirSync(aliceCwd, { recursive: true });
    fs.mkdirSync(path.join(root, "agents", "bob"), { recursive: true });
    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "note.md", content: "hi" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("write", { path: path.join(root, "agents", "bob", "evil.md"), content: "pwn" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
      fauxAssistantMessage("done"),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const harness = createPiHarness({ root, sqlitePath: path.join(root, "openstaffs/.data", "state.sqlite"), models });
    await harness.open();
    try {
      const convId = await harness.startSession(spec());
      await harness.send(convId, "先在界内写 note.md，再写到 agents/bob/evil.md");
      await harness.send(convId, "继续");
    } finally {
      await harness.close();
    }
    expect(fs.existsSync(path.join(aliceCwd, "note.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, "agents", "bob", "evil.md"))).toBe(false);
  });

  it("bash 放行：命令被执行、未被拦", async () => {
    fs.mkdirSync(aliceCwd, { recursive: true });
    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "printf hi > made-by-bash.txt" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const harness = createPiHarness({ root, sqlitePath: path.join(root, "openstaffs/.data", "state.sqlite"), models });
    await harness.open();
    try {
      const convId = await harness.startSession(spec());
      await harness.send(convId, "跑个命令");
    } finally {
      await harness.close();
    }
    expect(fs.existsSync(path.join(aliceCwd, "made-by-bash.txt"))).toBe(true);
  });
});

describe("并发写保护（work/）", () => {
  it("没读先写被拦；读过之后再写放行", async () => {
    const workdir = path.join(root, "work", "alice");
    fs.mkdirSync(workdir, { recursive: true });
    fs.writeFileSync(path.join(workdir, "note.md"), "old");

    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "note.md", content: "pwn" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("blocked"),
      fauxAssistantMessage(fauxToolCall("read", { path: "note.md" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("write", { path: "note.md", content: "new" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const harness = createPiHarness({ root, sqlitePath: path.join(root, "openstaffs/.data", "state.sqlite"), models });
    await harness.open();
    try {
      const convId = await harness.startSession({
        cwd: workdir,
        instructions: "你是 alice。",
        model: { provider: "faux", modelId: "faux-model" },
        access: { root, cwd: workdir, selfId: "alice", permissions: { write: [workdir], read: [workdir], bash: [] } },
      });
      await harness.send(convId, "直接写");
      expect(fs.readFileSync(path.join(workdir, "note.md"), "utf8")).toBe("old");
      await harness.send(convId, "先读再写");
      expect(fs.readFileSync(path.join(workdir, "note.md"), "utf8")).toBe("new");
    } finally {
      await harness.close();
    }
  });
});

describe("未注册会话", () => {
  it("beforeTool 直接返回 block（未注册 = 不跑工具）", () => {
    const extension = createAccessExtension(() => undefined);
    const registration = (extension.hooks ?? []).find((item: HookRegistration) => item.task === ToolTask.definition.name);
    const handlers = registration?.handlers as { beforeTool?: (call: { name: string; arguments?: unknown }, api: { conversationId: string }) => unknown };
    const beforeTool = handlers?.beforeTool;
    expect(beforeTool).toBeTypeOf("function");
    if (beforeTool === undefined) throw new Error("未安装 beforeTool 钩子");
    const verdict = beforeTool(
      { name: "write", arguments: { path: "note.md", content: "x" } },
      { conversationId: "conv-unknown" },
    ) as { block?: string } | undefined;
    expect(verdict?.block).toContain("未注册的会话");
  });
});

describe("越界提示", () => {
  it("拦截文案引导申请授权（异步说明）", () => {
    const message = writeBlockMessage("/etc/passwd");
    expect(message).toContain('不可写 "/etc/passwd"');
    expect(message).toContain("request_permission");
    expect(message).toContain("异步");
  });
});
