import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { readChain } from "../../src/domain/conversation-chain.ts";
import { createPiHarness } from "../../src/harness/pi-durable.ts";
import {
  activeMemberSessions, findSessionOwner, instructionsFor, interruptRoom, newSession, openDm, openGroup,
  permissionFilesFor, relationKey, roomTranscripts, sessionChains, skillDirsFor, type SessionDefaults,
} from "../../src/app/conversations.ts";
import { loadEmployee } from "../../src/domain/employee.ts";
import { FRAMEWORK_SKILLS_DIR } from "../../src/domain/skills.ts";
import type { HarnessPort } from "../../src/harness/port.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-app-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function seedEmployee(id: string) {
  const dir = path.join(root, "agents", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "AGENTS.md"), `你是 ${id}。`);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ model: "faux/faux-model" }));
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
      expect(relationKey({ kind: "group", project: "yt" }, "bob")).toBe("group:yt:bob");
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

  it("技能目录：群聊 = 项目 + 员工 + 框架内置；私聊 = 员工 + 框架内置（越窄越优先）", () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const speaker = loadEmployee(ws, "alice");
    expect(skillDirsFor(ws, { kind: "dm", employeeId: "alice" }, speaker)).toEqual([
      path.join(root, "agents", "alice", "skills"),
      FRAMEWORK_SKILLS_DIR,
    ]);
    expect(skillDirsFor(ws, { kind: "group", project: "yt" }, speaker)).toEqual([
      path.join(root, "projects", "yt", "skills"),
      path.join(root, "agents", "alice", "skills"),
      FRAMEWORK_SKILLS_DIR,
    ]);
  });

  it("内置基础技能随默认会话注入：列出 openstaffs 系列技能并给出 SKILL.md 位置", () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const speaker = loadEmployee(ws, "alice");
    const dm = instructionsFor(ws, { kind: "dm", employeeId: "alice" }, speaker);
    expect(dm).toContain("openstaffs");
    expect(dm).toContain(path.join("src", "skills", "openstaffs", "SKILL.md"));
    expect(dm).toContain(path.join("src", "skills", "openstaffs-ops", "SKILL.md"));
  });

  it("instructions 注入技能（名称 + 描述 + 位置；群技能在前）", () => {
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

  it("快照清单：根 AGENTS.md 与项目 AGENTS.md 按序注入（群聊），私聊只注入根 + 员工", () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    fs.writeFileSync(path.join(root, "AGENTS.md"), "公司总纲：不得违法。");
    fs.mkdirSync(path.join(root, "projects", "yt"), { recursive: true });
    fs.writeFileSync(path.join(root, "projects", "yt", "AGENTS.md"), "任务：做 yt 视频。");
    const speaker = loadEmployee(ws, "alice");

    const group = instructionsFor(ws, { kind: "group", project: "yt" }, speaker);
    expect(group).toContain("公司总纲：不得违法。");
    expect(group).toContain("任务：做 yt 视频。");
    expect(group.indexOf("公司总纲")).toBeLessThan(group.indexOf("任务：做 yt 视频。"));
    expect(group.indexOf("任务：做 yt 视频。")).toBeLessThan(group.indexOf("你是 alice。"));

    const dm = instructionsFor(ws, { kind: "dm", employeeId: "alice" }, speaker);
    expect(dm).toContain("公司总纲：不得违法。");
    expect(dm).not.toContain("任务：做 yt 视频。");
  });

  it("instructionsFor：框架环境段在最前；群聊再带项目与成员；私聊不带项目", () => {
    seedEmployee("alice");
    seedEmployee("bob");
    const ws = createWorkspace(root);
    fs.writeFileSync(path.join(root, "AGENTS.md"), "公司总纲：不得违法。");
    fs.mkdirSync(path.join(root, "projects", "yt"), { recursive: true });
    fs.writeFileSync(path.join(root, "projects", "yt", "members.md"), "- alice\n- bob\n");
    fs.writeFileSync(path.join(root, "projects", "yt", "project.json"), JSON.stringify({ alias: "演示项目" }));
    const speaker = loadEmployee(ws, "alice");

    const group = instructionsFor(ws, { kind: "group", project: "yt" }, speaker);
    expect(group).toContain("OpenStaffs");
    expect(group).toContain("老板");
    expect(group).toContain("演示项目");
    expect(group).toContain("bob");
    expect(group.indexOf("OpenStaffs")).toBeLessThan(group.indexOf("公司总纲"));

    const dm = instructionsFor(ws, { kind: "dm", employeeId: "alice" }, speaker);
    expect(dm).toContain("OpenStaffs");
    expect(dm).not.toContain("演示项目");
  });

  it("instructionsFor：办公目录覆盖的环境模板生效且置顶", () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const override = path.join(root, ".openstaffs", "prompts", "dm.md");
    fs.mkdirSync(path.dirname(override), { recursive: true });
    fs.writeFileSync(override, "自定义环境段：{{agent_id}}");
    const speaker = loadEmployee(ws, "alice");
    const dm = instructionsFor(ws, { kind: "dm", employeeId: "alice" }, speaker);
    expect(dm.startsWith("自定义环境段：alice")).toBe(true);
    expect(dm).toContain("你是 alice。");
  });

  it("员工未配模型时用 defaults 兜底可对话；无 defaults 则失败（不静默）", async () => {
    const dir = path.join(root, "agents", "carol");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "你是 carol。");
    const ws = createWorkspace(root);
    const harness = harnessWithFaux();
    await harness.open();
    try {
      const defaults: SessionDefaults = { model: "faux/faux-model" };
      const convId = await openDm(ws, harness, "carol", defaults);
      const reply = await harness.send(convId, "在吗");
      expect(reply.text).toBe("ok");
    } finally {
      await harness.close();
    }
  });

  it("会话链辅助：sessionChains / activeMemberSessions / findSessionOwner", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    const ws = createWorkspace(root);
    fs.mkdirSync(path.join(root, "projects", "yt"), { recursive: true });
    fs.writeFileSync(path.join(root, "projects", "yt", "members.md"), "# 成员\n- alice\n- bob\n");
    const harness = harnessWithFaux();
    await harness.open();
    try {
      const a1 = await openGroup(ws, harness, "yt", "alice");
      const chains = sessionChains(ws, { kind: "group", project: "yt" });
      expect(chains.map((c) => c.memberId)).toEqual(["alice", "bob"]);
      expect(chains[0]!.rows).toHaveLength(1);

      const active = activeMemberSessions(ws, { kind: "group", project: "yt" });
      expect(active).toEqual([{ memberId: "alice", convId: a1 }]);
      expect(findSessionOwner(ws, { kind: "group", project: "yt" }, a1)).toBe("alice");
      expect(findSessionOwner(ws, { kind: "group", project: "yt" }, "conv:不存在")).toBeUndefined();

      const transcripts = await roomTranscripts(ws, harness, { kind: "group", project: "yt" });
      expect(transcripts).toHaveLength(1);
      expect(transcripts[0]!.memberId).toBe("alice");
    } finally {
      await harness.close();
    }
  });

  it("interruptRoom：逐个中止各成员活跃会话；坏会话跳过不连坐", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    seedEmployee("carol");
    const ws = createWorkspace(root);
    fs.mkdirSync(path.join(root, "projects", "yt"), { recursive: true });
    fs.writeFileSync(path.join(root, "projects", "yt", "members.md"), "# 成员\n- alice\n- bob\n- carol\n");
    const harness = harnessWithFaux();
    await harness.open();
    try {
      const a = await openGroup(ws, harness, "yt", "alice");
      const b = await openGroup(ws, harness, "yt", "bob");
      // carol 的链写坏：活跃行指向不存在的会话
      const carolFile = path.join(root, "projects", "yt", "conversation_ids", "carol.md");
      fs.mkdirSync(path.dirname(carolFile), { recursive: true });
      fs.writeFileSync(
        carolFile,
        ["# 会话链", "", "| id | started | ended | previous |", "|----|---------|-------|----------|", "| conv:不存在 | 2026-10-16T00:00:00Z |  | - |", ""].join("\n"),
      );

      const result = await interruptRoom(ws, harness, { kind: "group", project: "yt" });
      expect(result.aborted.sort()).toEqual([a, b].sort());
    } finally {
      await harness.close();
    }
  });

  it("roomTranscripts：链指向不存在的 convId 时跳过该成员（不让整房间的合并视图/红点 500）", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    const ws = createWorkspace(root);
    fs.mkdirSync(path.join(root, "projects", "yt"), { recursive: true });
    fs.writeFileSync(path.join(root, "projects", "yt", "members.md"), "# 成员\n- alice\n- bob\n");
    const harness = harnessWithFaux();
    await harness.open();
    try {
      const aliceConv = await openGroup(ws, harness, "yt", "alice");
      // bob 的链被人为写坏：活跃行指向一个不存在的会话
      const bobFile = path.join(root, "projects", "yt", "conversation_ids", "bob.md");
      fs.mkdirSync(path.dirname(bobFile), { recursive: true });
      fs.writeFileSync(
        bobFile,
        ["# 会话链", "", "| id | started | ended | previous |", "|----|---------|-------|----------|", "| conv:不存在 | 2026-10-16T00:00:00Z |  | - |", ""].join("\n"),
      );

      const transcripts = await roomTranscripts(ws, harness, { kind: "group", project: "yt" });
      expect(transcripts.map((t) => t.memberId)).toEqual(["alice"]);
      expect(transcripts[0]!.convId).toBe(aliceConv);

      // 控制组：坏会话确实让 harness.transcript 抛错（跳过是必要的，而非恒真断言）
      await expect(harness.transcript("conv:不存在")).rejects.toThrow();
    } finally {
      await harness.close();
    }
  });

  it("会话快照：会话中改档案文件不生效；新开会话后生效", async () => {
    const dir = path.join(root, "agents", "dave");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "你是 dave。");
    fs.writeFileSync(path.join(dir, "profile.md"), "档案版本一。");
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ model: "faux/faux-model" }));

    const systems: string[] = [];
    const recordSystem = (messages: readonly { role: string; content: unknown }[]): void => {
      systems.push(
        messages
          .filter((m) => m.role === "system")
          .map((m) => JSON.stringify(m))
          .join("\n"),
      );
    };

    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
    faux.setResponses([
      (context) => {
        recordSystem(context.messages);
        return fauxAssistantMessage("ok");
      },
      (context) => {
        recordSystem(context.messages);
        return fauxAssistantMessage("ok");
      },
      (context) => {
        recordSystem(context.messages);
        return fauxAssistantMessage("ok");
      },
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const harness = createPiHarness({ root, sqlitePath: path.join(root, ".openstaffs", "state-snapshot.sqlite"), models });
    await harness.open();
    try {
      const ws = createWorkspace(root);
      const first = await openDm(ws, harness, "dave");
      await harness.send(first, "在吗");
      fs.writeFileSync(path.join(dir, "profile.md"), "档案版本二。");
      const again = await openDm(ws, harness, "dave");
      expect(again).toBe(first); // attach 复用旧会话，不重配置
      await harness.send(again, "还在吗");
      const fresh = await newSession(ws, harness, { kind: "dm", employeeId: "dave" }, "dave");
      expect(fresh).not.toBe(first);
      await harness.send(fresh, "新会话");

      expect(systems).toHaveLength(3);
      expect(systems[0]).toContain("档案版本一。");
      expect(systems[1]).toContain("档案版本一。"); // 会话进行中：文件变更不生效
      expect(systems[2]).toContain("档案版本二。"); // 新开会话：读到新档案
    } finally {
      await harness.close();
    }
  });

  it("固化跨重启仍生效：重启后 attach 复读同一会话，instructions 仍在 system", async () => {
    const dir = path.join(root, "agents", "dave");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "你是 dave。");
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ model: "faux/faux-model" }));
    const sqlitePath = path.join(root, ".openstaffs", "state-restart.sqlite");
    const ws = createWorkspace(root);

    const openingFaux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
    openingFaux.setResponses([fauxAssistantMessage("ok"), fauxAssistantMessage("ok")]);
    const openingModels = createModels();
    openingModels.setProvider(openingFaux.provider);
    const first = createPiHarness({ root, sqlitePath, models: openingModels });
    await first.open();
    const convId = await openDm(ws, first, "dave");
    await first.close();
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "你是 dave（改）。"); // 重启后改档案：attach 不得重渲染，快照应仍为旧指令

    let seenSystem = "";
    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
    faux.setResponses([
      (context) => {
        seenSystem = context.messages
          .filter((m) => m.role === "system")
          .map((m) => JSON.stringify(m))
          .join("\n");
        return fauxAssistantMessage("ok");
      },
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const reopened = createPiHarness({ root, sqlitePath, models });
    await reopened.open();
    try {
      const again = await openDm(ws, reopened, "dave");
      expect(again).toBe(convId);
      await reopened.send(again, "还在吗");
      expect(seenSystem).toContain("你是 dave。");
    } finally {
      await reopened.close();
    }
  });
});
