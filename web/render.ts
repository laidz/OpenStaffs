import type { RoomMessage } from "../src/app/rooms.ts";
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

export function messageHtml(message: RoomMessage, bossName = "老板", pinned = false): string {
  const speaker = message.speaker;
  const boss = speaker.kind === "boss";
  const name = speaker.kind === "boss" ? bossName : (speaker.alias ?? speaker.id);
  // 老板消息原样展示（转义 + 样式换行）；员工消息按 Markdown 渲染（UI 层，见 markdown.ts）
  const body = boss ? escapeHtml(message.text) : markdownHtml(message.text);
  const bodyClass = boss ? "msg-text" : "msg-text md";
  // 悬浮工具栏：复制（Markdown 原文）与 pin（逐条标记的唯一入口）。所有消息一视同仁。
  const tools = `<div class="msg-tools"><button type="button" class="msg-tool" data-action="copy" title="复制 Markdown 原文">复制</button><button type="button" class="msg-tool" data-action="pin" title="加图钉（给自己留提醒）">📌</button></div>`;
  const pinnedClass = pinned ? " pinned" : "";
  return `<div class="msg ${boss ? "boss" : "employee"}${pinnedClass}" data-conv-id="${escapeHtml(message.convId)}" data-entry-id="${escapeHtml(message.entryId)}"><div class="msg-name">${escapeHtml(name)}</div><div class="${bodyClass}">${body}</div>${tools}</div>`;
}

export function messagesHtml(messages: RoomMessage[], bossName = "老板", pinned: Iterable<string> = []): string {
  if (messages.length === 0) return `<div class="empty">还没有消息，发一条试试。</div>`;
  const pinnedSet = new Set(pinned);
  return messages.map((message) => messageHtml(message, bossName, pinnedSet.has(`${message.convId}:${message.entryId}`))).join("");
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

export function chatHtml(state: State): string {
  if (state.roomKey === undefined) {
    return `<section class="chat"><div class="empty">从左侧选择一个员工或项目开始对话。</div></section>`;
  }
  const isGroup = state.roomKey.startsWith("group:");
  const project = isGroup ? state.projects.find((p) => `group:${p.id}` === state.roomKey) : undefined;
  const employee = !isGroup ? state.employees.find((e) => `dm:${e.id}` === state.roomKey) : undefined;
  const title = isGroup ? (project?.alias ?? state.roomKey) : (employee?.alias ?? employee?.id ?? state.roomKey);
  const memberSelect = isGroup
    ? `<select id="member-select">${(project?.members ?? [])
        .map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.alias ?? m.id)}</option>`)
        .join("")}</select>`
    : "";
  // 群聊：输入框上方罗列成员复选框，勾选 = 往正文写 @（唯一真相源）；无勾选则发送禁用。
  const targetsRow = isGroup ? composerTargetsHtml(project?.members ?? []) : "";
  const placeholder = isGroup
    ? "输入消息，Enter 发送（发送对象 = 上方勾选的成员）"
    : "输入消息，Enter 发送";
  const sendDisabled = isGroup ? " disabled" : "";
  return `<section class="chat">
    <header class="chat-head">
      <span class="title">${escapeHtml(title)}</span>
      ${memberSelect}
      <button id="btn-new-session">新开会话</button>
      <button id="btn-history">历史</button>
      <button id="btn-interrupt" title="中止当前房间里所有在跑的成员">中断</button>
    </header>
    <div class="msg-list" id="msg-list">
      <div id="messages-part">${messagesHtml(state.messages, state.bossName, state.pinned)}</div>
      <div id="live-area">${liveHtml(state.live)}</div>
    </div>
    <div class="composer">
      ${targetsRow}
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
