import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import type { OrgScan } from "../../src/domain/org-config.ts";
import {
  ancestryOf, buildOrg, departmentAt, findPerson, headsOf, isInSubtree,
  listPeople, loadOrg, loadPerson, managedDepartmentsOf, managedSubtreeOf, personDisplayName,
} from "../../src/domain/org.ts";

/** 手搭扫描结果：不碰文件系统，专测结构运算。 */
function scan(parts: { departments?: [string, string[]][]; agents?: [string, string, string?][] }): OrgScan {
  const departments = [["", [], "agents"] as [string, string[], string]];
  return {
    departments: [...departments, ...(parts.departments ?? []).map(([p, head]) => [p, head, p.split("/").at(-1)!] as [string, string[], string])]
      .map(([p, head, name]) => ({ path: p, name, dir: `/ws/agents/${p}`, file: `/ws/agents/${p}/department.config.json`, head })),
    agents: (parts.agents ?? []).map(([id, deptPath, alias]) => ({
      id, dir: `/ws/agents/${deptPath}`, departmentPath: deptPath, file: `/ws/agents/${deptPath}/${id}.agent.config.json`,
      model: { model: "" }, prompt: `你是 ${id}。`, ...(alias === undefined ? {} : { alias }),
    })),
    warnings: [],
  };
}

// 树：根（staff0）→ eng[alice]（head=alice）→ eng/platform[bob, carol]
const TREE = buildOrg(
  scan({
    departments: [["eng", ["alice"]], ["eng/platform", ["bob"]]],
    agents: [["staff0", ""], ["alice", "eng", "爱丽丝"], ["bob", "eng/platform"], ["carol", "eng/platform"]],
  }),
);

describe("组织树", () => {
  it("部门嵌套、人在其所在部门；根部门恒在", () => {
    expect(TREE.root.path).toBe("");
    expect(TREE.root.people.map((p) => p.id)).toEqual(["staff0"]);
    expect(TREE.root.departments.map((d) => d.path)).toEqual(["eng"]);
    expect(departmentAt(TREE, "eng")!.departments.map((d) => d.path)).toEqual(["eng/platform"]);
    expect(departmentAt(TREE, "eng/platform")!.people.map((p) => p.id)).toEqual(["bob", "carol"]);
    expect(TREE.people.map((p) => p.id)).toEqual(["staff0", "alice", "bob", "carol"]);
  });

  it("findPerson / loadPerson / personDisplayName", () => {
    expect(findPerson(TREE, "alice")!.alias).toBe("爱丽丝");
    expect(findPerson(TREE, "nobody")).toBeUndefined();
  });

  it("人 id 重复：保留第一个 + warning（不抛、不双房间）", () => {
    const dup = buildOrg(scan({ departments: [["eng", []]], agents: [["bob", ""], ["bob", "eng"]] }));
    expect(dup.people.map((p) => p.id)).toEqual(["bob"]);
    expect(dup.people[0]!.departmentPath).toBe("");
    expect(dup.warnings.join("\n")).toContain("重复");
    expect(departmentAt(dup, "eng")!.people).toEqual([]);
  });
});

describe("负责人（head）", () => {
  it("只认本级直属成员；写子部门成员 / 写错 id → 视为无 + warning", () => {
    expect(headsOf(TREE, "eng")).toEqual(["alice"]);
    const bad = buildOrg(scan({ departments: [["eng", ["bob", "ghost"]]], agents: [["bob", "eng/platform"], ["alice", "eng"]] }));
    expect(headsOf(bad, "eng")).toEqual([]);
    expect(bad.warnings.join("\n")).toContain("ghost");
    expect(bad.warnings.join("\n")).toContain("bob");
  });

  it("ancestryOf：自根到该部门；未知路径 → 空", () => {
    expect(ancestryOf(TREE, "eng/platform").map((d) => d.path)).toEqual(["", "eng", "eng/platform"]);
    expect(ancestryOf(TREE, "nope")).toEqual([]);
  });
});

describe("穿透管理权", () => {
  it("管理者的范围 = 其所在部门的整棵子树（任意深度）", () => {
    expect(managedDepartmentsOf(TREE, "alice")).toEqual(["eng"]);
    expect(managedDepartmentsOf(TREE, "staff0")).toEqual([]); // 不是任何部门的 head
  });

  it("isInSubtree：根包含一切；前缀相同但不是子目录 → false", () => {
    expect(isInSubtree("", "eng/platform")).toBe(true);
    expect(isInSubtree("eng", "eng/platform")).toBe(true);
    expect(isInSubtree("eng", "eng")).toBe(true);
    expect(isInSubtree("eng", "english")).toBe(false);
    expect(isInSubtree("eng", "")).toBe(false);
  });

});

describe("loadOrg（走盘）", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-org-"));
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function write(file: string, content: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  it("从 agents/ 建树；人不存在时 loadPerson 抛错、personDisplayName 回落 id", () => {
    write(path.join(root, "agents", "eng", "department.config.json"), JSON.stringify({ head: ["alice"] }));
    write(path.join(root, "agents", "eng", "alice.agent.config.json"), JSON.stringify({ alias: "爱丽丝", prompt: "你是 alice。" }));
    const ws = createWorkspace(root);
    const tree = loadOrg(ws);
    expect(tree.people.map((p) => p.id)).toEqual(["alice"]);
    expect(loadPerson(ws, "alice").prompt).toBe("你是 alice。");
    expect(() => loadPerson(ws, "ghost")).toThrow("员工不存在");
    expect(personDisplayName(ws, "alice")).toBe("爱丽丝");
    expect(personDisplayName(ws, "ghost")).toBe("ghost");
    expect(listPeople(ws).map((p) => p.id)).toEqual(["alice"]);
  });
});

describe("managedSubtreeOf（走盘；B2 给 P3 的适配器）", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-subtree-"));
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function write(file: string, content: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  it("给出子树内全部部门目录与全部人所在目录（任意深度、目录去重）；非 head → 空", () => {
    write(path.join(root, "agents", "eng", "department.config.json"), JSON.stringify({ head: ["alice"] }));
    write(path.join(root, "agents", "eng", "alice.agent.config.json"), JSON.stringify({ prompt: "你是 alice。" }));
    write(path.join(root, "agents", "eng", "platform", "bob.agent.config.json"), JSON.stringify({ prompt: "你是 bob。" }));
    write(path.join(root, "agents", "eng", "platform", "carol.agent.config.json"), JSON.stringify({ prompt: "你是 carol。" }));
    write(path.join(root, "agents", "sales", "dave.agent.config.json"), JSON.stringify({ prompt: "你是 dave。" }));
    const ws = createWorkspace(root);
    expect(managedSubtreeOf(ws, "alice")).toEqual({
      // eng + eng/platform（含孙级）
      departmentDirs: [path.join(root, "agents", "eng"), path.join(root, "agents", "eng", "platform")],
      // alice（eng）/ bob、carol（eng/platform）→ 按目录去重；sales 不在子树内
      agentDirs: [path.join(root, "agents", "eng"), path.join(root, "agents", "eng", "platform")],
    });
    expect(managedSubtreeOf(ws, "dave")).toEqual({ departmentDirs: [], agentDirs: [] }); // 不是任何部门的 head
  });
});
