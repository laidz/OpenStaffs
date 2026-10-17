import fs from "node:fs";
import path from "node:path";
import { Type, type TSchema } from "typebox";
import { parseMembers, projectsOf } from "../domain/access-control.ts";
import { bossNamesFor, readBossName, readConfig } from "../domain/config.ts";
import { listEmployees, loadEmployee } from "../domain/employee.ts";
import type { Workspace } from "../domain/paths.ts";
import type { PermissionRequest, PermissionRequestStore } from "../domain/permission-requests.ts";
import { listProjects } from "../domain/project.ts";
import type { Relation } from "../domain/types.ts";
import type { HarnessPort } from "../harness/port.ts";
import { newSession, openDm, openGroup, relationCwd, roomTranscripts, type SessionDefaults } from "../app/conversations.ts";
import { mergeRoomMessages, parseRoomKey, roomKeyOf, type RoomSpeaker } from "../app/rooms.ts";

/** 授权请求依赖（由装配层注入；未注入时 request_permission 报"不可用"）。 */
export type ToolPermissions = {
  store: PermissionRequestStore;
  notify: (request: PermissionRequest) => void;
};

/** 工具运行上下文：会话身份 + 编排依赖。 */
export type ToolContext = {
  ws: Workspace;
  harness: HarnessPort;
  selfId: string;
  relation: Relation;
  permissions?: ToolPermissions;
};

/** 统一注册表条目。 */
export type ToolDef = {
  name: string;
  description: string;
  parameters: TSchema;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
};

function readTextOrEmpty(file: string): string {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function displayName(ws: Workspace, id: string): string {
  try {
    return loadEmployee(ws, id).alias ?? id;
  } catch {
    return id;
  }
}

/** 新会话/新条会话的模型兜底（全局默认模型）。 */
function defaultsOf(ctx: ToolContext): SessionDefaults | undefined {
  const config = readConfig(ctx.ws);
  return config === undefined ? undefined : { model: config.model };
}

/** 列出办公室：成员 + 项目。 */
const officeList: ToolDef = {
  name: "office_list",
  description:
    "列出办公室：全部成员（id、展示名）与全部项目（id、展示名、成员 id、你是否在其中）。想了解有哪些同事 / 哪些群聊时用它。",
  parameters: Type.Object({}),
  async run(_args, ctx) {
    const employees = listEmployees(ctx.ws).map((e) => ({ id: e.id, name: e.alias ?? e.id }));
    const mine = new Set(projectsOf(ctx.ws, ctx.selfId));
    const projects = listProjects(ctx.ws).map((p) => ({
      id: p.id,
      name: p.alias,
      members: parseMembers(ctx.ws, p.id),
      youAreMember: mine.has(p.id),
    }));
    return JSON.stringify({ you: ctx.selfId, employees, projects }, null, 2);
  },
};

/** 读某成员资料。 */
const memberProfile: ToolDef = {
  name: "member_profile",
  description: "读某位成员的资料：id、展示名与 profile.md 正文（岗位 / 职责 / 人格）。参数 member 是成员 id（目录名）。",
  parameters: Type.Object({ member: Type.String({ description: "成员 id（agents/ 下的目录名）" }) }),
  async run(args, ctx) {
    const member = String(args["member"]);
    const employee = loadEmployee(ctx.ws, member);
    const profile = readTextOrEmpty(path.join(employee.dir, "profile.md"));
    return [`成员：${employee.alias ?? employee.id}（${employee.id}）`, profile === "" ? "（无 profile.md）" : profile].join("\n\n");
  },
};

function speakerName(ws: Workspace, speaker: RoomSpeaker): string {
  if (speaker.kind === "boss") return readBossName(ws);
  return speaker.alias ?? displayName(ws, speaker.id);
}

/** 读房间聊天记录。 */
const roomHistory: ToolDef = {
  name: "room_history",
  description:
    "读某个房间的聊天记录（含发言人）。room 缺省 = 当前房间；也可传房间键 dm:<员工id> 或 group:<项目id>。limit 取最近若干条（缺省 50）。",
  parameters: Type.Object({
    room: Type.Optional(Type.String({ description: "房间键：dm:<员工id> 或 group:<项目id>；缺省当前房间" })),
    limit: Type.Optional(Type.Number({ description: "最近 N 条，缺省 50" })),
  }),
  async run(args, ctx) {
    const room = args["room"] === undefined ? undefined : String(args["room"]);
    const relation = room === undefined ? ctx.relation : parseRoomKey(room);
    if (relation === undefined) throw new Error(`房间键不合法：${room}（应为 dm:<员工id> 或 group:<项目id>）`);
    const limitRaw = args["limit"];
    const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw) ? Math.max(1, Math.floor(limitRaw)) : 50;

    const transcripts = await roomTranscripts(ctx.ws, ctx.harness, relation);
    const memberIds = relation.kind === "group" ? parseMembers(ctx.ws, relation.project) : [];
    const merged = mergeRoomMessages(roomKeyOf(relation), transcripts, memberIds, bossNamesFor(ctx.ws));
    const recent = merged.slice(-limit);
    if (recent.length === 0) return "（暂无消息）";
    return recent.map((m) => `${speakerName(ctx.ws, m.speaker)}：${m.text}`).join("\n");
  },
};

