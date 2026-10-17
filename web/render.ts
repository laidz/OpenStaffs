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
      const unread = state.unread[roomKey] ?? 0;
      const busy = state.busy[employee.id] === true ? '<span class="dot"></span>' : "";
      const active = state.roomKey === roomKey ? " active" : "";
      return `<button class="item${active}" data-room="${escapeHtml(roomKey)}"><span>${escapeHtml(employee.alias ?? employee.id)}${busy}</span>${unread > 0 ? `<span class="badge">${unread}</span>` : ""}</button>`;
    })
    .join("");
  const projectItems = state.projects
    .map((project) => {
      const roomKey = `group:${project.id}`;
      const unread = state.unread[roomKey] ?? 0;
      const busy = project.members.some((m) => state.busy[m.id] === true) ? '<span class="dot"></span>' : "";
      const active = state.roomKey === roomKey ? " active" : "";
      return `<button class="item${active}" data-room="${escapeHtml(roomKey)}"><span>${escapeHtml(project.alias)}${busy}</span>${unread > 0 ? `<span class="badge">${unread}</span>` : ""}</button>`;
    })
    .join("");
  return `<aside class="sidebar" id="sidebar">
    <h3>员工</h3>${employeeItems || `<p class="hint">还没有员工：在 agents/ 下创建目录并写 AGENTS.md（见 README.md）。</p>`}
    <h3>项目</h3>${projectItems || `<p class="hint">还没有项目：在 projects/ 下创建目录并写 members.md（见 README.md）。</p>`}
  </aside>`;
}

export function messageHtml(message: RoomMessage): string {
  const speaker = message.speaker;
  const boss = speaker.kind === "boss";
  const name = speaker.kind === "boss" ? "老板" : (speaker.alias ?? speaker.id);
  // 老板消息原样展示（转义 + 样式换行）；员工消息按 Markdown 渲染（UI 层，见 markdown.ts）
  const body = boss ? escapeHtml(message.text) : markdownHtml(message.text);
  const bodyClass = boss ? "msg-text" : "msg-text md";
  return `<div class="msg ${boss ? "boss" : "employee"}"><div class="msg-name">${escapeHtml(name)}</div><div class="${bodyClass}">${body}</div></div>`;
}

export function messagesHtml(messages: RoomMessage[]): string {
  return messages.length === 0 ? `<div class="empty">还没有消息，发一条试试。</div>` : messages.map(messageHtml).join("");
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
  return `<section class="chat">
    <header class="chat-head">
      <span class="title">${escapeHtml(title)}</span>
      ${memberSelect}
      <button id="btn-new-session">新开会话</button>
      <button id="btn-history">历史</button>
      <button id="btn-interrupt" title="中止当前房间里所有在跑的成员">中断</button>
    </header>
    <div class="msg-list" id="msg-list">
      <div id="messages-part">${messagesHtml(state.messages)}</div>
      <div id="live-area">${liveHtml(state.live)}</div>
    </div>
    <div class="composer">
      <textarea id="composer-input" placeholder="输入消息，Enter 发送（@成员 定向触发；不 @ 则广播）"></textarea>
      <button id="composer-send">发送</button>
    </div>
  </section>`;
}

export function layoutHtml(state: State): string {
  return `<div class="layout">${sidebarHtml(state)}${chatHtml(state)}</div>`;
}
