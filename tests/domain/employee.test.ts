import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { listEmployees, loadEmployee, renderInstructions } from "../../src/domain/employee.ts";

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

  it("config.json 的 alias 作为展示名读出（改名不动目录 id）", () => {
    const ws = createWorkspace(tmp);
    write("dave", "AGENTS.md", "你是 dave。");
    write("dave", "config.json", JSON.stringify({ provider: "faux", modelId: "m", alias: "灯芯草" }));
    expect(loadEmployee(ws, "dave").alias).toBe("灯芯草");
  });

  it("无 config.json / alias 非字符串时 alias 为 undefined", () => {
    const ws = createWorkspace(tmp);
    write("erin", "AGENTS.md", "你是 erin。");
    expect(loadEmployee(ws, "erin").alias).toBeUndefined();
    write("frank", "AGENTS.md", "你是 frank。");
    write("frank", "config.json", JSON.stringify({ alias: 42 }));
    expect(loadEmployee(ws, "frank").alias).toBeUndefined();
  });

  it("alias 两端空白被 trim", () => {
    const ws = createWorkspace(tmp);
    write("grace", "AGENTS.md", "你是 grace。");
    write("grace", "config.json", JSON.stringify({ alias: "  阿草  " }));
    expect(loadEmployee(ws, "grace").alias).toBe("阿草");
  });
});

it("listEmployees：按 id 排序、跳过隐藏目录、坏 config.json 不崩", () => {
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-list-"));
  try {
    for (const id of ["bob", "alice"]) {
      const dir = path.join(root2, "agents", id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "AGENTS.md"), `你是 ${id}。`);
    }
    fs.mkdirSync(path.join(root2, "agents", ".hidden"), { recursive: true });
    fs.writeFileSync(path.join(root2, "agents", "alice", "config.json"), "{坏");
    const ws = createWorkspace(root2);
    expect(listEmployees(ws).map((e) => e.id)).toEqual(["alice", "bob"]);
    expect(listEmployees(ws)[0]!.model).toEqual({ provider: "", modelId: "" });
  } finally {
    fs.rmSync(root2, { recursive: true, force: true });
  }
});
