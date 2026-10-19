import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { promptTemplatePath, renderEnvironment, renderTemplate } from "../../src/domain/prompt.ts";
import type { PromptVarContext } from "../../src/domain/prompt-vars.ts";
import { seedOffice } from "../helpers/office.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-prompt-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** 会话 cwd = 自己的工作目录（D25：群聊也用发言人自己的 work/<id>）。 */
function dmCtx(selfId: string): PromptVarContext {
  return { ws: createWorkspace(root), kind: "dm", selfId, cwd: path.join(root, "work", selfId) };
}

function groupCtx(project: string, selfId: string): PromptVarContext {
  return { ws: createWorkspace(root), kind: "group", selfId, projectId: project, cwd: path.join(root, "work", selfId) };
}

describe("模板渲染", () => {
  it("替换变量；容错空格；多级点号与下标访问", () => {
    seedOffice(root, {
      agents: [{ id: "alice", alias: "爱丽丝" }],
      projects: [{ id: "demo", alias: "演示项目", members: ["alice"] }],
    });
    const group = groupCtx("demo", "alice");
    expect(renderTemplate("你好 {{agent_name}}（{{ agent_id }}）", group)).toBe("你好 爱丽丝（alice）");
    expect(renderTemplate("{{members.0.name}}", group)).toBe("爱丽丝");
    expect(renderTemplate("{{members[0].name}}", group)).toBe("爱丽丝");
  });

  it("未知变量 / 越界下标 / 私聊取 project_* → 空串", () => {
    seedOffice(root, {
      agents: [{ id: "alice", alias: "爱丽丝" }],
      projects: [{ id: "demo", alias: "演示项目", members: ["alice"] }],
    });
    const group = groupCtx("demo", "alice");
    expect(renderTemplate("[{{nope}}][{{members.9.name}}]", group)).toBe("[][]");
    expect(renderTemplate("[{{project_name}}]", dmCtx("alice"))).toBe("[]");
  });

  it("非标量：数组用「、」连接、对象取 name", () => {
    seedOffice(root, {
      agents: [{ id: "alice", alias: "爱丽丝" }, { id: "bob" }],
      projects: [{ id: "demo", alias: "演示项目", members: ["alice", "bob"] }],
    });
    const group = groupCtx("demo", "alice");
    expect(renderTemplate("成员：{{members}}", group)).toBe("成员：爱丽丝、bob");
    expect(renderTemplate("{{members.1}}", group)).toBe("bob");
  });
});

describe("模板文件定位", () => {
  it("模板固定指向系统内置（src/prompts/<kind>.md）；空间不可覆盖", () => {
    const dm = promptTemplatePath("dm");
    const group = promptTemplatePath("group");
    expect(dm.endsWith(path.join("src", "prompts", "dm.md"))).toBe(true);
    expect(group.endsWith(path.join("src", "prompts", "group.md"))).toBe(true);
    expect(fs.existsSync(dm)).toBe(true);
    expect(fs.existsSync(group)).toBe(true);
  });

  it("空间不可覆盖：磁盘上存在 openstaffs/.data/prompts/dm.md 也不影响输出", () => {
    seedOffice(root, { agents: [{ id: "alice" }] });
    const override = path.join(root, "openstaffs/.data", "prompts", "dm.md");
    fs.mkdirSync(path.dirname(override), { recursive: true });
    fs.writeFileSync(override, "覆盖段：不该出现");
    expect(promptTemplatePath("dm").endsWith(path.join("src", "prompts", "dm.md"))).toBe(true);
    expect(renderEnvironment(dmCtx("alice"))).not.toContain("覆盖段");
  });
});

describe("环境段渲染", () => {
  it("渲染框架默认模板：含员工、老板、工作目录；trim 且无残留占位符", () => {
    seedOffice(root, { agents: [{ id: "alice", alias: "爱丽丝" }] });
    const out = renderEnvironment(dmCtx("alice"));
    expect(out).toContain("爱丽丝");
    expect(out).toContain("老板");
    expect(out).toContain(path.join(root, "work", "alice"));
    expect(out).not.toContain("{{");
    expect(out).toBe(out.trim());
  });

  it("bossName 自定义：环境段用真称谓，@ 语法教真称谓", () => {
    seedOffice(root, {
      agents: [{ id: "alice" }],
      projects: [{ id: "demo", members: ["alice"] }],
    });
    fs.mkdirSync(path.join(root, "openstaffs/.data"), { recursive: true });
    fs.writeFileSync(path.join(root, "openstaffs/.data", "config.json"), JSON.stringify({ bossName: "掌柜" }));
    const out = renderEnvironment(groupCtx("demo", "alice"));
    expect(out).toContain("「掌柜」");
    expect(out).toContain("把 `@掌柜` 写在最前面");
    expect(out).toContain("`@老板`、`@boss` 同样有效");
    expect(out).toContain("自动补 `@掌柜`");
  });
});
