import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentsDir, createWorkspace,
  officeDbFile, spaceDir, spaceSkillsDir, stateDir, workDir,
} from "../../src/domain/paths.ts";

describe("路径", () => {
  const ws = createWorkspace("/tmp/company");
  it("agent 工作目录 = work/<id>（D20；workDir 由 P2 提供，本计划只 import）", () => {
    expect(workDir(ws, "alice")).toBe(path.join("/tmp/company", "work", "alice"));
  });
  it("把根解析为绝对路径；标准目录（agents/ 为部门树根）", () => {
    expect(createWorkspace("relative").root).toBe(path.resolve("relative"));
    expect(agentsDir(ws)).toBe(path.join("/tmp/company", "agents"));
  });

  it("机器私有目录 = openstaffs/.data（D19：目录合并）", () => {
    expect(stateDir(ws)).toBe(path.join("/tmp/company", "openstaffs", ".data"));
    expect(spaceDir(ws)).toBe(path.join("/tmp/company", "openstaffs"));
    expect(spaceSkillsDir(ws)).toBe(path.join("/tmp/company", "openstaffs", "skills"));
  });

  it("消息库随 stateDir 搬迁：落在 openstaffs/.data/openstaffs.sqlite（不改拼接语义）", () => {
    expect(officeDbFile(ws)).toBe(path.join("/tmp/company", "openstaffs", ".data", "openstaffs.sqlite"));
    expect(officeDbFile(ws)).toBe(path.join(stateDir(ws), "openstaffs.sqlite"));
  });
});
