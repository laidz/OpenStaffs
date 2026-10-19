import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import {
  bossNamesFor, DEFAULT_PORT, configFile, displayThinkingLevel, parseModelRef, readBossName, readConfig, readSkillPaths,
  resolveEmployeeModel,
} from "../../src/domain/config.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-config-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const providers = { "opencode-go": { apiKey: "k" } };

describe("全局配置", () => {
  it("缺失/坏 JSON/缺 providers/缺 model/model 非法 → undefined（未配置，不崩）", () => {
    const ws = createWorkspace(root);
    expect(readConfig(ws)).toBeUndefined();
    fs.mkdirSync(path.join(root, "openstaffs/.data"), { recursive: true });
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
    fs.mkdirSync(path.join(root, "openstaffs/.data"), { recursive: true });
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
    fs.mkdirSync(path.join(root, "openstaffs/.data"), { recursive: true });
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

  it("读取全局 thinkingLevel：非空字符串保留（不校验档位）；空串/非字符串忽略", () => {
    const ws = createWorkspace(root);
    fs.mkdirSync(path.join(root, "openstaffs/.data"), { recursive: true });
    const base = { providers, model: "opencode-go/m" };
    fs.writeFileSync(configFile(ws), JSON.stringify({ ...base, thinkingLevel: "banana" }));
    expect(readConfig(ws)?.thinkingLevel).toBe("banana"); // 配置端不拦非法档
    fs.writeFileSync(configFile(ws), JSON.stringify({ ...base, thinkingLevel: "  high  " }));
    expect(readConfig(ws)?.thinkingLevel).toBe("high");
    fs.writeFileSync(configFile(ws), JSON.stringify({ ...base, thinkingLevel: "  " }));
    expect(readConfig(ws)?.thinkingLevel).toBeUndefined();
    fs.writeFileSync(configFile(ws), JSON.stringify({ ...base, thinkingLevel: 42 }));
    expect(readConfig(ws)?.thinkingLevel).toBeUndefined();
    fs.writeFileSync(configFile(ws), JSON.stringify(base));
    expect(readConfig(ws)?.thinkingLevel).toBeUndefined();
  });

  it("displayThinkingLevel：非法档 / 能力表不支持 → null；支持或无法判定 → 原值", () => {
    const supported = ["off", "minimal", "low", "medium", "high"];
    expect(displayThinkingLevel("high", supported)).toBe("high");
    expect(displayThinkingLevel("high", ["off"])).toBeNull(); // 非思考模型（reasoning: false）只支持 off
    expect(displayThinkingLevel("max", supported)).toBeNull(); // xhigh / max 需显式映射
    expect(displayThinkingLevel("xhigh", undefined)).toBe("xhigh"); // 模型目录缺失：无法判定，不擅自置 null
    expect(displayThinkingLevel("high", undefined)).toBe("high");
    expect(displayThinkingLevel("banana", supported)).toBeNull(); // 非法档
    expect(displayThinkingLevel("banana", undefined)).toBeNull();
    expect(displayThinkingLevel(" high ", supported)).toBeNull(); // 配置读取时已 trim
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

describe("bossNamesFor（@提及双认）", () => {
  it("缺省 → [老板, boss]；自定义 → [当前称谓, 老板, boss] 去重保序", () => {
    const ws = createWorkspace(root);
    expect(bossNamesFor(ws)).toEqual(["老板", "boss"]);
    fs.mkdirSync(path.join(root, "openstaffs/.data"), { recursive: true });
    fs.writeFileSync(configFile(ws), JSON.stringify({ bossName: "掌柜" }));
    expect(bossNamesFor(ws)).toEqual(["掌柜", "老板", "boss"]);
    fs.writeFileSync(configFile(ws), JSON.stringify({ bossName: "老板" }));
    expect(bossNamesFor(ws)).toEqual(["老板", "boss"]);
    fs.writeFileSync(configFile(ws), JSON.stringify({ bossName: "boss" }));
    expect(bossNamesFor(ws)).toEqual(["boss", "老板"]);
  });
});

describe("readSkillPaths（外部技能目录）", () => {
  it("三种写法：~ 开头按家目录、绝对路径原样、相对路径按办公空间根；顺序保留", () => {
    const ws = createWorkspace(root);
    fs.mkdirSync(path.join(root, "openstaffs/.data"), { recursive: true });
    fs.writeFileSync(configFile(ws), JSON.stringify({
      skillPaths: ["~/global-skills", "/abs/skills", "vendor/skills"],
    }));
    expect(readSkillPaths(ws)).toEqual([
      path.join(os.homedir(), "global-skills"),
      "/abs/skills",
      path.join(root, "vendor", "skills"),
    ]);
  });

  it("去重（同一目录两种写法算同一条，先出现者胜）", () => {
    const ws = createWorkspace(root);
    fs.mkdirSync(path.join(root, "openstaffs/.data"), { recursive: true });
    fs.writeFileSync(configFile(ws), JSON.stringify({
      skillPaths: ["/abs/skills", "/abs/skills/", "/abs/./skills"],
    }));
    expect(readSkillPaths(ws)).toEqual(["/abs/skills"]);
  });

  it("坏条目跳过：非数组 / 混入 null、数字、空串 / 数组本身不是数组", () => {
    const ws = createWorkspace(root);
    fs.mkdirSync(path.join(root, "openstaffs/.data"), { recursive: true });
    fs.writeFileSync(configFile(ws), JSON.stringify({ skillPaths: [null, 42, "  ", "/ok"] }));
    expect(readSkillPaths(ws)).toEqual(["/ok"]);
    fs.writeFileSync(configFile(ws), JSON.stringify({ skillPaths: "/not-an-array" }));
    expect(readSkillPaths(ws)).toEqual([]);
    fs.writeFileSync(configFile(ws), JSON.stringify({}));
    expect(readSkillPaths(ws)).toEqual([]);
  });

  it("文件缺失 / 坏 JSON → []（不崩）", () => {
    const ws = createWorkspace(root);
    expect(readSkillPaths(ws)).toEqual([]);
    fs.mkdirSync(path.join(root, "openstaffs/.data"), { recursive: true });
    fs.writeFileSync(configFile(ws), "{坏");
    expect(readSkillPaths(ws)).toEqual([]);
  });

  it("裸 ~ 与 ~/x 都解析到家目录；与绝对家目录写法互认为同一条", () => {
    const ws = createWorkspace(root);
    fs.mkdirSync(path.join(root, "openstaffs/.data"), { recursive: true });
    fs.writeFileSync(configFile(ws), JSON.stringify({ skillPaths: ["~", "~/g"] }));
    expect(readSkillPaths(ws)).toEqual([os.homedir(), path.join(os.homedir(), "g")]);

    fs.writeFileSync(configFile(ws), JSON.stringify({
      skillPaths: ["~/x", path.join(os.homedir(), "x"), "/after"],
    }));
    expect(readSkillPaths(ws)).toEqual([path.join(os.homedir(), "x"), "/after"]);
  });

  it("坏条目不影响后续条目的顺序", () => {
    const ws = createWorkspace(root);
    fs.mkdirSync(path.join(root, "openstaffs/.data"), { recursive: true });
    fs.writeFileSync(configFile(ws), JSON.stringify({ skillPaths: [null, "/a", 7, "b", "  ", "/c"] }));
    expect(readSkillPaths(ws)).toEqual(["/a", path.join(root, "b"), "/c"]);
  });
});
