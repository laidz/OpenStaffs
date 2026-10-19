import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { McpManager } from "../../src/harness/mcp-manager.ts";
import { createPiHarness } from "../../src/harness/pi-durable.ts";

const fixture = fileURLToPath(new URL("../fixtures/mcp-server.mjs", import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-mcp-e2e-"));
const output = path.join(root, "echo.txt");

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function writeJson(file: string, body: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
}

function fauxModels() {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("mcp__fixture__echo", { text: "e2e" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  return models;
}

describe("MCP 端到端", () => {
  it("模型能通过会话调用真实 MCP server 的工具", async () => {
    const systemFile = path.join(root, "system-mcp.json");
    writeJson(systemFile, {
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [fixture],
          env: { MCP_TEST_OUTPUT: output },
        },
      },
    });
    const manager = new McpManager({ ws: createWorkspace(root), systemFile, log: () => {} });
    await manager.start();
    expect(manager.errors()).toEqual([]);

    const harness = createPiHarness({
      root,
      sqlitePath: path.join(root, ".openstaffs", "state.sqlite"),
      models: fauxModels(),
      mcpExtensions: manager.extensions(),
      toolSearch: manager.needsToolSearch(),
    });
    await harness.open();
    try {
      const cwd = path.join(root, "agents", "alice");
      fs.mkdirSync(cwd, { recursive: true });
      const convId = await harness.startSession({
        cwd,
        instructions: "你是 alice。",
        model: { provider: "faux", modelId: "faux-model" },
        access: { root, cwd, selfId: "alice", memberProjects: [], permissionFiles: [], writableDirs: [cwd] },
        mcpExtensions: manager.extensionsFor({ kind: "dm", employeeId: "alice" }, "alice"),
      });
      const reply = await harness.send(convId, "调用工具");
      expect(reply.text).toBe("done");
      expect(fs.readFileSync(output, "utf8")).toBe("echo:e2e\n");
    } finally {
      await harness.close();
      await manager.close();
    }
  });
});
