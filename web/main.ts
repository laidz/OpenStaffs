import { api, type ConfigScope, type ConfigView, type SessionContextView, type Status } from "./api.ts";
import { initialState, reduce, selectView, type State, type UiEvent } from "./state.ts";
import { configPanelHtml, contextItemsHtml, contextMetaHtml, escapeHtml, historyHtml, layoutHtml, liveHtml, messageListHtml, messagesHtml, permissionCardsHtml, sessionInfoHtml, sessionPanelHtml, setupPage, sidebarHtml } from "./render.ts";
import { draftAfterSend, groupSendable, targetsOf, toggleTarget } from "./composer.ts";
import { localDraftStore } from "./drafts.ts";
import { connectEvents } from "./sse.ts";
import { parseRoute, routeUrl, type Route } from "./route.ts";
import type { ServerEvent } from "../src/server/sse.ts";

const app = document.getElementById("app")!;
let state: State = initialState;
let status: Status | undefined;
let sending = false;
/** 输入框草稿的本地缓存（按主题键）：切会议 / 进详情 / 全量重画后自动填回。 */
const drafts = localDraftStore();
/** 会话详情（只读）：聊天顶部信息条的「详情」进入，内容就是那一条会话；undefined = 不在面板。 */
type SessionPanelState = { memberId: string; convId: string; context?: SessionContextView };
let sessionPanel: SessionPanelState | undefined;
let sessionPanelSeq = 0;
/** 定义文件面板：左侧栏人员 / 部门 / 项目的 {} 进入。 */
let configPanel: (ConfigView & { label: string }) | undefined;

/** 切 URL（默认 pushState；新建会议落定 / 迁移等场景用 replace）。 */
function navigate(route: Route, mode: "push" | "replace" = "push"): void {
  const url = routeUrl(route);
  if (url === "" || url === window.location.pathname + window.location.search) return;
  if (mode === "push") window.history.pushState(route, "", url);
  else window.history.replaceState(route, "", url);
  if ("subjectKey" in route && route.subjectKey !== undefined) localStorage.setItem("openstaffs.subject", route.subjectKey);
  if ("meetingId" in route) localStorage.setItem("openstaffs.meeting", route.meetingId);
}

function dispatch(event: UiEvent, mode: "all" | "dynamic" = "dynamic"): void {
  const next = reduce(state, event);
  // 跨会议事件 / 去重命中：reducer 返回同一 state 引用 → 零重建
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
  restoreDraft(); // 全量重画会重建（空的）输入框：把该主题的本地草稿填回去
  scrollToBottom();
}

/** SSE 高频更新：按事件只更新受影响的容器，绝不重建输入框与消息列表。 */
function renderDynamic(event: UiEvent): void {
  if (event.type !== "sse") {
    // 授权事件只影响右下角卡片堆叠，不碰侧栏。
    if (event.type === "permissions" || event.type === "permission-busy" || event.type === "permission-error" || event.type === "permission-resolved") {
      renderPermCards();
      return;
    }
    // 「新建会议」标志：按钮态 + 聊天区（清空 / 恢复）。
    if (event.type === "new-meeting") {
      renderNewMeeting();
      renderMessages();
      renderChatHead();
      return;
    }
    if (event.type === "sessions") {
      renderSessionInfo();
      return;
    }
    if (event.type === "title") {
      renderSessionInfo();
      renderChatHead();
      return;
    }
    // pin 事件同时改当前会议气泡高亮与侧栏红点，两处都要局部更新。
    if (event.type === "pin") {
      renderMessages();
      renderSidebar();
      return;
    }
    // UI 事件（org/projects/pins/subject/meeting 等）只影响侧栏；需要整页的调用点走 "all" 档。
    renderSidebar();
    return;
  }
  switch (event.event.type) {
    case "permission.request":
    case "permission.resolved":
      renderPermCards();
      return;
    case "meeting.delta":
    case "meeting.failed":
      renderLive();
      return;
    case "meeting.activity":
      // run 起止改忙碌点（侧栏）；tool 起止改 live 的工具行。run 结束刷新上下文用量。
      if (event.event.kind === "run") {
        renderSidebar();
        renderLive(); // run 结束会清掉残影（中断 / 正式消息先到）——DOM 也得跟着消失
        if (event.event.phase === "end") void refreshSessionInfo(event.event.meetingId);
      } else renderLive();
      return;
    case "meeting.message":
      renderMessages();
      renderLive(); // 员工正式消息到达 → 清掉对应 live 气泡
      void refreshSessionInfo(event.event.meetingId); // 上下文随回复增长
      return;
    case "meeting.pins":
      renderSidebar();
      return;
    case "meeting.queued":
      renderMessages(); // 待发消息进入消息区（排队中）
      return;
    case "meeting.dequeued":
      renderMessages(); // 出队：占位撤下 / 排队标识摘掉
      return;
    case "meeting.title":
      // 标题变了（新会议的时间标题 / 命名结果 / 另一标签页手改）：重画受影响的那块。
      renderSessionInfo();
      renderChatHead();
      if (sessionPanel !== undefined) void prependPanelItems();
      return;
    case "meeting.deleted": {
      // 会议被删（本人或另一标签页）：历史页原地刷新列表；聊天页整体重画（消息区 / 空态跟着变）。
      const route = parseRoute(window.location.search);
      if (route.view === "history") {
        const subjectKey = route.subjectKey ?? state.subjectKey;
        if (subjectKey !== undefined) void openHistory(subjectKey, "none");
        return;
      }
      renderAll();
      return;
    }
    default:
      return;
  }
}

