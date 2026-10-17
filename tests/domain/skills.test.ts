import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listSkills, renderSkills } from "../../src/domain/skills.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-skill-"));
beforeEach(() => { fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root, { recursive: true }); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function skill(dir: string, name: string, content: string) {
  const d = path.join(dir, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "SKILL.md"), content);
}

describe("listSkills", () => {
  const groupDir = () => path.join(root, "group-skills");
  const agentDir = () => path.join(root, "agent-skills");

  it("从 YAML frontmatter 读 name/description", () => {
    skill(groupDir(), "report", "---\nname: 写报告\ndescription: 生成周报\n---\n\n正文");
    expect(listSkills([groupDir()])).toEqual([
      { name: "写报告", description: "生成周报", dir: path.join(groupDir(), "report") },
    ]);
  });

  it("无 frontmatter 时 name = 目录名、description 为空", () => {
    skill(groupDir(), "plain", "没有 frontmatter");
    expect(listSkills([groupDir()])).toEqual([
      { name: "plain", description: "", dir: path.join(groupDir(), "plain") },
    ]);
  });

  it("顺序：按 dirs 顺序（群在前），目录内按名字排序", () => {
    skill(groupDir(), "b", "---\nname: 群B\ndescription: gb\n---\n");
    skill(groupDir(), "a", "---\nname: 群A\ndescription: ga\n---\n");
    skill(agentDir(), "z", "---\nname: 员Z\ndescription: az\n---\n");
    expect(listSkills([groupDir(), agentDir()]).map((s) => s.name)).toEqual(["群A", "群B", "员Z"]);
  });

  it("同名去重：先出现者胜（群技能优先）", () => {
    skill(groupDir(), "x", "---\nname: dup\ndescription: from-group\n---\n");
    skill(agentDir(), "y", "---\nname: dup\ndescription: from-agent\n---\n");
    const skills = listSkills([groupDir(), agentDir()]);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.description).toBe("from-group");
  });

  it("缺失目录/非目录项/隐藏项与 node_modules 跳过，不崩溃", () => {
    skill(groupDir(), "ok", "---\nname: ok\n---\n");
    fs.mkdirSync(path.join(groupDir(), ".hidden"), { recursive: true });
    fs.mkdirSync(path.join(groupDir(), "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(groupDir(), "file.txt"), "x");
    expect(listSkills([path.join(root, "nope"), groupDir()]).map((s) => s.name)).toEqual(["ok"]);
  });

  it("CRLF 换行也能读 frontmatter", () => {
    skill(groupDir(), "crlf", "---\r\nname: crlf-name\r\ndescription: crlf-desc\r\n---\r\n正文");
    expect(listSkills([groupDir()])).toEqual([
      { name: "crlf-name", description: "crlf-desc", dir: path.join(groupDir(), "crlf") },
    ]);
  });

  it("--- 未闭合时视为无 frontmatter（不劫持正文）", () => {
    skill(groupDir(), "unclosed", "---\nname: hijacked\ndescription: hijacked-desc\n\n正文");
    expect(listSkills([groupDir()])).toEqual([
      { name: "unclosed", description: "", dir: path.join(groupDir(), "unclosed") },
    ]);
  });

  it("没有 SKILL.md 的目录不算技能", () => {
    skill(groupDir(), "real", "---\nname: real\n---\n");
    fs.mkdirSync(path.join(groupDir(), "ghost"), { recursive: true });
    expect(listSkills([groupDir()]).map((s) => s.name)).toEqual(["real"]);
  });
});

describe("renderSkills", () => {
  it("空列表 → 空串", () => {
    expect(renderSkills([])).toBe("");
  });

  it("渲染 name + description（无描述只列名字）", () => {
    const text = renderSkills([
      { name: "写报告", description: "生成周报", dir: "/x" },
      { name: "nop", description: "", dir: "/y" },
    ]);
    expect(text).toContain("## 可用技能");
    expect(text).toContain("- 写报告：生成周报");
    expect(text).toContain("- nop");
  });

  it("目录项带 SKILL.md 位置（供 agent 按需 read 激活）", () => {
    const text = renderSkills([{ name: "写报告", description: "生成周报", dir: "/x/report" }]);
    expect(text).toContain(`位置：${path.join("/x/report", "SKILL.md")}`);
  });

  it("带「按位置 read」的用法说明", () => {
    const text = renderSkills([{ name: "s", description: "d", dir: "/x/s" }]);
    expect(text).toContain("当任务匹配某技能的描述时");
    expect(text).toContain("read");
    expect(text).toContain(path.join("/x/s", "SKILL.md"));
  });
});
