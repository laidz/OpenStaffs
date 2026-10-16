import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createModels, type Models, type Provider } from "@earendil-works/pi-ai/models";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { WorkspaceConfig } from "../domain/config.ts";

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
 * 从全局配置构造 Models：apiKey 经 CredentialStore 注入（stored credential 优先于环境变量）；
 * 未知 provider 抛错（启动时可给出明确原因）。
 */
export async function createConfiguredModels(config: WorkspaceConfig): Promise<Models> {
  const factory = PROVIDERS[config.provider];
  if (factory === undefined) {
    throw new Error(`未知供应商 ${config.provider}（可选：${Object.keys(PROVIDERS).join(", ")}）`);
  }
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(config.provider, async () => ({ type: "api_key", key: config.apiKey }));
  const models = createModels({ credentials });
  models.setProvider(factory());
  return models;
}
