import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { renderTemplate } from "../../src/domain/prompt.ts";
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
