// src/capabilities/assemble.ts —— 作用域链的能力累加装配（D12：一律累加，无覆盖、无优先级）。
import type { LoadedConfig } from "../config/schema.ts";

/** 作用域链装配结果（D12）：一律累加，无覆盖、无优先级。 */
export type Capabilities = { prompt: string; skills: string[]; mcp: string[] };

export function assembleCapabilities(scopes: readonly LoadedConfig[]): Capabilities {
  const prompts: string[] = [];
  const skills: string[] = [];
  const mcp: string[] = [];
  for (const scope of scopes) {
    if (scope.fields.prompt !== undefined && scope.fields.prompt.trim() !== "") prompts.push(scope.fields.prompt);
    skills.push(...scope.fields.skills);
    mcp.push(...scope.fields.mcp);
  }
  return { prompt: prompts.join("\n"), skills, mcp };
}
