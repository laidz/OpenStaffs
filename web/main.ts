import { api, type EmployeeSession, type Status } from "./api.ts";
import { initialState, pickAgentSession, reduce, selectView, type State, type UiEvent } from "./state.ts";
import { agentPanelHtml, escapeHtml, freshSessionHint, layoutHtml, liveHtml, messagesHtml, permissionCardsHtml, sessionInfoHtml, setupPage, sidebarHtml } from "./render.ts";
import { draftAfterSend, groupSendable, targetsOf, toggleTarget } from "./composer.ts";
import { connectEvents } from "./sse.ts";
import type { ServerEvent } from "../src/server/sse.ts";

const app = document.getElementById("app")!;
let state: State = initialState;
let status: Status | undefined;
let sending = false;
/** 员工「会话上下文」面板（打开时替换聊天区；undefined = 不在面板）。 */
type AgentPanelState = { employee: { id: string; alias?: string }; sessions: EmployeeSession[]; selected?: string };
let agentPanel: AgentPanelState | undefined;
let agentPanelSeq = 0;
let agentPanelRenderSeq = 0;

function dispatch(event: UiEvent, mode: "all" | "dynamic" = "dynamic"): void {
  const next = reduce(state, event);
  // 跨房间事件 / 去重命中：reducer 返回同一 state 引用 → 零重建（spec §8.2）
  if (next === state) return;
  state = next;
  if (mode === "all") renderAll();
  else renderDynamic(event);
}

function renderAll(): void {
  agentPanel = undefined; // 全量重画 = 离开面板；避免面板状态与 DOM 两份真相
  if (selectView(state) === "setup") {
    app.innerHTML = setupPage(status?.root ?? "", status?.port ?? 4319);
    return;
  }
  app.innerHTML = layoutHtml(state);
  bindEvents();
  scrollToBottom();
}

/** SSE 高频更新（spec §8.2）：按事件只更新受影响的容器，绝不重建输入框与消息列表。 */
function renderDynamic(event: UiEvent): void {
  if (event.type !== "sse") {
    // 授权事件只影响右下角卡片堆叠，不碰侧栏。
    if (event.type === "permissions" || event.type === "permission-busy" || event.type === "permission-error" || event.type === "permission-resolved") {
      renderPermCards();
      return;
    }
    // 新开会话标志：只影响按钮态与输入框上方的提示。
    if (event.type === "fresh-session") {
      renderFreshSession();
      return;
    }
    // 会话信息条：模型 / 思考强度 / 上下文用量。
    if (event.type === "sessions") {
      renderSessionInfo();
      return;
    }
    // pin 事件同时改当前房间气泡高亮与侧栏红点，两处都要局部更新。
    if (event.type === "pin") {
      renderMessages();
      renderSidebar();
      return;
    }
    // UI 事件（org/projects/pins 等）只影响侧栏；需要整页的调用点走 "all" 档。
    renderSidebar();
    return;
  }
  switch (event.event.type) {
    case "permission.request":
    case "permission.resolved":
      renderPermCards();
      return;
    case "room.delta":
    case "room.failed":
      renderLive();
      return;
    case "room.activity":
      // run 起止改忙碌点（侧栏）；tool 起止改 live 的工具行。run 结束刷新上下文用量。
      if (event.event.kind === "run") {
        renderSidebar();
        if (event.event.phase === "end") void refreshSessionInfo(event.event.roomKey);
      } else renderLive();
      return;
    case "room.message":
      renderMessages();
      renderLive(); // 员工正式消息到达 → 清掉对应 live 气泡
      void refreshSessionInfo(event.event.roomKey); // 上下文随回复增长
      return;
    case "room.pins":
      renderSidebar();
      return;
    case "room.queued":
      renderMessages(); // 待发消息进入消息区（排队中）
      return;
    case "room.dequeued":
      renderMessages(); // 出队：占位撤下 / 排队标识摘掉
      if (event.event.reason === "delivered") void syncAfterDelivered(event.event.roomKey, event.event.submissionId);
      return;
    default:
      return;
  }
}

