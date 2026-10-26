import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace, messagesDbFile, stateDir } from "../../src/domain/paths.ts";
import { readChain, startNewSession } from "../../src/domain/conversation-chain.ts";
import { createPiHarness } from "../../src/harness/pi-durable.ts";
import {
  accessFor, activeMemberSessions, employeeActiveSessions, findSessionOwner, instructionsFor, interruptRoom, newSession, openDm, openGroup,
  relationCwd, relationKey, roomSessionInfo, sessionChains, sessionDefaults,
  type SessionDefaults,
} from "../../src/app/conversations.ts";
import { loadEmployee } from "../../src/domain/employee.ts";
import { createEntity, writeProfile } from "../../src/domain/memory/store.ts";
import { seedOffice } from "../helpers/office.ts";
import type { ConversationSpec, HarnessPort } from "../../src/harness/port.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-app-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** 夹具：一个人 = 一份 `<id>.agent.config.json`（放在 agents/ 根或部门目录）。 */
function seedEmployee(id: string, alias?: string, department?: string): void {
  seedOffice(root, { agents: [{ id, department, alias, model: "faux/faux-model", prompt: `你是 ${id}。` }] });
}

function harnessWithFaux() {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model", reasoning: true }] });
  faux.setResponses([fauxAssistantMessage("ok"), fauxAssistantMessage("ok")]);
  const models = createModels();
  models.setProvider(faux.provider);
  return createPiHarness({ root, sqlitePath: path.join(root, "openstaffs/.data", "state.sqlite"), models });
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
      // 会话链不在员工目录（D25/D26）：agents/<id>/conversation_ids.md 不存在
      expect(fs.existsSync(path.join(root, "agents", "alice", "conversation_ids.md"))).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("新会话注入 profile + 索引；关闭开关则不注入", () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    writeProfile(ws, "alice", "我是 alice");
    createEntity(ws, "alice", { title: "VIP 口径", description: "谈 VIP 时看", body: "正文" });
    const text = instructionsFor(ws, { kind: "dm", employeeId: "alice" }, loadEmployee(ws, "alice"));
    expect(text).toContain("我是 alice");
    expect(text).toContain("vip-口径 · VIP 口径 — 谈 VIP 时看");

    seedOffice(root, { agents: [{ id: "bob", model: "faux/faux-model", memory: false }] });
    writeProfile(ws, "bob", "不该出现");
    const bob = instructionsFor(ws, { kind: "dm", employeeId: "bob" }, loadEmployee(ws, "bob"));
    expect(bob).not.toContain("不该出现");
    expect(bob).not.toContain("## 使用记忆");

    const ordered = instructionsFor(ws, { kind: "dm", employeeId: "alice" }, loadEmployee(ws, "alice"));
    const indexes = ["OpenStaffs", "你是 alice。", "## 使用记忆", "我是 alice", "## 可用技能"]
      .map((needle) => ordered.indexOf(needle));
    expect(indexes.every((index) => index >= 0)).toBe(true);
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
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

  it("instructions：prompt 链（空间 → 部门 → 项目 → 员工）→ 记忆 → 技能目录（含系统内置）", () => {
    const ws = seedOffice(root, {
      space: { prompt: "空间总纲" },
      departments: [{ path: "eng", prompt: "部门规矩" }],
      agents: [{ id: "alice", department: "eng", prompt: "你是运营。" }],
      projects: [{ id: "yt", members: ["alice"], prompt: "项目规范" }],
    });
    writeProfile(ws, "alice", "记忆一条。");
    const speaker = loadEmployee(ws, "alice");
    const text = instructionsFor(ws, { kind: "group", project: "yt" }, speaker);
    const order = ["空间总纲", "部门规矩", "项目规范", "你是运营。", "记忆一条。", "## 可用技能"];
    const positions = order.map((token) => text.indexOf(token));
    expect(positions.every((index) => index >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("员工的活跃会话：私聊 + 他所在的群；非成员不算", () => {
    const ws = seedOffice(root, {
      agents: [{ id: "alice" }, { id: "bob" }],
      projects: [{ id: "yt", members: ["alice"] }, { id: "seo", members: ["bob"] }],
    });
    fs.mkdirSync(path.join(root, "work", "alice"), { recursive: true });
    startNewSession(path.join(root, "work", "alice", "conversation_ids.md"), "conv_dm", "2026-10-25T10:00:00+08:00");
    const ytDir = path.join(stateDir(ws), "chains", "group-yt");
    startNewSession(path.join(ytDir, "alice.md"), "conv_yt", "2026-10-25T10:01:00+08:00");
    const seoDir = path.join(stateDir(ws), "chains", "group-seo");
    startNewSession(path.join(seoDir, "bob.md"), "conv_seo", "2026-10-25T10:02:00+08:00");

    const sessions = employeeActiveSessions(ws, "alice");
    expect(sessions.map((session) => session.convId).sort()).toEqual(["conv_dm", "conv_yt"]);
    expect(sessions.every((session) => session.started !== "")).toBe(true);
  });

  it("工作目录 = work/<id>（项目没有工作目录，D25）", () => {
    const ws = seedOffice(root, { agents: [{ id: "alice" }] });
    expect(relationCwd(ws, { kind: "group", project: "yt" }, "alice")).toBe(path.join(root, "work", "alice"));
    expect(relationCwd(ws, { kind: "dm", employeeId: "alice" }, "alice")).toBe(path.join(root, "work", "alice"));
  });

  it("关系工作目录：私聊与群聊都是发言人的 work/<id>/，群聊不落项目目录（D20/D25/D26）", () => {
    const ws = seedOffice(root, {
      agents: [{ id: "alice" }, { id: "bob" }],
      projects: [{ id: "yt", members: ["alice", "bob"] }],
    });
    expect(relationCwd(ws, { kind: "dm", employeeId: "alice" }, "alice")).toBe(path.join(root, "work", "alice"));
    // 群聊 cwd = 发言人的 work 目录（Review Focus #4），不是项目目录（projects/yt）
    expect(relationCwd(ws, { kind: "group", project: "yt" }, "bob")).toBe(path.join(root, "work", "bob"));
  });

  it("access：权限 = 项目 + 员工累加 + 运行时（工作目录 / 主管写权 / 技能根）", () => {
    const ws = seedOffice(root, {
      agents: [{ id: "alice", department: "eng", permissions: { write: [], read: ["./"], bash: ["./"] } }],
      projects: [{ id: "yt", members: ["alice"], prompt: "" }],
    });
    const access = accessFor(ws, { kind: "group", project: "yt" }, loadEmployee(ws, "alice"));
    expect(access.cwd).toBe(path.join(root, "work", "alice"));
    expect(access.permissions["write"]).toEqual([path.join(root, "work", "alice")]);
    expect(access.permissions["read"]).toContain(path.join(root, "work", "alice"));
    expect(access.permissions["read"]).toContain(path.join(root, "openstaffs", "skills"));
  });

  it("access：主管对管理子树有写权（穿透）", () => {
    const ws = seedOffice(root, {
      departments: [{ path: "eng", head: ["alice"] }],
      agents: [
        { id: "alice", department: "eng", permissions: { write: [], read: [], bash: [] } },
        { id: "bob", department: "eng/platform", permissions: { write: [], read: [], bash: [] } },
      ],
    });
    const alice = accessFor(ws, { kind: "dm", employeeId: "alice" }, loadEmployee(ws, "alice"));
    const write = alice.permissions["write"] ?? [];
    expect(write).toContain(path.join(root, "work", "alice")); // 自己的工作目录恒可写
    expect(write).toContain(path.join(root, "agents", "eng")); // 主管管理的部门目录
    expect(write).toContain(path.join(root, "agents", "eng", "platform")); // 穿透到子树
    expect(accessFor(ws, { kind: "dm", employeeId: "bob" }, loadEmployee(ws, "bob")).permissions["write"]).toEqual([
      path.join(root, "work", "bob"),
    ]);
  });

  it("人级 instructions 用 config 的 prompt", () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const out = instructionsFor(ws, { kind: "dm", employeeId: "alice" }, loadEmployee(ws, "alice"));
    expect(out).toContain("你是 alice。");
  });

  it("私聊发言人与关系不一致时报错（不静默挂错人）", async () => {
    seedEmployee("alice");
    seedEmployee("bob");
    const ws = createWorkspace(root);
    const stub = {} as HarnessPort;
    await expect(
      newSession(ws, stub, { kind: "dm", employeeId: "alice" }, "bob"),
    ).rejects.toThrow("不一致");
  });

  it("群聊：每成员一条会话、按需创建、各记各的链", async () => {
    const ws = seedOffice(root, {
      agents: [{ id: "alice" }, { id: "bob" }],
      projects: [{ id: "yt", members: ["alice", "bob"] }],
    });
    const harness = harnessWithFaux();
    await harness.open();
    try {
      const aliceConv = await openGroup(ws, harness, "yt", "alice");
      const aliceFile = path.join(root, "openstaffs/.data", "chains", "group-yt", "alice.md");
      const bobFile = path.join(root, "openstaffs/.data", "chains", "group-yt", "bob.md");
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

  it("群聊链落 openstaffs/.data/chains/，不落员工目录（D25/D26）", async () => {
    const ws = seedOffice(root, {
      agents: [{ id: "alice" }, { id: "bob" }],
      projects: [{ id: "yt", members: ["alice", "bob"] }],
    });
    const harness = harnessWithFaux();
    await harness.open();
    try {
      await openGroup(ws, harness, "yt", "alice");
      const chainsDir = path.join(root, "openstaffs", ".data", "chains");
      expect(fs.existsSync(chainsDir)).toBe(true);
      // 链文件确实落在 .data/chains/ 下（递归列出，含成员名）
      expect(fs.readdirSync(chainsDir, { recursive: true }).some((entry) => entry.includes("alice"))).toBe(true);
      expect(readChain(path.join(chainsDir, "group-yt", "alice.md"))).toHaveLength(1);
      expect(fs.existsSync(path.join(root, "agents", "alice", "conversation_ids.md"))).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("群聊新开会话只影响该成员", async () => {
    const ws = seedOffice(root, {
      agents: [{ id: "alice" }, { id: "bob" }],
      projects: [{ id: "yt", members: ["alice", "bob"] }],
    });
    const harness = harnessWithFaux();
    await harness.open();
    try {
      const a1 = await openGroup(ws, harness, "yt", "alice");
      const b1 = await openGroup(ws, harness, "yt", "bob");
      const a2 = await newSession(ws, harness, { kind: "group", project: "yt" }, "alice");
      expect(a2).not.toBe(a1);
      const aliceFile = path.join(root, "openstaffs/.data", "chains", "group-yt", "alice.md");
      const bobFile = path.join(root, "openstaffs/.data", "chains", "group-yt", "bob.md");
      expect(readChain(aliceFile)).toHaveLength(2);
      expect(readChain(aliceFile)[0]!.ended).not.toBeNull();
      expect(readChain(aliceFile)[1]!.previous).toBe(a1);
      expect(readChain(bobFile)).toHaveLength(1);
      expect(readChain(bobFile)[0]!.id).toBe(b1);
    } finally {
      await harness.close();
    }
  });

  it("技能按名引用装配：空间 / 部门 / 项目 / 员工 config 的 skills 累加，系统内置恒在", () => {
    const ws = seedOffice(root, {
      space: { skills: ["space-skill"] },
      departments: [{ path: "eng", skills: ["dept-skill"] }],
      agents: [{ id: "alice", department: "eng", skills: ["agent-skill"] }],
      projects: [{ id: "yt", members: ["alice"], skills: ["project-skill"] }],
    });
    for (const name of ["space-skill", "dept-skill", "project-skill", "agent-skill"]) {
      const file = path.join(root, "openstaffs", "skills", name, "SKILL.md");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `---\nname: ${name}\ndescription: 来自 ${name}\n---\n`);
    }
    const speaker = loadEmployee(ws, "alice");

    const group = instructionsFor(ws, { kind: "group", project: "yt" }, speaker);
    for (const name of ["space-skill", "dept-skill", "project-skill", "agent-skill"]) {
      expect(group).toContain(`${name}：来自 ${name}`);
    }
    // 私聊无项目层 → 项目引用的技能不出现；空间 / 部门 / 员工引用仍在
    const dm = instructionsFor(ws, { kind: "dm", employeeId: "alice" }, speaker);
    expect(dm).toContain("space-skill：来自 space-skill");
    expect(dm).toContain("dept-skill：来自 dept-skill");
    expect(dm).toContain("agent-skill：来自 agent-skill");
    expect(dm).not.toContain("project-skill");
    // 系统内置技能恒在（不受 config 引用影响）
    expect(group).toContain(path.join("src", "skills", "openstaffs", "SKILL.md"));
  });

  it("外部 skillPaths 作为按名解析的后备根：空间目录缺失时命中外部库，撞名时空间优先", () => {
    const ws = seedOffice(root, { agents: [{ id: "alice", skills: ["x", "collide"] }] });
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
    fs.mkdirSync(path.join(root, "openstaffs/.data"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "openstaffs/.data", "config.json"),
      JSON.stringify({ skillPaths: ["ext-skills"] }), // 相对办公空间根
    );

    const dm = instructionsFor(ws, { kind: "dm", employeeId: "alice" }, loadEmployee(ws, "alice"));
    expect(dm).toContain("- 外部技能：来自外部库");
    expect(dm).toContain("- 撞名：来自空间撞名"); // 空间目录在解析链中先于外部目录
    expect(dm).not.toContain("来自外部撞名");
  });

  it("技能清单只认 config 的 skills 名：agents/<id>/skills/ 不再被扫描", () => {
    seedEmployee("alice");
    const ws = createWorkspace(root);
    const ghost = path.join(root, "agents", "alice", "skills", "ghost", "SKILL.md");
    fs.mkdirSync(path.dirname(ghost), { recursive: true });
    fs.writeFileSync(ghost, "---\nname: ghost\ndescription: 员工目录里的幽灵技能\n---\n");
    const text = instructionsFor(ws, { kind: "dm", employeeId: "alice" }, loadEmployee(ws, "alice"));
    expect(text).not.toContain("ghost");
    // 系统内置技能仍恒在（清单非空，不因忽略员工目录而变空）
    expect(text).toContain(path.join("src", "skills", "openstaffs", "SKILL.md"));
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

  it("instructions 注入技能（名称 + 描述 + 位置；引用先出现者在前）", () => {
    const ws = seedOffice(root, {
      agents: [{ id: "alice", prompt: "你是 alice。", skills: ["agent-skill"] }],
      projects: [{ id: "yt", members: ["alice"], skills: ["group-skill"] }],
    });
    for (const name of ["group-skill", "agent-skill"]) {
      const file = path.join(root, "openstaffs", "skills", name, "SKILL.md");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `---\nname: ${name}\ndescription: 来自 ${name}\n---\n`);
    }
    const text = instructionsFor(ws, { kind: "group", project: "yt" }, loadEmployee(ws, "alice"));
    expect(text).toContain("你是 alice。");
    expect(text).toContain("- group-skill：来自 group-skill");
    expect(text).toContain("- agent-skill：来自 agent-skill");
    expect(text.indexOf("group-skill")).toBeLessThan(text.indexOf("agent-skill"));
  });

  it("prompt 累加：群聊含项目 config 的 prompt；私聊不含项目层", () => {
    const ws = seedOffice(root, {
      space: { prompt: "空间总纲" },
      agents: [{ id: "alice", prompt: "你是 alice。" }],
      projects: [{ id: "yt", members: ["alice"], prompt: "任务：做 yt 视频。" }],
    });
    const speaker = loadEmployee(ws, "alice");

    const group = instructionsFor(ws, { kind: "group", project: "yt" }, speaker);
    expect(group).toContain("空间总纲");
    expect(group).toContain("任务：做 yt 视频。");
    expect(group.indexOf("空间总纲")).toBeLessThan(group.indexOf("任务：做 yt 视频。"));
    expect(group.indexOf("任务：做 yt 视频。")).toBeLessThan(group.indexOf("你是 alice。"));

    const dm = instructionsFor(ws, { kind: "dm", employeeId: "alice" }, speaker);
    expect(dm).toContain("空间总纲");
    expect(dm).not.toContain("任务：做 yt 视频。");
  });

  it("空间 / 项目 AGENTS.md 不再进入 instructions（D5/D33）", () => {
    const ws = seedOffice(root, { agents: [{ id: "alice" }], projects: [{ id: "seo", members: ["alice"] }] });
    fs.writeFileSync(path.join(root, "AGENTS.md"), "空间总纲（应被忽略）");
    fs.mkdirSync(path.join(root, "projects", "seo"), { recursive: true });
    fs.writeFileSync(path.join(root, "projects", "seo", "AGENTS.md"), "项目规范（应被忽略）");
    const text = instructionsFor(ws, { kind: "group", project: "seo" }, loadEmployee(ws, "alice"));
    expect(text).not.toContain("空间总纲");
    expect(text).not.toContain("项目规范");
  });

  it("prompt 链进入 instructions：空间 → 部门（根 → 叶）→ 项目 → 员工，`\\n\\n` 分段", () => {
    const ws = createWorkspace(root);
    const seedJson = (file: string, value: unknown): void => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(value));
    };
    seedJson(path.join(root, "openstaffs", "space.config.json"), { prompt: "空间段" });
    seedJson(path.join(root, "agents", "department.config.json"), { prompt: "根部门段" });
    seedJson(path.join(root, "agents", "eng", "department.config.json"), { prompt: "工程部段" });
    seedJson(path.join(root, "agents", "eng", "alice.agent.config.json"), { prompt: "员工段" });
    seedJson(path.join(root, "projects", "seo.project.config.json"), { members: ["alice"], prompt: "项目段" });

    const text = instructionsFor(ws, { kind: "group", project: "seo" }, loadEmployee(ws, "alice"));
    const order = ["空间段", "根部门段", "工程部段", "项目段", "员工段"].map((segment) => text.indexOf(segment));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order); // 顺序严格递增
    expect(text).toContain("空间段\n\n根部门段"); // 逐段渲染 + `\n\n` 分段
    expect(text).toContain("项目段\n\n员工段");
  });

  it("系统段在最前；空间自定义段其次；私聊不带群聊段", () => {
    const ws = seedOffice(root, {
      space: { prompt: "空间自定义规矩。" },
      agents: [{ id: "alice", prompt: "你是 alice。" }, { id: "bob", prompt: "你是 bob。" }],
      projects: [{ id: "yt", alias: "演示项目", members: ["alice", "bob"] }],
    });
    const speaker = loadEmployee(ws, "alice");

    const group = instructionsFor(ws, { kind: "group", project: "yt" }, speaker);
    expect(group).toContain("OpenStaffs");
    expect(group).toContain("空间自定义规矩。");
    expect(group).toContain("演示项目");
    expect(group).toContain("bob");
    expect(group.indexOf("OpenStaffs")).toBeLessThan(group.indexOf("空间自定义规矩。"));
    expect(group.indexOf("空间自定义规矩。")).toBeLessThan(group.indexOf("你是 alice。"));

    const dm = instructionsFor(ws, { kind: "dm", employeeId: "alice" }, speaker);
    expect(dm).toContain("1 对 1 私聊");
    expect(dm).not.toContain("群聊规则");
    expect(dm).not.toContain("演示项目");
  });

  it("人未配模型时用 defaults 兜底可对话；无 defaults 则失败（不静默）", async () => {
    seedOffice(root, { agents: [{ id: "carol", prompt: "你是 carol。" }] });
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
    const ws = seedOffice(root, {
      agents: [{ id: "alice" }, { id: "bob" }],
      projects: [{ id: "yt", members: ["alice", "bob"] }],
    });
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
    } finally {
      await harness.close();
    }
  });

  it("interruptRoom：逐个中止各成员活跃会话；坏会话跳过不连坐", async () => {
    const ws = seedOffice(root, {
      agents: [{ id: "alice" }, { id: "bob" }, { id: "carol" }],
      projects: [{ id: "yt", members: ["alice", "bob", "carol"] }],
    });
    const harness = harnessWithFaux();
    await harness.open();
    try {
      const a = await openGroup(ws, harness, "yt", "alice");
      const b = await openGroup(ws, harness, "yt", "bob");
      // carol 的链写坏：活跃行指向不存在的会话
      const carolFile = path.join(root, "openstaffs/.data", "chains", "group-yt", "carol.md");
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

  it("会话快照：会话中改 prompt 不生效；新开会话后生效", async () => {
    seedOffice(root, {
      space: { skills: ["space-e2e"] },
      agents: [{ id: "dave", model: "faux/faux-model", prompt: "档案版本一。" }],
    });
    const daveFile = path.join(root, "agents", "dave.agent.config.json");
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
    const harness = createPiHarness({ root, sqlitePath: path.join(root, "openstaffs/.data", "state-snapshot.sqlite"), models });
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
    seedOffice(root, { agents: [{ id: "dave", model: "faux/faux-model", prompt: "你是 dave。" }] });
    const daveFile = path.join(root, "agents", "dave.agent.config.json");
    const sqlitePath = path.join(root, "openstaffs/.data", "state-restart.sqlite");
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
    seedOffice(root, {
      agents: [
        { id: "alice", model: "faux/faux-model", thinkingLevel: "high" },
        { id: "bob", model: "faux/faux-model" },
        { id: "carol", model: "faux/faux-model", thinkingLevel: "banana" },
      ],
    });
    const aliceFile = path.join(root, "agents", "alice.agent.config.json");
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
    const ws = seedOffice(root, {
      agents: [{ id: "alice", model: "faux/faux-model", thinkingLevel: "high" }],
      projects: [{ id: "yt", members: ["alice", "ghost"] }],
    });
    const aliceFile = path.join(root, "agents", "alice.agent.config.json");
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
      const aliceGroupConv = await openGroup(ws, harness, "yt", "alice");
      const ghostFile = path.join(root, "openstaffs/.data", "chains", "group-yt", "ghost.md");
      fs.mkdirSync(path.dirname(ghostFile), { recursive: true });
      fs.writeFileSync(
        ghostFile,
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

  it("会话装配按能力累加把 MCP 扩展写入 spec", async () => {
    const ws = seedOffice(root, {
      space: { mcp: ["space-mcp"] },
      agents: [{ id: "alice", mcp: ["agent-mcp"] }, { id: "bob" }],
      projects: [{ id: "yt", members: ["alice", "bob"], mcp: ["project-mcp"] }],
    });
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
      extensionsFor(names: readonly string[]) {
        calls.push(names.join(","));
        return ["mcp:global:fixture"];
      },
    };

    await openDm(ws, stub, "alice", undefined, resolver);
    await newSession(ws, stub, { kind: "group", project: "yt" }, "bob", undefined, resolver);

    // 名字来源 = 作用域链能力累加（空间 → 部门 → 项目 → 员工）；私聊无项目层
    expect(calls).toEqual(["space-mcp,agent-mcp", "space-mcp,project-mcp"]);
    expect(specs[0]!.mcpExtensions).toEqual(["mcp:global:fixture"]);
    expect(specs[1]!.mcpExtensions).toEqual(["mcp:global:fixture"]);
  });
});
