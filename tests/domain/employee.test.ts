import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { loadEmployee, renderInstructions } from "../../src/domain/employee.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-"));
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(id: string, file: string, content: string) {
  const dir = path.join(tmp, "agents", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
}

describe("loadEmployee", () => {
  it("以 AGENTS.md 为入口，引入档案与记忆", () => {
    const ws = createWorkspace(tmp);
    write("alice", "AGENTS.md", "你是 alice。");
    write("alice", "profile.md", "岗位：运营");
    write("alice", "MEMORY.md", "记得老板喜欢简短。");
    write("alice", "config.json", JSON.stringify({ provider: "opencode-go", modelId: "deepseek-v4.1-flash", thinkingLevel: "low" }));

    const e = loadEmployee(ws, "alice");
    expect(e.id).toBe("alice");
    expect(e.entry).toBe("你是 alice。");
    expect(e.model).toEqual({ provider: "opencode-go", modelId: "deepseek-v4.1-flash", thinkingLevel: "low" });
    expect(renderInstructions(e)).toContain("你是 alice。");
    expect(renderInstructions(e)).toContain("岗位：运营");
    expect(renderInstructions(e)).toContain("记得老板喜欢简短。");
  });

  it("缺文件时不崩溃，且 model 为空", () => {
    const ws = createWorkspace(tmp);
    write("bob", "AGENTS.md", "你是 bob。");
    const e = loadEmployee(ws, "bob");
    expect(e.profile).toBe("");
    expect(e.memory).toBe("");
    expect(e.model).toEqual({ provider: "", modelId: "" });
    expect(renderInstructions(e)).toBe("你是 bob。");
  });

  it("员工不存在时报错", () => {
    const ws = createWorkspace(tmp);
    expect(() => loadEmployee(ws, "nobody")).toThrow("员工不存在");
  });

  it("config.json 损坏时不崩溃", () => {
    const ws = createWorkspace(tmp);
    write("carol", "AGENTS.md", "你是 carol。");
    write("carol", "config.json", "{ not json");
    expect(loadEmployee(ws, "carol").model).toEqual({ provider: "", modelId: "" });
  });
});