/**
 * 出队（投递开始）后的兜底：**诚实结论——当前不可达**。
 * 时序：`dispatch` 先 `reduce` 再 `renderDynamic`；而 `room.dequeued` 的 reducer 分支
 * （web/state.ts）已把该项从 `state.queued` 移除 → 这里 `find` 必为 `undefined` → 提前 return，
 * 其后的 roomMessageId 比对与重拉（`syncRoomMessages`）**从不执行**（该时序问题非本 diff 引入，属既有代码）。
 * 等价保障（不依赖本分支）：① 写路径「谁写谁广播」——发言落库后即以 `room.message` 推达库行
 * （老板侧附**仅 UI 用**的 roomMessageId 副本），真气泡据此出现；② 进房间 / 重连时 `GET /messages` 全量重拉。
 * 代码保留不动：修正时序（让 reducer 保留该项后再判）属既有 `reduce`→`renderDynamic` 顺序的重构，不在本任务范围。
 */
async function syncAfterDelivered(roomKey: string, submissionId: string): Promise<void> {
  if (state.roomKey !== roomKey) return;
  const delivered = state.queued.find((item) => item.submissionId === submissionId);
  if (delivered === undefined) return;
  if (state.messages.some((message) => message.roomMessageId === delivered.roomMessageId)) return;
  await syncRoomMessages(roomKey);
}

/** 重拉房间消息，只把**尚未见过**的喂入 reducer（复用发送后的补齐口径）。 */
async function syncRoomMessages(roomKey: string): Promise<void> {
  try {
    const { messages } = await api.messages(roomKey);
    const known = new Set(state.messages.map((m) => `${m.convId}:${m.entryId}`));
    for (const message of messages) {
      if (!known.has(`${message.convId}:${message.entryId}`)) {
        dispatch({ type: "sse", event: { type: "room.message", roomKey, message } });
      }
    }
  } catch {
    // 重拉失败不影响结论：等 SSE 或下次进房间补齐。
  }
}

/** 侧栏（忙碌点 / 红点 / 高亮）局部更新。 */
function renderSidebar(): void {
  const sidebar = document.getElementById("sidebar");
  if (sidebar === null) return;
  sidebar.outerHTML = sidebarHtml(state);
  bindRoomButtons(); // outerHTML 重建了侧栏，需重新挂载房间点击
  bindAgentSessionButtons(); // 员工行的「会话上下文」入口
  bindDeptToggles(); // 以及部门折叠
}

/** 消息列表局部更新；nearBottom 必须在重建 DOM 之前测量。 */
function renderMessages(): void {
  const messagesPart = document.getElementById("messages-part");
  if (messagesPart === null) return;
  const stick = nearBottom();
  messagesPart.innerHTML = messagesHtml(state.messages, state.bossName, state.pinned, state.queued);
  if (stick) scrollToBottom();
}

/** 「新开会话」已就绪态：按钮高亮 + 输入框上方提示（就地改 DOM，不重建输入框）。 */
function renderFreshSession(): void {
  document.getElementById("btn-new-session")?.classList.toggle("armed", state.freshSession);
  const hint = document.getElementById("fresh-hint");
  const text = freshSessionHint(state);
  if (text === "") {
    hint?.remove();
    return;
  }
  const existing = hint ?? document.createElement("div");
  if (hint === null) document.querySelector(".composer")?.prepend(existing);
  existing.className = "fresh-hint";
  existing.id = "fresh-hint";
  existing.textContent = text;
}

/** 流式气泡局部更新（增量文本 / 工具行 / 失败气泡）。 */
function renderLive(): void {
  const liveArea = document.getElementById("live-area");
  if (liveArea === null) return;
  const stick = nearBottom();
  liveArea.innerHTML = liveHtml(state.live);
  if (stick) scrollToBottom();
}

/** 会话信息条局部更新（模型 / 思考强度 / 上下文用量）。 */
function renderSessionInfo(): void {
  const holder = document.getElementById("session-info");
  if (holder === null) return;
  holder.outerHTML = sessionInfoHtml(state);
}

/** 重拉当前房间的会话信息；辅助展示，失败静默等下一次事件。 */
async function refreshSessionInfo(roomKey: string): Promise<void> {
  try {
    const { sessions } = await api.sessionInfo(roomKey);
    dispatch({ type: "sessions", roomKey, sessions });
  } catch {
    // 信息条失败不打扰用户：下一条消息 / run 结束会再试。
  }
}

/** 用户是否贴近底部（距底 <80px）。 */
function nearBottom(): boolean {
  const list = document.getElementById("msg-list");
  return list === null || list.scrollHeight - list.scrollTop - list.clientHeight < 80;
}

function scrollToBottom(): void {
  const list = document.getElementById("msg-list");
  if (list !== null) list.scrollTop = list.scrollHeight;
}

/** 事件入口的 rejection 收敛：API 失败给用户提示，不留 unhandled rejection。 */
function reportError(error: unknown): void {
  window.alert(error instanceof Error ? error.message : String(error));
}

