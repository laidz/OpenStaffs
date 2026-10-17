import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { DEFAULT_PORT, configFile, readBossName, readConfig, resolveEmployeeModel } from "../../src/domain/config.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-config-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("全局配置", () => {
  it("缺失/坏 JSON/缺字段/空串 → undefined（未配置，不崩）", () => {
    const ws = createWorkspace(root);
    expect(readConfig(ws)).toBeUndefined();
    fs.mkdirSync(path.join(root, ".openstaffs"), { recursive: true });
    fs.writeFileSync(configFile(ws), "{坏");
    expect(readConfig(ws)).toBeUndefined();
    fs.writeFileSync(configFile(ws), JSON.stringify({ provider: "opencode-go", apiKey: "k" }));
    expect(readConfig(ws)).toBeUndefined();
    fs.writeFileSync(configFile(ws), JSON.stringify({ provider: "  ", apiKey: "k", modelId: "m" }));
    expect(readConfig(ws)).toBeUndefined();
  });

  it("读全配置；port 缺省/非法一律回落 4319", () => {
    const ws = createWorkspace(root);
    fs.mkdirSync(path.join(root, ".openstaffs"), { recursive: true });
    fs.writeFileSync(configFile(ws), JSON.stringify({ provider: "opencode-go", apiKey: "k", modelId: "m" }));
    expect(readConfig(ws)).toEqual({ provider: "opencode-go", apiKey: "k", modelId: "m", port: DEFAULT_PORT });
    fs.writeFileSync(configFile(ws), JSON.stringify({ provider: "opencode-go", apiKey: "k", modelId: "m", port: -1 }));
    expect(readConfig(ws)?.port).toBe(DEFAULT_PORT);
    fs.writeFileSync(configFile(ws), JSON.stringify({ provider: "opencode-go", apiKey: "k", modelId: "m", port: 5000 }));
    expect(readConfig(ws)?.port).toBe(5000);
  });

  it("readBossName：读 config.json 的 bossName；缺失/坏 JSON/空串 → 老板", () => {
    const ws = createWorkspace(root);
    expect(readBossName(ws)).toBe("老板"); // 文件缺失
    fs.mkdirSync(path.join(root, ".openstaffs"), { recursive: true });
    fs.writeFileSync(configFile(ws), "{坏");
    expect(readBossName(ws)).toBe("老板");
    fs.writeFileSync(configFile(ws), JSON.stringify({ bossName: "  " }));
    expect(readBossName(ws)).toBe("老板");
    fs.writeFileSync(configFile(ws), JSON.stringify({ bossName: "张总" }));
    expect(readBossName(ws)).toBe("张总");
  });

  it("员工模型兜底：provider+modelId 成对填写才生效，否则整体用全局", () => {
    const global = { provider: "opencode-go", modelId: "global-model" };
    expect(resolveEmployeeModel(global, { provider: "faux", modelId: "f" })).toEqual({ provider: "faux", modelId: "f" });
    expect(resolveEmployeeModel(global, { provider: "", modelId: "" })).toEqual(global);
    expect(resolveEmployeeModel(global, { provider: "faux", modelId: "" })).toEqual(global);
    expect(resolveEmployeeModel(global, { provider: "faux", modelId: "f", thinkingLevel: "high" })).toEqual({
      provider: "faux", modelId: "f", thinkingLevel: "high",
    });
  });
});
