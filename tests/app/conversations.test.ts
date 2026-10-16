import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { readChain } from "../../src/domain/conversation-chain.ts";
import { createPiHarness } from "../../src/harness/pi-durable.ts";
import { instructionsFor, newSession, openDm, openGroup, permissionFilesFor, relationKey, skillDirsFor } from "../../src/app/conversations.ts";
import { loadEmployee } from "../../src/domain/employee.ts";
import type { HarnessPort } from "../../src/harness/port.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-app-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function seedEmployee(id: string) {
  const dir = path.join(root, "agents", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "AGENTS.md"), `你是 ${id}。`);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ provider: "faux", modelId: "faux-model" }));
}

function harnessWithFaux() {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
  faux.setResponses([fauxAssistantMessage("ok"), fauxAssistantMessage("ok")]);
  const models = createModels();
  models.setProvider(faux.provider);
  return createPiHarness({ root, sqlitePath: path.join(root, ".openstaffs", "state.sqlite"), models });
}

describe("应用用例", () => {
  it("开私聊：建立会话并在员工目录落 conversation_ids.md", async () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const harness = harnessWithFaux();
    await harness.open();
    try {
      const convId = await openDm(ws, harness, "alice");
      const chain = readChain(path.join(root, "agents", "alice", "conversation_ids.md"));
      expect(chain).toHaveLength(1);
      expect(chain[0]!.id).toBe(convId);
    } finally {
      await harness.close();
    }
  });

  it("新开会话：追加一条并结束上一条", async () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const harness = harnessWithFaux();
    await harness.open();
    try {
      const first = await openDm(ws, harness, "alice");
      const second = await newSession(ws, harness, { kind: "dm", employeeId: "alice" }, "alice");
      expect(second).not.toBe(first);
      const chain = readChain(path.join(root, "agents", "alice", "conversation_ids.md"));
      expect(chain).toHaveLength(2);
      expect(chain[0]!.ended).not.toBeNull();
      expect(chain[1]!.previous).toBe(first);
      expect(relationKey({ kind: "dm", employeeId: "alice" }, "alice")).toBe("dm:alice");
    } finally {
      await harness.close();
    }
  });

  it("重开 harness（模拟重启）后 openDm 复用链条里的活跃会话，不新建、不改链", async () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const first = harnessWithFaux();
    await first.open();
    const convId = await openDm(ws, first, "alice");
    await first.close();

    const reopened = harnessWithFaux();
    await reopened.open();
    try {
      const again = await openDm(ws, reopened, "alice");
      expect(again).toBe(convId);
      const chain = readChain(path.join(root, "agents", "alice", "conversation_ids.md"));
      expect(chain).toHaveLength(1);
    } finally {
      await reopened.close();
    }
  });

  it("私聊只挂员工 permission.json", () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const speaker = loadEmployee(ws, "alice");
    expect(permissionFilesFor(ws, { kind: "dm", employeeId: "alice" }, speaker)).toEqual([
      path.join(root, "agents", "alice", "permission.json"),
    ]);
  });

  it("群聊挂项目 + 员工 permission.json（项目在前）", () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const speaker = loadEmployee(ws, "alice");
    expect(permissionFilesFor(ws, { kind: "group", project: "yt" }, speaker)).toEqual([
      path.join(root, "projects", "yt", "permission.json"),
      path.join(root, "agents", "alice", "permission.json"),
    ]);
  });

  it("私聊发言人与关系不一致时报错（不静默挂错权限文件）", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    const ws = createWorkspace(root);
    const stub = {} as HarnessPort;
    await expect(
      newSession(ws, stub, { kind: "dm", employeeId: "alice" }, "bob"),
    ).rejects.toThrow("不一致");
  });

  it("群聊：每成员一条会话、按需创建、各记各的链", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    const ws = createWorkspace(root);
    const harness = harnessWithFaux();
    await harness.open();
    try {
      const aliceConv = await openGroup(ws, harness, "yt", "alice");
      const aliceFile = path.join(root, "projects", "yt", "conversation_ids", "alice.md");
      const bobFile = path.join(root, "projects", "yt", "conversation_ids", "bob.md");
      expect(fs.existsSync(aliceFile)).toBe(true);
      expect(fs.existsSync(bobFile)).toBe(false);

      const bobConv = await openGroup(ws, harness, "yt", "bob");
      expect(bobConv).not.toBe(aliceConv);
      expect(await openGroup(ws, harness, "yt", "alice")).toBe(aliceConv);

      expect(readChain(aliceFile)).toHaveLength(1);
      expect(readChain(bobFile)).toHaveLength(1);
      expect(readChain(aliceFile)[0]!.id).toBe(aliceConv);
      expect(readChain(bobFile)[0]!.id).toBe(bobConv);
    } finally {
      await harness.close();
    }
  });

  it("群聊新开会话只影响该成员", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    const ws = createWorkspace(root);
    const harness = harnessWithFaux();
    await harness.open();
    try {
      const a1 = await openGroup(ws, harness, "yt", "alice");
      const b1 = await openGroup(ws, harness, "yt", "bob");
      const a2 = await newSession(ws, harness, { kind: "group", project: "yt" }, "alice");
      expect(a2).not.toBe(a1);
      const aliceFile = path.join(root, "projects", "yt", "conversation_ids", "alice.md");
      const bobFile = path.join(root, "projects", "yt", "conversation_ids", "bob.md");
      expect(readChain(aliceFile)).toHaveLength(2);
      expect(readChain(aliceFile)[0]!.ended).not.toBeNull();
      expect(readChain(aliceFile)[1]!.previous).toBe(a1);
      expect(readChain(bobFile)).toHaveLength(1);
      expect(readChain(bobFile)[0]!.id).toBe(b1);
    } finally {
      await harness.close();
    }
  });

  it("技能目录：私聊只有员工 skills；群聊 = 项目 skills + 员工 skills", () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const speaker = loadEmployee(ws, "alice");
    expect(skillDirsFor(ws, { kind: "dm", employeeId: "alice" }, speaker)).toEqual([
      path.join(root, "agents", "alice", "skills"),
    ]);
    expect(skillDirsFor(ws, { kind: "group", project: "yt" }, speaker)).toEqual([
      path.join(root, "projects", "yt", "skills"),
      path.join(root, "agents", "alice", "skills"),
    ]);
  });

  it("instructions 注入技能（只给 name+description；群技能在前）", () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const groupSkill = path.join(root, "projects", "yt", "skills", "g", "SKILL.md");
    fs.mkdirSync(path.dirname(groupSkill), { recursive: true });
    fs.writeFileSync(groupSkill, "---\nname: 群技能\ndescription: 来自项目\n---\n");
    const agentSkill = path.join(root, "agents", "alice", "skills", "a", "SKILL.md");
    fs.mkdirSync(path.dirname(agentSkill), { recursive: true });
    fs.writeFileSync(agentSkill, "---\nname: 员工技能\ndescription: 来自员工\n---\n");
    const speaker = loadEmployee(ws, "alice");
    const text = instructionsFor(ws, { kind: "group", project: "yt" }, speaker);
    expect(text).toContain("你是 alice。");
    expect(text).toContain("- 群技能：来自项目");
    expect(text).toContain("- 员工技能：来自员工");
    expect(text.indexOf("群技能")).toBeLessThan(text.indexOf("员工技能"));
  });
});