function guard(promise: Promise<unknown>): void {
  void promise.catch(reportError);
}

function composerInput(): HTMLTextAreaElement | null {
  return document.getElementById("composer-input") as HTMLTextAreaElement | null;
}

/** 当前房间的成员上下文：群聊给出成员 id 列表（非群聊为空）。 */
function roomMembers(): { isGroup: boolean; memberIds: string[] } {
  const roomKey = state.roomKey;
  if (roomKey?.startsWith("group:") === true) {
    const project = state.projects.find((p) => `group:${p.id}` === roomKey);
    return { isGroup: true, memberIds: (project?.members ?? []).map((m) => m.id) };
  }
  return { isGroup: false, memberIds: [] };
}

/** 当前群聊正文里 @ 到的成员（非群聊恒为空）；与后端路由解析完全一致。 */
function composerTargets(): string[] {
  const input = composerInput();
  const { isGroup, memberIds } = roomMembers();
  return input !== null && isGroup ? targetsOf(input.value, memberIds) : [];
}

/**
 * 群聊门禁：正文是定向的唯一真相源——复选框与发送按钮都从正文推导（勾选会写入/移除正文开头的 @ 前缀块）。
 * 无有效 @（未勾选任何成员）或只有 @ 没有正文时禁发：原来的“不 @ 则广播”在 UI 里永远到不了。
 */
function syncComposerUi(): void {
  const { isGroup, memberIds } = roomMembers();
  const input = composerInput();
  const targets = composerTargets();
  if (isGroup) {
    for (const box of app.querySelectorAll<HTMLInputElement>("#composer-targets input[data-target]")) {
      box.checked = targets.includes(box.dataset.target!);
    }
  }
  const canSend = input !== null && (!isGroup || groupSendable(input.value, memberIds));
  const button = document.getElementById("composer-send") as HTMLButtonElement | null;
  if (button !== null) button.disabled = sending || !canSend;
}

function bindRoomButtons(): void {
  for (const element of app.querySelectorAll<HTMLElement>("[data-room]")) {
    element.addEventListener("click", () => guard(enterRoom(element.dataset.room!)));
  }
}

/** 侧栏员工行右侧的「会话上下文」入口（名字按钮仍走 data-room）。 */
function bindAgentSessionButtons(): void {
  for (const element of app.querySelectorAll<HTMLElement>("[data-agent-sessions]")) {
    element.addEventListener("click", (event) => {
      event.stopPropagation();
      guard(openAgentPanel(element.dataset.agentSessions!));
    });
  }
}

/** 部门折叠（renderSidebar 重建侧栏后必须重挂）。 */
function bindDeptToggles(): void {
  for (const button of app.querySelectorAll<HTMLElement>("[data-toggle-dept]")) {
    button.addEventListener("click", () => dispatch({ type: "toggle-dept", path: button.dataset.toggleDept! }));
  }
}

function bindEvents(): void {
  bindRoomButtons();
  bindAgentSessionButtons();
  bindDeptToggles();
  document.getElementById("composer-send")?.addEventListener("click", () => void sendCurrent());
  const input = document.getElementById("composer-input");
  input?.addEventListener("keydown", (event) => {
    const key = (event as KeyboardEvent).key;
    // isComposing：中文输入法用 Enter 上屏候选词时不得发送
    if (key === "Enter" && !(event as KeyboardEvent).shiftKey && !(event as KeyboardEvent).isComposing) {
      event.preventDefault();
      void sendCurrent();
    }
  });
  input?.addEventListener("input", () => syncComposerUi());
  for (const box of app.querySelectorAll<HTMLInputElement>("#composer-targets input[data-target]")) {
    box.addEventListener("change", () => {
      const area = composerInput();
      if (area === null) return;
      area.value = toggleTarget(area.value, box.dataset.target!, box.checked);
      syncComposerUi();
      area.focus();
    });
  }
  document.getElementById("btn-new-session")?.addEventListener("click", () => dispatch({ type: "fresh-session", on: !state.freshSession }));
  document.getElementById("btn-history")?.addEventListener("click", () => guard(openHistory()));
  document.getElementById("btn-interrupt")?.addEventListener("click", () => guard(interruptCurrent()));
  // 气泡工具栏用事件委托挂在消息容器上：renderMessages 整体重建 innerHTML 时监听器不丢。
  document.getElementById("msg-list")?.addEventListener("click", (event) => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>("button[data-action]");
    if (button !== null && button !== undefined) void messageAction(button);
  });
  bindPermCards();
}

