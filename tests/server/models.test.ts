import { describe, expect, it } from "vitest";
import { PROVIDERS, createConfiguredModels } from "../../src/server/models.ts";

describe("Models 装配", () => {
  it("apiKey 经 CredentialStore 注入（本地可解析），未知 provider 抛错", async () => {
    const models = await createConfiguredModels({ provider: "opencode-go", apiKey: "sk-test-123", modelId: "m", port: 4319 });
    const auth = await models.getAuth("opencode-go");
    expect(auth).toBeDefined();
    expect(JSON.stringify(auth?.auth)).toContain("sk-test-123");

    await expect(
      createConfiguredModels({ provider: "nope", apiKey: "k", modelId: "m", port: 4319 }),
    ).rejects.toThrow("未知供应商");

    expect(Object.keys(PROVIDERS)).toContain("opencode-go");
  });
});
