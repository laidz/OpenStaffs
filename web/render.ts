import type { RoomMessage } from "../src/app/rooms.ts";
import type { QueuedItemView } from "../src/app/outbox.ts";
import type { RoomSessionInfo } from "../src/app/conversations.ts";
import { markdownHtml } from "./markdown.ts";
import type { ConfigView, ContextItemView, EmployeeSession, EmployeeSummary, OrgDept, SessionContextView } from "./api.ts";
import type { State } from "./state.ts";

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

export function setupPage(root: string, port: number): string {
  return `
    <main class="setup">
      <h1>OpenStaffs · 首次配置</h1>
      <p>请创建/编辑下面这个文件（若目录不存在请先创建 <code>openstaffs/.data/</code>），填入供应商密钥与默认模型（可配多个供应商）：</p>
      <pre>${escapeHtml(root)}/openstaffs/.data/config.json</pre>
      <pre>{
  "providers": {
    "opencode-go": { "apiKey": "你的密钥" }
  },
  "model": "opencode-go/deepseek-v4.1-flash",
  "port": ${port}
}</pre>
      <p>可选 provider：opencode-go / anthropic / openai / deepseek / google / openrouter。模型引用格式为 <code>供应商/模型 id</code>；员工可在自己的 <code>agents/&lt;部门…&gt;/&lt;名字&gt;.agent.config.json</code> 里用 <code>model</code> 字段覆盖成别的供应商与模型。</p>
      <p>保存配置后：Ctrl+C 停止服务 → 重新 <code>npm start</code> → 刷新本页。</p>
      <p class="hint">首次启动已自动初始化空间：<code>openstaffs/space.config.json</code>（空间自定义层，可选）与 <code>agents/staff0.agent.config.json</code>（0 号员工）。员工与项目不需要在这里配置（详见 README.md）。</p>
    </main>`;
}

export function sidebarHtml(state: State): string {
  const employeeItems =
    state.org === undefined
      ? state.employees.map((person) => personItemHtml(state, person)).join("") // 首帧（org 未到）回落平铺
      : [
          ...state.org.people.map((person) => personItemHtml(state, person)),
          ...state.org.departments.map((dept) => deptHtml(state, dept)),
        ].join("");
  const projectItems = state.projects
    .map((project) => {
      const roomKey = `group:${project.id}`;
      const pins = state.pins[roomKey] ?? 0;
      const busy = project.members.some((m) => state.busy[m.id] === true) ? '<span class="dot"></span>' : "";
      const active = state.roomKey === roomKey ? " active" : "";
      return `<div class="item-row">
        <button class="item item-main${active}" data-room="${escapeHtml(roomKey)}"><span>${escapeHtml(project.alias)}${busy}</span>${pins > 0 ? `<span class="badge">${pins}</span>` : ""}</button>
        ${configButtonHtml("project", project.id, `查看 ${project.id}.project.config.json`)}
      </div>`;
    })
    .join("");
  return `<aside class="sidebar" id="sidebar">
    <h3>员工</h3>${employeeItems || `<p class="hint">暂无员工</p>`}
    <h3>项目</h3>${projectItems || `<p class="hint">暂无项目</p>`}
  </aside>`;
}

/** 侧栏每一行右侧的 {} 按钮：展示该层定义文件的原样 JSON（只读）。 */
function configButtonHtml(scope: "agent" | "department" | "project", id: string, title: string): string {
  return `<button type="button" class="item-ctx" data-config-scope="${escapeHtml(scope)}" data-config-id="${escapeHtml(id)}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">{}</button>`;
}

