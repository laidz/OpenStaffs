import { parseMembers } from "../domain/access-control.ts";
import { loadEmployee } from "../domain/employee.ts";
import { listProjects, loadProject } from "../domain/project.ts";
import type { Workspace } from "../domain/paths.ts";
import type { Relation } from "../domain/types.ts";
import type { MeetingKind, MeetingRecord, MeetingStore } from "../store/meetings.ts";

/**
 * 会议的业务层：**subject（员工 / 项目）↔ 会议** 的解析、快照与视图。
 * `meeting_id` 是框架自持的身份；`subjectKey`（`dm:<员工>` / `group:<项目>`）只是 API / UI 的
 * 入口地址，**不是**会话身份——同一 subject 可以有多场会议（历史）。
 */

export type MeetingDeps = { ws: Workspace; meetings: MeetingStore };

/** 会议的视图（HTTP / SSE / 前端用；不含库里内部列）。 */
export type MeetingView = {
  meetingId: string;
  kind: MeetingKind;
  subjectId: string;
  subjectLabel: string;
  /** 成员**实时**取当前主题成员（不是开会快照）：群加人后旧会议也能立刻 @ 到新人。 */
  participants: string[];
  title?: string;
  createdAt: string;
};

/** 主题键（API / URL 用）：`dm:<员工id>` / `group:<项目id>`。 */
export function subjectKeyOf(relation: Relation): string {
  return relation.kind === "dm" ? `dm:${relation.employeeId}` : `group:${relation.project}`;
}

/** 主题 id 安全校验（对齐 domain/project.ts 的 assertValidProjectId）：拒绝空/空白/路径分隔符/NUL/点开头。 */
function isSafeSubjectId(id: string): boolean {
  return (
    id.trim() !== "" &&
    !/\s/u.test(id) &&
    !id.includes("/") &&
    !id.includes("\\") &&
    !id.includes("\0") &&
    id !== "." &&
    id !== ".." &&
    !id.startsWith(".")
  );
}

export function parseSubjectKey(key: string): Relation | undefined {
  if (key.startsWith("dm:") && isSafeSubjectId(key.slice(3))) return { kind: "dm", employeeId: key.slice(3) };
  if (key.startsWith("group:") && isSafeSubjectId(key.slice(6))) return { kind: "group", project: key.slice(6) };
  return undefined;
}

/** 会议 → 它挂在哪个主题上（prompt / 权限 / 成员表都按这个反查）。 */
export function subjectOf(meeting: MeetingRecord): Relation {
  return meeting.kind === "dm" ? { kind: "dm", employeeId: meeting.subjectId } : { kind: "group", project: meeting.subjectId };
}

/** 开会时的显示名：员工 / 项目 alias；取不到（已删除等）用 id。 */
export function subjectLabel(ws: Workspace, relation: Relation): string {
  if (relation.kind === "dm") {
    try {
      return loadEmployee(ws, relation.employeeId).alias ?? relation.employeeId;
    } catch {
      return relation.employeeId;
    }
  }
  try {
    return loadProject(ws, relation.project).alias ?? relation.project;
  } catch {
    return relation.project;
  }
}

/** 开会时的成员快照：私聊 = 那一个人；群聊 = 项目 config 的 members。 */
export function participantIds(ws: Workspace, relation: Relation): string[] {
  return relation.kind === "dm" ? [relation.employeeId] : parseMembers(ws, relation.project);
}

export function meetingView(ws: Workspace, meeting: MeetingRecord): MeetingView {
  return {
    meetingId: meeting.meetingId,
    kind: meeting.kind,
    subjectId: meeting.subjectId,
    subjectLabel: meeting.subjectLabel,
    participants: participantIds(ws, subjectOf(meeting)),
    ...(meeting.title === undefined ? {} : { title: meeting.title }),
    createdAt: meeting.createdAt,
  };
}

/** 新建一场会议（只开新线程，**不结束**任何旧会议；旧会议随时可继续聊）。 */
export function createNewMeeting(deps: MeetingDeps, relation: Relation, now: Date): MeetingRecord {
  return deps.meetings.create({
    kind: relation.kind,
    subjectId: relation.kind === "dm" ? relation.employeeId : relation.project,
    subjectLabel: subjectLabel(deps.ws, relation),
    now: now.toISOString(),
  });
}

/** 该 subject 最新的会议；没有就新建一场（「首条消息才落会议」的口径）。 */
export function ensureMeeting(deps: MeetingDeps, relation: Relation, now: Date): MeetingRecord {
  const kind = relation.kind;
  const subjectId = relation.kind === "dm" ? relation.employeeId : relation.project;
  return deps.meetings.latest(kind, subjectId) ?? createNewMeeting(deps, relation, now);
}

/** 该 subject 的全部会议（created_at 倒序 = 历史列表；全部都能继续聊）。 */
export function meetingsOf(deps: MeetingDeps, relation: Relation): MeetingRecord[] {
  const kind = relation.kind;
  const subjectId = relation.kind === "dm" ? relation.employeeId : relation.project;
  return deps.meetings.list(kind, subjectId);
}

/** 该员工所在的全部"主题"（私聊 + 他参与的每个项目）：员工会话面板用。 */
export function subjectsOfEmployee(ws: Workspace, employeeId: string): Relation[] {
  const out: Relation[] = [{ kind: "dm", employeeId }];
  for (const project of listProjects(ws)) {
    if (parseMembers(ws, project.id).includes(employeeId)) out.push({ kind: "group", project: project.id });
  }
  return out;
}


/** 删除会议时的依赖：会议行 + 消息 / 会话映射 / pin 一起清；正在跑的会话先中止再退订。 */
export type DeleteMeetingDeps = {
  ws: Workspace;
  meetings: MeetingStore;
  messages: { deleteByMeeting(meetingId: string): number };
  sessions: {
    listByMeeting(meetingId: string): { convId: string }[];
    deleteByMeeting(meetingId: string): number;
  };
  abort?: (convId: string) => Promise<void>;
  unregister?: (convId: string) => Promise<void>;
  removePins?: (meetingId: string) => void;
};

/** 删除一场会议（不存在返回 undefined）。返回被删会议的主题键，供前端导航。 */
export async function deleteMeeting(
  deps: DeleteMeetingDeps,
  meetingId: string,
): Promise<{ meetingId: string; subjectKey: string } | undefined> {
  const meeting = deps.meetings.get(meetingId);
  if (meeting === undefined) return undefined;
  for (const session of deps.sessions.listByMeeting(meetingId)) {
    try {
      await deps.abort?.(session.convId);
    } catch {
      // 坏会话 / 已在跑结束：删除不因它失败
    }
    try {
      await deps.unregister?.(session.convId);
    } catch {
      // 同上
    }
  }
  deps.messages.deleteByMeeting(meetingId);
  deps.sessions.deleteByMeeting(meetingId);
  deps.removePins?.(meetingId);
  deps.meetings.delete(meetingId);
  return { meetingId, subjectKey: subjectKeyOf(subjectOf(meeting)) };
}
