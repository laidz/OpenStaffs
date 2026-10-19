import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { listEmployees, loadEmployee, memoryOf, renderInstructions } from "../../src/domain/employee.ts";
import { loadPerson } from "../../src/domain/org.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-"));
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(id: string, content: string) {
  fs.mkdirSync(path.join(tmp, "agents"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "agents", `${id}.agent.config.json`), content);
}

describe("loadEmployee（org 薄适配层，B1）", () => {
  it("转发到 org：读 id / model / prompt，renderInstructions === prompt", () => {
    const ws = createWorkspace(tmp);
    write("alice", JSON.stringify({ model: "opencode-go/deepseek-v4.1-flash", thinkingLevel: "low", prompt: "你是 alice。" }));

    const e = loadEmployee(ws, "alice");
    expect(e).toEqual(loadPerson(ws, "alice")); // 适配层 = org 的同一个人
    expect(e.id).toBe("alice");
    expect(e.model).toEqual({ model: "opencode-go/deepseek-v4.1-flash", thinkingLevel: "low" });
    expect(renderInstructions(e)).toBe("你是 alice。"); // D5：人级 instructions = 内联 prompt
  });

  it("prompt 缺省时为空串，renderInstructions 也为空", () => {
    const ws = createWorkspace(tmp);
    write("bob", JSON.stringify({ model: "faux/faux-model" }));
    const e = loadEmployee(ws, "bob");
    expect(e.prompt).toBe("");
    expect(renderInstructions(e)).toBe("");
  });

  it("员工不存在时报错（沿用旧口径）", () => {
    const ws = createWorkspace(tmp);
    expect(() => loadEmployee(ws, "nobody")).toThrow("员工不存在");
  });

  it("坏 JSON / model 非字符串时不崩溃", () => {
    const ws = createWorkspace(tmp);
    write("carol", "{ not json");
    expect(loadEmployee(ws, "carol").model).toEqual({ model: "" });
    write("carol", JSON.stringify({ model: 42 }));
    expect(loadEmployee(ws, "carol").model).toEqual({ model: "" });
  });

  it("thinkingLevel 只接受非空字符串（trim）；数字 / null / 空串忽略", () => {
    const ws = createWorkspace(tmp);
    write("henry", JSON.stringify({ model: "faux/m", thinkingLevel: 42 }));
    expect(loadEmployee(ws, "henry").model).toEqual({ model: "faux/m" });
    write("henry", JSON.stringify({ model: "faux/m", thinkingLevel: "  high  " }));
    expect(loadEmployee(ws, "henry").model).toEqual({ model: "faux/m", thinkingLevel: "high" });
    write("henry", JSON.stringify({ model: "faux/m", thinkingLevel: "   " }));
    expect(loadEmployee(ws, "henry").model).toEqual({ model: "faux/m" });
    write("henry", JSON.stringify({ model: "faux/m", thinkingLevel: null }));
    expect(loadEmployee(ws, "henry").model).toEqual({ model: "faux/m" });
  });

  it("alias 作为展示名读出（改名不动 id）", () => {
    const ws = createWorkspace(tmp);
    write("dave", JSON.stringify({ model: "faux/m", alias: "灯芯草" }));
    expect(loadEmployee(ws, "dave").alias).toBe("灯芯草");
  });

  it("alias 非字符串 / 空串时 alias 为 undefined", () => {
    const ws = createWorkspace(tmp);
    write("erin", JSON.stringify({ model: "faux/m" }));
    expect(loadEmployee(ws, "erin").alias).toBeUndefined();
    write("frank", JSON.stringify({ alias: 42 }));
    expect(loadEmployee(ws, "frank").alias).toBeUndefined();
  });

  it("alias 两端空白被 trim", () => {
    const ws = createWorkspace(tmp);
    write("grace", JSON.stringify({ alias: "  阿草  " }));
    expect(loadEmployee(ws, "grace").alias).toBe("阿草");
  });
});

describe("memoryOf（D27：优先 work/<id>/MEMORY.md，旧位置回落）", () => {
  function writeFile(rel: string, content: string): void {
    const file = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  it("读 work/<id>/MEMORY.md", () => {
    const ws = createWorkspace(tmp);
    write("alice", JSON.stringify({ prompt: "你是 alice。" }));
    writeFile(path.join("work", "alice", "MEMORY.md"), "新记忆。");
    expect(memoryOf(ws, "alice")).toBe("新记忆。");
  });

  it("work 下为空/缺失时回落到旧位置 agents/<id>/MEMORY.md", () => {
    const ws = createWorkspace(tmp);
    write("alice", JSON.stringify({ prompt: "你是 alice。" }));
    writeFile(path.join("agents", "alice", "MEMORY.md"), "旧记忆。");
    expect(memoryOf(ws, "alice")).toBe("旧记忆。");
    // work 下写了空白 → 视为无，继续回落
    writeFile(path.join("work", "alice", "MEMORY.md"), "   \n");
    expect(memoryOf(ws, "alice")).toBe("旧记忆。");
  });

  it("两处都没有 → 空串（不崩）", () => {
    const ws = createWorkspace(tmp);
    write("bob", JSON.stringify({ prompt: "" }));
    expect(memoryOf(ws, "bob")).toBe("");
  });
});

it("listEmployees：按 id 排序、跳过隐藏条目、坏 config 不崩", () => {
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-list-"));
  try {
    fs.mkdirSync(path.join(root2, "agents"), { recursive: true });
    for (const id of ["bob", "alice"]) {
      fs.writeFileSync(path.join(root2, "agents", `${id}.agent.config.json`), JSON.stringify({ prompt: `你是 ${id}。` }));
    }
    fs.mkdirSync(path.join(root2, "agents", ".hidden"), { recursive: true });
    fs.writeFileSync(path.join(root2, "agents", ".hidden", "x.agent.config.json"), JSON.stringify({ prompt: "x" }));
    fs.writeFileSync(path.join(root2, "agents", "alice.agent.config.json"), "{坏");
    const ws = createWorkspace(root2);
    expect(listEmployees(ws).map((e) => e.id)).toEqual(["alice", "bob"]);
    expect(listEmployees(ws)[0]!.model).toEqual({ model: "" });
  } finally {
    fs.rmSync(root2, { recursive: true, force: true });
  }
});