/** 侧栏里的一员：名字按钮进私聊（红点 = pin 计数，忙碌点 = 正在跑）；右侧 {} 看定义文件。 */
function personItemHtml(state: State, person: EmployeeSummary): string {
  const roomKey = `dm:${person.id}`;
  const pins = state.pins[roomKey] ?? 0;
  const busy = state.busy[person.id] === true ? '<span class="dot"></span>' : "";
  const active = state.roomKey === roomKey ? " active" : "";
  return `<div class="item-row">
    <button class="item item-main${active}" data-room="${escapeHtml(roomKey)}"><span>${escapeHtml(person.alias ?? person.id)}${busy}</span>${pins > 0 ? `<span class="badge">${pins}</span>` : ""}</button>
    ${configButtonHtml("agent", person.id, `查看 ${person.id}.agent.config.json`)}
  </div>`;
}

/** 部门节点：可折叠（折叠时不渲染正文——不是藏起来再叠着显示）；{} 看 department.config.json。 */
function deptHtml(state: State, dept: OrgDept): string {
  const collapsed = state.collapsedDepts.includes(dept.path);
  const body = [...dept.people.map((p) => personItemHtml(state, p)), ...dept.departments.map((d) => deptHtml(state, d))].join("");
  return `<div class="dept" data-dept="${escapeHtml(dept.path)}">
    <div class="item-row dept-row">
      <button type="button" class="dept-head" data-toggle-dept="${escapeHtml(dept.path)}" aria-expanded="${collapsed ? "false" : "true"}"><span class="caret">${collapsed ? "▸" : "▾"}</span><span>${escapeHtml(dept.name)}</span></button>
      ${configButtonHtml("department", dept.path, `查看 ${dept.path === "" ? "agents" : `agents/${dept.path}`}/department.config.json`)}
    </div>
    ${collapsed ? "" : `<div class="dept-body">${body}</div>`}
  </div>`;
}

/** 排队标识（挂在真气泡上，或独立占位气泡里）：等待的成员 + 撤回入口（撤回 = 撤掉这条消息所有没开始的投递）。 */
function queuedBarHtml(roomMessageId: string, memberIds: string[]): string {
  return `<div class="msg-queue">排队中：${escapeHtml(memberIds.join("、"))}<button type="button" class="msg-unqueue" data-action="unqueue" data-room-message="${escapeHtml(roomMessageId)}" title="撤回这条还没投递的消息">撤回</button></div>`;
}

export function messageHtml(message: RoomMessage, bossName = "老板", pinned = false, pending: string[] = []): string {
  const speaker = message.speaker;
  const boss = speaker.kind === "boss";
  const name = speaker.kind === "boss" ? bossName : (speaker.alias ?? speaker.id);
  // 老板消息原样展示（转义 + 样式换行）；员工消息按 Markdown 渲染（UI 层，见 markdown.ts）
  const body = boss ? escapeHtml(message.text) : markdownHtml(message.text);
  const bodyClass = boss ? "msg-text" : "msg-text md";
  // 悬浮工具栏：复制（Markdown 原文）与 pin（逐条标记的唯一入口）。所有消息一视同仁。
  const tools = `<div class="msg-tools"><button type="button" class="msg-tool" data-action="copy" title="复制 Markdown 原文">复制</button><button type="button" class="msg-tool" data-action="pin" title="加图钉（给自己留提醒）">📌</button></div>`;
  const pinnedClass = pinned ? " pinned" : "";
  // 这条消息还有投递在排队（如群里只 @ 到了忙的成员）：贴在气泡上提示，不再另出占位气泡。
  const queue = message.roomMessageId === undefined || pending.length === 0 ? "" : queuedBarHtml(message.roomMessageId, pending);
  return `<div class="msg ${boss ? "boss" : "employee"}${pinnedClass}${queue === "" ? "" : " has-queue"}" data-conv-id="${escapeHtml(message.convId)}" data-entry-id="${escapeHtml(message.entryId)}"><div class="msg-name">${escapeHtml(name)}</div><div class="${bodyClass}">${body}</div>${tools}${queue}</div>`;
}

