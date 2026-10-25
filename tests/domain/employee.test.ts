import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace, workDir } from "../../src/domain/paths.ts";
import { listEmployees, loadEmployee, renderInstructions } from "../../src/domain/employee.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-emp-"));
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** 在 agents/ 下写一个人的定义文件（D1/D2）。 */
function seed(id: string, config: Record<string, unknown> = {}): string {
  const file = path.join(tmp, "agents", `${id}.agent.config.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}

describe("loadEmployee（单一 config 定义）", () => {
  it("从 .agent.config.json 读出 alias / prompt / skills / mcp / model", () => {
    const ws = createWorkspace(tmp);
    seed("alice", {
      alias: "爱丽丝",
      prompt: "你是爱丽丝。",
      skills: ["写报告", "查数据"],
      mcp: ["github"],
      model: "opencode-go/deepseek-v4.1-flash",
      thinkingLevel: "low",
    });
    const e = loadEmployee(ws, "alice");
    expect(e.id).toBe("alice");
    expect(e.alias).toBe("爱丽丝");
    expect(e.prompt).toBe("你是爱丽丝。");
    expect(e.skills).toEqual(["写报告", "查数据"]);
    expect(e.mcp).toEqual(["github"]);
    expect(e.model).toEqual({ model: "opencode-go/deepseek-v4.1-flash", thinkingLevel: "low" });
    expect(e.workDir).toBe(workDir(ws, "alice"));
    expect("entry" in e).toBe(false); // AGENTS.md 入口已废除（D5）
    expect("profile" in e).toBe(false); // profile.md 已废除（D2）
    expect("departmentPath" in e).toBe(false); // 定义来源收口到单一 config 文件
  });

  it("不再读 AGENTS.md / profile.md（写在同一目录也不生效）", () => {
    const ws = createWorkspace(tmp);
    seed("bob");
    // 旧机制的真实布局：agents/<id>/AGENTS.md（不是 agents/ 根）；写在这里也不生效
    const bobDir = path.join(tmp, "agents", "bob");
    fs.mkdirSync(bobDir, { recursive: true });
    fs.writeFileSync(path.join(bobDir, "AGENTS.md"), "空间总纲（应被忽略）");
    fs.writeFileSync(path.join(bobDir, "profile.md"), "岗位说明（应被忽略）");
    const e = loadEmployee(ws, "bob");
    expect(e.prompt).toBeUndefined();
    expect(JSON.stringify(e)).not.toContain("空间总纲");
    expect(JSON.stringify(e)).not.toContain("岗位说明");
  });

  it("定义文件缺失 → 抛「员工不存在」", () => {
    const ws = createWorkspace(tmp);
    expect(() => loadEmployee(ws, "nobody")).toThrow("员工不存在");
  });

  it("坏 JSON / 空文件 → 与空配置等价（不崩，model 为空）", () => {
    const ws = createWorkspace(tmp);
    fs.mkdirSync(path.join(tmp, "agents"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "agents", "carol.agent.config.json"), "{ not json");
    const e = loadEmployee(ws, "carol");
    expect(e.model).toEqual({ model: "" });
    expect(e.skills).toEqual([]);
    expect(e.mcp).toEqual([]);
    expect(e.prompt).toBeUndefined();
    expect(e.permissions).toBeUndefined();

    // 真·空文件（0 字节）走同一兜底：按空配置处理，不崩
    fs.writeFileSync(path.join(tmp, "agents", "dan.agent.config.json"), "");
    const empty = loadEmployee(ws, "dan");
    expect(empty.model).toEqual({ model: "" });
    expect(empty.prompt).toBeUndefined();
    expect(empty.skills).toEqual([]);
  });

  it("thinkingLevel 只接受非空字符串（trim）；数字 / null / 空串忽略", () => {
    const ws = createWorkspace(tmp);
    seed("henry", { model: "faux/m", thinkingLevel: 42 });
    expect(loadEmployee(ws, "henry").model).toEqual({ model: "faux/m" });
    seed("henry", { model: "faux/m", thinkingLevel: "  high  " });
    expect(loadEmployee(ws, "henry").model).toEqual({ model: "faux/m", thinkingLevel: "high" });
    seed("henry", { model: "faux/m", thinkingLevel: "   " });
    expect(loadEmployee(ws, "henry").model).toEqual({ model: "faux/m" });
    seed("henry", { model: "faux/m", thinkingLevel: null });
    expect(loadEmployee(ws, "henry").model).toEqual({ model: "faux/m" });
  });

  it("alias / prompt 两端空白被 trim", () => {
    const ws = createWorkspace(tmp);
    seed("grace", { alias: "  阿草  ", prompt: "  你是阿草。  " });
    expect(loadEmployee(ws, "grace").alias).toBe("阿草");
    expect(loadEmployee(ws, "grace").prompt).toBe("你是阿草。");
  });

  it("permissions 按 config 读出（工具 → 路径表）", () => {
    const ws = createWorkspace(tmp);
    seed("pat", { permissions: { write: ["./out"], read: ["./"] } });
    expect(loadEmployee(ws, "pat").permissions).toEqual({ write: ["./out"], read: ["./"] });
  });

  it("renderInstructions = prompt（缺省空串）", () => {
    const ws = createWorkspace(tmp);
    seed("alice", { prompt: "你是 alice。" });
    expect(renderInstructions(loadEmployee(ws, "alice"))).toBe("你是 alice。");
    seed("earl", {});
    expect(renderInstructions(loadEmployee(ws, "earl"))).toBe("");
  });
});

it("memoryEnabled：员工显式值覆盖空间默认；缺省为 true", () => {
  const ws = createWorkspace(tmp);
  seed("alice", {});
  expect(loadEmployee(ws, "alice").memoryEnabled).toBe(true);

  seed("alice", { memory: false });
  expect(loadEmployee(ws, "alice").memoryEnabled).toBe(false);

  seed("alice", {});
  fs.mkdirSync(path.join(tmp, "openstaffs", ".data"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "openstaffs", ".data", "config.json"), JSON.stringify({ memory: false }));
  expect(loadEmployee(ws, "alice").memoryEnabled).toBe(false);

  seed("alice", { memory: true });
  expect(loadEmployee(ws, "alice").memoryEnabled).toBe(true);
});

it("listEmployees：按 id 排序、跳过隐藏项与无定义文件的目录", () => {
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-list-"));
  try {
    fs.mkdirSync(path.join(root2, "agents"), { recursive: true });
    for (const id of ["bob", "alice"]) {
      fs.writeFileSync(path.join(root2, "agents", `${id}.agent.config.json`), "{}\n");
    }
    fs.mkdirSync(path.join(root2, "agents", "eng"), { recursive: true }); // 无定义文件的部门目录
    fs.mkdirSync(path.join(root2, "agents", ".hidden"), { recursive: true });
    fs.writeFileSync(path.join(root2, "agents", ".hidden", "x.agent.config.json"), "{}\n");
    const ws = createWorkspace(root2);
    expect(listEmployees(ws).map((e) => e.id)).toEqual(["alice", "bob"]);
  } finally {
    fs.rmSync(root2, { recursive: true, force: true });
  }
});
