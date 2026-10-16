import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { afterEach, describe, expect, it } from "vitest";
import { createPiHarness } from "../../src/harness/pi-durable.ts";
import type { ConversationSpec } from "../../src/harness/port.ts";

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

function fauxModels() {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
  faux.setResponses([fauxAssistantMessage("你好，我是 alice。")]);
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, faux };
}

describe("Pi Durable HarnessPort", () => {
  it("能开一条会话、发消息、拿回答、读回 transcript", async () => {
    const { models } = fauxModels();
    const harness = createPiHarness({ root, sqlitePath: path.join(root, ".openstaffs", "state.sqlite"), models });
    await harness.open();
    try {
      const cwd = path.join(root, "agents", "alice");
      fs.mkdirSync(cwd, { recursive: true });
      const convId = await harness.ensureActive("dm:alice", spec(cwd));
      const reply = await harness.send(convId, "你是谁？");
      expect(reply.role).toBe("assistant");
      expect(reply.text).toContain("alice");
      const history = await harness.transcript(convId);
      expect(history.some((m) => m.role === "user" && m.text === "你是谁？")).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("ensureActive 幂等：同 key 返回同一会话 id", async () => {
    const { models } = fauxModels();
    const harness = createPiHarness({ root, sqlitePath: path.join(root, ".openstaffs", "state.sqlite"), models });
    await harness.open();
    try {
      const cwd = path.join(root, "agents", "alice");
      fs.mkdirSync(cwd, { recursive: true });
      const a = await harness.ensureActive("dm:alice", spec(cwd));
      const b = await harness.ensureActive("dm:alice", spec(cwd));
      expect(b).toBe(a);
    } finally {
      await harness.close();
    }
  });

  it("transcript 只含员工/老板发言，不把工具结果当发言", async () => {
    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "note.md", content: "hi" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("完成"),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const harness = createPiHarness({ root, sqlitePath: path.join(root, ".openstaffs", "state.sqlite"), models });
    await harness.open();
    try {
      const cwd = path.join(root, "agents", "alice");
      fs.mkdirSync(cwd, { recursive: true });
      const convId = await harness.ensureActive("dm:alice", spec(cwd));
      await harness.send(convId, "写 note.md");
      const history = await harness.transcript(convId);
      expect(history.some((m) => m.text.includes("Successfully wrote"))).toBe(false);
      expect(history.some((m) => m.role === "user" && m.text === "写 note.md")).toBe(true);
      expect(history.some((m) => m.role === "assistant" && m.text === "完成")).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("连续两次 send：消息不丢不重、按序", async () => {
    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
    faux.setResponses([fauxAssistantMessage("答一"), fauxAssistantMessage("答二")]);
    const models = createModels();
    models.setProvider(faux.provider);
    const harness = createPiHarness({ root, sqlitePath: path.join(root, ".openstaffs", "state.sqlite"), models });
    await harness.open();
    try {
      const cwd = path.join(root, "agents", "alice");
      fs.mkdirSync(cwd, { recursive: true });
      const convId = await harness.ensureActive("dm:alice", spec(cwd));
      await harness.send(convId, "问一");
      await harness.send(convId, "问二");
      const history = await harness.transcript(convId);
      const users = history.filter((m) => m.role === "user").map((m) => m.text);
      const assistants = history.filter((m) => m.role === "assistant").map((m) => m.text);
      expect(users).toEqual(["问一", "问二"]);
      expect(assistants).toEqual(["答一", "答二"]);
    } finally {
      await harness.close();
    }
  });

  it("send 在提交未完成时抛错，而非伪造员工发言", async () => {
    const { models } = fauxModels();
    const harness = createPiHarness({ root, sqlitePath: path.join(root, ".openstaffs", "state.sqlite"), models });
    await harness.open();
    try {
      const cwd = path.join(root, "agents", "nobody");
      fs.mkdirSync(cwd, { recursive: true });
      const empty: ConversationSpec = {
        cwd,
        instructions: "无模型员工。",
        model: { provider: "", modelId: "" },
        access: { root, cwd, selfId: "nobody", memberProjects: [], permissionFiles: [] },
      };
      const convId = await harness.ensureActive("dm:nobody", empty);
      await expect(harness.send(convId, "在吗")).rejects.toThrow();
    } finally {
      await harness.close();
    }
  });
});
