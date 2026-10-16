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

export function projectDir(ws: Workspace, name: string): string {
  return path.join(projectsDir(ws), name);
}

export function membersFile(ws: Workspace, name: string): string {
  return path.join(projectDir(ws, name), "members.md");
}

export function conversationIdsFile(_ws: Workspace, dir: string): string {
  return path.join(dir, "conversation_ids.md");
}