/**
 * 消息区：已落盘消息（含 markdown/pin/工具栏）+ 排队中的老板消息。
 * 排队条目按「消息」粒度合并（同一次发送的 N 份投递共享 roomMessageId）：
 * - 该消息还没进 transcript → 出独立占位气泡（灰底 + 排队标识 + 撤回）；
 * - 已有真气泡（如群里只有忙的那位还在排）→ 把排队标识贴在真气泡上，避免同一句话两个气泡。
 */
export function messagesHtml(
  messages: RoomMessage[],
  bossName = "老板",
  pinned: Iterable<string> = [],
  queued: QueuedItemView[] = [],
  hidden = 0,
): string {
  const pinnedSet = new Set(pinned);
  const byMessage = new Map<string, QueuedItemView[]>();
  for (const item of queued) {
    const list = byMessage.get(item.roomMessageId);
    if (list === undefined) byMessage.set(item.roomMessageId, [item]);
    else list.push(item);
  }
  const bubbles = messages.map((message) => {
    const roomMessageId = message.roomMessageId;
    const pending = roomMessageId === undefined ? undefined : byMessage.get(roomMessageId);
    if (roomMessageId !== undefined) byMessage.delete(roomMessageId); // 真气泡已出：排队标识贴上去，不出占位
    return messageHtml(message, bossName, pinnedSet.has(`${message.convId}:${message.entryId}`), pending?.map((item) => item.memberId) ?? []);
  });
  // 残留的 byMessage = 完全还没落盘的消息 → 占位气泡（Map 保留首次出现顺序 = 投递顺序）
  for (const [roomMessageId, items] of byMessage) {
    bubbles.push(`<div class="msg boss queued" data-room-message="${escapeHtml(roomMessageId)}"><div class="msg-name">${escapeHtml(bossName)}</div><div class="msg-text">${escapeHtml(items[0]!.text)}</div>${queuedBarHtml(roomMessageId, items.map((item) => item.memberId))}</div>`);
  }
  if (bubbles.length === 0) return `<div class="empty">还没有消息，发一条试试。</div>`;
  return bubbles.join("");
}

/**
 * 消息区顶部说明：新开会话后上一轮内容不再显示（隐藏条数来自服务端，0 = 没收起过）。
 * 目的：让人一眼看出「是被收起了」而不是「记录丢了」；旧内容在「历史」里仍可回看。
 */
export function hiddenMessagesHtml(hidden: number): string {
  if (hidden <= 0) return "";
  return `<div class="log-divider" id="log-divider">上一轮会话内容已收起（${hidden} 条），点「历史」可回看</div>`;
}

/** 消息区整体：说明条 + 气泡 + 排队中。
 *  「新开会话」已就绪（未发送）= **聊天区立刻清空**（上一轮记录不再显示）；
 *  再点一下取消 → `state.messages` 原封不动，直接重画就回来了。
 *  发送第一条后才真正建会话，服务端也只返回新一轮（见 store.currentWindow）。 */
export function messageListHtml(state: State): string {
  if (state.freshSession) {
    return `<div class="log-divider" id="log-divider">新一轮会话：发送第一条消息后开始（再点「新开会话」可取消，恢复上一轮记录）</div>`;
  }
  const body = messagesHtml(state.messages, state.bossName, state.pinned, state.queued);
  const divider = hiddenMessagesHtml(state.hiddenMessages);
  return divider === "" ? body : divider + body;
}

/**
 * 流式 / 进行中气泡：昵称 + 正文（Markdown）+ 底部状态行（转圈 + 当前在做的事）。
 * - 昵称取成员的 alias（org 里没有该人时回落 id）——不再直接把 agent_id 顶在气泡上；
 * - 状态行在 run 期间**恒存在**（文案由 state.activity 保证非空），
 *   旧实现只在「工具有在跑」时渲染该行，工具一结束整行消失 → 气泡塌陷、消息列表跳动。
 */
