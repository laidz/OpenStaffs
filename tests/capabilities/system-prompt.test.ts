import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  renderMemoryPrompt, renderSystemPrompt, SYSTEM_PROMPT_TEMPLATES,
} from "../../src/capabilities/system-prompt.ts";
import { writeProfile } from "../../src/domain/memory/store.ts";
import { createWorkspace } from "../../src/domain/paths.ts";
import type { PromptVarContext } from "../../src/domain/prompt-vars.ts";
import { seedOffice } from "../helpers/office.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-system-prompt-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function ctx(kind: "dm" | "group", projectId?: string): PromptVarContext {
  return {
    ws: createWorkspace(root),
    kind,
    selfId: "alice",
    ...(projectId === undefined ? {} : { projectId }),
    cwd: path.join(root, "work", "alice"),
  };
}

describe("系统级 prompt", () => {
  it("四个模板都存在且非空", () => {
    for (const name of ["environment", "dm", "group", "memory"] as const) {
      expect(SYSTEM_PROMPT_TEMPLATES[name].trim().length).toBeGreaterThan(0);
    }
  });

  it("环境段：身份 / 私人目录 / 负责人 / 权限边界", () => {
    seedOffice(root, { agents: [{ id: "alice", alias: "爱丽丝" }] });
    const text = renderSystemPrompt(ctx("dm"));
    expect(text).toContain("OpenStaffs");
    expect(text).toContain("爱丽丝");
    expect(text).toContain("alice");
    expect(text).toContain(path.join(root, "work", "alice"));
    expect(text).toContain("老板");
    expect(text).toContain("request_permission");
  });

  it("私聊：含私聊前缀，不含群聊规则", () => {
    seedOffice(root, { agents: [{ id: "alice" }] });
    const text = renderSystemPrompt(ctx("dm"));
    expect(text).toContain("1 对 1 私聊");
    expect(text).not.toContain("群聊规则");
    expect(text).not.toContain("每条消息都以 @ 开头");
    expect(text).not.toContain("派活一次说完");
  });

  it("群聊：项目 / 成员 / 负责人 / @ 规则 / 派活礼仪", () => {
    seedOffice(root, {
      agents: [{ id: "alice", alias: "爱丽丝" }, { id: "bob" }],
      projects: [{ id: "demo", alias: "演示项目", members: ["alice", "bob"] }],
    });
    const text = renderSystemPrompt(ctx("group", "demo"));
    expect(text).toContain("演示项目");
    expect(text).toContain("demo");
    expect(text).toContain("爱丽丝");
    expect(text).toContain("bob");
    expect(text).toContain("每条消息都以 @ 开头");
    expect(text).toContain("派活一次说完");
    expect(text).toContain("@老板");
  });

  it("记忆：含工具说明；关闭为空串；无 profile 时只留说明", () => {
    seedOffice(root, { agents: [{ id: "alice" }] });
    const withTools = renderMemoryPrompt(ctx("dm"), true);
    expect(withTools).toContain("## 使用记忆");
    expect(withTools).toContain("memory_profile");
    expect(withTools).toContain("memory_add");
    expect(withTools).toContain("memory_get");
    expect(withTools).toContain("memory_list");
    expect(withTools).not.toContain("## 你的记忆");

    expect(renderMemoryPrompt(ctx("dm"), false)).toBe("");

    writeProfile(createWorkspace(root), "alice", "我是 alice");
    const withProfile = renderMemoryPrompt(ctx("dm"), true);
    expect(withProfile).toContain("## 你的记忆");
    expect(withProfile).toContain("我是 alice");
  });
});