/** 气泡工具栏 / 排队撤回：先本地即时反馈（乐观更新），失败回滚并提示。 */
async function messageAction(button: HTMLButtonElement): Promise<void> {
  const roomKey = state.roomKey;
  if (button.dataset.action === "unqueue") {
    const roomMessageId = button.dataset.roomMessage;
    if (roomKey === undefined || roomMessageId === undefined) return;
    button.disabled = true;
    try {
      await api.cancelQueued(roomKey, roomMessageId); // 成功后服务端广播 room.dequeued，占位随之撤下
    } catch (error) {
      button.disabled = false;
      reportError(error);
    }
    return;
  }
  const msgEl = button.closest<HTMLElement>(".msg");
  const convId = msgEl?.dataset.convId;
  const entryId = msgEl?.dataset.entryId;
  if (msgEl === null || roomKey === undefined || convId === undefined || entryId === undefined) return;
  const key = `${convId}:${entryId}`;
  if (button.dataset.action === "copy") {
    const message = state.messages.find((m) => `${m.convId}:${m.entryId}` === key);
    if (message === undefined) return;
    try {
      await navigator.clipboard.writeText(message.text); // Markdown 原文，不是渲染结果
    } catch (error) {
      reportError(error);
    }
    return;
  }
  const pinned = !state.pinned.includes(key);
  dispatch({ type: "pin", roomKey, key, pinned });
  try {
    await api.pin(roomKey, convId, entryId, pinned);
  } catch (error) {
    dispatch({ type: "pin", roomKey, key, pinned: !pinned }); // 回滚
    reportError(error);
  }
}

/** 授权卡片局部更新；无容器（setup 页等）时跳过。 */
function renderPermCards(): void {
  const holder = document.getElementById("perm-cards");
  if (holder === null) return;
  holder.outerHTML = permissionCardsHtml(state);
  bindPermCards(); // outerHTML 重建了卡片，需重新挂载按钮
}

function bindPermCards(): void {
  for (const button of app.querySelectorAll<HTMLButtonElement>("[data-perm-accept]")) {
    button.addEventListener("click", () => guard(resolvePermission(button.dataset.permAccept!, "accept")));
  }
  for (const button of app.querySelectorAll<HTMLButtonElement>("[data-perm-reject]")) {
    button.addEventListener("click", () => guard(resolvePermission(button.dataset.permReject!, "reject")));
  }
}

/** 处理一条授权请求：成功（含投递告警）本地移除；404 视为已处理同步移除；其余错误回到可重试态并显示红字。 */
async function resolvePermission(id: string, decision: "accept" | "reject"): Promise<void> {
  dispatch({ type: "permission-busy", id, busy: true });
  try {
    const result = await api.resolvePermission(id, decision);
    dispatch({ type: "permission-resolved", id });
    if (result.warning !== undefined) window.alert(result.warning);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("不存在或已处理")) {
      dispatch({ type: "permission-resolved", id }); // 其他标签页已处理：本地同步移除
      return;
    }
    dispatch({ type: "permission-busy", id, busy: false });
    dispatch({ type: "permission-error", id, error: message });
  }
}

async function refreshPins(): Promise<void> {
  const pins = await api.pins();
  dispatch({ type: "pins", pins });
}

function onServerEvent(event: ServerEvent): void {
  dispatch({ type: "sse", event });
  syncAgentPanelActivity(event);
}

/** 面板打开时：用 SSE 的 run 起止更新对应 Tab 的运行点（不重拉正文，避免阅读位置跳动）。 */
function syncAgentPanelActivity(event: ServerEvent): void {
  if (agentPanel === undefined || event.type !== "room.activity" || event.kind !== "run") return;
  const session = agentPanel.sessions.find((item) => item.convId === event.convId);
  if (session === undefined) return;
  session.running = event.phase === "start";
  const tab = document.querySelector<HTMLElement>(`[data-agent-conv="${CSS.escape(event.convId)}"]`);
  if (tab === null) return;
  tab.classList.toggle("running", session.running);
  const dot = tab.querySelector(".dot");
  if (session.running && dot === null) {
    const marker = document.createElement("span");
    marker.className = "dot";
    marker.title = "运行中";
    tab.prepend(marker);
  } else if (!session.running && dot !== null) {
    dot.remove();
  }
}

