import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import {
  AGENT_CONFIG_SUFFIX, agentConfigFileName, agentIdOfConfigFile, scanOrg,
} from "../../src/domain/org-config.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-orgcfg-"));
beforeEach(() => { fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root, { recursive: true }); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const ws = createWorkspace(root);

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe("命名解析", () => {
  it("文件名 ↔ 人 id", () => {
    expect(AGENT_CONFIG_SUFFIX).toBe(".agent.config.json");
    expect(agentConfigFileName("alice")).toBe("alice.agent.config.json");
    expect(agentIdOfConfigFile("alice.agent.config.json")).toBe("alice");
    expect(agentIdOfConfigFile("platform/dave.agent.config.json")).toBeUndefined(); // 只认纯文件名
    expect(agentIdOfConfigFile(".agent.config.json")).toBeUndefined(); // 空 id
    expect(agentIdOfConfigFile("department.config.json")).toBeUndefined();
    expect(agentIdOfConfigFile("alice.json")).toBeUndefined();
  });
});

describe("scanOrg", () => {
  it("缺 agents/ 也给根部门（不抛）；目录 = 部门、可嵌套；root 直属的人在根部门", () => {
    const scan = scanOrg(ws);
    expect(scan.departments.map((d) => d.path)).toEqual([""]);
    expect(scan.agents).toEqual([]);
    expect(scan.warnings).toEqual([]);

    write(path.join(root, "agents", "staff0.agent.config.json"), JSON.stringify({ prompt: "管家" }));
    write(path.join(root, "agents", "eng", "department.config.json"), JSON.stringify({ alias: "研发", head: ["alice"] }));
    write(path.join(root, "agents", "eng", "alice.agent.config.json"), JSON.stringify({ alias: "爱丽丝", model: "faux/m", prompt: "你是 alice。" }));
    write(path.join(root, "agents", "eng", "platform", "bob.agent.config.json"), JSON.stringify({ prompt: "你是 bob。" }));

    const scan2 = scanOrg(ws);
    expect(scan2.departments.map((d) => d.path)).toEqual(["", "eng", "eng/platform"]);
    expect(scan2.departments.find((d) => d.path === "eng")).toEqual({
      path: "eng", name: "eng", dir: path.join(root, "agents", "eng"),
      file: path.join(root, "agents", "eng", "department.config.json"), alias: "研发", head: ["alice"],
    });
    expect(scan2.agents.map((a) => [a.id, a.departmentPath])).toEqual([["staff0", ""], ["alice", "eng"], ["bob", "eng/platform"]]);
    expect(scan2.agents[1]).toEqual({
      id: "alice", dir: path.join(root, "agents", "eng"), departmentPath: "eng",
      file: path.join(root, "agents", "eng", "alice.agent.config.json"),
      alias: "爱丽丝", model: { model: "faux/m" }, prompt: "你是 alice。",
    });
  });

  it("坏 JSON / 缺字段 / 非字符串字段 → 按缺省，不抛", () => {
    write(path.join(root, "agents", "bad.agent.config.json"), "{不是 JSON");
    write(path.join(root, "agents", "lazy.agent.config.json"), JSON.stringify({ alias: 42, model: 7, prompt: null, thinkingLevel: 3 }));
    write(path.join(root, "agents", "eng", "department.config.json"), JSON.stringify({ head: "alice", alias: "  " }));

    const scan = scanOrg(ws);
    expect(scan.agents.find((a) => a.id === "bad")).toEqual({
      id: "bad", dir: path.join(root, "agents"), departmentPath: "",
      file: path.join(root, "agents", "bad.agent.config.json"), model: { model: "" }, prompt: "",
    });
    const lazy = scan.agents.find((a) => a.id === "lazy")!;
    expect(lazy.alias).toBeUndefined();
    expect(lazy.model).toEqual({ model: "" });
    expect(lazy.prompt).toBe("");
    expect(scan.departments.find((d) => d.path === "eng")).toEqual({
      path: "eng", name: "eng", dir: path.join(root, "agents", "eng"),
      file: path.join(root, "agents", "eng", "department.config.json"), head: [],
    });
  });

  it("thinkingLevel / alias 两端空白被 trim；head 只留非空字符串", () => {
    write(path.join(root, "agents", "alice.agent.config.json"), JSON.stringify({ alias: "  爱丽丝  ", model: " faux/m ", thinkingLevel: " high " }));
    write(path.join(root, "agents", "eng", "department.config.json"), JSON.stringify({ head: [" alice ", "", 3, null] }));
    const scan = scanOrg(ws);
    expect(scan.agents[0]!.alias).toBe("爱丽丝");
    expect(scan.agents[0]!.model).toEqual({ model: "faux/m", thinkingLevel: "high" });
    expect(scan.departments.find((d) => d.path === "eng")!.head).toEqual(["alice"]);
  });

  it("跳过隐藏目录 / 隐藏文件；其它 json 不算人", () => {
    write(path.join(root, "agents", ".hidden", "x.agent.config.json"), JSON.stringify({ prompt: "x" }));
    write(path.join(root, "agents", ".hidden.agent.config.json"), JSON.stringify({ prompt: "x" }));
    write(path.join(root, "agents", "notes.json"), JSON.stringify({ prompt: "x" }));
    write(path.join(root, "agents", "alice.agent.config.json"), JSON.stringify({ prompt: "ok" }));
    const scan = scanOrg(ws);
    expect(scan.agents.map((a) => a.id)).toEqual(["alice"]);
    expect(scan.departments.map((d) => d.path)).toEqual([""]);
  });

  it("id 含空白 / @ / 保留前缀 __ → 收录但记 warnings", () => {
    write(path.join(root, "agents", "bad name.agent.config.json"), JSON.stringify({ prompt: "x" }));
    write(path.join(root, "agents", "a@b.agent.config.json"), JSON.stringify({ prompt: "x" }));
    write(path.join(root, "agents", "__boss.agent.config.json"), JSON.stringify({ prompt: "x" }));
    const scan = scanOrg(ws);
    expect(scan.agents.map((a) => a.id).sort()).toEqual(["__boss", "a@b", "bad name"]);
    expect(scan.warnings).toHaveLength(3);
    expect(scan.warnings.join("\n")).toContain("bad name");
    expect(scan.warnings.join("\n")).toContain("__boss");
  });
});
