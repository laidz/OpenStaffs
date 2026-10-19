import { expect, test } from "vitest";
import { renderPromptChain } from "../../src/capabilities/prompt.ts";
import { emptyConfigFields, type LoadedConfig, type ScopeKind } from "../../src/config/schema.ts";
import { renderTemplate } from "../../src/domain/prompt.ts";
import type { PromptVarContext } from "../../src/domain/prompt-vars.ts";
import { builtinSpacePrompt } from "../../src/domain/space.ts";

const ctx: PromptVarContext = { ws: { root: "/office" }, kind: "dm", selfId: "alice", cwd: "/office/work/alice" };

/** 夹具：最小 `LoadedConfig`（本用例只关心 `fields.prompt`，其余为空）。 */
function loaded(scope: ScopeKind, id: string, prompt?: string): LoadedConfig {
  return {
    scope,
    id,
    file: `/office/${id}.config.json`,
    baseDir: "/office",
    fields: { ...emptyConfigFields(), ...(prompt === undefined ? {} : { prompt }) },
    issues: [],
  };
}

test("按作用域顺序拼接，空段丢弃，段落间 `\\n\\n`", () => {
  const text = renderPromptChain(
    [loaded("space", "space", "空间规矩。"), loaded("department", "eng"), loaded("agent", "alice", "你是爱丽丝。")],
    ctx,
  );
  expect(text).toBe("空间规矩。\n\n你是爱丽丝。");
});

test("每段都过变量渲染；只有空白 → 当空段丢弃", () => {
  const text = renderPromptChain([loaded("agent", "alice", "你是 {{agent_id}}，在 {{workdir}} 干活。")], ctx);
  expect(text).toBe("你是 alice，在 /office/work/alice 干活。");
  expect(renderPromptChain([loaded("agent", "alice", "   ")], ctx)).toBe("");
});

test("每段 trim：首尾空白不残留", () => {
  expect(renderPromptChain([loaded("agent", "alice", "\n  你是爱丽丝。\n\n")], ctx)).toBe("你是爱丽丝。");
});

test("同值重复保留（D10 无去重 / 无覆盖）", () => {
  const text = renderPromptChain([loaded("department", "eng", "守规矩。"), loaded("agent", "alice", "守规矩。")], ctx);
  expect(text).toBe("守规矩。\n\n守规矩。");
});

test("空链 → 空串", () => {
  expect(renderPromptChain([], ctx)).toBe("");
});

test("session_kind 变量：私聊 dm / 群聊 group（内置 prompt 用它区分文案）", () => {
  const groupCtx: PromptVarContext = { ...ctx, kind: "group", projectId: "seo" };
  expect(renderTemplate("当前会话：{{session_kind}}", groupCtx)).toBe("当前会话：group");
  expect(renderTemplate("当前会话：{{session_kind}}", ctx)).toBe("当前会话：dm");
});

test("内置 space.md 的群聊规则由 group_rules 门控：私聊不含 @ 规则，群聊含", () => {
  const space = loaded("space", "space", builtinSpacePrompt());
  const groupCtx: PromptVarContext = { ...ctx, kind: "group", projectId: "seo" };
  const dm = renderPromptChain([space], ctx);
  const group = renderPromptChain([space], groupCtx);
  // 仅群聊成立的硬规则绝不出现在私聊
  expect(dm).not.toContain("每条消息都以 @ 开头");
  expect(dm).not.toContain("群聊规则：");
  expect(dm).not.toContain("派活一次说完");
  // 群聊出现（含 @ 规则与派活礼仪）
  expect(group).toContain("每条消息都以 @ 开头");
  expect(group).toContain("群聊规则：");
  expect(group).toContain("派活一次说完");
  // 两种会话共有的规则仍在（大内容走文件 / 收敛即停）
  expect(dm).toContain("大内容走文件");
  expect(group).toContain("大内容走文件");
});
