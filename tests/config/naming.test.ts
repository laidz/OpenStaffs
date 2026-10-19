import { expect, test } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import {
  agentConfigFile, agentIdOfConfigFile, departmentConfigFile, isConfigFileName, projectConfigFile, projectIdOfConfigFile, spaceConfigFile,
} from "../../src/config/naming.ts";

test("四类配置文件的落点（spec §3 / D3 / D26）", () => {
  const ws = createWorkspace("/office");
  expect(spaceConfigFile(ws)).toBe("/office/openstaffs/space.config.json");
  expect(projectConfigFile(ws, "seo")).toBe("/office/projects/seo.project.config.json");
  expect(departmentConfigFile("/office/agents/eng")).toBe("/office/agents/eng/department.config.json");
  expect(agentConfigFile("/office/agents/eng", "alice")).toBe("/office/agents/eng/alice.agent.config.json");
});

test("文件名反解 + 识别", () => {
  expect(agentIdOfConfigFile("/office/agents/eng/alice.agent.config.json")).toBe("alice");
  expect(agentIdOfConfigFile("/office/agents/eng/department.config.json")).toBeUndefined();
  expect(projectIdOfConfigFile("/office/projects/seo.project.config.json")).toBe("seo");
  expect(projectIdOfConfigFile("/office/projects/seo.agent.config.json")).toBeUndefined();
  expect(isConfigFileName("department.config.json")).toBe(true);
  expect(isConfigFileName("space.config.json")).toBe(true);
  expect(isConfigFileName("x.agent.config.json")).toBe(true);
  expect(isConfigFileName("x.project.config.json")).toBe(true);
  expect(isConfigFileName("permission.json")).toBe(false);
  expect(isConfigFileName("mcp.json")).toBe(false);
});