export function liveHtml(state: State): string {
  return Object.values(state.live)
    .map((entry) => {
      const name = state.employees.find((person) => person.id === entry.memberId)?.alias ?? entry.memberId;
      if (entry.error !== undefined) {
        return `<div class="msg employee live error"><div class="msg-name">${escapeHtml(name)}</div><div class="msg-text">⚠️ ${escapeHtml(entry.error)}</div></div>`;
      }
      const status = `<div class="live-status"><span class="live-spinner" aria-hidden="true"></span><span class="live-status-text">${escapeHtml(entry.activity || "正在思考…")}</span></div>`;
      return `<div class="msg employee live" data-live-conv="${escapeHtml(entry.convId)}"><div class="msg-name">${escapeHtml(name)}</div><div class="msg-text md">${markdownHtml(entry.text) || "…"}</div>${status}</div>`;
    })
    .join("");
}

/**
 * 「新开会话」已就绪时的提示文案（空串 = 未就绪）。
 * 语义：点击 → **聊天区立刻清空上一轮记录**（纯 UI 状态，可取消）；下一条消息**投递时**才真正建会话
 * （空点不建、撤回/中断也不建）；建会话那一刻服务端也只返回新一轮（见 store.currentWindow）。
 */
export function freshSessionHint(state: State): string {
  if (!state.freshSession || state.roomKey === undefined) return "";
  return state.roomKey.startsWith("group:")
    ? "发送第一条消息即开启新会话（@ 到的成员各开一条）；旧记录可在「历史」回看，再点「新开会话」可取消"
    : "发送第一条消息即开启新会话（当前会话将结束）；旧记录可在「历史」回看，再点「新开会话」可取消";
}

/** 上下文 token 数的紧凑展示：999 / 12.8K / 1.2M。 */
export function formatTokenCount(tokens: number): string {
  const trim = (value: number): string => value.toFixed(1).replace(/\.0$/u, "");
  if (tokens >= 1_000_000) return `${trim(tokens / 1_000_000)}M`;
  if (tokens >= 1000) return `${trim(tokens / 1000)}K`;
  return String(Math.max(0, Math.round(tokens)));
}

/**
 * 会话标题（点击即原地改名）：没标题渲染「未命名」占位（绝不出现 undefined）。
 * `className` 区分展示位置（聊天顶部 / 信息条 / 详情）。
 */
function titleHtml(convId: string, title: string | undefined, className: string): string {
  return `<button type="button" class="session-title ${className}" data-rename-conv="${escapeHtml(convId)}" title="点击改名">${escapeHtml(title ?? "未命名")}</button>`;
}

/**
 * 会话信息条：显示每条活跃会话**实际在用**的模型全值、思考强度、已用上下文 / 模型窗口。
 * 群聊逐成员展示（私聊不重复成员名）；思考强度 null = 未显式设定 → 展示 `default`（模型默认档）。
 */
export function sessionInfoHtml(state: State): string {
  const isGroup = state.roomKey?.startsWith("group:") === true;
  const metas = state.sessions
    .map((info: RoomSessionInfo) => {
      const employee = state.employees.find((e) => e.id === info.memberId);
      const name = employee?.alias ?? info.memberId;
      const parts: string[] = [];
      parts.push(titleHtml(info.convId, info.title, "info-title"));
      if (isGroup) parts.push(`<span class="session-member">${escapeHtml(name)}</span>`);
      parts.push(`<span class="session-model">${escapeHtml(info.model)}</span>`);
      parts.push(`<span class="session-thinking">思考 ${escapeHtml(info.thinkingLevel ?? "default")}</span>`);
      const used = formatTokenCount(info.contextUsed);
      const context =
        info.contextWindow === undefined
          ? `上下文 ${used}`
          : `上下文 ${used} / ${formatTokenCount(info.contextWindow)}，${Math.round((info.contextUsed / info.contextWindow) * 100)}%`;
      parts.push(`<span class="session-context">${context}</span>`);
      parts.push(`<button type="button" class="session-detail" data-session-detail="${escapeHtml(info.convId)}" data-member="${escapeHtml(info.memberId)}" title="查看这条会话的完整上下文（只读）">详情</button>`);
      return `<span class="session-meta" data-member="${escapeHtml(info.memberId)}">${parts.join("")}</span>`;
    })
    .join("");
  return `<div class="session-info" id="session-info">${metas}</div>`;
}

