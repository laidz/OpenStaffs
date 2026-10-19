import path from "node:path";

export type Workspace = { readonly root: string };

export function createWorkspace(root: string): Workspace {
  return { root: path.resolve(root) };
}

export function stateDir(ws: Workspace): string {
  return path.join(ws.root, ".openstaffs");
}

export function agentsDir(ws: Workspace): string {
  return path.join(ws.root, "agents");
}

export function projectsDir(ws: Workspace): string {
  return path.join(ws.root, "projects");
}

export function employeeDir(ws: Workspace, id: string): string {
  return path.join(agentsDir(ws), id);
}

export function conversationIdsFile(_ws: Workspace, dir: string): string {
  return path.join(dir, "conversation_ids.md");
}

/** 项目 = 扁平配置文件（D26），没有目录；群会话链改放机器私有区。 */
export function groupConversationIdsFile(ws: Workspace, name: string, agentId: string): string {
  return path.join(stateDir(ws), "chains", `group-${name}`, `${agentId}.md`);
}

/** 空间级附属目录名：老板的能力与附属（skills/、mcps.json）；可见、可版本化、随空间整包迁移。 */
export const SPACE_DIR_NAME = "openstaffs";

export function spaceDir(ws: Workspace): string {
  return path.join(ws.root, SPACE_DIR_NAME);
}

export function spaceSkillsDir(ws: Workspace): string {
  return path.join(spaceDir(ws), "skills");
}

/** 自有消息库（P1）；`stateDir` 的迁移（P4）不影响本函数语义。 */
export function messagesDbFile(ws: Workspace): string {
  return path.join(stateDir(ws), "messages.sqlite");
}

/** 工作树目录名（D20：平铺 `work/<名字>/`，与定义树分离）。 */
export const WORK_DIR_NAME = "work";

/** agent 的工作目录（会话 cwd / 自己的可写目录 / 会话链落点）；P2 只建目录，不预置 MEMORY.md（D27 归 P5）。 */
export function workDir(ws: Workspace, id: string): string {
  return path.join(ws.root, WORK_DIR_NAME, id);
}
