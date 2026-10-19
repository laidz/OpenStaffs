import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { scopeChain } from "../../src/capabilities/scopes.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-chain-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function write(file: string, body: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
}

test("顺序 = 空间 → 部门（根 → 叶）→ 项目（仅群聊）→ 员工；缺失层跳过", () => {
  const ws = createWorkspace(root);
  write(path.join(root, "openstaffs", "space.config.json"), { prompt: "空间" });
  write(path.join(root, "agents", "eng", "department.config.json"), { prompt: "eng" });
  write(path.join(root, "agents", "eng", "platform", "department.config.json"), { prompt: "platform" });
  write(path.join(root, "projects", "seo.project.config.json"), { prompt: "seo" });
  write(path.join(root, "agents", "eng", "platform", "bob.agent.config.json"), { prompt: "bob" });
  const dirs = [path.join(root, "agents", "eng"), path.join(root, "agents", "eng", "platform")];

  expect(
    scopeChain({ ws, agentId: "bob", agentDir: dirs[1]!, departmentDirs: dirs, projectId: "seo" }).map((c) => c.id + ":" + c.fields.prompt),
  ).toEqual(["space:空间", "eng:eng", "platform:platform", "seo:seo", "bob:bob"]);

  expect(
    scopeChain({ ws, agentId: "bob", agentDir: dirs[1]!, departmentDirs: dirs }).map((c) => c.scope),
  ).toEqual(["space", "department", "department", "agent"]);
});

test("部门链去重；部门无配置文件则跳过该层", () => {
  const ws = createWorkspace(root);
  write(path.join(root, "agents", "eng", "alice.agent.config.json"), { prompt: "alice" });
  const chain = scopeChain({
    ws, agentId: "alice", agentDir: path.join(root, "agents", "eng"),
    departmentDirs: [path.join(root, "agents", "eng"), path.join(root, "agents", "eng")],
  });
  expect(chain.map((c) => c.id)).toEqual(["alice"]);
});