/** 通用发消息（老板 / 群成员 / 项目）。 */
const sendMessage: ToolDef = {
  name: "send_message",
  description:
    "发消息。target 三选一：boss（主动私聊负责人，会进其待办）；member:<成员id>（在**当前群聊**里触发该成员，即 @他）；project:<项目id>（投递到你在该项目群的会话）。text 为消息内容。",
  parameters: Type.Object({
    target: Type.String({ description: "boss | member:<成员id> | project:<项目id>" }),
    text: Type.String({ description: "消息内容" }),
  }),
  async run(args, ctx) {
    const target = String(args["target"]);
    const text = String(args["text"]);
    if (target === "boss") {
      const convId = await openDm(ctx.ws, ctx.harness, ctx.selfId, defaultsOf(ctx));
      await ctx.harness.append(convId, { kind: "chat.message", text, data: { author: ctx.selfId } });
      return `已发给「${readBossName(ctx.ws)}」（会显示在其待办里）。`;
    }
    const memberMatch = /^member:(.+)$/u.exec(target);
    if (memberMatch !== null) {
      const memberId = memberMatch[1]!;
      if (ctx.relation.kind !== "group") throw new Error("member: 目标只能在群聊里用（当前是私聊）");
      if (!parseMembers(ctx.ws, ctx.relation.project).includes(memberId)) throw new Error(`不是本群成员：${memberId}`);
      const convId = await openGroup(ctx.ws, ctx.harness, ctx.relation.project, memberId, defaultsOf(ctx));
      await ctx.harness.submit(convId, text, { kind: "chat.message", data: { author: ctx.selfId } });
      return `已触发 ${memberId}。`;
    }
    const projectMatch = /^project:(.+)$/u.exec(target);
    if (projectMatch !== null) {
      const projectId = projectMatch[1]!;
      const convId = await openGroup(ctx.ws, ctx.harness, projectId, ctx.selfId, defaultsOf(ctx));
      await ctx.harness.append(convId, { kind: "chat.message", text, data: { author: ctx.selfId } });
      return `已投递到项目 ${projectId}。`;
    }
    throw new Error(`无法识别的 target：${target}（应为 boss | member:<id> | project:<id>）`);
  },
};

/** 新开一段会话。 */
const newSessionTool: ToolDef = {
  name: "new_session",
  description: "重开一段新会话（结束当前、开新条，旧会话保留可回看）。适合上下文太长或想彻底换个话题时。下一轮起生效。",
  parameters: Type.Object({}),
  async run(_args, ctx) {
    await newSession(ctx.ws, ctx.harness, ctx.relation, ctx.selfId, defaultsOf(ctx));
    return "已重开会话（下一轮起使用新会话）。";
  },
};

/** 申请写权限（异步：负责人稍后在界面弹框中处理）。 */
const requestPermission: ToolDef = {
  name: "request_permission",
  description:
    "向负责人申请写入某些路径的权限。**异步**：工具立即返回；负责人稍后在界面弹框中接受或拒绝，结果会以一条新消息通知你——在此之前不要重复发起，也不要尝试写入这些路径或用其他方式绕过拦截。paths 为要申请的路径（目录或文件，可多个；相对路径按当前工作目录解析）；reason 为简短理由（必填，会展示给负责人）。",
  parameters: Type.Object({
    paths: Type.Array(Type.String(), { description: "要申请的路径（目录 / 文件，可多个）" }),
    reason: Type.String({ description: "简短理由：为什么需要这些路径（会展示给负责人）" }),
  }),
  async run(args, ctx) {
    const permissions = ctx.permissions;
    if (permissions === undefined) throw new Error("授权申请不可用：当前会话未装配该能力。");
    const cwd = relationCwd(ctx.ws, ctx.relation);
    const rawPaths = Array.isArray(args["paths"]) ? args["paths"] : [];
    const paths = [
      ...new Set(
        rawPaths
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter((value) => value !== "")
          .map((value) => path.resolve(cwd, value)),
      ),
    ];
    const bossName = readBossName(ctx.ws);
    if (paths.length === 0) throw new Error("paths 不能为空：至少给出一个要申请的路径。");
    const reason = String(args["reason"] ?? "").trim();
    if (reason === "") throw new Error(`reason 不能为空：用一两句话说明为什么要这些路径（会展示给「${bossName}」）。`);
    if (permissions.store.findDuplicate(ctx.selfId, paths) !== undefined) {
      return `已有相同的授权请求在等待「${bossName}」处理（${paths.length} 个地址），请勿重复发起。`;
    }
    const request = permissions.store.add({ agentId: ctx.selfId, roomKey: roomKeyOf(ctx.relation), paths, reason });
    permissions.notify(request);
    return [
      `已向「${bossName}」发起授权请求（${paths.length} 个地址）：`,
      ...paths.map((value) => `- ${value}`),
      "等待处理：请勿重复发起，也不要尝试写入这些路径或用其他方式绕过拦截；处理后你会收到新消息。",
    ].join("\n");
  },
};

/** OpenStaffs 自有工具（统一注册表，唯一真相源）。加工具 = 加一条并在此登记。 */
export const openStaffsToolDefs: readonly ToolDef[] = [officeList, memberProfile, roomHistory, sendMessage, newSessionTool, requestPermission];