/** 侧栏（忙碌点 / 红点 / 高亮）局部更新。 */
function renderSidebar(): void {
  const sidebar = document.getElementById("sidebar");
  if (sidebar === null) return;
  sidebar.outerHTML = sidebarHtml(state);
  bindSidebar(); // outerHTML 重建了侧栏，需重新挂载主题点击 / {} 入口 / 部门折叠
}

/** 消息列表局部更新；nearBottom 必须在重建 DOM 之前测量。 */
function renderMessages(): void {
  const messagesPart = document.getElementById("messages-part");
  if (messagesPart === null) return;
  const stick = nearBottom();
  messagesPart.innerHTML = messageListHtml(state);
  if (stick) scrollToBottom();
}

/** 「新建会议」已就绪态：按钮高亮（清空由 renderMessages 负责，不重建输入框）。 */
function renderNewMeeting(): void {
  document.getElementById("btn-new-meeting")?.classList.toggle("armed", state.freshMeeting);
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
}

/** 聊天头部：会议标题跟着 state 变（新建会议 pending 时收起标题）。 */
function renderChatHead(): void {
  const head = document.querySelector<HTMLElement>(".chat-head");
  if (head === null) return;
  const current = head.querySelector<HTMLElement>("[data-rename-meeting]");
  const meeting = state.freshMeeting ? undefined : state.meeting;
  if (meeting === undefined) {
    current?.remove();
    return;
  }
  const title = meeting.title ?? "未命名";
  if (current === null) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "session-title chat-title";
    button.dataset.renameMeeting = meeting.meetingId;
    button.title = "点击改名";
    button.textContent = title;
    head.querySelector(".title")?.after(button);
    bindTitles();
    return;
  }
  current.textContent = title;
  current.dataset.renameMeeting = meeting.meetingId;
}

