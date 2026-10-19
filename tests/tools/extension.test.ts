import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { seedOffice } from "../helpers/office.ts";
import { PermissionRequestStore } from "../../src/domain/permission-requests.ts";
import { createPiHarness } from "../../src/harness/pi-durable.ts";
import type { ConversationSpec, HarnessPort } from "../../src/harness/port.ts";
import { createOpenStaffsToolsExtension } from "../../src/tools/extension.ts";

type ToolResultLike = { output?: unknown; isError?: boolean };

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-ext-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function fauxModels() {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
  faux.setResponses([fauxAssistantMessage("ok")]);
  const models = createModels();
  models.setProvider(faux.provider);
  return models;
}

describe("OpenStaffs 工具扩展", () => {
  it("暴露 6 个工具，名字唯一", () => {
    const ext = createOpenStaffsToolsExtension({ ws: createWorkspace(root), getHarness: () => ({} as HarnessPort) });
    expect((ext.tools ?? []).map((t) => t.name).sort()).toEqual([
      "member_profile", "new_session", "office_list", "request_permission", "room_history", "send_message",
    ]);
  });

  it("execute 经 sessionInfo 解析身份/关系；未注册会话 → isError", async () => {
    seedOffice(root, { agents: [{ id: "alice", model: "faux/faux-model", prompt: "你是 alice。" }] });
    const dir = path.join(root, "work", "alice");
    fs.mkdirSync(dir, { recursive: true });

    const ws = createWorkspace(root);
    let harness: ReturnType<typeof createPiHarness>;
    const ext = createOpenStaffsToolsExtension({ ws, getHarness: () => harness });
    harness = createPiHarness({ root, sqlitePath: path.join(root, ".openstaffs", "state.sqlite"), models: fauxModels(), extensions: [ext] });
    await harness.open();
    try {
      const spec: ConversationSpec = {
        cwd: dir,
        instructions: "你是 alice。",
        model: { provider: "faux", modelId: "faux-model" },
        access: { root, cwd: dir, selfId: "alice", permissions: {} },
      };
      const convId = await harness.startSession(spec);
      const officeList = (ext.tools ?? []).find((t) => t.name === "office_list")!;
      const ok = (await officeList.execute({}, { conversationId: convId } as never, {} as never)) as ToolResultLike;
      expect(ok.isError).toBeFalsy();
      expect(JSON.stringify(ok.output)).toContain("alice");

      const missing = (await officeList.execute({}, { conversationId: "conv:不存在" } as never, {} as never)) as ToolResultLike;
      expect(missing.isError).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("注入 permissions 后 request_permission 可用：落库一条请求、无错误", async () => {
    seedOffice(root, { agents: [{ id: "alice", model: "faux/faux-model", prompt: "你是 alice。" }] });
    const dir = path.join(root, "work", "alice");
    fs.mkdirSync(dir, { recursive: true });

    const ws = createWorkspace(root);
    const store = new PermissionRequestStore(ws);
    let harness: ReturnType<typeof createPiHarness>;
    const ext = createOpenStaffsToolsExtension({
      ws,
      getHarness: () => harness,
      permissions: { store, notify: () => {} },
    });
    harness = createPiHarness({ root, sqlitePath: path.join(root, ".openstaffs", "state.sqlite"), models: fauxModels(), extensions: [ext] });
    await harness.open();
    try {
      const spec: ConversationSpec = {
        cwd: dir,
        instructions: "你是 alice。",
        model: { provider: "faux", modelId: "faux-model" },
        access: { root, cwd: dir, selfId: "alice", permissions: {} },
      };
      const convId = await harness.startSession(spec);
      const tool = (ext.tools ?? []).find((t) => t.name === "request_permission")!;
      const result = (await tool.execute({ paths: ["x.md"], reason: "r" }, { conversationId: convId } as never, {} as never)) as ToolResultLike;
      expect(result.isError).toBeFalsy();
      expect(store.list()).toHaveLength(1);
      expect(store.list()[0]).toMatchObject({ agentId: "alice", roomKey: "dm:alice", reason: "r" });
    } finally {
      await harness.close();
    }
  });
});