export function chatHtml(state: State): string {
  if (state.roomKey === undefined) {
    return `<section class="chat"><div class="empty">从左侧选择一个员工或项目开始对话。</div></section>`;
  }
  const isGroup = state.roomKey.startsWith("group:");
  const project = isGroup ? state.projects.find((p) => `group:${p.id}` === state.roomKey) : undefined;
  const employee = !isGroup ? state.employees.find((e) => `dm:${e.id}` === state.roomKey) : undefined;
  const title = isGroup ? (project?.alias ?? state.roomKey) : (employee?.alias ?? employee?.id ?? state.roomKey);
  // 私聊：房间名后跟上「当前会话标题」（可点击改）；群聊没有唯一当前会话 → 标题在信息条里逐条展示。
  const currentSession = isGroup ? undefined : state.sessions[0];
  const sessionTitleChip = currentSession === undefined ? "" : titleHtml(currentSession.convId, currentSession.title, "chat-title");
  // 群聊：输入框上方罗列成员复选框，勾选 = 往正文写 @（唯一真相源）；无勾选则发送禁用。
  const targetsRow = isGroup ? composerTargetsHtml(project?.members ?? []) : "";
  const placeholder = isGroup
    ? "输入消息，Enter 发送（发送对象 = 上方勾选的成员）"
    : "输入消息，Enter 发送";
  const sendDisabled = isGroup ? " disabled" : "";
  // 「新开会话」只置标志：下一条消息投递时才真正建会话（空点不产生空会话，撤回也不建）。
  const armed = state.freshSession ? " armed" : "";
  const hint = freshSessionHint(state);
  return `<section class="chat">
    <header class="chat-head">
      <span class="title">${escapeHtml(title)}</span>${sessionTitleChip}
      <button id="btn-new-session" class="btn-new-session${armed}" title="清空聊天区并开启新会话（发送第一条后生效）">新开会话</button>
      <button id="btn-history">历史</button>
      <button id="btn-interrupt" title="中止当前房间里所有在跑的成员">中断</button>
    </header>
    ${sessionInfoHtml(state)}
    <div class="msg-list" id="msg-list">
      <div id="messages-part">${messageListHtml(state)}</div>
      <div id="live-area">${liveHtml(state)}</div>
    </div>
    <div class="composer">
      ${targetsRow}
      ${hint === "" ? "" : `<div class="fresh-hint" id="fresh-hint">${escapeHtml(hint)}</div>`}
      <div class="composer-row">
        <textarea id="composer-input" placeholder="${placeholder}"></textarea>
        <button id="composer-send"${sendDisabled}>发送</button>
      </div>
    </div>
  </section>`;
}

/** 群聊发送对象复选框（展示名 + id；转义均在 HTML 层完成）。 */
function composerTargetsHtml(members: { id: string; alias?: string }[]): string {
  if (members.length === 0) {
    return `<div class="composer-targets" id="composer-targets"><span class="hint">本群还没有成员（项目 config 的 members 为空）</span></div>`;
  }
  const items = members
    .map((member) => {
      const name = escapeHtml(member.alias ?? member.id);
      const id = escapeHtml(member.id);
      const code = member.alias !== undefined && member.alias !== member.id ? `<code>${id}</code>` : "";
      return `<label class="target"><input type="checkbox" data-target="${id}" /><span>${name}</span>${code}</label>`;
    })
    .join("");
  return `<div class="composer-targets" id="composer-targets"><span class="targets-label">发送给：</span>${items}</div>`;
}

