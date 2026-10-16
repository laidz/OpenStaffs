import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { afterEach, describe, expect, it } from "vitest";
import { createPiHarness } from "../../src/harness/pi-durable.ts";
import type { ConversationSpec } from "../../src/harness/port.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-hook-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const aliceCwd = path.join(root, "agents", "alice");

function spec(): ConversationSpec {
  return {
    cwd: aliceCwd,
    instructions: "你是 alice。",
    model: { provider: "faux", modelId: "faux-model" },
    access: { root, cwd: aliceCwd, selfId: "alice", memberProjects: [] },
  };
}

describe("访问控制钩子", () => {
  it("界内 write 生效，界外 write 被拦", async () => {
    fs.mkdirSync(aliceCwd, { recursive: true });
    fs.mkdirSync(path.join(root, "agents", "bob"), { recursive: true });
    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "note.md", content: "hi" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("write", { path: "agents/bob/evil.md", content: "pwn" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
      fauxAssistantMessage("done"),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const harness = createPiHarness({ root, sqlitePath: path.join(root, ".openstaffs", "state.sqlite"), models });
    await harness.open();
    try {
      const convId = await harness.ensureActive("dm:alice", spec());
      await harness.send(convId, "先在界内写 note.md，再写到 agents/bob/evil.md");
      await harness.send(convId, "继续");
    } finally {
      await harness.close();
    }
    expect(fs.existsSync(path.join(aliceCwd, "note.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, "agents", "bob", "evil.md"))).toBe(false);
    // 恶意写若未被拦，会落到 alice 的 cwd 下（agents/alice/agents/bob/evil.md）；
    // 钩子把它当工作区根相对的 agents/ 路径拒绝，故任何位置都不应出现。
    expect(fs.existsSync(path.join(aliceCwd, "agents", "bob", "evil.md"))).toBe(false);
  });
});
