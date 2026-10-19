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
  accessFor, activeMemberSessions, findSessionOwner, instructionsFor, interruptRoom, newSession, openDm, openGroup,
  permissionFilesFor, relationKey, roomSessionInfo, roomTranscripts, sessionChains, sessionDefaults, skillDirsFor,
  type SessionDefaults,
} from "../../src/app/conversations.ts";
import { loadPerson } from "../../src/domain/org.ts";
import { readSkillPaths } from "../../src/domain/config.ts";
import { FRAMEWORK_SKILLS_DIR } from "../../src/domain/skills.ts";
import type { ConversationSpec, HarnessPort } from "../../src/harness/port.ts";
import type { Relation } from "../../src/domain/types.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-app-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** 夹具：人 = 单文件（放在 agents/ 根或部门目录）。 */
function seedEmployee(id: string, alias?: string, department?: string): void {
  const dir = department === undefined ? path.join(root, "agents") : path.join(root, "agents", department);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.agent.config.json`),
    JSON.stringify({ model: "faux/faux-model", prompt: `你是 ${id}。`, ...(alias === undefined ? {} : { alias }) }),
  );
}

function harnessWithFaux() {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model", reasoning: true }] });
  faux.setResponses([fauxAssistantMessage("ok"), fauxAssistantMessage("ok")]);
  const models = createModels();
  models.setProvider(faux.provider);
  return createPiHarness({ root, sqlitePath: path.join(root, ".openstaffs", "state.sqlite"), models });
}

describe("应用用例", () => {
  it("开私聊：会话 cwd = work/<id>/（目录自动创建），会话链落 work/<id>/conversation_ids.md", async () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const harness = harnessWithFaux();
    await harness.open();
    try {
      const convId = await openDm(ws, harness, "alice");
      expect(fs.existsSync(path.join(root, "work", "alice"))).toBe(true);
      const chain = readChain(path.join(root, "work", "alice", "conversation_ids.md"));
      expect(chain.map((r) => r.id)).toEqual([convId]);
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
      const chain = readChain(path.join(root, "work", "alice", "conversation_ids.md"));
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
      const chain = readChain(path.join(root, "work", "alice", "conversation_ids.md"));
      expect(chain).toHaveLength(1);
    } finally {
      await reopened.close();
    }
  });

  it("私聊只挂人级 permission.json；群聊项目在前", () => {
    seedEmployee("alice", undefined, "eng");
    const ws = createWorkspace(root);
    const speaker = loadPerson(ws, "alice");
    expect(permissionFilesFor(ws, { kind: "dm", employeeId: "alice" }, speaker)).toEqual([
      path.join(root, "agents", "eng", "alice.permission.json"),
    ]);
    expect(permissionFilesFor(ws, { kind: "group", project: "yt" }, speaker)).toEqual([
      path.join(root, "projects", "yt", "permission.json"),
      path.join(root, "agents", "eng", "alice.permission.json"),
    ]);
  });

  it("access：writableDirs = 自己的工作目录 + 主管管理的部门目录（穿透）", () => {
    seedEmployee("alice", undefined, "eng");
    seedEmployee("bob", undefined, "eng/platform");
    fs.writeFileSync(path.join(root, "agents", "eng", "department.config.json"), JSON.stringify({ head: ["alice"] }));
    const ws = createWorkspace(root);
    const access = accessFor(ws, { kind: "dm", employeeId: "alice" }, loadPerson(ws, "alice"));
    expect(access.writableDirs).toEqual([path.join(root, "work", "alice"), path.join(root, "agents", "eng")]);
    expect(access.writableDirs).not.toContain(path.join(root, "agents", "eng", "platform")); // 子树覆盖由前缀判定，不展开
    expect(accessFor(ws, { kind: "dm", employeeId: "bob" }, loadPerson(ws, "bob")).writableDirs).toEqual([
      path.join(root, "work", "bob"),
    ]);
  });

  it("人级 instructions 用 prompt（不再读 profile.md / MEMORY.md）", () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const out = instructionsFor(ws, { kind: "dm", employeeId: "alice" }, loadPerson(ws, "alice"));
    expect(out).toContain("你是 alice。");
  });

  it("技能目录不再含员工技能目录（项目 → 空间 → 外部 → 系统内置）", () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const speaker = loadPerson(ws, "alice");
    expect(skillDirsFor(ws, { kind: "dm", employeeId: "alice" }, speaker)).toEqual([
      path.join(root, "openstaffs", "skills"), FRAMEWORK_SKILLS_DIR,
    ]);
    expect(skillDirsFor(ws, { kind: "group", project: "yt" }, speaker)).toEqual([
      path.join(root, "projects", "yt", "skills"), path.join(root, "openstaffs", "skills"), FRAMEWORK_SKILLS_DIR,
    ]);
    // 外部 skillPaths 在空间之后、系统内置之前
    const external = ["/ext/one", "/ext/two"];
    expect(skillDirsFor(ws, { kind: "dm", employeeId: "alice" }, speaker, external)).toEqual([
      path.join(root, "openstaffs", "skills"), ...external, FRAMEWORK_SKILLS_DIR,
    ]);
    expect(skillDirsFor(ws, { kind: "group", project: "yt" }, speaker, external)).toEqual([
      path.join(root, "projects", "yt", "skills"), path.join(root, "openstaffs", "skills"), ...external, FRAMEWORK_SKILLS_DIR,
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

  it("空间级技能随会话注入（私聊与群聊都注入），且同名时窄者（项目）胜", () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const spaceSkill = path.join(root, "openstaffs", "skills", "s", "SKILL.md");
    fs.mkdirSync(path.dirname(spaceSkill), { recursive: true });
    fs.writeFileSync(spaceSkill, "---\nname: 撞名技能\ndescription: 来自空间\n---\n");
    const groupSkill = path.join(root, "projects", "yt", "skills", "a", "SKILL.md");
    fs.mkdirSync(path.dirname(groupSkill), { recursive: true });
    fs.writeFileSync(groupSkill, "---\nname: 撞名技能\ndescription: 来自项目\n---\n");
    const spaceOnlySkill = path.join(root, "openstaffs", "skills", "space-only", "SKILL.md");
    fs.mkdirSync(path.dirname(spaceOnlySkill), { recursive: true });
    fs.writeFileSync(spaceOnlySkill, "---\nname: 空间独有\ndescription: 只在空间有\n---\n");
    const speaker = loadPerson(ws, "alice");

    const dm = instructionsFor(ws, { kind: "dm", employeeId: "alice" }, speaker);
    expect(dm).toContain("- 撞名技能：来自空间"); // 私聊无项目目录 → 只能读到空间技能
    expect(dm).toContain("- 空间独有：只在空间有"); // 空间独有的技能未被漏掉

    const group = instructionsFor(ws, { kind: "group", project: "yt" }, speaker);
    expect(group).toContain("- 撞名技能：来自项目"); // 项目（窄）胜空间（宽）
    expect(group).not.toContain("来自空间");
    expect(group).toContain("- 空间独有：只在空间有");
  });

  it("外部 skillPaths 的技能随会话注入（所有会话），来源在空间之后", () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const extDir = path.join(root, "ext-skills");
    const extSkill = path.join(extDir, "x", "SKILL.md");
    fs.mkdirSync(path.dirname(extSkill), { recursive: true });
    fs.writeFileSync(extSkill, "---\nname: 外部技能\ndescription: 来自外部库\n---\n");
    const spaceCollide = path.join(root, "openstaffs", "skills", "collide", "SKILL.md");
    fs.mkdirSync(path.dirname(spaceCollide), { recursive: true });
    fs.writeFileSync(spaceCollide, "---\nname: 撞名\ndescription: 来自空间撞名\n---\n");
    const extCollide = path.join(extDir, "collide", "SKILL.md");
    fs.mkdirSync(path.dirname(extCollide), { recursive: true });
    fs.writeFileSync(extCollide, "---\nname: 撞名\ndescription: 来自外部撞名\n---\n");
    fs.mkdirSync(path.join(root, ".openstaffs"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".openstaffs", "config.json"),
      JSON.stringify({ skillPaths: ["ext-skills"] }), // 相对办公空间根
    );
    const speaker = loadPerson(ws, "alice");

    const dm = instructionsFor(ws, { kind: "dm", employeeId: "alice" }, speaker, readSkillPaths(ws));
    expect(dm).toContain("- 外部技能：来自外部库");
    expect(dm).toContain("- 撞名：来自空间撞名"); // 空间目录在链中先于外部目录
    expect(dm).not.toContain("来自外部撞名");
  });

  it("内置基础技能随默认会话注入：列出 openstaffs 系列技能并给出 SKILL.md 位置", () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const speaker = loadPerson(ws, "alice");
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
    const spaceSkill = path.join(root, "openstaffs", "skills", "s", "SKILL.md");
    fs.mkdirSync(path.dirname(spaceSkill), { recursive: true });
    fs.writeFileSync(spaceSkill, "---\nname: 空间技能\ndescription: 来自空间\n---\n");
    const speaker = loadPerson(ws, "alice");
    const text = instructionsFor(ws, { kind: "group", project: "yt" }, speaker);
    expect(text).toContain("你是 alice。");
    expect(text).toContain("- 群技能：来自项目");
    expect(text).toContain("- 空间技能：来自空间");
    expect(text.indexOf("群技能")).toBeLessThan(text.indexOf("空间技能"));
  });

  it("快照清单：根 AGENTS.md 与项目 AGENTS.md 按序注入（群聊），私聊只注入根 + 人级 prompt", () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    fs.writeFileSync(path.join(root, "AGENTS.md"), "公司总纲：不得违法。");
    fs.mkdirSync(path.join(root, "projects", "yt"), { recursive: true });
    fs.writeFileSync(path.join(root, "projects", "yt", "AGENTS.md"), "任务：做 yt 视频。");
    const speaker = loadPerson(ws, "alice");

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
    const speaker = loadPerson(ws, "alice");

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

  it("人未配模型时用 defaults 兜底可对话；无 defaults 则失败（不静默）", async () => {
    fs.mkdirSync(path.join(root, "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "agents", "carol.agent.config.json"),
      JSON.stringify({ prompt: "你是 carol。" }),
    );
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

  it("会话快照：会话中改 prompt 不生效；新开会话后生效", async () => {
    fs.mkdirSync(path.join(root, "agents"), { recursive: true });
    const daveFile = path.join(root, "agents", "dave.agent.config.json");
    fs.writeFileSync(daveFile, JSON.stringify({ model: "faux/faux-model", prompt: "档案版本一。" }));
    const spaceSkill = path.join(root, "openstaffs", "skills", "space-e2e", "SKILL.md");
    fs.mkdirSync(path.dirname(spaceSkill), { recursive: true });
    fs.writeFileSync(spaceSkill, "---\nname: 端到端空间技能\ndescription: 来自空间-e2e\n---\n");

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
      fs.writeFileSync(daveFile, JSON.stringify({ model: "faux/faux-model", prompt: "档案版本二。" }));
      const again = await openDm(ws, harness, "dave");
      expect(again).toBe(first); // attach 复用旧会话，不重配置
      await harness.send(again, "还在吗");
      const fresh = await newSession(ws, harness, { kind: "dm", employeeId: "dave" }, "dave");
      expect(fresh).not.toBe(first);
      await harness.send(fresh, "新会话");

      expect(systems).toHaveLength(3);
      expect(systems[0]).toContain("档案版本一。");
      expect(systems[0]).toContain("端到端空间技能"); // 真实会话创建路径（specFor）把空间级技能塞进了 instructions
      expect(systems[1]).toContain("档案版本一。"); // 会话进行中：文件变更不生效
      expect(systems[2]).toContain("档案版本二。"); // 新开会话：读到新 prompt
    } finally {
      await harness.close();
    }
  });

  it("固化跨重启仍生效：重启后 attach 复读同一会话，instructions 仍在 system", async () => {
    fs.mkdirSync(path.join(root, "agents"), { recursive: true });
    const daveFile = path.join(root, "agents", "dave.agent.config.json");
    fs.writeFileSync(daveFile, JSON.stringify({ model: "faux/faux-model", prompt: "你是 dave。" }));
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
    fs.writeFileSync(daveFile, JSON.stringify({ model: "faux/faux-model", prompt: "你是 dave（改）。" })); // 重启后改 prompt：attach 不得重渲染，快照应仍为旧指令

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

  it("思考强度装配：人 > 会话默认；非法档原样保留；未配置则不写进 spec", async () => {
    seedEmployee("alice");
    const aliceFile = path.join(root, "agents", "alice.agent.config.json");
    fs.writeFileSync(
      aliceFile,
      JSON.stringify({ model: "faux/faux-model", thinkingLevel: "high" }),
    );
    seedEmployee("bob");
    seedEmployee("carol");
    const carolFile = path.join(root, "agents", "carol.agent.config.json");
    fs.writeFileSync(
      carolFile,
      JSON.stringify({ model: "faux/faux-model", thinkingLevel: "banana" }),
    );
    const ws = createWorkspace(root);
    const specs: ConversationSpec[] = [];
    const stub = {
      startSession: async (spec: ConversationSpec) => {
        specs.push(spec);
        return `conv_${specs.length}`;
      },
      attach: async () => false,
    } as unknown as HarnessPort;

    const defaults: SessionDefaults = { model: "faux/faux-model", thinkingLevel: "low" };
    await newSession(ws, stub, { kind: "dm", employeeId: "alice" }, "alice", defaults);
    await newSession(ws, stub, { kind: "dm", employeeId: "bob" }, "bob", defaults);
    await newSession(ws, stub, { kind: "dm", employeeId: "carol" }, "carol", defaults);
    await newSession(ws, stub, { kind: "dm", employeeId: "bob" }, "bob", { model: "faux/faux-model" });
    // model 非法不影响 thinkingLevel（两者独立解析）
    fs.writeFileSync(
      aliceFile,
      JSON.stringify({ model: "invalid", thinkingLevel: "high" }),
    );
    await newSession(ws, stub, { kind: "dm", employeeId: "alice" }, "alice", { model: "faux/faux-model", thinkingLevel: "low" });

    expect(specs[0]?.thinkingLevel).toBe("high"); // 人覆盖全局
    expect(specs[1]?.thinkingLevel).toBe("low"); // 人没配 → 全局/会话默认兜底
    expect(specs[2]?.thinkingLevel).toBe("banana"); // 配置端不校验档位
    expect(specs[3] !== undefined && "thinkingLevel" in specs[3]).toBe(false); // 都没配 → 交给 Pi 默认
    expect(specs[4]?.model).toEqual({ provider: "faux", modelId: "faux-model" }); // 人 model 非法 → 全局模型兜底
    expect(specs[4]?.thinkingLevel).toBe("high"); // 思考强度仍保留人值
  });

  it("sessionDefaults：把全局 model / thinkingLevel 转成会话默认值", () => {
    const config = { providers: { faux: { apiKey: "k" } }, model: "faux/faux-model", port: 4319 };
    expect(sessionDefaults(undefined)).toBeUndefined();
    expect(sessionDefaults(config)).toEqual({ model: "faux/faux-model" });
    expect(sessionDefaults({ ...config, thinkingLevel: "max" })).toEqual({ model: "faux/faux-model", thinkingLevel: "max" });
  });

  it("roomSessionInfo：读会话实际快照（模型全值/思考强度/上下文用量与窗口）；坏会话跳过", async () => {
    seedEmployee("alice");
    const aliceFile = path.join(root, "agents", "alice.agent.config.json");
    fs.writeFileSync(
      aliceFile,
      JSON.stringify({ model: "faux/faux-model", thinkingLevel: "high" }),
    );
    const ws = createWorkspace(root);
    const harness = harnessWithFaux();
    await harness.open();
    try {
      expect(await roomSessionInfo(ws, harness, { kind: "dm", employeeId: "alice" })).toEqual([]);
      const convId = await openDm(ws, harness, "alice");
      await harness.send(convId, "你好");
      const [info] = await roomSessionInfo(ws, harness, { kind: "dm", employeeId: "alice" });
      expect(info).toMatchObject({
        memberId: "alice",
        convId,
        model: "faux/faux-model",
        thinkingLevel: "high",
        contextWindow: 128000,
      });
      expect(info!.contextUsed).toBeGreaterThan(0);

      // 链指向不存在的会话：只跳过该成员，好会话照常返回
      fs.mkdirSync(path.join(root, "projects", "yt"), { recursive: true });
      fs.mkdirSync(path.join(root, "projects", "yt", "conversation_ids"), { recursive: true });
      fs.writeFileSync(path.join(root, "projects", "yt", "members.md"), "- alice\n- ghost\n");
      const aliceGroupConv = await openGroup(ws, harness, "yt", "alice");
      fs.writeFileSync(
        path.join(root, "projects", "yt", "conversation_ids", "ghost.md"),
        ["# 会话链", "", "| id | started | ended | previous |", "|----|---------|-------|----------|", "| conv:不存在 | 2026-10-16T00:00:00Z |  | - |", ""].join("\n"),
      );
      const groupInfo = await roomSessionInfo(ws, harness, { kind: "group", project: "yt" });
      expect(groupInfo.map((s) => s.memberId)).toEqual(["alice"]);
      expect(groupInfo[0]!.convId).toBe(aliceGroupConv);

      // 模型不支持 max（faux 推理模型无 xhigh / max 显式映射）→ 展示 null，不回落成 high
      fs.writeFileSync(
        aliceFile,
        JSON.stringify({ model: "faux/faux-model", thinkingLevel: "max" }),
      );
      await newSession(ws, harness, { kind: "dm", employeeId: "alice" }, "alice");
      const [unsupported] = await roomSessionInfo(ws, harness, { kind: "dm", employeeId: "alice" });
      expect(unsupported!.thinkingLevel).toBeNull();
    } finally {
      await harness.close();
    }
  });

  it("会话装配把 MCP 扩展写入 spec，且透传关系与发言人", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    const ws = createWorkspace(root);
    const specs: ConversationSpec[] = [];
    const stub = {
      startSession: async (spec: ConversationSpec) => {
        specs.push(spec);
        return `conv_${specs.length}`;
      },
      attach: async () => false,
    } as unknown as HarnessPort;
    const calls: string[] = [];
    const resolver = {
      extensionsFor(relation: Relation, speakerId: string) {
        calls.push(`${relation.kind}:${speakerId}`);
        return ["mcp:system:fixture"];
      },
    };

    await openDm(ws, stub, "alice", undefined, resolver);
    await newSession(ws, stub, { kind: "group", project: "yt" }, "bob", undefined, resolver);

    expect(calls).toEqual(["dm:alice", "group:bob"]);
    expect(specs[0]!.mcpExtensions).toEqual(["mcp:system:fixture"]);
    expect(specs[1]!.mcpExtensions).toEqual(["mcp:system:fixture"]);
  });
});
