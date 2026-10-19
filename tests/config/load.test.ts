import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { loadAgentConfig, loadProjectConfig, loadSpaceConfig, readConfigFile } from "../../src/config/load.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-cfg-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function write(file: string, body: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`);
}

test("缺失 / 坏 JSON → undefined（不崩）", () => {
  expect(readConfigFile(path.join(root, "none.agent.config.json"), "agent", "none")).toBeUndefined();
  const bad = path.join(root, "bad.agent.config.json");
  write(bad, "{坏");
  expect(readConfigFile(bad, "agent", "bad")).toBeUndefined();
});

test("合法 → baseDir = 文件所在目录；issues 随字段级问题", () => {
  const file = path.join(root, "ok.agent.config.json");
  write(file, { prompt: "你好", skills: ["a", 5] });
  const loaded = readConfigFile(file, "agent", "ok")!;
  expect(loaded.baseDir).toBe(root);
  expect(loaded.fields.prompt).toBe("你好");
  expect(loaded.issues).toHaveLength(1);
});

test("四个作用域加载包装：缺文件 undefined，有文件即读到", () => {
  const ws = createWorkspace(root);
  expect(loadSpaceConfig(ws)).toBeUndefined();
  expect(loadProjectConfig(ws, "seo")).toBeUndefined();
  expect(loadAgentConfig(path.join(root, "agents", "eng"), "alice")).toBeUndefined();
  write(path.join(root, "openstaffs", "space.config.json"), { prompt: "空间" });
  expect(loadSpaceConfig(ws)?.fields.prompt).toBe("空间");
  write(path.join(root, "projects", "seo.project.config.json"), { members: ["alice"] });
  expect(loadProjectConfig(ws, "seo")?.fields.members).toEqual(["alice"]);
  write(path.join(root, "agents", "eng", "alice.agent.config.json"), { alias: "爱丽丝" });
  expect(loadAgentConfig(path.join(root, "agents", "eng"), "alice")?.fields.alias).toBe("爱丽丝");
});
