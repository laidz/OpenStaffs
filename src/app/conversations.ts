import path from "node:path";
import { conversationIdsFile, employeeDir, groupConversationIdsFile, projectDir, type Workspace } from "../domain/paths.ts";
import { loadEmployee, renderInstructions, type Employee } from "../domain/employee.ts";
import { projectsOf } from "../domain/access-control.ts";
import { activeSession, startNewSession } from "../domain/conversation-chain.ts";
import { listSkills, renderSkills } from "../domain/skills.ts";
import type { HarnessPort, ConversationSpec } from "../harness/port.ts";

export type Relation =
  | { kind: "dm"; employeeId: string }
  | { kind: "group"; project: string };

export function relationKey(relation: Relation, speakerId: string): string {
  return relation.kind === "dm" ? `dm:${relation.employeeId}` : `group:${relation.project}:${speakerId}`;
}

export function relationCwd(ws: Workspace, relation: Relation): string {
  return relation.kind === "dm" ? employeeDir(ws, relation.employeeId) : projectDir(ws, relation.project);
}

export function permissionFilesFor(ws: Workspace, relation: Relation, speaker: Employee): string[] {
  const files: string[] = [];
  if (relation.kind === "group") files.push(path.join(projectDir(ws, relation.project), "permission.json"));
  files.push(path.join(employeeDir(ws, speaker.id), "permission.json"));
  return files;
}

function chainFileFor(ws: Workspace, relation: Relation, speakerId: string): string {
  return relation.kind === "dm"
    ? conversationIdsFile(ws, employeeDir(ws, relation.employeeId))
    : groupConversationIdsFile(ws, relation.project, speakerId);
}

/** 技能根目录：群聊 = 项目 skills + 员工 skills（群在前）；私聊 = 员工 skills。 */
export function skillDirsFor(ws: Workspace, relation: Relation, speaker: Employee): string[] {
  const dirs: string[] = [];
  if (relation.kind === "group") dirs.push(path.join(projectDir(ws, relation.project), "skills"));
  dirs.push(path.join(employeeDir(ws, speaker.id), "skills"));
  return dirs;
}

/** 会话的 instructions = 员工入口/档案/记忆 + 技能清单（只注入 name + description）。 */
export function instructionsFor(ws: Workspace, relation: Relation, speaker: Employee): string {
  return [renderInstructions(speaker), renderSkills(listSkills(skillDirsFor(ws, relation, speaker)))]
    .filter((part) => part.trim() !== "")
    .join("\n\n");
}

function specFor(ws: Workspace, relation: Relation, speaker: Employee): ConversationSpec {
  if (relation.kind === "dm" && speaker.id !== relation.employeeId) {
    throw new Error(`私聊关系与发言人不一致: ${relation.employeeId} ≠ ${speaker.id}`);
  }
  const cwd = relationCwd(ws, relation);
  return {
    cwd,
    instructions: instructionsFor(ws, relation, speaker),
    model: { provider: speaker.model.provider, modelId: speaker.model.modelId },
    ...(speaker.model.thinkingLevel === undefined ? {} : { thinkingLevel: speaker.model.thinkingLevel }),
    access: {
      root: ws.root,
      cwd,
      selfId: speaker.id,
      memberProjects: projectsOf(ws, speaker.id),
      permissionFiles: permissionFilesFor(ws, relation, speaker),
    },
  };
}

async function ensure(ws: Workspace, harness: HarnessPort, relation: Relation, speakerId: string): Promise<string> {
  const speaker = loadEmployee(ws, speakerId);
  const file = chainFileFor(ws, relation, speakerId);
  const active = activeSession(file);
  const spec = specFor(ws, relation, speaker);
  if (active !== undefined && (await harness.attach(relationKey(relation, speakerId), active.id, spec))) {
    return active.id;
  }
  const convId = await harness.ensureActive(relationKey(relation, speakerId), spec);
  startNewSession(file, convId, new Date().toISOString());
  return convId;
}

export function openDm(ws: Workspace, harness: HarnessPort, employeeId: string): Promise<string> {
  return ensure(ws, harness, { kind: "dm", employeeId }, employeeId);
}

export function openGroup(ws: Workspace, harness: HarnessPort, project: string, speakerId: string): Promise<string> {
  return ensure(ws, harness, { kind: "group", project }, speakerId);
}

export async function newSession(ws: Workspace, harness: HarnessPort, relation: Relation, speakerId: string): Promise<string> {
  const speaker = loadEmployee(ws, speakerId);
  const spec = specFor(ws, relation, speaker);
  const convId = await harness.startSession(relationKey(relation, speakerId), spec);
  startNewSession(chainFileFor(ws, relation, speakerId), convId, new Date().toISOString());
  return convId;
}
