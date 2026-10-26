import { api, type ConfigScope, type ConfigView, type SessionContextView, type Status } from "./api.ts";
import { initialState, reduce, selectView, type State, type UiEvent } from "./state.ts";
import { configPanelHtml, contextItemsHtml, contextMetaHtml, escapeHtml, freshSessionHint, localDateTime, layoutHtml, liveHtml, messageListHtml, messagesHtml, permissionCardsHtml, sessionInfoHtml, sessionPanelHtml, setupPage, sidebarHtml } from "./render.ts";
import { draftAfterSend, groupSendable, targetsOf, toggleTarget } from "./composer.ts";
import { localDraftStore } from "./drafts.ts";
import { connectEvents } from "./sse.ts";
import type { ServerEvent } from "../src/server/sse.ts";

const app = document.getElementById("app")!;
let state: State = initialState;
let status: Status | undefined;
let sending = false;
/** 输入框草稿的本地缓存（按房间键）：切会话 / 进详情 / 全量重画后自动填回。 */
const drafts = localDraftStore();
/** 会话详情（只读）：聊天顶部信息条的「详情」进入，内容就是那一条会话；undefined = 不在面板。 */
type SessionPanelState = { memberId: string; convId: string; context?: SessionContextView };
let sessionPanel: SessionPanelState | undefined;
let sessionPanelSeq = 0;
/** 定义文件面板：左侧栏人员 / 部门 / 项目的 {} 进入。 */
let configPanel: (ConfigView & { label: string }) | undefined;

function dispatch(event: UiEvent, mode: "all" | "dynamic" = "dynamic"): void {
  const next = reduce(state, event);
  // 跨房间事件 / 去重命中：reducer 返回同一 state 引用 → 零重建（spec §8.2）
  if (next === state) return;
  state = next;
  if (mode === "all") renderAll();
  else renderDynamic(event);
}

function renderAll(): void {
  sessionPanel = undefined; // 全量重画 = 离开面板；避免面板状态与 DOM 两份真相
  configPanel = undefined;
  if (selectView(state) === "setup") {
    app.innerHTML = setupPage(status?.root ?? "", status?.port ?? 4319);
    return;
  }
  app.innerHTML = layoutHtml(state);
  bindEvents();
  restoreDraft(); // 全量重画会重建（空的）输入框：把该房间的本地草稿填回去
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
    // 会话标题（本地改名成功）：信息条与私聊顶部跟着变。
    if (event.type === "title") {
      renderSessionInfo();
      renderChatHead();
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
        renderLive(); // run 结束会清掉残影（中断 / 正式消息先到）——DOM 也得跟着消失
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
    case "session.title":
      // 标题变了（新会话的时间标题 / 命名结果 / 另一标签页手改）：重画受影响的那块。
      renderSessionInfo(); // 信息条（内含标题）
      renderChatHead(); // 私聊顶部的当前会话标题
      if (sessionPanel !== undefined && sessionPanel.convId === event.event.convId) void openSessionPanel(sessionPanel.memberId, sessionPanel.convId);
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
  bindSidebar(); // outerHTML 重建了侧栏，需重新挂载房间点击 / {} 入口 / 部门折叠
}

/** 消息列表局部更新；nearBottom 必须在重建 DOM 之前测量。 */
function renderMessages(): void {
  const messagesPart = document.getElementById("messages-part");
  if (messagesPart === null) return;
  const stick = nearBottom();
  messagesPart.innerHTML = messageListHtml(state);
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
  liveArea.innerHTML = liveHtml(state);
  if (stick) scrollToBottom();
}

/** 会话信息条局部更新（模型 / 思考强度 / 上下文用量 / 详情入口）。 */
function renderSessionInfo(): void {
  const holder = document.getElementById("session-info");
  if (holder === null) return;
  holder.outerHTML = sessionInfoHtml(state);
  bindSessionDetailButtons(); // outerHTML 重建了信息条，重新挂详情入口
  bindTitles(); // 标题按钮也是重建的
}

/** 聊天头部：私聊的「当前会话标题」跟着会话信息变（群聊不显，头部只有房间名）。 */
function renderChatHead(): void {
  const head = document.querySelector<HTMLElement>(".chat-head");
  if (head === null) return;
  const current = document.querySelector<HTMLElement>("[data-rename-conv].chat-title");
  const session = state.roomKey?.startsWith("dm:") === true ? state.sessions[0] : undefined;
  if (session === undefined) {
    current?.remove();
    return;
  }
  const title = session.title ?? "未命名";
  if (current === null) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "session-title chat-title";
    button.dataset.renameConv = session.convId;
    button.title = "点击改名";
    button.textContent = title;
    head.querySelector(".title")?.after(button);
    bindTitles();
    return;
  }
  current.textContent = title;
  current.dataset.renameConv = session.convId;
}