async function refreshAll(): Promise<void> {
  const [org, projects, pins, permissions] = await Promise.all([
    api.org(),
    api.projects(),
    api.pins(),
    api.permissionRequests(),
  ]);
  dispatch({ type: "org", root: org.root });
  dispatch({ type: "projects", list: projects });
  dispatch({ type: "pins", pins });
  dispatch({ type: "permissions", list: permissions.requests });
  if (state.roomKey !== undefined) {
    const roomKey = state.roomKey;
    const [room, info] = await Promise.all([
      api.messages(roomKey),
      api.sessionInfo(roomKey).catch(() => undefined), // 信息条是辅助展示：失败不拖垮整页刷新
    ]);
    dispatch({ type: "room", roomKey, messages: room.messages, pinned: room.pinned, queued: room.queued }, "all");
    if (info !== undefined) dispatch({ type: "sessions", roomKey, sessions: info.sessions });
  }
}

async function enterRoom(roomKey: string): Promise<void> {
  agentPanel = undefined;
  const [room, info] = await Promise.all([
    api.messages(roomKey),
    api.sessionInfo(roomKey).catch(() => undefined),
  ]);
  dispatch({ type: "room", roomKey, messages: room.messages, pinned: room.pinned, queued: room.queued }, "all");
  if (info !== undefined) dispatch({ type: "sessions", roomKey, sessions: info.sessions });
}

async function sendCurrent(): Promise<void> {
  if (sending || state.roomKey === undefined) return;
  const roomKey = state.roomKey;
  const input = composerInput();
  const text = input?.value.trim() ?? "";
  if (text === "") return;
  const isGroup = roomKey.startsWith("group:");
  const targets = composerTargets();
  // 兜底门禁：群聊需「有效对象 + 前缀外的正文」（按钮已禁用、Enter 也走这里）；后端同样会拒绝无对象。
  if (isGroup && !groupSendable(input?.value ?? "", roomMembers().memberIds)) return;
  const fresh = state.freshSession; // 「新开会话」：这条消息投递时对目标成员真正建会话（撤回/中断则不建）
  const button = document.getElementById("composer-send") as HTMLButtonElement | null;
  sending = true;
  if (button !== null) button.disabled = true;
  try {
    await api.send(roomKey, text, crypto.randomUUID(), fresh);
    if (fresh) dispatch({ type: "fresh-session", on: false }); // 一次一条：用完即清
    // 发送期间用户又改了输入（或点了别的成员）则不覆盖：未改动才重置草稿（重建 DOM 后也要补回）。
    const untouched = input !== null && input.value.trim() === text;
    if (fresh) {
      // 新开会话换了整条会话：房间视图整套消息都变了，走全量重取（增量合并会留着旧会话的消息）。
      await enterRoom(roomKey);
    } else {
      // R9 兜底：服务端 pump 订阅晚于 submit，新房间的首条 boss 消息不会经 SSE 推来。
      // 重拉当前房间，仅把**尚未见过**的消息喂入 reducer（复合键过滤：只为新消息触发一次重渲）。
      await syncRoomMessages(roomKey);
    }
    if (untouched) applyDraft(isGroup ? draftAfterSend(targets) : "");
    void refreshSessionInfo(roomKey); // 上下文随这轮投递变化
  } catch (error) {
    reportError(error);
  } finally {
    sending = false;
    syncComposerUi();
  }
}

/** 发送成功后写入草稿（room 事件可能重建过输入框，故重新取元素）；保留勾选对象的 @ 前缀便于接着发。 */
function applyDraft(draft: string): void {
  const area = composerInput();
  if (area === null) return;
  area.value = draft;
  syncComposerUi();
  if (draft !== "") area.focus();
}

async function interruptCurrent(): Promise<void> {
  if (state.roomKey === undefined) return;
  await api.interrupt(state.roomKey);
}

/** 打开员工的「会话上下文」：默认选运行中的，否则私聊，再否则第一条。 */
async function openAgentPanel(employeeId: string, keep?: string): Promise<void> {
  const seq = ++agentPanelSeq;
  const { employee, sessions } = await api.employeeSessions(employeeId);
  if (seq !== agentPanelSeq) return; // 快速连点：只让最后一次请求落 DOM
  const selected = pickAgentSession(sessions, keep ?? agentPanel?.selected);
  agentPanel = { employee, sessions, ...(selected === undefined ? {} : { selected }) };
  await renderAgentPanel();
}

