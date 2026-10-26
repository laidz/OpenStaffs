import { expect, test } from "vitest";
import type { AccessContext } from "../../src/domain/access-control.ts";
import {
  bashPathsIn,
  configNamesIn,
  gateToolCall,
  isAgentConfigName,
  isConfigNameIgnoringCase,
} from "../../src/tools/gate.ts";

const root = "/office";
const cwd = "/office/work/alice";

function access(permissions: Record<string, string[]>, selfId = "alice"): AccessContext {
  return { root, cwd, selfId, permissions };
}

const base = access({
  write: [cwd, "/office/agents/eng"],
  read: [cwd, "/office/agents/alice", "/office/openstaffs/skills"],
  bash: [cwd, "/office/agents/alice"],
});

/** 配置内容：恰好落在写者有效集之内（相对配置文件所在目录归一）。 */
const inBounds = JSON.stringify({ permissions: { write: ["./platform"] } });
/** 配置内容：超出写者有效集 → attenuation 必须拦下。 */
const outOfBounds = JSON.stringify({ permissions: { write: ["/etc"] } });

test("write：界内放行、界外拦下（提示走授权申请）", () => {
  expect(gateToolCall(base, { name: "write", arguments: { path: "notes.md", content: "x" } })).toBeUndefined();
  expect(gateToolCall(base, { name: "write", arguments: { path: "/office/agents/eng/dave.agent.config.json", content: "{}" } })?.block).toContain("staff0");
  expect(gateToolCall(base, { name: "write", arguments: { path: "dave.agent.config.json", content: "{}" } })).toBeDefined();
  expect(gateToolCall(base, { name: "write", arguments: { path: "/etc/passwd", content: "x" } })?.block).toContain("request_permission");
});

test("read 闸门按 read 工具的有效集判定", () => {
  expect(gateToolCall(base, { name: "read", arguments: { path: "/office/openstaffs/skills/report/SKILL.md" } })).toBeUndefined();
  expect(gateToolCall(base, { name: "read", arguments: { path: "/office/agents/bob/x.md" } })).toBeDefined();
});

// R-P3-4：配置规则是**写专属**——read 不受配置名分支影响（人可读配置）。
test("R-P3-4：read 配置名不受配置规则影响（越界才拦）", () => {
  const readable = [
    "/office/agents/alice/alice.agent.config.json",
    "/office/agents/alice/department.config.json",
    "/office/agents/alice/space.config.json",
    "/office/agents/alice/alice.project.config.json",
  ];
  for (const target of readable) {
    expect(gateToolCall(base, { name: "read", arguments: { path: target } }), target).toBeUndefined();
  }
  // 仍受 read 有效集约束：界外读照样拦。
  expect(gateToolCall(base, { name: "read", arguments: { path: "/office/agents/eng/dave.agent.config.json" } })).toBeDefined();
});

// R-P3-24：越界读用「读」专属文案，不得误导成"写"。
test("R-P3-24：read 越界文案是读专属（不提示写）", () => {
  const readVerdict = gateToolCall(base, { name: "read", arguments: { path: "/office/agents/bob/x.md" } });
  expect(readVerdict).toBeDefined();
  expect(readVerdict?.block).toContain("不可读");
  expect(readVerdict?.block).not.toContain("不可写");
  const writeVerdict = gateToolCall(base, { name: "write", arguments: { path: "/etc/passwd", content: "x" } });
  expect(writeVerdict?.block).toContain("不可写");
  expect(readVerdict?.block).not.toBe(writeVerdict?.block);
});

// R-P3-21（spec §6 / D8）：**唯一**硬保护 = 人的定义文件 `*.agent.config.json`（含自己的），大小写不敏感。
test("R-P3-21：仅 *.agent.config.json 硬拦（大小写不敏感，文案指向主管/老板）", () => {
  const blocked = [
    "/office/agents/eng/dave.agent.config.json",
    "/office/agents/alice/alice.agent.config.json",
    "/office/agents/eng/DAVE.AGENT.CONFIG.JSON",
    "/office/agents/eng/Dave.Agent.Config.Json",
  ];
  for (const target of blocked) {
    const verdict = gateToolCall(base, { name: "write", arguments: { path: target, content: "{}" } });
    expect(verdict, target).toBeDefined();
    expect(verdict?.block, target).toContain("不可写");
  }
  expect(isAgentConfigName("DAVE.AGENT.CONFIG.JSON")).toBe(true);
  expect(isAgentConfigName("dave.agent.config.json")).toBe(true);
  expect(isAgentConfigName("eng.project.config.json")).toBe(false);
  expect(isAgentConfigName("department.config.json")).toBe(false);
  expect(isAgentConfigName("notes.md")).toBe(false);
});

