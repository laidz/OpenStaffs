import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { readMcpCredentials } from "../../src/domain/config.ts";
import {
  loadMcpSnapshot, mcpExtensionName, mcpToolName, resolveMcpServers,
} from "../../src/domain/mcp.ts";

let root = "";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-mcp-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeJson(file: string, body: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
}

function server(command: string): { command: string } {
  return { command };
}

describe("三层 mcp.json", () => {
  it("合并顺序为系统 → 空间 → 项目，同名窄者胜，私聊不含项目层", () => {
    const ws = createWorkspace(root);
    const systemFile = path.join(root, "system-mcp.json");
    writeJson(systemFile, {
      mcpServers: {
        shared: server("system"),
        onlySystem: server("system"),
      },
    });
    writeJson(path.join(root, "openstaffs", "mcp.json"), {
      mcpServers: { shared: server("space"), onlySpace: server("space") },
    });
    writeJson(path.join(root, "agents", "alice.agent.config.json"), { prompt: "你是 alice。" });
    writeJson(path.join(root, "projects", "p1", "mcp.json"), {
      mcpServers: { shared: server("project"), onlyProject: server("project") },
    });

    const snapshot = loadMcpSnapshot(ws, { systemFile });
    const group = resolveMcpServers(snapshot, { kind: "group", project: "p1" }, "alice").selections;
    expect(group.map((item) => [item.name, item.config.command])).toEqual([
      ["shared", "project"],
      ["onlySystem", "system"],
      ["onlySpace", "space"],
      ["onlyProject", "project"],
    ]);

    const dm = resolveMcpServers(snapshot, { kind: "dm", employeeId: "alice" }, "alice").selections;
    expect(dm.map((item) => [item.name, item.config.command])).toEqual([
      ["shared", "space"],
      ["onlySystem", "system"],
      ["onlySpace", "space"],
    ]);
  });

  it("员工层不再有 mcp.json 来源：私聊只有空间 + 系统", () => {
    const ws = createWorkspace(root);
    const systemFile = path.join(root, "system-mcp.json");
    writeJson(path.join(root, "agents", "alice.agent.config.json"), { prompt: "x" });
    writeJson(path.join(root, "agents", "alice", "mcp.json"), { mcpServers: { gone: server("employee") } });

    const snapshot = loadMcpSnapshot(ws, { systemFile });
    expect(snapshot.sources.some((source) => source.scope.kind === "employee")).toBe(false);
    expect(resolveMcpServers(snapshot, { kind: "dm", employeeId: "alice" }, "alice").selections).toEqual([]);
  });

  it("窄层同名定义非法时遮蔽宽层，不回落到宽层", () => {
    const ws = createWorkspace(root);
    const systemFile = path.join(root, "system-mcp.json");
    writeJson(systemFile, { mcpServers: { shared: server("system") } });
    writeJson(path.join(root, "agents", "alice.agent.config.json"), { prompt: "你是 alice。" });
    writeJson(path.join(root, "openstaffs", "mcp.json"), {
      // 缺 command：非法（空间层比系统层窄）
      mcpServers: { shared: { args: [] } },
    });

    const snapshot = loadMcpSnapshot(ws, { systemFile });
    expect(snapshot.sources.some((source) => source.errors.some((line) => line.includes('"shared"')))).toBe(true);
    const dm = resolveMcpServers(snapshot, { kind: "dm", employeeId: "alice" }, "alice").selections;
    expect(dm.map((item) => item.name)).not.toContain("shared");
  });

  it("凭据占位符可出现在 command / args / env / cwd，缺失时明确报错", () => {
    const ws = createWorkspace(root);
    writeJson(path.join(root, ".openstaffs", "config.json"), {
      mcp: { github: { token: "ghp_secret", host: "example.test" } },
    });
    const systemFile = path.join(root, "system-mcp.json");
    writeJson(systemFile, {
      mcpServers: {
        github: {
          command: "${config.mcp.github.host}",
          args: ["--token", "${config.mcp.github.token}", "${HOME}/keep"],
          env: { TOKEN: "${config.mcp.github.token}" },
          cwd: "sub",
        },
        broken: { command: "npx", env: { TOKEN: "${config.mcp.broken.token}" } },
      },
    });

    const snapshot = loadMcpSnapshot(ws, { systemFile });
    const source = snapshot.sources[0]!;
    expect(source.servers).toHaveLength(1);
    const github = source.servers[0]!;
    expect(github.command).toBe("example.test");
    expect(github.args).toEqual(["--token", "ghp_secret", "${HOME}/keep"]);
    expect(github.env).toEqual({ TOKEN: "ghp_secret" });
    expect(github.cwd).toBe(path.join(root, "sub"));
    expect(source.invalid).toContain("broken");
    expect(source.errors.join("\n")).toContain("broken.token");
  });

  it("坏 JSON、mcpServers 非对象与坏字段都被隔离，不影响其它层", () => {
    const ws = createWorkspace(root);
    const systemFile = path.join(root, "system-mcp.json");
    fs.writeFileSync(systemFile, "{ not json");
    writeJson(path.join(root, "openstaffs", "mcp.json"), {
      mcpServers: { ok: server("npx"), badArgs: { command: "npx", args: [1] } },
    });

    const snapshot = loadMcpSnapshot(ws, { systemFile });
    expect(snapshot.sources[0]!.errors.join("\n")).toContain("不是合法 JSON");
    const space = snapshot.sources.find((source) => source.scope.kind === "space")!;
    expect(space.servers.map((item) => item.name)).toEqual(["ok"]);
    expect(space.invalid).toContain("badArgs");
  });

  it("server 名只允许安全字符；点号 / 空格名报错并跳过", () => {
    const ws = createWorkspace(root);
    const systemFile = path.join(root, "system-mcp.json");
    writeJson(systemFile, {
      mcpServers: {
        "my.server": { command: "npx" },
        "bad name": { command: "npx" },
        good_name: { command: "npx" },
      },
    });

    const snapshot = loadMcpSnapshot(ws, { systemFile });
    const source = snapshot.sources[0]!;
    expect(source.invalid).toEqual(expect.arrayContaining(["my.server", "bad name"]));
    expect(source.servers.map((item) => item.name)).toEqual(["good_name"]);
    expect(source.errors.join("\n")).toContain("名字不合法");
  });

  it("凭据与工具 / 扩展映射直接使用 server 原名", () => {
    const ws = createWorkspace(root);
    writeJson(path.join(root, ".openstaffs", "config.json"), {
      mcp: { my_server: { token: "ghp_secret" } },
    });
    const systemFile = path.join(root, "system-mcp.json");
    writeJson(systemFile, {
      mcpServers: {
        my_server: {
          command: "npx",
          env: { TOKEN: "${config.mcp.my_server.token}" },
        },
      },
    });

    const snapshot = loadMcpSnapshot(ws, { systemFile });
    const source = snapshot.sources[0]!;
    expect(source.errors).toEqual([]);
    const server = source.servers[0]!;
    expect(server.name).toBe("my_server");
    expect(server.env).toEqual({ TOKEN: "ghp_secret" });
    expect(mcpToolName(server.name, "echo")).toBe("mcp__my_server__echo");
    expect(mcpExtensionName({ kind: "system" }, server.name)).toBe("mcp:system:my_server");
  });

  it("扩展名与工具名带层级且非法字符被替换", () => {
    expect(mcpExtensionName({ kind: "employee", id: "alice" }, "my server")).toBe("mcp:employee:alice:my server");
    expect(mcpExtensionName({ kind: "system" }, "github")).toBe("mcp:system:github");
    expect(mcpToolName("my server", "search issues")).toBe("mcp__my_server__search_issues");
  });
});

describe("readMcpCredentials", () => {
  it("独立读取 mcp 字段，缺文件 / 坏 JSON / 非字符串值安全跳过", () => {
    const ws = createWorkspace(root);
    expect(readMcpCredentials(ws)).toEqual({});

    writeJson(path.join(root, ".openstaffs", "config.json"), {
      mcp: {
        github: { token: "a", empty: "  ", bad: 1 },
        broken: "x",
      },
    });
    expect(readMcpCredentials(ws)).toEqual({ github: { token: "a" } });

    fs.writeFileSync(path.join(root, ".openstaffs", "config.json"), "{oops");
    expect(readMcpCredentials(ws)).toEqual({});
  });
});
