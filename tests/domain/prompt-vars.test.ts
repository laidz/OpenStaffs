import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import {
  agentId, agentName, bossName, memberCount, members, projectId, projectName, promptVariables, sessionInfo, sessionKind,
  workdir, type PromptVarContext,
} from "../../src/domain/prompt-vars.ts";
import { seedOffice } from "../helpers/office.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-prompt-vars-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** 会话 cwd = 自己的工作目录（D25：项目没有工作目录；群聊也用发言人自己的 work/<id>）。 */
function dmCtx(selfId: string): PromptVarContext {
  return { ws: createWorkspace(root), kind: "dm", selfId, cwd: path.join(root, "work", selfId) };
}

function groupCtx(project: string, selfId: string): PromptVarContext {
  return { ws: createWorkspace(root), kind: "group", selfId, projectId: project, cwd: path.join(root, "work", selfId) };
}

describe("提示词变量", () => {
  it("agent_name 优先 alias、缺省 id；agent_id 恒为 id", () => {
    seedOffice(root, { agents: [{ id: "alice", alias: "爱丽丝" }, { id: "bob" }] });
    expect(agentName(dmCtx("alice"))).toBe("爱丽丝");
    expect(agentName(dmCtx("bob"))).toBe("bob");
    expect(agentId(dmCtx("alice"))).toBe("alice");
  });

  it("boss_name 读 config.json 的 bossName；缺失/坏 JSON/空串 → 老板", () => {
    seedOffice(root, { agents: [{ id: "alice" }] });
    expect(bossName(dmCtx("alice"))).toBe("老板");
    fs.mkdirSync(path.join(root, "openstaffs/.data"), { recursive: true });
    fs.writeFileSync(path.join(root, "openstaffs/.data", "config.json"), JSON.stringify({ bossName: "张总" }));
    expect(bossName(dmCtx("alice"))).toBe("张总");
    fs.writeFileSync(path.join(root, "openstaffs/.data", "config.json"), JSON.stringify({ bossName: "  " }));
    expect(bossName(dmCtx("alice"))).toBe("老板");
  });

  it("workdir 直出 cwd（= 自己的工作目录）", () => {
    seedOffice(root, { agents: [{ id: "alice" }] });
    expect(workdir(dmCtx("alice"))).toBe(path.join(root, "work", "alice"));
  });

  it("project_name / project_id：群聊取项目 alias / id；私聊 undefined", () => {
    seedOffice(root, {
      agents: [{ id: "alice" }, { id: "bob" }],
      projects: [{ id: "demo", alias: "演示项目", members: ["alice", "bob"] }, { id: "plain", members: ["alice"] }],
    });
    const group = groupCtx("demo", "alice");
    expect(projectName(group)).toBe("演示项目");
    expect(projectId(group)).toBe("demo");
    expect(projectName(groupCtx("plain", "alice"))).toBe("plain"); // 无 alias → 回退 id
    expect(projectName(dmCtx("alice"))).toBeUndefined();
    expect(projectId(dmCtx("alice"))).toBeUndefined();
  });

  it("members：群成员数组（带 alias，缺目录回退 id）；member_count 计数；私聊为空", () => {
    seedOffice(root, {
      agents: [{ id: "alice", alias: "爱丽丝" }, { id: "bob" }],
      projects: [{ id: "demo", alias: "演示项目", members: ["alice", "bob", "ghost"] }], // ghost 无目录
    });
    const group = groupCtx("demo", "alice");
    expect(members(group)).toEqual([
      { id: "alice", name: "爱丽丝" },
      { id: "bob", name: "bob" },
      { id: "ghost", name: "ghost" },
    ]);
    expect(memberCount(group)).toBe(3);
    expect(members(dmCtx("alice"))).toEqual([]);
    expect(memberCount(dmCtx("alice"))).toBe(0);
  });

  it("session_kind / session_info：私聊一句 / 群聊带项目与成员", () => {
    seedOffice(root, {
      agents: [{ id: "alice", alias: "爱丽丝" }, { id: "bob" }],
      projects: [{ id: "demo", alias: "演示项目", members: ["alice", "bob"] }],
    });
    expect(sessionKind(dmCtx("alice"))).toBe("dm");
    expect(sessionKind(groupCtx("demo", "alice"))).toBe("group");
    expect(sessionInfo(dmCtx("alice"))).toContain("私聊");
    const group = sessionInfo(groupCtx("demo", "alice"));
    expect(group).toContain("演示项目");
    expect(group).toContain("爱丽丝");
    expect(group).toContain("bob");
  });

  it("promptVariables 注册表暴露全部变量函数（消费端按名字调用）", () => {
    seedOffice(root, { agents: [{ id: "alice", alias: "爱丽丝" }], projects: [{ id: "demo", members: ["alice"] }] });
    const group = groupCtx("demo", "alice");
    expect(Object.keys(promptVariables).sort()).toEqual([
      "agent_id", "agent_name", "boss_name", "group_rules", "member_count", "members", "project_id", "project_name",
      "session_info", "session_kind", "workdir",
    ]);
    expect(promptVariables["agent_name"]?.(group)).toBe("爱丽丝");
    expect(promptVariables["workdir"]?.(group)).toBe(path.join(root, "work", "alice"));
  });
});
