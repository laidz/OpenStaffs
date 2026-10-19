import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import {
  agentId, agentName, bossName, memberCount, members, projectId, projectName, promptVariables, workdir,
  type PromptVarContext,
} from "../../src/domain/prompt-vars.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-prompt-vars-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function seedEmployee(id: string, alias?: string): void {
  fs.mkdirSync(path.join(root, "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "agents", `${id}.agent.config.json`),
    JSON.stringify({ prompt: `你是 ${id}。`, ...(alias === undefined ? {} : { alias }) }),
  );
}

function seedProject(id: string, memberIds: string[], alias?: string): void {
  const dir = path.join(root, "projects", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "members.md"), memberIds.map((m) => `- ${m}`).join("\n") + "\n");
  if (alias !== undefined) fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ alias }));
}

function dmCtx(selfId: string): PromptVarContext {
  return {
    ws: createWorkspace(root),
    kind: "dm",
    selfId,
    cwd: path.join(root, "agents", selfId),
  };
}

function groupCtx(project: string, selfId: string): PromptVarContext {
  return {
    ws: createWorkspace(root),
    kind: "group",
    selfId,
    projectId: project,
    cwd: path.join(root, "projects", project),
  };
}

describe("提示词变量", () => {
  it("agent_name 优先 alias、缺省 id；agent_id 恒为 id", () => {
    seedEmployee("alice", "爱丽丝");
    seedEmployee("bob");
    expect(agentName(dmCtx("alice"))).toBe("爱丽丝");
    expect(agentName(dmCtx("bob"))).toBe("bob");
    expect(agentId(dmCtx("alice"))).toBe("alice");
  });

  it("boss_name 读 config.json 的 bossName；缺失/坏 JSON/空串 → 老板", () => {
    seedEmployee("alice");
    expect(bossName(dmCtx("alice"))).toBe("老板");
    fs.mkdirSync(path.join(root, ".openstaffs"), { recursive: true });
    fs.writeFileSync(path.join(root, ".openstaffs", "config.json"), JSON.stringify({ bossName: "张总" }));
    expect(bossName(dmCtx("alice"))).toBe("张总");
    fs.writeFileSync(path.join(root, ".openstaffs", "config.json"), JSON.stringify({ bossName: "  " }));
    expect(bossName(dmCtx("alice"))).toBe("老板");
  });

  it("workdir 直出 cwd", () => {
    seedEmployee("alice");
    expect(workdir(dmCtx("alice"))).toBe(path.join(root, "agents", "alice"));
  });

  it("project_name / project_id：群聊取项目 alias / id；私聊 undefined", () => {
    seedEmployee("alice");
    seedEmployee("bob");
    seedProject("demo", ["alice", "bob"], "演示项目");
    const group = groupCtx("demo", "alice");
    expect(projectName(group)).toBe("演示项目");
    expect(projectId(group)).toBe("demo");
    seedProject("plain", ["alice"]); // 无 project.json → alias = id
    expect(projectName(groupCtx("plain", "alice"))).toBe("plain");
    expect(projectName(dmCtx("alice"))).toBeUndefined();
    expect(projectId(dmCtx("alice"))).toBeUndefined();
  });

  it("members：群成员数组（带 alias，缺目录回退 id）；member_count 计数；私聊为空", () => {
    seedEmployee("alice", "爱丽丝");
    seedEmployee("bob");
    seedProject("demo", ["alice", "bob", "ghost"], "演示项目"); // ghost 无目录
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

  it("promptVariables 注册表暴露全部变量函数（消费端按名字调用）", () => {
    seedEmployee("alice", "爱丽丝");
    const group = groupCtx("demo", "alice");
    expect(Object.keys(promptVariables).sort()).toEqual([
      "agent_id", "agent_name", "boss_name", "member_count", "members", "project_id", "project_name", "workdir",
    ]);
    expect(promptVariables["agent_name"]?.(group)).toBe("爱丽丝");
    expect(promptVariables["workdir"]?.(group)).toBe(path.join(root, "projects", "demo"));
  });
});