// R-P3-21（D8/D15）：department / space / project 配置**不硬拦**——主管写下级定义的正道，
// 走「write + attenuation（界内放行、越界拦）」。
test("R-P3-21：department / space / project 配置 write 走 attenuation，界内放行", () => {
  expect(
    gateToolCall(base, { name: "write", arguments: { path: "/office/agents/eng/department.config.json", content: inBounds } }),
  ).toBeUndefined();
  expect(
    gateToolCall(base, { name: "write", arguments: { path: "/office/agents/eng/eng.project.config.json", content: inBounds } }),
  ).toBeUndefined();
  expect(
    gateToolCall(base, { name: "write", arguments: { path: "/office/work/alice/space.config.json", content: inBounds } }),
  ).toBeUndefined();
  // 非配置名文件不注入 attenuation 校验（照常按路径判定）。
  expect(
    gateToolCall(base, { name: "write", arguments: { path: "/office/agents/eng/notes.json", content: outOfBounds } }),
  ).toBeUndefined();
});

test("R-P3-21：write 配置名（含大小写变体）permissions 越界 → attenuation 拦下", () => {
  const cases: Array<{ target: string; content: string }> = [
    { target: "/office/agents/eng/department.config.json", content: outOfBounds },
    { target: "/office/agents/eng/DEPARTMENT.CONFIG.JSON", content: outOfBounds },
    { target: "/office/agents/eng/FOO.PROJECT.CONFIG.JSON", content: outOfBounds },
    { target: "/office/agents/eng/Foo.Project.Config.Json", content: outOfBounds },
    { target: "/office/work/alice/SPACE.CONFIG.JSON", content: outOfBounds },
  ];
  for (const { target, content } of cases) {
    const verdict = gateToolCall(base, { name: "write", arguments: { path: target, content } });
    expect(verdict, target).toBeDefined();
    expect(verdict?.block, target).toContain("attenuation");
  }
  // 大小写变体必须被**识别为配置**（同一分支），不得漏到普通路径检查。
  expect(isConfigNameIgnoringCase("FOO.PROJECT.CONFIG.JSON")).toBe(true);
  expect(isConfigNameIgnoringCase("DEPARTMENT.CONFIG.JSON")).toBe(true);
  expect(isConfigNameIgnoringCase("SPACE.CONFIG.JSON")).toBe(true);
  expect(isConfigNameIgnoringCase("DAVE.AGENT.CONFIG.JSON")).toBe(true);
  expect(isConfigNameIgnoringCase("notes.md")).toBe(false);
  expect(isConfigNameIgnoringCase("bob.project.md")).toBe(false);
});

test("write 配置文件：不是合法 JSON / 顶层不是对象 → 拦下", () => {
  for (const target of ["/office/agents/eng/department.config.json", "/office/agents/eng/FOO.PROJECT.CONFIG.JSON"]) {
    expect(gateToolCall(base, { name: "write", arguments: { path: target, content: "{坏" } }), target).toBeDefined();
    expect(gateToolCall(base, { name: "write", arguments: { path: target, content: "[]" } }), target).toBeDefined();
  }
});

test("edit：任何配置名一律拦下（引导用 write 整体写入）；普通文件放行", () => {
  for (const target of [
    "/office/agents/eng/department.config.json",
    "/office/agents/eng/FOO.PROJECT.CONFIG.JSON",
    "/office/work/alice/SPACE.CONFIG.JSON",
  ]) {
    const verdict = gateToolCall(base, { name: "edit", arguments: { path: target, edits: [] } });
    expect(verdict, target).toBeDefined();
    expect(verdict?.block, target).toContain("write");
  }
  // agent config：edit 同样拦（硬保护优先，文案指向空间管家/老板）。
  expect(gateToolCall(base, { name: "edit", arguments: { path: "/office/agents/eng/DAVE.AGENT.CONFIG.JSON", edits: [] } })?.block).toContain("staff0");
  expect(gateToolCall(base, { name: "edit", arguments: { path: "/office/work/alice/notes.md", edits: [] } })).toBeUndefined();
});

test("bash：命令里的界外绝对路径拦下；普通命令放行；不是沙箱（只做近似检查）", () => {
  expect(gateToolCall(base, { name: "bash", arguments: { command: "echo hi && ls data" } })).toBeUndefined();
  expect(gateToolCall(base, { name: "bash", arguments: { command: "cat /etc/passwd" } })).toBeDefined();
  expect(gateToolCall(base, { name: "bash", arguments: { command: "rm -rf /office/projects" } })).toBeDefined();
  expect(bashPathsIn("cp a.txt /tmp/x", cwd)).toEqual(["/tmp/x"]);
});

