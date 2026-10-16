import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentsDir, conversationIdsFile, createWorkspace, employeeDir, groupConversationIdsFile, membersFile, projectDir,
} from "../../src/domain/paths.ts";

describe("workspace paths", () => {
  const ws = createWorkspace("/tmp/company");

  it("把根解析为绝对路径", () => {
    expect(createWorkspace("relative").root).toBe(path.resolve("relative"));
  });

  it("给出各标准目录", () => {
    expect(agentsDir(ws)).toBe(path.join("/tmp/company", "agents"));
    expect(employeeDir(ws, "alice")).toBe(path.join("/tmp/company", "agents", "alice"));
    expect(projectDir(ws, "yt")).toBe(path.join("/tmp/company", "projects", "yt"));
    expect(membersFile(ws, "yt")).toBe(path.join("/tmp/company", "projects", "yt", "members.md"));
  });

  it("会话链文件落在给定目录下", () => {
    expect(conversationIdsFile(ws, projectDir(ws, "yt"))).toBe(
      path.join("/tmp/company", "projects", "yt", "conversation_ids.md"),
    );
  });

  it("群聊链文件按成员落在 conversation_ids/ 子目录", () => {
    expect(groupConversationIdsFile(ws, "yt", "alice")).toBe(
      path.join("/tmp/company", "projects", "yt", "conversation_ids", "alice.md"),
    );
  });
});
