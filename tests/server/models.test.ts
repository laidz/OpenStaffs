import { describe, expect, it } from "vitest";
import { PROVIDERS, createConfiguredModels } from "../../src/server/models.ts";

describe("Models 装配", () => {
  it("多供应商 apiKey 各自经 CredentialStore 注入；未知供应商抛错", async () => {
    const models = await createConfiguredModels({
      "opencode-go": { apiKey: "sk-test-123" },
      anthropic: { apiKey: "sk-ant-456" },
    });
    const first = await models.getAuth("opencode-go");
    expect(first).toBeDefined();
    expect(JSON.stringify(first?.auth)).toContain("sk-test-123");
    const second = await models.getAuth("anthropic");
    expect(second).toBeDefined();
    expect(JSON.stringify(second?.auth)).toContain("sk-ant-456");

    await expect(
      createConfiguredModels({ "opencode-go": { apiKey: "k" }, nope: { apiKey: "k" } }),
    ).rejects.toThrow("未知供应商");

    expect(Object.keys(PROVIDERS)).toContain("opencode-go");
  });
});
