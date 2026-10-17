import { api, type Status } from "./api.ts";
import { initialState, reduce, selectView, type State, type UiEvent } from "./state.ts";
import { escapeHtml, layoutHtml, liveHtml, messagesHtml, permissionCardsHtml, setupPage, sidebarHtml } from "./render.ts";
import { draftAfterSend, groupSendable, targetsOf, toggleTarget } from "./composer.ts";
import { connectEvents } from "./sse.ts";
import type { ServerEvent } from "../src/server/sse.ts";

const app = document.getElementById("app")!;
let state: State = initialState;
let status: Status | undefined;
let sending = false;

function dispatch(event: UiEvent, mode: "all" | "dynamic" = "dynamic"): void {
  const next = reduce(state, event);
  // 跨房间事件 / 去重命中：reducer 返回同一 state 引用 → 零重建（spec §8.2）
  if (next === state) return;
  state = next;
  if (mode === "all") renderAll();
  else renderDynamic(event);
}

function renderAll(): void {
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
    // pin 事件同时改当前房间气泡高亮与侧栏红点，两处都要局部更新。
    if (event.type === "pin") {
      renderMessages();
      renderSidebar();
      return;
    }
    // UI 事件（employees/projects/pins 等）只影响侧栏；需要整页的调用点走 "all" 档。
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
      // run 起止改忙碌点（侧栏）；tool 起止改 live 的工具行。
      if (event.event.kind === "run") renderSidebar();
      else renderLive();
      return;
    case "room.message":
      renderMessages();
      renderLive(); // 员工正式消息到达 → 清掉对应 live 气泡
      return;
    case "room.pins":
      renderSidebar();
      return;
    default:
      return;
  }
}

/** 侧栏（忙碌点 / 红点 / 高亮）局部更新。 */
function renderSidebar(): void {
  const sidebar = document.getElementById("sidebar");
  if (sidebar === null) return;
  sidebar.outerHTML = sidebarHtml(state);
  bindRoomButtons(); // outerHTML 重建了侧栏，需重新挂载房间点击
}

/** 消息列表局部更新；nearBottom 必须在重建 DOM 之前测量。 */
function renderMessages(): void {
  const messagesPart = document.getElementById("messages-part");
  if (messagesPart === null) return;
  const stick = nearBottom();
  messagesPart.innerHTML = messagesHtml(state.messages, state.bossName, state.pinned);
  if (stick) scrollToBottom();
}

/** 流式气泡局部更新（增量文本 / 工具行 / 失败气泡）。 */
function renderLive(): void {
  const liveArea = document.getElementById("live-area");
  if (liveArea === null) return;
  const stick = nearBottom();
  liveArea.innerHTML = liveHtml(state.live);
  if (stick) scrollToBottom();
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

function bindEvents(): void {
  bindRoomButtons();
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
  document.getElementById("btn-new-session")?.addEventListener("click", () => guard(newSession()));
  document.getElementById("btn-history")?.addEventListener("click", () => guard(openHistory()));
  document.getElementById("btn-interrupt")?.addEventListener("click", () => guard(interruptCurrent()));
  // 气泡工具栏用事件委托挂在消息容器上：renderMessages 整体重建 innerHTML 时监听器不丢。
  document.getElementById("msg-list")?.addEventListener("click", (event) => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>("button[data-action]");
    if (button !== null && button !== undefined) void messageAction(button);
  });
  bindPermCards();
}

/** 气泡工具栏动作：复制 Markdown 原文 / 切换 pin（先乐观更新，失败回滚）。 */
async function messageAction(button: HTMLButtonElement): Promise<void> {
  const msgEl = button.closest<HTMLElement>(".msg");
  const roomKey = state.roomKey;
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
}

async function refreshAll(): Promise<void> {
  const [employees, projects, pins, permissions] = await Promise.all([
    api.employees(),
    api.projects(),
    api.pins(),
    api.permissionRequests(),
  ]);
  dispatch({ type: "employees", list: employees });
  dispatch({ type: "projects", list: projects });
  dispatch({ type: "pins", pins });
  dispatch({ type: "permissions", list: permissions.requests });
  if (state.roomKey !== undefined) {
    const roomKey = state.roomKey;
    const { messages, pinned } = await api.messages(roomKey);
    dispatch({ type: "room", roomKey, messages, pinned }, "all");
  }
}

async function enterRoom(roomKey: string): Promise<void> {
  const { messages, pinned } = await api.messages(roomKey);
  dispatch({ type: "room", roomKey, messages, pinned }, "all");
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
  const button = document.getElementById("composer-send") as HTMLButtonElement | null;
  sending = true;
  if (button !== null) button.disabled = true;
  try {
    await api.send(roomKey, text, crypto.randomUUID());
    // 发送期间用户又改了输入（或点了别的成员）则不覆盖；未改动才重置为“保留勾选”的草稿。
    if (input !== null && input.value.trim() === text) {
      if (isGroup) {
        input.value = draftAfterSend(targets); // 保留勾选对象的 @ 前缀：接着发下一条无需重新勾选
        input.focus();
      } else {
        input.value = "";
      }
    }
    // R9 兜底：服务端 pump 订阅晚于 submit，新房间的首条 boss 消息不会经 SSE 推来。
    // 重拉当前房间，仅把**尚未见过**的消息喂入 reducer（复合键过滤：只为新消息触发一次重渲）。
    try {
      const { messages } = await api.messages(roomKey);
      const known = new Set(state.messages.map((m) => `${m.convId}:${m.entryId}`));
      for (const message of messages) {
        if (!known.has(`${message.convId}:${message.entryId}`)) {
          dispatch({ type: "sse", event: { type: "room.message", roomKey, message } });
        }
      }
    } catch {
      // 重拉失败不影响发送成功的结论：静默忽略，等 SSE（Task 14）或下次进房间补齐。
    }
  } catch (error) {
    reportError(error);
  } finally {
    sending = false;
    syncComposerUi();
  }
}

async function newSession(): Promise<void> {
  if (state.roomKey === undefined) return;
  const roomKey = state.roomKey;
  const isGroup = roomKey.startsWith("group:");
  let memberId: string | undefined;
  if (isGroup) {
    const select = document.getElementById("member-select") as HTMLSelectElement | null;
    memberId = select?.value;
    if (memberId === undefined || memberId === "") return;
  }
  const label = isGroup ? `成员 ${memberId} 的` : "";
  if (!window.confirm(`确定新开${label}会话？当前会话将结束（可在历史中回看）。`)) return;
  await api.newSession(roomKey, memberId);
  await enterRoom(roomKey);
}

async function interruptCurrent(): Promise<void> {
  if (state.roomKey === undefined) return;
  await api.interrupt(state.roomKey);
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
  bindPermCards(); // 全局授权卡片在只读视图里也可见可点
}

async function main(): Promise<void> {
  try {
    status = await api.status();
    dispatch({ type: "status", configured: status.configured, bossName: status.bossName }, "all");
    if (!status.configured) return;
    const [employees, projects, pins, permissions] = await Promise.all([
      api.employees(),
      api.projects(),
      api.pins(),
      api.permissionRequests(),
    ]);
    dispatch({ type: "employees", list: employees }, "all");
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