// R-P3-4：bash 是写类工具（近似判定），命令里出现 `*.agent.config.json` → 拦下（大小写不敏感）。
test("R-P3-4：bash 命令里的 *.agent.config.json（含变体）拦下", () => {
  expect(gateToolCall(base, { name: "bash", arguments: { command: "echo {} > /office/agents/eng/dave.agent.config.json" } })).toBeDefined();
  expect(gateToolCall(base, { name: "bash", arguments: { command: "cat /office/agents/eng/BOB.AGENT.CONFIG.JSON" } })).toBeDefined();
  expect(gateToolCall(base, { name: "bash", arguments: { command: "ls data" } })).toBeUndefined();
});

// R-P3-19（修订，fail-closed）：bash 无法做 JSON + attenuation 校验，故命令里出现**任何**配置
// 文件名（space / department / project / agent，含无 `/` 的裸相对文件名）一律拦下，引导改用 write 工具。
test("R-P3-19：bash 命令里出现任何配置名（绝对 + 裸相对）→ 拦下，引导走 write", () => {
  const blocked = [
    "echo {} > alice.agent.config.json",
    "echo {} > /office/agents/alice/department.config.json",
    "printf '{\"permissions\":{\"write\":[\"/\"]}}' > x.project.config.json",
    "printf '{}' > /office/work/alice/space.config.json",
    "cp ~/evil.json /office/SPACE.CONFIG.JSON",
    "echo {} > bob.AGENT.CONFIG.JSON",
  ];
  for (const command of blocked) {
    const verdict = gateToolCall(base, { name: "bash", arguments: { command } });
    expect(verdict, command).toBeDefined();
    expect(verdict?.block, command).toContain("配置");
  }
  // 自提权写法：写项目 config 的 permissions 被拦（不得从 bash 绕过 attenuation）。
  const escalate = gateToolCall(base, {
    name: "bash",
    arguments: { command: `printf '{"permissions":{"write":["/"]}}' > x.project.config.json` },
  });
  expect(escalate?.block).toContain("write");
  // 普通命令不受影响。
  expect(gateToolCall(base, { name: "bash", arguments: { command: "echo hi && ls data" } })).toBeUndefined();
  expect(gateToolCall(base, { name: "bash", arguments: { command: "npm test" } })).toBeUndefined();
  expect(configNamesIn("echo {} > alice.agent.config.json")).toBe("alice.agent.config.json");
  expect(configNamesIn("ls data")).toBeUndefined();
});

test("未映射的工具不进路径闸门（自有工具 / MCP 工具）", () => {
  expect(gateToolCall(base, { name: "send_message", arguments: { target: "boss", text: "x" } })).toBeUndefined();
  expect(gateToolCall(base, { name: "mcp__github__create_issue", arguments: {} })).toBeUndefined();
});

// staff0（空间管家）是硬保护的唯一例外：可建 / 改 agent 定义（含自己），
// 但仍走 write 的 JSON + attenuation + 路径闸门；edit / bash 照旧拦。
test("staff0：可写 agent 配置（含自己），仍受 JSON / attenuation / 路径约束", () => {
  const staff0 = access({ write: ["/office"], read: ["/office"], bash: ["/office"] }, "staff0");
  expect(
    gateToolCall(staff0, { name: "write", arguments: { path: "/office/agents/eng/dave.agent.config.json", content: "{}" } }),
  ).toBeUndefined();
  expect(
    gateToolCall(staff0, { name: "write", arguments: { path: "/office/agents/staff0.agent.config.json", content: "{}" } }),
  ).toBeUndefined();

  // 空间外 permissions：attenuation 拦下。
  const escalate = gateToolCall(staff0, {
    name: "write",
    arguments: { path: "/office/agents/eng/dave.agent.config.json", content: outOfBounds },
  });
  expect(escalate?.block).toContain("attenuation");
  // 坏 JSON：拦下。
  expect(
    gateToolCall(staff0, { name: "write", arguments: { path: "/office/agents/eng/dave.agent.config.json", content: "{坏" } })?.block,
  ).toContain("JSON");
  // edit：仍引导改用 write。
  expect(
    gateToolCall(staff0, { name: "edit", arguments: { path: "/office/agents/eng/dave.agent.config.json", edits: [] } })?.block,
  ).toContain("write");
  // bash：仍不得碰配置。
  expect(
    gateToolCall(staff0, {
      name: "bash",
      arguments: { command: "echo {} > /office/agents/eng/dave.agent.config.json" },
    })?.block,
  ).toContain("配置");
  // 空间外的 agent 配置文件：路径闸门拦下。
  expect(
    gateToolCall(staff0, { name: "write", arguments: { path: "/tmp/dave.agent.config.json", content: "{}" } }),
  ).toBeDefined();
});