/** 重拉当前会议的会话信息；辅助展示，失败静默等下一次事件。 */
async function refreshSessionInfo(meetingId: string): Promise<void> {
  try {
    const { sessions } = await api.sessionInfo(meetingId);
    dispatch({ type: "sessions", meetingId, sessions });
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

/** 当前主题的成员上下文：群聊给出成员 id 列表（非群聊为空）。有会议按会议快照，没有按项目当前成员。 */
function subjectMembers(): { isGroup: boolean; memberIds: string[] } {
  const subjectKey = state.subjectKey;
  if (subjectKey?.startsWith("group:") !== true) return { isGroup: false, memberIds: [] };
  if (state.meeting !== undefined && !state.freshMeeting) return { isGroup: true, memberIds: state.meeting.participants };
  const project = state.projects.find((p) => `group:${p.id}` === subjectKey);
  return { isGroup: true, memberIds: (project?.members ?? []).map((member) => member.id) };
}

/** 当前群聊正文里 @ 到的成员（非群聊恒为空）；与后端路由解析完全一致。 */
function composerTargets(): string[] {
  const input = composerInput();
  const { isGroup, memberIds } = subjectMembers();
  return input !== null && isGroup ? targetsOf(input.value, memberIds) : [];
}

/**
 * 群聊门禁：正文是定向的唯一真相源——复选框与发送按钮都从正文推导（勾选会写入/移除正文开头的 @ 前缀块）。
 * 无有效 @（未勾选任何成员）或只有 @ 没有正文时禁发。
 */
function syncComposerUi(): void {
  const { isGroup, memberIds } = subjectMembers();
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

function bindSubjectButtons(): void {
  for (const element of app.querySelectorAll<HTMLElement>("[data-subject]")) {
    element.addEventListener("click", () => guard(openSubject(element.dataset.subject!)));
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
  bindSubjectButtons();
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
 * 会议标题的**原地改名**：点标题 → 就地换成输入框（预填当前值、全选）；
 * Enter / 失焦保存，Esc 取消；失败保留输入内容并就地提示（不丢字）。
 */
function bindTitles(): void {
  for (const element of app.querySelectorAll<HTMLButtonElement>("button[data-rename-meeting]")) {
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
  const meetingId = button.dataset.renameMeeting;
  if (meetingId === undefined) return;
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
      const saved = await api.renameMeeting(meetingId, title);
      settled = true;
      // 先换回按钮（把输入框收走），再通知 state：局部重画时 DOM 已是最终形态。
      button.textContent = saved.title;
      restore();
      // 服务端已广播 meeting.title；这里也本地更新（不依赖事件到达时机）。
      dispatch({ type: "title", meetingId, title: saved.title });
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
  document.getElementById("btn-new-meeting")?.addEventListener("click", () => guard(toggleNewMeeting()));
  document.getElementById("btn-history")?.addEventListener("click", () => {
    const subjectKey = state.subjectKey;
    if (subjectKey !== undefined) guard(openHistory(subjectKey, "push"));
  });
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
  const meetingId = state.meetingId;
  if (meetingId === undefined) return;
  if (button.dataset.action === "unqueue") {
    const messageId = button.dataset.roomMessage;
    if (messageId === undefined) return;
    button.disabled = true;
    try {
      await api.cancelQueued(meetingId, messageId); // 成功后服务端广播 meeting.dequeued，占位随之撤下
    } catch (error) {
      button.disabled = false;
      reportError(error);
    }
    return;
  }
  const msgEl = button.closest<HTMLElement>(".msg");
  const convId = msgEl?.dataset.convId;
  const entryId = msgEl?.dataset.entryId;
  if (msgEl === null || convId === undefined || entryId === undefined) return;
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
  dispatch({ type: "pin", meetingId, key, pinned });
  try {
    await api.pin(meetingId, convId, entryId, pinned);
  } catch (error) {
    dispatch({ type: "pin", meetingId, key, pinned: !pinned }); // 回滚
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

/** 会话详情面板的实时跟随：这条会话有新内容 → 自动拉一次上下文。 */
function followPanelContent(event: ServerEvent): void {
  const panel = sessionPanel;
  if (panel === undefined) return;
  const touched =
    event.type === "meeting.delta" ||
    event.type === "meeting.failed" ||
    event.type === "meeting.activity" ||
    (event.type === "meeting.message" && event.message.speaker.kind === "employee" && event.message.speaker.id === panel.memberId);
  if (!touched) return;
  // 增量 / 工具事件按会话过滤；正式消息按成员过滤（库行视图 convId 恒为 store）
  if (event.type !== "meeting.message" && event.convId !== panel.convId) return;
  if (panelRefreshTimer !== undefined) window.clearTimeout(panelRefreshTimer);
  panelRefreshTimer = window.setTimeout(() => {
    panelRefreshTimer = undefined;
    void prependPanelItems();
  }, 350);
}

/** 拉一次最新上下文并**原地**更新条目区（不重建整个面板）。 */
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
  const meta = document.getElementById("ctx-meta-line");
  if (meta !== null) meta.innerHTML = contextMetaHtml(context);
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
  const route = parseRoute(window.location.search);
  if (route.view === "history") await openHistory(route.subjectKey ?? state.subjectKey ?? "", "none");
  else if (route.view === "meeting") await loadMeeting(route.meetingId);
  else if (route.view === "subject") await enterSubject(route.subjectKey);
}

/** 打开某主题：拉当前会议 + 历史；有当前会议就进它，否则停在「暂无记录」（等第一条消息）。 */
async function openSubject(subjectKey: string): Promise<void> {
  sessionPanel = undefined;
  configPanel = undefined;
  await enterSubject(subjectKey);
}

async function enterSubject(subjectKey: string): Promise<void> {
  const view = await api.subject(subjectKey);
  dispatch({ type: "subject", subjectKey: view.key, ...(view.current === undefined ? {} : { current: view.current }), meetings: view.meetings }, "all");
  if (view.current !== undefined) {
    navigate({ view: "meeting", meetingId: view.current.meetingId });
    await loadMeeting(view.current.meetingId);
    return;
  }
  navigate({ view: "subject", subjectKey: view.key });
}

/** 打开某场会议（历史会议同样可继续聊）。 */
async function openMeeting(meetingId: string): Promise<void> {
  sessionPanel = undefined;
  configPanel = undefined;
  await loadMeeting(meetingId);
}

async function loadMeeting(meetingId: string): Promise<void> {
  const [view, info] = await Promise.all([
    api.messages(meetingId),
    api.sessionInfo(meetingId).catch(() => undefined),
  ]);
  const subjectKey = view.meeting.kind === "dm" ? `dm:${view.meeting.subjectId}` : `group:${view.meeting.subjectId}`;
  const subject = await api.subject(subjectKey).catch(() => undefined);
  if (state.subjectKey !== subjectKey && subject !== undefined) {
    dispatch({ type: "subject", subjectKey, ...(subject.current === undefined ? {} : { current: subject.current }), meetings: subject.meetings }, "all");
  }
  dispatch({ type: "meeting", meetingId, meeting: view.meeting, messages: view.messages, pinned: view.pinned, queued: view.queued }, "all");
  if (info !== undefined) dispatch({ type: "sessions", meetingId, sessions: info.sessions });
}

/** 「新建会议」：点一下 = 清空聊天区等第一条；再点一下 = 取消（恢复当前会议）。 */
async function toggleNewMeeting(): Promise<void> {
  const subjectKey = state.subjectKey;
  if (subjectKey === undefined) return;
  if (!state.freshMeeting) {
    dispatch({ type: "new-meeting", on: true }, "all");
    navigate({ view: "subject", subjectKey });
    return;
  }
  dispatch({ type: "new-meeting", on: false });
  const current = state.meeting;
  if (current !== undefined) {
    navigate({ view: "meeting", meetingId: current.meetingId }, "replace");
    await loadMeeting(current.meetingId);
  }
}

async function sendCurrent(): Promise<void> {
  const subjectKey = state.subjectKey;
  if (sending || subjectKey === undefined) return;
  const input = composerInput();
  const text = input?.value.trim() ?? "";
  if (text === "") return;
  const isGroup = subjectKey.startsWith("group:");
  const targets = composerTargets();
  // 兜底门禁：群聊需「有效对象 + 前缀外的正文」（按钮已禁用、Enter 也走这里）；后端同样会拒绝无对象。
  if (isGroup && !groupSendable(input?.value ?? "", subjectMembers().memberIds)) return;
  const newMeeting = state.freshMeeting; // 「新建会议」：这条消息落定时才真正建会议
  const button = document.getElementById("composer-send") as HTMLButtonElement | null;
  sending = true;
  if (button !== null) button.disabled = true;
  try {
    const result = await api.sendToSubject(subjectKey, text, crypto.randomUUID(), newMeeting);
    // 发送期间用户又改了输入（或点了别的成员）则不覆盖：未改动才重置草稿。
    const untouched = input !== null && input.value.trim() === text;
    if (newMeeting) dispatch({ type: "new-meeting", on: false });
    navigate({ view: "meeting", meetingId: result.meetingId }, newMeeting ? "replace" : "push");
    await loadMeeting(result.meetingId);
    if (untouched) applyDraft(isGroup ? draftAfterSend(targets) : "");
  } catch (error) {
    if (newMeeting) dispatch({ type: "new-meeting", on: false });
    reportError(error);
  } finally {
    sending = false;
    syncComposerUi();
  }
}

/** 当前主题的本地草稿存回浏览器（空内容 = 删除）。 */
function saveComposerDraft(): void {
  const subjectKey = state.subjectKey;
  const area = composerInput();
  if (subjectKey === undefined || area === null) return;
  drafts.save(subjectKey, area.value);
}

/** 把当前主题的本地草稿填回输入框（renderAll 重建 DOM 后调用）；顺带同步群聊勾选与发送按钮态。 */
function restoreDraft(): void {
  const subjectKey = state.subjectKey;
  const area = composerInput();
  if (subjectKey === undefined || area === null) return;
  const draft = drafts.load(subjectKey);
  if (draft !== "") area.value = draft;
  syncComposerUi(); // 群聊：正文是勾选态的唯一真相源，勾回来才能继续发
}

/** 发送成功后写入草稿（事件可能重建过输入框，故重新取元素）；保留勾选对象的 @ 前缀便于接着发。 */
function applyDraft(draft: string): void {
  const area = composerInput();
  if (area === null) return;
  area.value = draft;
  saveComposerDraft(); // 发完了：缓存跟着清空（群聊只剩 @ 前缀）
  syncComposerUi();
  if (draft !== "") area.focus();
}

async function interruptCurrent(): Promise<void> {
  if (state.meetingId === undefined) return;
  await api.interrupt(state.meetingId);
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
  const label = id === "" ? "根部门" : id;
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

/**
 * 历史会议页（独立视图，URL = `?view=history&subject=…`）。
 * `mode` 决定是否写 URL：点「历史」= push；删完原地刷新 = none；手改 URL 进来 = none。
 */
async function openHistory(subjectKey: string, mode: "push" | "replace" | "none" = "push"): Promise<void> {
  if (subjectKey === "") return;
  sessionPanel = undefined;
  configPanel = undefined;
  const view = await api.subject(subjectKey);
  // dynamic：只更新侧栏高亮，不触发 renderAll（否则会先画回聊天再被历史页覆盖）
  dispatch({ type: "subject", subjectKey: view.key, ...(view.current === undefined ? {} : { current: view.current }), meetings: view.meetings });
  if (mode !== "none") navigate({ view: "history", subjectKey: view.key }, mode);
  app.innerHTML = historyHtml(state);
  document.getElementById("btn-history-back")?.addEventListener("click", () => guard(backToChat()));
  bindSidebar(); // 面板内也带一份侧栏（主题 / {} 定义 / 部门折叠）
  bindPermCards(); // 全局授权卡片也可见可点
  bindTitles(); // 历史行的标题可改名（点击保存后重拉列表）
  for (const element of app.querySelectorAll<HTMLElement>("[data-meeting]")) {
    const meetingId = element.dataset.meeting!;
    element.addEventListener("click", () => {
      navigate({ view: "meeting", meetingId });
      guard(openMeeting(meetingId));
    });
  }
  for (const element of app.querySelectorAll<HTMLElement>("[data-delete-meeting]")) {
    element.addEventListener("click", () => guard(removeMeeting(element.dataset.deleteMeeting!)));
  }
}

/** 从历史页返回聊天：回到该主题最新一场会议（没有就停在「暂无记录」）。 */
async function backToChat(): Promise<void> {
  const subjectKey = state.subjectKey;
  if (subjectKey === undefined) {
    renderAll();
    return;
  }
  await enterSubject(subjectKey);
}

/** 删除会议（老板专属）：不可恢复；删的是当前会议就回该主题最新一场 / 暂无记录。 */
async function removeMeeting(meetingId: string): Promise<void> {
  const confirmed = window.confirm("删除这场会议？该会议的消息、会话映射与 pin 会一并删除，不可恢复。");
  if (!confirmed) return;
  await api.deleteMeeting(meetingId);
  const subjectKey = state.subjectKey;
  if (subjectKey === undefined) {
    renderAll();
    return;
  }
  await openHistory(subjectKey, "none"); // 删除入口只在历史页：原地刷新，不回聊天
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
    window.addEventListener("popstate", () => void applyRoute());

    await applyRoute();
  } catch (error) {
    app.innerHTML = `<main class="setup"><h1>OpenStaffs</h1><p>服务不可用：${escapeHtml(error instanceof Error ? error.message : String(error))}</p></main>`;
  }
}

/** 按 URL 打开（首屏 / 浏览器前进后退都走它）。 */
async function applyRoute(): Promise<void> {
  const route = parseRoute(window.location.search);
  if (route.view === "history") {
    const subjectKey = route.subjectKey
      ?? localStorage.getItem("openstaffs.subject")
      ?? (state.employees[0] === undefined ? undefined : `dm:${state.employees[0].id}`);
    if (subjectKey !== undefined) {
      await openHistory(subjectKey, route.subjectKey === undefined ? "replace" : "none");
      return;
    }
  }
  if (route.view === "meeting") {
    await openMeeting(route.meetingId);
    return;
  }
  if (route.view === "subject") {
    await openSubject(route.subjectKey);
    return;
  }
  // 无参数：上次看的会议 → 上次的主题 → 第一个员工 / 项目。
  const lastMeeting = localStorage.getItem("openstaffs.meeting");
  if (lastMeeting !== null) {
    try {
      await openMeeting(lastMeeting);
      navigate({ view: "meeting", meetingId: lastMeeting }, "replace");
      return;
    } catch {
      // 会议已随库重建消失（开发阶段破坏性更新）：落到下面按主题找。
    }
  }
  const lastSubject = localStorage.getItem("openstaffs.subject");
  if (lastSubject !== null) {
    try {
      await openSubject(lastSubject);
      return;
    } catch {
      // 同上
    }
  }
  const first = state.employees[0];
  if (first !== undefined) {
    await enterSubject(`dm:${first.id}`);
    return;
  }
  const project = state.projects[0];
  if (project !== undefined) await enterSubject(`group:${project.id}`);
}

void main();