/** 重拉当前房间的会话信息；辅助展示，失败静默等下一次事件。 */async function refreshSessionInfo(roomKey: string): Promise<void> {
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

/** 侧栏人员 / 部门 / 项目的 {} 入口：展示该层定义文件原文（只读）。 */
function bindConfigButtons(): void {
  for (const element of app.querySelectorAll<HTMLElement>("[data-config-scope]")) {
    element.addEventListener("click", (event) => {
      event.stopPropagation();
      guard(openConfigPanel(element.dataset.configScope as ConfigScope, element.dataset.configId ?? ""));
    });
  }
}

/** 会话信息条上的「详情」：进入该会话的只读详情（只这一条，不切 Tab）。 */
function bindSessionDetailButtons(): void {
  for (const element of app.querySelectorAll<HTMLElement>("[data-session-detail]")) {
    element.addEventListener("click", () => guard(openSessionPanel(element.dataset.member ?? "", element.dataset.sessionDetail!)));
  }
}

/** 侧栏整体挂载（全量渲染与面板渲染共用）。 */
function bindSidebar(): void {
  bindRoomButtons();
  bindConfigButtons();
  bindDeptToggles();
}

/** 部门折叠（renderSidebar 重建侧栏后必须重挂）。 */
function bindDeptToggles(): void {
  for (const button of app.querySelectorAll<HTMLElement>("[data-toggle-dept]")) {
    button.addEventListener("click", () => dispatch({ type: "toggle-dept", path: button.dataset.toggleDept! }));
  }
}

/**
 * 会话标题的**原地改名**：点标题 → 就地换成输入框（预填当前值、全选）；
 * Enter / 失焦保存，Esc 取消；失败保留输入内容并就地提示（不丢字）。
 */
function bindTitles(): void {
  for (const element of app.querySelectorAll<HTMLButtonElement>("button[data-rename-conv]")) {
    if (element.dataset.titleBound === "1") continue; // 已挂过（局部重画复用同一按钮）
    element.dataset.titleBound = "1";
    element.addEventListener("click", (event) => {
      event.stopPropagation(); // 历史列表里标题与「查看」同处一行：改名不得触发查看
      startRename(element);
    });
  }
}

/** 把标题按钮就地换成输入框，并在保存时走改名接口。 */
function startRename(button: HTMLButtonElement): void {
  const convId = button.dataset.renameConv;
  const roomKey = state.roomKey;
  if (convId === undefined || roomKey === undefined) return;
  const previous = button.textContent ?? "";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "session-title-input";
  input.value = previous === "未命名" ? "" : previous;
  input.maxLength = 40;
  button.replaceWith(input);
  input.focus();
  input.select();

  let settled = false;
  let saving = false;
  const restore = (): void => {
    input.replaceWith(button);
  };
  const save = async (): Promise<void> => {
    if (settled || saving) return;
    const title = input.value.trim();
    if (title === "" || title === previous) {
      settled = true;
      restore();
      return;
    }
    saving = true;
    try {
      const saved = await api.renameSession(roomKey, convId, title);
      settled = true;
      // 先换回按钮（把输入框收走），再通知 state：局部重画时 DOM 已是最终形态。
      button.textContent = saved.title;
      restore();
      // 服务端已广播 session.title；这里也本地更新（不依赖事件到达时机）。
      dispatch({ type: "title", roomKey, convId: saved.convId, title: saved.title });
    } catch (error) {
      saving = false; // 允许重试；输入框保留用户输入
      input.classList.add("session-title-input-error");
      window.alert(error instanceof Error ? error.message : String(error));
      input.focus();
    }
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      void save();
    } else if (event.key === "Escape") {
      event.preventDefault();
      settled = true;
      restore();
    }
  });
  input.addEventListener("blur", () => void save());
}

