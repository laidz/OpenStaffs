import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createModels, type Models, type Provider } from "@earendil-works/pi-ai/models";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { ProviderEntry } from "../domain/config.ts";

/** 内置供应商白名单（README 同步列出；以各 provider 工厂 d.ts 为准）。 */
export const PROVIDERS: Record<string, () => Provider> = {
  "opencode-go": opencodeGoProvider,
  anthropic: anthropicProvider,
  openai: openaiProvider,
  deepseek: deepseekProvider,
  google: googleProvider,
  openrouter: openrouterProvider,
};

/**
 * 从全局配置的多供应商构造 Models：每个供应商的 apiKey 经 CredentialStore 注入
 * （stored credential 优先于环境变量）；任一未知供应商抛错（启动时可给出明确原因）。
 */
export async function createConfiguredModels(providers: Record<string, ProviderEntry>): Promise<Models> {
  for (const id of Object.keys(providers)) {
    if (PROVIDERS[id] === undefined) {
      throw new Error(`未知供应商 ${id}（可选：${Object.keys(PROVIDERS).join(", ")}）`);
    }
  }
  const credentials = new InMemoryCredentialStore();
  const models = createModels({ credentials });
  for (const [id, entry] of Object.entries(providers)) {
    await credentials.modify(id, async () => ({ type: "api_key", key: entry.apiKey }));
    models.setProvider(PROVIDERS[id]!());
  }
  return models;
}
