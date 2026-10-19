import { managedSubtreeOf } from "../domain/org.ts";
import { spaceSkillsDir, type Workspace } from "../domain/paths.ts";
import { FRAMEWORK_SKILLS_DIR } from "../domain/skills.ts";
import type { RuntimeGrants } from "./types.ts";

/** 运行时授予（D13）：自己的工作目录（所有工具）+ 主管写权 + 技能库根（read）。 */
export function runtimeGrantsFor(input: {
  ws: Workspace;
  agentId: string;
  workdir: string;
  extraReadRoots?: readonly string[];
}): RuntimeGrants {
  const subtree = managedSubtreeOf(input.ws, input.agentId);
  return {
    workdir: input.workdir,
    readRoots: [spaceSkillsDir(input.ws), ...(input.extraReadRoots ?? []), FRAMEWORK_SKILLS_DIR],
    managedWriteDirs: [...subtree.departmentDirs, ...subtree.agentDirs],
  };
}
