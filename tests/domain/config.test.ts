import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import {
  DEFAULT_PORT, configFile, parseModelRef, readBossName, readConfig, resolveEmployeeModel,
} from "../../src/domain/config.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-config-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const providers = { "opencode-go": { apiKey: "k" } };

describe("全局配置", () => {
  it("缺失/坏 JSON/缺 providers/缺 model/model 非法 → undefined（未配置，不崩）", () => {
    const ws = createWorkspace(root);
    expect(readConfig(ws)).toBeUndefined();
    fs.mkdirSync(path.join(root, ".openstaffs"), { recursive: true });
    fs.writeFileSync(configFile(ws), "{坏");
    expect(readConfig(ws)).toBeUndefined();
    fs.writeFileSync(configFile(ws), JSON.stringify({ model: "opencode-go/m" }));
    expect(readConfig(ws)).toBeUndefined();
    fs.writeFileSync(configFile(ws), JSON.stringify({ providers }));
    expect(readConfig(ws)).toBeUndefined();
    fs.writeFileSync(configFile(ws), JSON.stringify({ providers, model: "just-a-model" }));
    expect(readConfig(ws)).toBeUndefined();
    fs.writeFileSync(configFile(ws), JSON.stringify({ providers: {}, model: "opencode-go/m" }));
    expect(readConfig(ws)).toBeUndefined();
    fs.writeFileSync(configFile(ws), JSON.stringify({ providers: { "opencode-go": {} }, model: "opencode-go/m" }));
    expect(readConfig(ws)).toBeUndefined();
  });

  it("读多供应商配置；providers 里的坏条目被跳过；port 缺省/非法一律回落 4319", () => {
    const ws = createWorkspace(root);
    fs.mkdirSync(path.join(root, ".openstaffs"), { recursive: true });
    const full = {
      providers: { "opencode-go": { apiKey: "k" }, anthropic: { apiKey: "  a  " } },
      model: "opencode-go/deepseek-v4.1-flash",
    };
    fs.writeFileSync(configFile(ws), JSON.stringify(full));
    expect(readConfig(ws)).toEqual({
      providers: { "opencode-go": { apiKey: "k" }, anthropic: { apiKey: "a" } },
      model: "opencode-go/deepseek-v4.1-flash",
      port: DEFAULT_PORT,
    });
    fs.writeFileSync(configFile(ws), JSON.stringify({ ...full, port: -1 }));
    expect(readConfig(ws)?.port).toBe(DEFAULT_PORT);
    fs.writeFileSync(configFile(ws), JSON.stringify({ ...full, port: 5000 }));
    expect(readConfig(ws)?.port).toBe(5000);
    // 坏条目（apiKey 非字符串 / 空）跳过，好条目仍生效
    fs.writeFileSync(configFile(ws), JSON.stringify({ ...full, model: "anthropic/x", providers: { anthropic: { apiKey: 42 }, google: { apiKey: "" }, "opencode-go": { apiKey: "k" }, "  ": { apiKey: "z" } } }));
    expect(readConfig(ws)?.providers).toEqual({ "opencode-go": { apiKey: "k" } });
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

  it("parseModelRef：第一个 / 前为供应商，其余为模型 id；两侧非空才合法", () => {
    expect(parseModelRef("opencode-go/deepseek-v4.1-flash")).toEqual({ provider: "opencode-go", modelId: "deepseek-v4.1-flash" });
    expect(parseModelRef("openrouter/anthropic/claude-x")).toEqual({ provider: "openrouter", modelId: "anthropic/claude-x" });
    expect(parseModelRef(" a / b ")).toEqual({ provider: "a", modelId: "b" });
    expect(parseModelRef("no-slash")).toBeUndefined();
    expect(parseModelRef("/model")).toBeUndefined();
    expect(parseModelRef("provider/")).toBeUndefined();
    expect(parseModelRef(" / ")).toBeUndefined();
    expect(parseModelRef("")).toBeUndefined();
  });

  it("员工模型兜底：员工 model 合法则用员工的，否则整体用全局；thinkingLevel 独立保留", () => {
    const global = "opencode-go/global-model";
    expect(resolveEmployeeModel(global, { model: "faux/f" })).toEqual({ provider: "faux", modelId: "f" });
    expect(resolveEmployeeModel(global, { model: "" })).toEqual({ provider: "opencode-go", modelId: "global-model" });
    expect(resolveEmployeeModel(global, { model: "invalid" })).toEqual({ provider: "opencode-go", modelId: "global-model" });
    expect(resolveEmployeeModel("", { model: "" })).toEqual({ provider: "", modelId: "" });
    expect(resolveEmployeeModel(global, { model: "faux/f", thinkingLevel: "high" })).toEqual({
      provider: "faux", modelId: "f", thinkingLevel: "high",
    });
  });
});
