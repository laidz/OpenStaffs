import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentsDir, conversationIdsFile, createWorkspace, employeeDir, groupConversationIdsFile,
  messagesDbFile, spaceDir, spaceSkillsDir, stateDir, workDir,
} from "../../src/domain/paths.ts";

describe("路径", () => {
  const ws = createWorkspace("/tmp/company");
  it("agent 工作目录 = work/<id>（D20；workDir 由 P2 提供，本计划只 import）", () => {
    expect(workDir(ws, "alice")).toBe(path.join("/tmp/company", "work", "alice"));
  });
  it("群会话链落在 stateDir 下（项目已无目录，D26）", () => {
    expect(groupConversationIdsFile(ws, "yt", "alice")).toBe(path.join(stateDir(ws), "chains", "group-yt", "alice.md"));
  });

  it("把根解析为绝对路径；各标准目录（agents/employee 保留，B1/N1）", () => {
    expect(createWorkspace("relative").root).toBe(path.resolve("relative"));
    expect(agentsDir(ws)).toBe(path.join("/tmp/company", "agents"));
    expect(employeeDir(ws, "alice")).toBe(path.join("/tmp/company", "agents", "alice"));
  });

  it("会话链文件落在给定目录下", () => {
    expect(conversationIdsFile(ws, workDir(ws, "alice"))).toBe(
      path.join("/tmp/company", "work", "alice", "conversation_ids.md"),
    );
  });

  it("机器私有目录 = openstaffs/.data（D19：目录合并）", () => {
    expect(stateDir(ws)).toBe(path.join("/tmp/company", "openstaffs", ".data"));
    expect(spaceDir(ws)).toBe(path.join("/tmp/company", "openstaffs"));
    expect(spaceSkillsDir(ws)).toBe(path.join("/tmp/company", "openstaffs", "skills"));
  });

  it("消息库随 stateDir 搬迁：落在 openstaffs/.data/messages.sqlite（不改拼接语义）", () => {
    expect(messagesDbFile(ws)).toBe(path.join("/tmp/company", "openstaffs", ".data", "messages.sqlite"));
    expect(messagesDbFile(ws)).toBe(path.join(stateDir(ws), "messages.sqlite"));
  });
});
