import type { RoomMessage } from "../src/app/rooms.ts";
import type { QueuedItemView } from "../src/app/outbox.ts";
import type { RoomSessionInfo } from "../src/app/conversations.ts";
import { markdownHtml } from "./markdown.ts";
import type { Live, State } from "./state.ts";

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

export function setupPage(root: string, port: number): string {
  return `
    <main class="setup">
      <h1>OpenStaffs · 首次配置</h1>
      <p>请创建/编辑下面这个文件（若目录不存在请先创建 <code>.openstaffs/</code>），填入供应商密钥与默认模型（可配多个供应商）：</p>
      <pre>${escapeHtml(root)}/.openstaffs/config.json</pre>
      <pre>{
  "providers": {
    "opencode-go": { "apiKey": "你的密钥" }
  },
  "model": "opencode-go/deepseek-v4.1-flash",
  "port": ${port}
}</pre>
      <p>可选 provider：opencode-go / anthropic / openai / deepseek / google / openrouter。模型引用格式为 <code>供应商/模型 id</code>；员工可在 <code>agents/&lt;员工&gt;/config.json</code> 里用 <code>model</code> 覆盖成别的供应商与模型。</p>
      <p>保存配置后：Ctrl+C 停止服务 → 重新 <code>npm start</code> → 刷新本页。</p>
      <p class="hint">员工与项目不需要在这里配置：直接在 <code>agents/</code> 与 <code>projects/</code> 下建文件夹即可（详见 README.md）。</p>
    </main>`;
}

export function sidebarHtml(state: State): string {
  const employeeItems = state.employees
    .map((employee) => {
      const roomKey = `dm:${employee.id}`;
      const pins = state.pins[roomKey] ?? 0;
      const busy = state.busy[employee.id] === true ? '<span class="dot"></span>' : "";
      const active = state.roomKey === roomKey ? " active" : "";
      return `<button class="item${active}" data-room="${escapeHtml(roomKey)}"><span>${escapeHtml(employee.alias ?? employee.id)}${busy}</span>${pins > 0 ? `<span class="badge">${pins}</span>` : ""}</button>`;
    })
    .join("");
  const projectItems = state.projects
    .map((project) => {
      const roomKey = `group:${project.id}`;
      const pins = state.pins[roomKey] ?? 0;
      const busy = project.members.some((m) => state.busy[m.id] === true) ? '<span class="dot"></span>' : "";
      const active = state.roomKey === roomKey ? " active" : "";
      return `<button class="item${active}" data-room="${escapeHtml(roomKey)}"><span>${escapeHtml(project.alias)}${busy}</span>${pins > 0 ? `<span class="badge">${pins}</span>` : ""}</button>`;
    })
    .join("");
  return `<aside class="sidebar" id="sidebar">
    <h3>员工</h3>${employeeItems || `<p class="hint">还没有员工：在 agents/ 下创建目录并写 AGENTS.md（见 README.md）。</p>`}
    <h3>项目</h3>${projectItems || `<p class="hint">还没有项目：在 projects/ 下创建目录并写 members.md（见 README.md）。</p>`}
  </aside>`;
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

export function liveHtml(live: Record<string, Live>): string {
  return Object.values(live)
    .map((entry) => {
      const body =
        entry.error !== undefined
          ? `<div class="msg-text">⚠️ ${escapeHtml(entry.error)}</div>`
          : `<div class="msg-text md">${markdownHtml(entry.text) || "…"}</div>`;
      const tool =
        entry.tools.length > 0
          ? `<div class="tool-line">正在执行 ${escapeHtml(entry.tools[entry.tools.length - 1]!)}…</div>`
          : "";
      return `<div class="msg employee live${entry.error !== undefined ? " error" : ""}"><div class="msg-name">${escapeHtml(entry.memberId)}</div>${body}${tool}</div>`;
    })
    .join("");
}

/**
 * 「新开会话」已就绪时的提示文案（空串 = 未就绪）。
 * 语义：按钮只置标志，下一条消息**投递时**才真正建会话——空点不建、撤回/中断也不建。
 */
export function freshSessionHint(state: State): string {
  if (!state.freshSession || state.roomKey === undefined) return "";
  return state.roomKey.startsWith("group:")
    ? "下一条消息将开启新会话（@ 到的成员各开一条）；再点「新开会话」可取消"
    : "下一条消息将开启新会话（当前会话将结束，可在历史中回看）；再点「新开会话」可取消";
}

/** 上下文 token 数的紧凑展示：999 / 12.8K / 1.2M。 */
export function formatTokenCount(tokens: number): string {
  const trim = (value: number): string => value.toFixed(1).replace(/\.0$/u, "");
  if (tokens >= 1_000_000) return `${trim(tokens / 1_000_000)}M`;
  if (tokens >= 1000) return `${trim(tokens / 1000)}K`;
  return String(Math.max(0, Math.round(tokens)));
}

/**
 * 会话信息条：显示每条活跃会话**实际在用**的模型全值、思考强度、已用上下文 / 模型窗口。
 * 群聊逐成员展示（私聊不重复成员名）；思考强度 null = 模型明确不支持该档。
 */
export function sessionInfoHtml(state: State): string {
  const isGroup = state.roomKey?.startsWith("group:") === true;
  const metas = state.sessions
    .map((info: RoomSessionInfo) => {
      const employee = state.employees.find((e) => e.id === info.memberId);
      const name = employee?.alias ?? info.memberId;
      const parts: string[] = [];
      if (isGroup) parts.push(`<span class="session-member">${escapeHtml(name)}</span>`);
      parts.push(`<span class="session-model">${escapeHtml(info.model)}</span>`);
      parts.push(`<span class="session-thinking">思考 ${escapeHtml(String(info.thinkingLevel ?? "null"))}</span>`);
      const used = formatTokenCount(info.contextUsed);
      const context =
        info.contextWindow === undefined
          ? `上下文 ${used}`
          : `上下文 ${used} / ${formatTokenCount(info.contextWindow)}，${Math.round((info.contextUsed / info.contextWindow) * 100)}%`;
      parts.push(`<span class="session-context">${context}</span>`);
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
      <span class="title">${escapeHtml(title)}</span>
      <button id="btn-new-session" class="btn-new-session${armed}" title="下一条消息开启新会话">新开会话</button>
      <button id="btn-history">历史</button>
      <button id="btn-interrupt" title="中止当前房间里所有在跑的成员">中断</button>
    </header>
    ${sessionInfoHtml(state)}
    <div class="msg-list" id="msg-list">
      <div id="messages-part">${messagesHtml(state.messages, state.bossName, state.pinned, state.queued)}</div>
      <div id="live-area">${liveHtml(state.live)}</div>
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
    return `<div class="composer-targets" id="composer-targets"><span class="hint">本群还没有成员（members.md 为空）</span></div>`;
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

export function layoutHtml(state: State): string {
  return `<div class="layout">${sidebarHtml(state)}${chatHtml(state)}</div>${permissionCardsHtml(state)}`;
}
