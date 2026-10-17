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

describe("四层 mcp.json", () => {
  it("合并顺序为系统 → 空间 → 员工 → 项目，同名窄者胜，私聊不含项目层", () => {
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
    writeJson(path.join(root, "agents", "alice", "mcp.json"), {
      mcpServers: { shared: server("employee"), onlyEmployee: server("employee") },
    });
    writeJson(path.join(root, "projects", "p1", "mcp.json"), {
      mcpServers: { shared: server("project"), onlyProject: server("project") },
    });

    const snapshot = loadMcpSnapshot(ws, { systemFile });
    const group = resolveMcpServers(snapshot, { kind: "group", project: "p1" }, "alice").selections;
    expect(group.map((item) => [item.name, item.config.command])).toEqual([
      ["shared", "project"],
      ["onlySystem", "system"],
      ["onlySpace", "space"],
      ["onlyEmployee", "employee"],
      ["onlyProject", "project"],
    ]);

    const dm = resolveMcpServers(snapshot, { kind: "dm", employeeId: "alice" }, "alice").selections;
    expect(dm.map((item) => [item.name, item.config.command])).toEqual([
      ["shared", "employee"],
      ["onlySystem", "system"],
      ["onlySpace", "space"],
      ["onlyEmployee", "employee"],
    ]);
  });

  it("窄层同名定义非法时遮蔽宽层，不回落到宽层", () => {
    const ws = createWorkspace(root);
    const systemFile = path.join(root, "system-mcp.json");
    writeJson(systemFile, { mcpServers: { shared: server("system") } });
    writeJson(path.join(root, "agents", "alice", "mcp.json"), {
      // 缺 command：非法
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

  it("alias 用于凭据、工具与扩展映射；缺省回退原名", () => {
    const ws = createWorkspace(root);
    writeJson(path.join(root, ".openstaffs", "config.json"), {
      mcp: { "safe-alias": { token: "ghp_secret" } },
    });
    const systemFile = path.join(root, "system-mcp.json");
    writeJson(systemFile, {
      mcpServers: {
        "my.server": {
          alias: "safe-alias",
          command: "npx",
          env: { TOKEN: "${config.mcp.safe-alias.token}" },
        },
        plain: { command: "npx" },
      },
    });

    const snapshot = loadMcpSnapshot(ws, { systemFile });
    const source = snapshot.sources[0]!;
    expect(source.errors).toEqual([]);
    const dotted = source.servers.find((item) => item.name === "my.server")!;
    const plain = source.servers.find((item) => item.name === "plain")!;
    expect(dotted.alias).toBe("safe-alias");
    expect(dotted.env).toEqual({ TOKEN: "ghp_secret" });
    expect(plain.alias).toBe("plain");
    expect(mcpToolName(dotted.alias, "echo")).toBe("mcp__safe-alias__echo");
    expect(mcpExtensionName({ kind: "system" }, dotted.alias)).toBe("mcp:system:safe-alias");
  });

  it("alias 非法或同一文件内重复时报错并跳过", () => {
    const ws = createWorkspace(root);
    const systemFile = path.join(root, "system-mcp.json");
    writeJson(systemFile, {
      mcpServers: {
        bad: { alias: "a.b", command: "npx" },
        first: { alias: "same", command: "npx" },
        second: { alias: "same", command: "npx" },
      },
    });

    const snapshot = loadMcpSnapshot(ws, { systemFile });
    const source = snapshot.sources[0]!;
    expect(source.invalid).toContain("bad");
    expect(source.invalid).toContain("second");
    expect(source.servers.map((item) => item.name)).toEqual(["first"]);
    expect(source.errors.join("\n")).toContain("alias");
  });

  it("不同层使用相同 alias 时窄者胜，合并仍按原名", () => {
    const ws = createWorkspace(root);
    const systemFile = path.join(root, "system-mcp.json");
    writeJson(systemFile, { mcpServers: { a: { alias: "shared", command: "system" } } });
    writeJson(path.join(root, "projects", "p1", "mcp.json"), {
      mcpServers: { b: { alias: "shared", command: "project" } },
    });

    const snapshot = loadMcpSnapshot(ws, { systemFile });
    const group = resolveMcpServers(snapshot, { kind: "group", project: "p1" }, "alice").selections;
    expect(group).toHaveLength(1);
    expect(group[0]!.name).toBe("b");
    expect(group[0]!.config.alias).toBe("shared");
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