function bindEvents(): void {
  bindSidebar();
  bindSessionDetailButtons();
  bindTitles();
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
  input?.addEventListener("input", () => {
    saveComposerDraft();
    syncComposerUi();
  });
  for (const box of app.querySelectorAll<HTMLInputElement>("#composer-targets input[data-target]")) {
    box.addEventListener("change", () => {
      const area = composerInput();
      if (area === null) return;
      area.value = toggleTarget(area.value, box.dataset.target!, box.checked);
      saveComposerDraft(); // 勾选会改正文（写 @ 前缀）→ 草稿跟着存
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
  followPanelContent(event);
}

/** 面板里新内容的刷新节流：流式期间事件密集，合并成一次重画。 */
let panelRefreshTimer: number | undefined;

/**
 * 会话详情面板的实时跟随：这条会话有新内容 → 自动拉一次上下文，**直接 prepend 进列表**（新的在上）。
 * 没有「刷新 / 有新内容」按钮：面板是只读的，不需要人手动点。
 */
function followPanelContent(event: ServerEvent): void {
  const panel = sessionPanel;
  if (panel === undefined) return;
  const touched =
    event.type === "room.delta" ||
    event.type === "room.failed" ||
    event.type === "room.activity" ||
    (event.type === "room.message" && event.message.speaker.kind === "employee" && event.message.speaker.id === panel.memberId);
  if (!touched) return;
  // 增量 / 工具事件按会话过滤；正式消息按成员过滤（库行视图 convId 恒为 store）
  if (event.type !== "room.message" && event.convId !== panel.convId) return;
  if (panelRefreshTimer !== undefined) window.clearTimeout(panelRefreshTimer);
  panelRefreshTimer = window.setTimeout(() => {
    panelRefreshTimer = undefined;
    void prependPanelItems();
  }, 350);
}

/**
 * 拉一次最新上下文并**原地**更新条目区（不重建整个面板）。
 * - 条目区是「新的在上」，所以新内容天然 prepend 到顶部；
 * - 已展开的折叠块（data-key）保持展开；用户不在顶部时调整 scrollTop，阅读位置不跳。
 */
async function prependPanelItems(): Promise<void> {
  const panel = sessionPanel;
  if (panel === undefined) return;
  const holder = document.getElementById("ctx-items");
  if (holder === null) return; // 已经不在面板
  const seq = ++sessionPanelSeq;
  const context = await api.sessionContext(panel.memberId, panel.convId).catch(() => undefined);
  if (context === undefined || seq !== sessionPanelSeq || sessionPanel !== panel) return; // 过期结果
  const live = document.getElementById("ctx-items");
  if (live === null) return;
  const scroller = live.closest(".agent-context");
  const stuckTop = scroller === null || scroller.scrollTop < 24;
  const openKeys = new Set(
    [...live.querySelectorAll<HTMLDetailsElement>("details[data-key][open]")].map((details) => details.dataset.key ?? ""),
  );
  const before = live.scrollHeight;
  panel.context = context;
  live.innerHTML = contextItemsHtml([...context.items].reverse());
  for (const details of live.querySelectorAll<HTMLDetailsElement>("details[data-key]")) {
    if (openKeys.has(details.dataset.key ?? "")) details.open = true;
  }
  // 顶部信息行的用量 / 运行中跟着变（只改那一行，不动卡片其他部分）
  const meta = document.getElementById("ctx-meta-line");
  if (meta !== null) meta.innerHTML = contextMetaHtml(context);
  // 不在顶部阅读时：保持原来的阅读位置（新内容加在上面会把下面的内容推下去）
  if (scroller !== null && !stuckTop) scroller.scrollTop += live.scrollHeight - before;
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
    dispatch({ type: "room", roomKey, messages: room.messages, hidden: room.hidden, pinned: room.pinned, queued: room.queued }, "all");
    if (info !== undefined) dispatch({ type: "sessions", roomKey, sessions: info.sessions });
  }
}

async function enterRoom(roomKey: string): Promise<void> {
  sessionPanel = undefined;
  configPanel = undefined;
  const [room, info] = await Promise.all([
    api.messages(roomKey),
    api.sessionInfo(roomKey).catch(() => undefined),
  ]);
  dispatch({ type: "room", roomKey, messages: room.messages, hidden: room.hidden, pinned: room.pinned, queued: room.queued }, "all");
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

/** 当前房间的本地草稿存回浏览器（空内容 = 删除）。没有房间 / 没有输入框时什么都不做。 */
function saveComposerDraft(): void {
  const roomKey = state.roomKey;
  const area = composerInput();
  if (roomKey === undefined || area === null) return;
  drafts.save(roomKey, area.value);
}

/** 把当前房间的本地草稿填回输入框（renderAll 重建 DOM 后调用）；顺带同步群聊勾选与发送按钮态。 */
function restoreDraft(): void {
  const roomKey = state.roomKey;
  const area = composerInput();
  if (roomKey === undefined || area === null) return;
  const draft = drafts.load(roomKey);
  if (draft === "") return;
  area.value = draft;
  syncComposerUi(); // 群聊：正文是勾选态的唯一真相源，勾回来才能继续发
}

/** 发送成功后写入草稿（room 事件可能重建过输入框，故重新取元素）；保留勾选对象的 @ 前缀便于接着发。 */
function applyDraft(draft: string): void {
  const area = composerInput();
  if (area === null) return;
  area.value = draft;
  saveComposerDraft(); // 发完了：缓存跟着清空（群聊只剩 @ 前缀）
  syncComposerUi();
  if (draft !== "") area.focus();
}

async function interruptCurrent(): Promise<void> {
  if (state.roomKey === undefined) return;
  await api.interrupt(state.roomKey);
}

/** 会话详情（只读）：入口 = 聊天顶部信息条的「详情」，内容就是那一条会话。 */
async function openSessionPanel(memberId: string, convId: string): Promise<void> {
  configPanel = undefined;
  sessionPanel = { memberId, convId };
  await renderSessionPanel();
}

async function renderSessionPanel(): Promise<void> {
  const panel = sessionPanel;
  if (panel === undefined) {
    renderAll();
    return;
  }
  const seq = ++sessionPanelSeq;
  const context = await api.sessionContext(panel.memberId, panel.convId).catch(() => undefined);
  if (seq !== sessionPanelSeq || sessionPanel !== panel) return; // 快速连点 / 已离开：丢弃过期结果
  panel.context = context;
  app.innerHTML = sessionPanelHtml(state, context);
  bindSidebar();
  bindPermCards();
  bindTitles(); // 详情头部的标题也能就地改
  document.getElementById("session-panel-back")?.addEventListener("click", () => {
    sessionPanel = undefined;
    renderAll();
  });
}

/** 定义文件面板（只读）：左侧栏人员 / 部门 / 项目的 {} 进入，原样展示 config JSON。 */
async function openConfigPanel(scope: ConfigScope, id: string): Promise<void> {
  sessionPanel = undefined;
  const view = await api.config(scope, id);
  const label =
    scope === "agent" ? id : scope === "department" ? (id === "" ? "根部门" : id) : id;
  configPanel = { ...view, label };
  renderConfigPanel();
}

function renderConfigPanel(): void {
  if (configPanel === undefined) {
    renderAll();
    return;
  }
  app.innerHTML = configPanelHtml(state, configPanel, configPanel.label);
  bindSidebar();
  bindPermCards();
  document.getElementById("config-panel-back")?.addEventListener("click", () => {
    configPanel = undefined;
    renderAll();
  });
}

/** 成员展示名：优先 alias（组织树里的昵称），回落到 id。 */
function memberName(memberId: string): string {
  return state.employees.find((person) => person.id === memberId)?.alias ?? memberId;
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
          `<div class="session"><span><button type="button" class="session-title history-title" data-rename-conv="${escapeHtml(row.id)}" title="点击改名">${escapeHtml(row.title ?? "未命名")}</button> · ${escapeHtml(memberName(row.memberId))} · ${escapeHtml(localDateTime(row.started))}${row.ended === null ? "（进行中）" : ""}</span><button data-conv="${escapeHtml(row.id)}">查看</button></div>`,
      )
      .join("") || `<p class="hint">还没有会话。</p>`}
    <p><button id="btn-history-back">返回聊天</button></p>
  </div></div>${permissionCardsHtml(state)}`;
  document.getElementById("btn-history-back")?.addEventListener("click", () => renderAll());
  bindSidebar(); // 面板内也带一份侧栏（房间 / {} 定义 / 部门折叠）
  bindPermCards(); // 全局授权卡片在只读视图里也可见可点
  bindTitles(); // 历史行的标题可改名（点击保存后重拉列表）
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
  bindSidebar(); // 详情视图同样带一份侧栏
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