/** 授权卡片来源标签：群聊取项目别名，其余（dm:）为私聊。 */
function roomLabel(state: State, roomKey: string): string {
  if (!roomKey.startsWith("group:")) return "私聊";
  const project = state.projects.find((p) => `group:${p.id}` === roomKey);
  return project === undefined ? roomKey : `群聊「${project.alias}」`;
}

/** 右下角授权卡片堆叠（新请求在前；空列表为空容器）。 */
export function permissionCardsHtml(state: State): string {
  const cards = state.permissionRequests
    .map((request) => {
      const flavour = request.busy === true ? " disabled" : "";
      const error = request.error === undefined ? "" : `<div class="perm-error">${escapeHtml(request.error)}</div>`;
      const paths = request.paths.map((p) => `<li><code>${escapeHtml(p)}</code></li>`).join("");
      return `<div class="perm-card">
        <div class="perm-title">授权请求</div>
        <div class="perm-meta">发起人：${escapeHtml(request.agentName)}（${escapeHtml(request.agentId)}） · 来自：${escapeHtml(roomLabel(state, request.roomKey))}</div>
        <div class="perm-reason">理由：${escapeHtml(request.reason)}</div>
        <ul class="perm-paths">${paths}</ul>
        <div class="perm-actions">
          <button data-perm-accept="${escapeHtml(request.id)}"${flavour}>接受</button>
          <button data-perm-reject="${escapeHtml(request.id)}"${flavour}>拒绝</button>
        </div>
        ${error}
      </div>`;
    })
    .join("");
  return `<div class="perm-cards" id="perm-cards">${cards}</div>`;
}

function relationLabel(session: EmployeeSession): string {
  return session.kind === "dm" ? "私聊" : `群 · ${session.projectAlias ?? session.projectId ?? ""}`;
}

/** 本地时间 `YYYY-MM-DD HH:mm`（浏览器本地时区）；解析不了则退回原串截断，绝不显半截 ISO。 */
export function localDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 16).replace("T", " ");
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 本地时间 `HH:mm:ss`（条目行上的时间）；解析不了返回空串（宁可不显）。 */
export function localClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

const ROLE_LABEL: Record<ContextItemView["role"], string> = {
  system: "系统",
  user: "用户",
  assistant: "助手",
  tool: "工具结果",
};

/** 一条工具调用的状态徽标：无结果 / 出错 / 已完成。 */
function callBadge(result: ContextItemView | undefined): string {
  if (result === undefined) return '<span class="ctx-meta">无结果</span>';
  return result.isError === true ? '<span class="ctx-error">错误</span>' : '<span class="ctx-ok">已完成</span>';
}

/**
 * 工具调用 + 它自己的结果（同一个 toolCallId）合成**一块**可折叠内容，默认收起。
 * 原来「调用」与「结果」是两条并列条目，UI 上像两件不相干的事，且默认全展开、很吵。
 * `key` 用于新内容到达后保持已展开的折叠块（列表重画时不会“刷刷全合上”）。
 */
function toolCallHtml(call: { id?: string; name: string; arguments?: unknown }, result: ContextItemView | undefined, key: string): string {
  const args = `<pre class="ctx-args">${escapeHtml(JSON.stringify(call.arguments ?? {}, null, 2))}</pre>`;
  const output =
    result === undefined
      ? ""
      : `<div class="ctx-result"><pre>${escapeHtml(result.text === "" ? "（空输出）" : result.text)}</pre></div>`;
  return `<details class="ctx-block ctx-call" data-key="${escapeHtml(key)}"><summary>工具调用：${escapeHtml(call.name)} ${callBadge(result)}</summary>${args}${output}</details>`;
}

/** 孤立结果（对应调用不在本视图里）：仍单独成条，同样默认收起。 */
function orphanResultHtml(item: ContextItemView, key: string): string {
  return `<details class="ctx-block ctx-call" data-key="${escapeHtml(key)}"><summary>工具结果：${escapeHtml(item.toolName ?? "工具")} ${callBadge(item)}</summary><pre>${escapeHtml(item.text === "" ? "（空输出）" : item.text)}</pre></details>`;
}