async function renderAgentPanel(): Promise<void> {
  if (agentPanel === undefined) {
    renderAll();
    return;
  }
  const seq = ++agentPanelRenderSeq;
  const { employee, sessions, selected } = agentPanel;
  const context =
    selected === undefined ? undefined : await api.sessionContext(employee.id, selected).catch(() => undefined);
  if (seq !== agentPanelRenderSeq || agentPanel === undefined) return; // 切 Tab / 关闭面板：丢弃过期结果
  app.innerHTML = agentPanelHtml(state, employee, sessions, selected, context);
  bindRoomButtons();
  bindAgentSessionButtons();
  bindDeptToggles();
  bindPermCards();
  document.getElementById("agent-panel-back")?.addEventListener("click", () => {
    agentPanel = undefined;
    renderAll();
  });
  document.getElementById("agent-panel-refresh")?.addEventListener("click", () => guard(openAgentPanel(employee.id, agentPanel?.selected)));
  for (const element of app.querySelectorAll<HTMLElement>("[data-agent-conv]")) {
    element.addEventListener("click", () => {
      if (agentPanel === undefined) return;
      agentPanel.selected = element.dataset.agentConv!;
      guard(renderAgentPanel());
    });
  }
}

async function openHistory(): Promise<void> {
  if (state.roomKey === undefined) return;
  const roomKey = state.roomKey;
  const { chains } = await api.sessions(roomKey);
  const rows = chains
    .flatMap((chain) => chain.rows.map((row) => ({ ...row, memberId: chain.memberId })))
    .sort((a, b) => (a.started < b.started ? 1 : -1));
  app.innerHTML = `<div class="layout">${sidebarHtml(state)}<div class="panel">
    <h3>历史会话（只读）</h3>
    ${rows
      .map(
        (row) =>
          `<div class="session"><span>${escapeHtml(row.memberId)} · ${escapeHtml(row.started.slice(0, 19).replace("T", " "))}${row.ended === null ? "（进行中）" : ""}</span><button data-conv="${escapeHtml(row.id)}">查看</button></div>`,
      )
      .join("") || `<p class="hint">还没有会话。</p>`}
    <p><button id="btn-history-back">返回聊天</button></p>
  </div></div>${permissionCardsHtml(state)}`;
  document.getElementById("btn-history-back")?.addEventListener("click", () => renderAll());
  bindRoomButtons(); // 面板内也带一份侧栏
  bindAgentSessionButtons(); // 侧栏员工行的会话入口
  bindDeptToggles(); // 面板内侧栏的部门折叠同样可用
  bindPermCards(); // 全局授权卡片在只读视图里也可见可点
  for (const element of app.querySelectorAll<HTMLElement>("[data-conv]")) {
    const convId = element.dataset.conv!;
    element.addEventListener("click", () => guard(loadHistoryView(roomKey, convId)));
  }
}

async function loadHistoryView(roomKey: string, convId: string): Promise<void> {
  const { messages } = await api.history(roomKey, convId);
  app.innerHTML = `<div class="layout">${sidebarHtml(state)}<div class="panel">
    <p><button id="btn-history-back">返回列表</button></p>
    ${messagesHtml(messages, state.bossName)}
  </div></div>${permissionCardsHtml(state)}`;
  document.getElementById("btn-history-back")?.addEventListener("click", () => guard(openHistory()));
  bindRoomButtons(); // 详情视图同样带一份侧栏
  bindAgentSessionButtons(); // 侧栏员工行的会话入口
  bindDeptToggles(); // 详情视图侧栏的部门折叠同样可用
  bindPermCards(); // 全局授权卡片在只读视图里也可见可点
}

async function main(): Promise<void> {
  try {
    status = await api.status();
    dispatch({ type: "status", configured: status.configured, bossName: status.bossName }, "all");
    if (!status.configured) return;
    const [org, projects, pins, permissions] = await Promise.all([
      api.org(),
      api.projects(),
      api.pins(),
      api.permissionRequests(),
    ]);
    dispatch({ type: "org", root: org.root }, "all");
    dispatch({ type: "projects", list: projects }, "all");
    dispatch({ type: "pins", pins }, "all");
    dispatch({ type: "permissions", list: permissions.requests }, "all");

    connectEvents({
      onEvent: onServerEvent,
      onReconnect: () => void refreshAll().catch(() => {}),
    });
    // 切回页面时重拉红点（别的标签页可能改过 pin）
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void refreshPins().catch(() => {});
    });
  } catch (error) {
    app.innerHTML = `<main class="setup"><h1>OpenStaffs</h1><p>服务不可用：${escapeHtml(error instanceof Error ? error.message : String(error))}</p></main>`;
  }
}

void main();
