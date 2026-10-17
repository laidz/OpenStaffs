import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { promptTemplatePath, renderEnvironment, renderTemplate } from "../../src/domain/prompt.ts";
import type { PromptVarContext } from "../../src/domain/prompt-vars.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-prompt-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function seedEmployee(id: string, alias?: string): void {
  const dir = path.join(root, "agents", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "AGENTS.md"), `你是 ${id}。`);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(alias === undefined ? {} : { alias }));
}

function seedProject(id: string, memberIds: string[], alias?: string): void {
  const dir = path.join(root, "projects", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "members.md"), memberIds.map((m) => `- ${m}`).join("\n") + "\n");
  if (alias !== undefined) fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ alias }));
}

function dmCtx(selfId: string): PromptVarContext {
  return { ws: createWorkspace(root), kind: "dm", selfId, cwd: path.join(root, "agents", selfId) };
}

function groupCtx(project: string, selfId: string): PromptVarContext {
  return { ws: createWorkspace(root), kind: "group", selfId, projectId: project, cwd: path.join(root, "projects", project) };
}

describe("模板渲染", () => {
  it("替换变量；容错空格；多级点号与下标访问", () => {
    seedEmployee("alice", "爱丽丝");
    seedProject("demo", ["alice"], "演示项目");
    const group = groupCtx("demo", "alice");
    expect(renderTemplate("你好 {{agent_name}}（{{ agent_id }}）", group)).toBe("你好 爱丽丝（alice）");
    expect(renderTemplate("{{members.0.name}}", group)).toBe("爱丽丝");
    expect(renderTemplate("{{members[0].name}}", group)).toBe("爱丽丝");
  });

  it("未知变量 / 越界下标 / 私聊取 project_* → 空串", () => {
    seedEmployee("alice", "爱丽丝");
    seedProject("demo", ["alice"], "演示项目");
    const group = groupCtx("demo", "alice");
    expect(renderTemplate("[{{nope}}][{{members.9.name}}]", group)).toBe("[][]");
    expect(renderTemplate("[{{project_name}}]", dmCtx("alice"))).toBe("[]");
  });

  it("非标量：数组用「、」连接、对象取 name", () => {
    seedEmployee("alice", "爱丽丝");
    seedEmployee("bob");
    seedProject("demo", ["alice", "bob"], "演示项目");
    const group = groupCtx("demo", "alice");
    expect(renderTemplate("成员：{{members}}", group)).toBe("成员：爱丽丝、bob");
    expect(renderTemplate("{{members.1}}", group)).toBe("bob");
  });
});

describe("模板文件定位", () => {
  it("默认指向框架模板（src/prompts/<kind>.md）", () => {
    const ws = createWorkspace(root);
    const dm = promptTemplatePath(ws, "dm");
    const group = promptTemplatePath(ws, "group");
    expect(dm.endsWith(path.join("src", "prompts", "dm.md"))).toBe(true);
    expect(group.endsWith(path.join("src", "prompts", "group.md"))).toBe(true);
    expect(fs.existsSync(dm)).toBe(true);
    expect(fs.existsSync(group)).toBe(true);
  });

  it("办公目录覆盖优先，且不影响另一种会话", () => {
    const ws = createWorkspace(root);
    const override = path.join(root, ".openstaffs", "prompts", "dm.md");
    fs.mkdirSync(path.dirname(override), { recursive: true });
    fs.writeFileSync(override, "覆盖段");
    expect(promptTemplatePath(ws, "dm")).toBe(override);
    expect(promptTemplatePath(ws, "group").endsWith(path.join("src", "prompts", "group.md"))).toBe(true);
  });
});

describe("环境段渲染", () => {
  it("渲染框架默认模板：含员工、老板、工作目录；trim 且无残留占位符", () => {
    seedEmployee("alice", "爱丽丝");
    const out = renderEnvironment(dmCtx("alice"));
    expect(out).toContain("爱丽丝");
    expect(out).toContain("老板");
    expect(out).toContain(path.join(root, "agents", "alice"));
    expect(out).not.toContain("{{");
    expect(out).toBe(out.trim());
  });

  it("办公覆盖模板生效", () => {
    seedEmployee("alice");
    const override = path.join(root, ".openstaffs", "prompts", "dm.md");
    fs.mkdirSync(path.dirname(override), { recursive: true });
    fs.writeFileSync(override, "自定义：{{agent_id}}@{{workdir}}");
    expect(renderEnvironment(dmCtx("alice"))).toBe(`自定义：alice@${path.join(root, "agents", "alice")}`);
  });

  it("覆盖文件为空 → 环境段为空串（不产出空段）", () => {
    seedEmployee("alice");
    const override = path.join(root, ".openstaffs", "prompts", "dm.md");
    fs.mkdirSync(path.dirname(override), { recursive: true });
    fs.writeFileSync(override, "   \n");
    expect(renderEnvironment(dmCtx("alice"))).toBe("");
  });

  it("bossName 自定义：环境段用真称谓，@ 语法教真称谓", () => {
    seedEmployee("alice");
    seedProject("demo", ["alice"]);
    fs.mkdirSync(path.join(root, ".openstaffs"), { recursive: true });
    fs.writeFileSync(path.join(root, ".openstaffs", "config.json"), JSON.stringify({ bossName: "掌柜" }));
    const out = renderEnvironment(groupCtx("demo", "alice"));
    expect(out).toContain("「掌柜」");
    expect(out).toContain("把 `@掌柜` 写在最前面");
    expect(out).toContain("`@老板`、`@boss` 同样有效");
    expect(out).toContain("自动补 `@掌柜`");
  });
});
