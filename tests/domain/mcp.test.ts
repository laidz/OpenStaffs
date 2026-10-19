import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { mcpDefinitionsFile, loadMcpSnapshot, mcpExtensionName, mcpToolName, resolveMcpServers } from "../../src/domain/mcp.ts";

let root = "";
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-mcp-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function writeJson(file: string, body: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
}

describe("全局 mcps.json + 按名引用（D16）", () => {
  it("定义落在 openstaffs/mcps.json；按名选择保留配置顺序", () => {
    const ws = createWorkspace(root);
    expect(mcpDefinitionsFile(ws)).toBe(path.join(root, "openstaffs", "mcps.json"));
    writeJson(mcpDefinitionsFile(ws), {
      mcpServers: { github: { command: "gh-mcp" }, files: { command: "fs-mcp", args: ["--root", "."] } },
    });
    const snapshot = loadMcpSnapshot(ws);
    const selected = resolveMcpServers(snapshot, ["files", "github"]);
    expect(selected.missing).toEqual([]);
    expect(selected.selections.map((item) => [item.name, item.config.command])).toEqual([
      ["files", "fs-mcp"],
      ["github", "gh-mcp"],
    ]);
  });

  it("未定义的 mcp 名 → missing（不崩、不抛）", () => {
    const ws = createWorkspace(root);
    writeJson(mcpDefinitionsFile(ws), { mcpServers: { github: { command: "gh-mcp" } } });
    const selected = resolveMcpServers(loadMcpSnapshot(ws), ["github", "nope"]);
    expect(selected.selections.map((item) => item.name)).toEqual(["github"]);
    expect(selected.missing).toEqual(["nope"]);
  });

  it("缺失文件 / 坏 JSON / mcpServers 非对象 / 缺 mcpServers → 各自降级为空、不崩", () => {
    const ws = createWorkspace(root);
    // 缺失文件：空且无错
    const missing = loadMcpSnapshot(ws);
    expect(missing.source.servers).toEqual([]);
    expect(missing.source.invalid).toEqual([]);
    expect(missing.source.errors).toEqual([]);

    // 真·坏 JSON：记错误、空选择、不抛
    fs.mkdirSync(path.dirname(mcpDefinitionsFile(ws)), { recursive: true });
    fs.writeFileSync(mcpDefinitionsFile(ws), "{ 这不是合法 JSON");
    const broken = loadMcpSnapshot(ws);
    expect(broken.source.servers).toEqual([]);
    expect(broken.source.errors.join("\n")).toContain("不是合法 JSON");

    // mcpServers 是非对象（数组）：记错误、空选择、不崩
    writeJson(mcpDefinitionsFile(ws), { mcpServers: ["nope"] });
    const nonObject = loadMcpSnapshot(ws);
    expect(nonObject.source.servers).toEqual([]);
    expect(nonObject.source.errors.join("\n")).toContain("mcpServers 必须是对象");

    // 合法 JSON 但没有 mcpServers：视为空、无错
    writeJson(mcpDefinitionsFile(ws), { other: {} });
    const absent = loadMcpSnapshot(ws);
    expect(absent.source.servers).toEqual([]);
    expect(absent.source.errors).toEqual([]);
  });

  it("非法 server（点号名 / 缺 command）被隔离：只跳过它，其余照常装配", () => {
    const ws = createWorkspace(root);
    writeJson(mcpDefinitionsFile(ws), {
      mcpServers: { ok: { command: "npx" }, "bad.name": { command: "x" }, missing: { args: [] } },
    });
    const snapshot = loadMcpSnapshot(ws);
    expect(snapshot.source.servers.map((item) => item.name)).toEqual(["ok"]);
    expect(snapshot.source.invalid).toEqual(["bad.name", "missing"]);
    expect(snapshot.source.errors.length).toBeGreaterThan(0);

    // 未定义 / 非法名在按名引用时都不选中（不崩）。
    const selected = resolveMcpServers(snapshot, ["ok", "bad.name", "missing", "ghost"]);
    expect(selected.selections.map((item) => item.name)).toEqual(["ok"]);
    expect(selected.missing).toEqual(["ghost"]);
  });

  it("凭据占位符可出现在 command / args / env / cwd；其余 ${...} 原样保留", () => {
    const ws = createWorkspace(root);
    writeJson(path.join(root, "openstaffs/.data", "config.json"), {
      mcp: { github: { token: "ghp_secret", host: "example.test" } },
    });
    writeJson(mcpDefinitionsFile(ws), {
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

    const source = loadMcpSnapshot(ws).source;
    expect(source.servers).toHaveLength(1);
    const github = source.servers[0]!;
    expect(github.command).toBe("example.test");
    expect(github.args).toEqual(["--token", "ghp_secret", "${HOME}/keep"]); // 非凭据占位符原样保留
    expect(github.env).toEqual({ TOKEN: "ghp_secret" });
    expect(github.cwd).toBe(path.join(root, "openstaffs", "sub")); // 相对 mcps.json 所在目录
    // 缺凭据的 server 被隔离（invalid + 明确错误），不影响 github。
    expect(source.invalid).toContain("broken");
    expect(source.errors.join("\n")).toContain("broken.token");
  });

  it("扩展名与工具名：mcp:global:<server> / mcp__<server>__<tool>", () => {
    expect(mcpExtensionName("github")).toBe("mcp:global:github");
    expect(mcpToolName("github", "create_issue")).toBe("mcp__github__create_issue");
  });
});