/**
 * 条目列表渲染：先把「工具结果」按 toolCallId 归位到对应的调用上，再逐条渲染。
 * 只有**真能配上调用**的结果才合并（配不上就独立成条，绝不隐身），其余照常展示。
 * 传进来的列表按「新内容在前」排列（调用方已 reverse），配对与排序无关。
 */
export function contextItemsHtml(items: ContextItemView[]): string {
  const results = new Map<string, ContextItemView>();
  for (const item of items) {
    if (item.role === "tool" && item.toolCallId !== undefined) results.set(item.toolCallId, item);
  }
  const callIds = new Set<string>();
  for (const item of items) {
    for (const call of item.toolCalls ?? []) {
      if (call.id !== undefined) callIds.add(call.id);
    }
  }
  return items
    .map((item) => {
      // 能配上调用的工具结果：已并入那一块，不再单列
      if (item.role === "tool" && item.toolCallId !== undefined && callIds.has(item.toolCallId)) return "";
      return contextItemHtml(item, results);
    })
    .join("");
}

/** 条目在重画前后的稳定标识（用于保住已展开的折叠块）：时间 + 角色 + 工具调用 id + 文本长度。 */
function itemKey(item: ContextItemView): string {
  return `${item.at ?? ""}:${item.role}:${item.toolCallId ?? ""}:${item.text.length}`;
}

function contextItemHtml(item: ContextItemView, results: Map<string, ContextItemView>): string {
  const meta = item.kind === undefined ? "" : `<span class="ctx-meta">${escapeHtml(item.kind)}</span>`;
  const toolName = item.toolName === undefined ? "" : `<span class="ctx-meta">${escapeHtml(item.toolName)}</span>`;
  const error = item.isError === true ? '<span class="ctx-error">错误</span>' : "";
  const key = itemKey(item);
  // 每步的时间（本地时区）放在行首、与左侧内容并排；模型消息没带 timestamp 就不显
  const clock = item.at === undefined ? "" : localClock(item.at);
  const at = clock === "" ? "" : `<span class="ctx-time" title="${escapeHtml(localDateTime(item.at!))}">${escapeHtml(clock)}</span>`;
  const thinking =
    item.thinking === undefined || item.thinking === ""
      ? ""
      : `<details class="ctx-block" data-key="${escapeHtml(`${key}:thinking`)}"><summary>思考</summary><pre>${escapeHtml(item.thinking)}</pre></details>`;
  // 工具结果的正文放进折叠块里（不再在条目里重复一份）
  const text = item.role === "tool" || item.text === "" ? "" : `<pre class="ctx-text">${escapeHtml(item.text)}</pre>`;
  const calls =
    item.role === "tool"
      ? orphanResultHtml(item, `${key}:result`)
      : (item.toolCalls ?? [])
          .map((call) => toolCallHtml(call, call.id === undefined ? undefined : results.get(call.id), `${key}:call:${call.id ?? call.name}`))
          .join("");
  // 工具结果的内容在折叠块里，不算「空」
  const empty = text === "" && thinking === "" && calls === "" && item.role !== "tool" ? '<div class="ctx-meta">（空）</div>' : "";
  return `<div class="ctx-item ctx-${item.role}">
    <div class="ctx-head">${at}<strong>${ROLE_LABEL[item.role]}</strong>${meta}${toolName}${error}${item.toolCallId === undefined ? "" : `<span class="ctx-meta">${escapeHtml(item.toolCallId)}</span>`}</div>
    ${thinking}${text}${calls}${empty}
  </div>`;
}

/** 基础信息卡片里的「模型 / 思考 / 用量 / 运行中」一行；新内容到达时原地更新（不重画卡片）。 */
export function contextMetaHtml(context: SessionContextView): string {
  // 上下文用量与聊天顶部信息条同口径：带单位、带百分比（如 166K / 1M，17%）
  const used = formatTokenCount(context.contextUsed);
  const usage =
    context.contextWindow === undefined
      ? `上下文 ${used}`
      : `上下文 ${used} / ${formatTokenCount(context.contextWindow)}，${Math.round((context.contextUsed / context.contextWindow) * 100)}%`;
  return `${escapeHtml(context.model)} · 思考 ${escapeHtml(context.thinkingLevel ?? "default")} · ${escapeHtml(usage)}${context.running ? ' · <span class="ctx-running">运行中</span>' : ""}`;
}

/**
 * 会话详情面板的正文：基础信息卡片（关系 / 模型 / 用量 / 系统提示词）+ 模型条目。
 * 系统提示词并进第一张卡片（不再是页面上另起一坨）；条目区**新的在上**（逆序）。
 */
function contextBodyHtml(context: SessionContextView): string {
  const system = context.instructions.trim() === ""
    ? '<p class="hint">（没有系统提示词）</p>'
    : `<details class="ctx-system"><summary>系统提示词（${[...context.instructions].length} 字）</summary><div class="ctx-system-body"><pre class="ctx-text">${escapeHtml(context.instructions)}</pre></div></details>`;
  return `<div class="ctx-header">
      <div>${titleHtml(context.convId, context.title, "detail-title")}<strong>${escapeHtml(relationLabel(context))}</strong> <span class="ctx-meta">${escapeHtml(context.convId)} · ${escapeHtml(localDateTime(context.started))}</span></div>
      <div class="ctx-meta" id="ctx-meta-line">${contextMetaHtml(context)}</div>
      ${context.cwd === undefined ? "" : `<div class="ctx-meta">cwd：${escapeHtml(context.cwd)}</div>`}
      ${system}
    </div>
    <div class="ctx-items" id="ctx-items">${contextItemsHtml([...context.items].reverse())}</div>`;
}

/**
 * 会话详情（只读）：就是聊天顶部信息条那一条会话的完整上下文（系统提示词 + 模型条目）。
 * 没有「刷新」按钮：这条会话有新内容时自动 prepend 进列表（见 web/main.ts）。
 */
export function sessionPanelHtml(state: State, context: SessionContextView | undefined): string {
  const body =
    context === undefined
      ? '<p class="hint">无法读取该会话上下文（它可能刚刚结束）。</p>'
      : contextBodyHtml(context);
  return `<div class="layout">${sidebarHtml(state)}<section class="chat detail-panel">
    <header class="chat-head">
      <span class="title">会话详情（只读）</span>
      <button id="session-panel-back">返回聊天</button>
    </header>
    <div class="agent-context">${body}</div>
  </section></div>${permissionCardsHtml(state)}`;
}

/** 定义文件面板（只读）：左侧栏人员 / 部门 / 项目的 {} 按钮；原样展示 config JSON。 */
export function configPanelHtml(state: State, view: ConfigView, label: string): string {
  const body =
    view.text === null
      ? `<p class="hint">该层没有配置文件：<code>${escapeHtml(view.file)}</code></p>`
      : `<pre class="ctx-text config-text">${escapeHtml(view.text)}</pre>`;
  return `<div class="layout">${sidebarHtml(state)}<section class="chat detail-panel">
    <header class="chat-head">
      <span class="title">配置 · ${escapeHtml(label)}</span>
      <span class="ctx-meta">${escapeHtml(view.file)}</span>
      <button id="config-panel-back">返回聊天</button>
    </header>
    <div class="agent-context">${body}</div>
  </section></div>${permissionCardsHtml(state)}`;
}

export function layoutHtml(state: State): string {
  return `<div class="layout">${sidebarHtml(state)}${chatHtml(state)}</div>${permissionCardsHtml(state)}`;
}
