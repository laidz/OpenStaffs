import { describe, expect, it } from "vitest";
import { chatHtml, configPanelHtml, historyHtml, liveHtml, messageHtml, messageListHtml, messagesHtml, permissionCardsHtml, sessionInfoHtml, sessionPanelHtml, setupPage, sidebarHtml } from "../../web/render.ts";
import { initialState, type State } from "../../web/state.ts";
import type { EmployeeSession, SessionContextView } from "../../web/api.ts";
import type { MeetingView } from "../../src/app/meetings.ts";
import type { MeetingMessage } from "../../src/app/meeting-messages.ts";
import type { QueuedItemView } from "../../src/app/outbox.ts";

const meeting: MeetingView = {
  meetingId: "mtg_1",
  kind: "dm",
  subjectId: "alice",
  subjectLabel: "爱丽丝",
  participants: ["alice"],
  title: "登录排查",
  createdAt: "2026-10-26T10:00:00.000Z",
};

function inMeeting(overrides: Partial<State> = {}): State {
  return {
    ...initialState,
    configured: true,
    subjectKey: "dm:alice",
    meetingId: "mtg_1",
    meeting,
    meetings: [meeting],
    ...overrides,
  };
}

function employeeMessage(entryId: string, text: string, speaker: { id: string; alias?: string } = { id: "alice", alias: "爱丽丝" }): MeetingMessage {
  return { convId: "store", entryId, speaker: { kind: "employee", ...speaker }, text, bossDirected: true };
}

function bossMessage(entryId: string, text: string, messageId?: string): MeetingMessage {
  return { convId: "store", entryId, speaker: { kind: "boss" }, text, bossDirected: false, ...(messageId === undefined ? {} : { messageId }) };
}

describe("渲染", () => {
  it("HTML 转义与 boss/员工布局类名", () => {
    const html = messageHtml(bossMessage("1", "<script>alert(1)</script>"));
    expect(html).toContain('class="msg boss"');
    expect(html).toContain("老板");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("员工消息显示 alias；空列表提示", () => {
    const employee = employeeMessage("2", "好");
    expect(messageHtml(employee)).toContain('class="msg employee"');
    expect(messageHtml(employee)).toContain("爱丽丝");
    expect(messagesHtml([])).toContain("还没有消息");
  });

  it("老板消息发言人名消费 bossName（默认「老板」）", () => {
    expect(messageHtml(bossMessage("1", "你好"), "掌柜")).toContain("掌柜");
    expect(messageHtml(bossMessage("1", "你好"), "掌柜")).not.toContain(">老板<");
    expect(messageHtml(bossMessage("1", "你好"))).toContain("老板");
  });

  it("引导页示例为多供应商新格式", () => {
    const html = setupPage("/office", 4319);
    expect(html).toContain('"providers"');
    expect(html).toContain('"opencode-go": { "apiKey": "你的密钥" }');
    expect(html).toContain('"model": "opencode-go/deepseek-v4.1-flash"');
    expect(html).toContain('"port": 4319');
    expect(html).toContain("agents/&lt;部门…&gt;/&lt;名字&gt;.agent.config.json");
    expect(html).not.toContain("agents/&lt;员工&gt;/config.json");
  });

  it("引导页指向 openstaffs/.data/config.json（不再是 .openstaffs）", () => {
    const html = setupPage("/office", 4319);
    expect(html).toContain("/office/openstaffs/.data/config.json");
    expect(html).toContain("openstaffs/space.config.json");
    expect(html).toContain("agents/staff0.agent.config.json");
    expect(html).not.toContain(".openstaffs");
  });
});

describe("会话信息条", () => {
  it("模型全值、思考强度（含 null）、上下文用量/窗口与占比", () => {
    const state = inMeeting({
      sessions: [{ memberId: "alice", convId: "c1", model: "faux/faux-model", thinkingLevel: null, contextUsed: 12800, contextWindow: 128000 }],
    });
    const html = sessionInfoHtml(state);
    expect(html).toContain("faux/faux-model");
    expect(html).toContain("思考 default");
    expect(html).not.toContain("思考 null");
    expect(html).toContain("12.8K / 128K，10%");
    expect(html).not.toContain("alice ·"); // 私聊不重复成员名
  });

  it("群聊按成员展示；窗口未知只给已用量；无会话渲染空容器", () => {
    const group = inMeeting({
      subjectKey: "group:yt",
      projects: [{ id: "yt", alias: "油管", members: [] }],
      employees: [{ id: "alice", alias: "爱丽丝", model: "faux/faux-model" }],
      sessions: [
        { memberId: "alice", convId: "c1", model: "faux/faux-model", thinkingLevel: "high", contextUsed: 999 },
        { memberId: "bob", convId: "c2", model: "other/m2", thinkingLevel: "off", contextUsed: 2000 },
      ],
    });
    const html = sessionInfoHtml(group);
    expect(html).toContain("爱丽丝");
    expect(html).toContain("bob");
    expect(html).toContain("999");
    expect(html).toContain("2K");
    expect(html).not.toContain("999 /");
    expect(sessionInfoHtml({ ...initialState, configured: true, subjectKey: "dm:alice" })).toBe(`<div class="session-info" id="session-info"></div>`);
  });

  it("每条会话带「详情」入口（参数是 convId + 成员 id）", () => {
    const state = inMeeting({ sessions: [{ memberId: "alice", convId: "conv_dm", model: "faux/x", thinkingLevel: "off", contextUsed: 0 }] });
    const html = sessionInfoHtml(state);
    expect(html).toContain('data-session-detail="conv_dm"');
    expect(html).toContain('data-member="alice"');
  });
});

describe("聊天头部与会议标题", () => {
  it("私聊：头部显示主题名 + 当前会议标题（点击改名），不再有单条会话标题", () => {
    const html = chatHtml(inMeeting({ employees: [{ id: "alice", alias: "爱丽丝", model: "faux/x" }], sessions: [{ memberId: "alice", convId: "c1", model: "faux/x", thinkingLevel: "off", contextUsed: 0 }] }));
    expect(html).toContain("爱丽丝");
    expect(html).toContain("登录排查");
    expect(html).toContain('data-rename-meeting="mtg_1"');
    expect(html).not.toContain("data-rename-conv");
  });

  it("群聊：会议标题同样在头部（一场会议一个标题）", () => {
    const state = inMeeting({
      subjectKey: "group:yt",
      meeting: { ...meeting, kind: "group", subjectId: "yt", subjectLabel: "油管项目", participants: ["alice"] },
      projects: [{ id: "yt", alias: "油管项目", members: [{ id: "alice", alias: "爱丽丝" }] }],
      sessions: [{ memberId: "alice", convId: "c1", model: "faux/x", thinkingLevel: "off", contextUsed: 0 }],
    });
    const header = chatHtml(state).split('class="session-info"')[0]!;
    expect(header).toContain('data-rename-meeting="mtg_1"');
    expect(header).toContain("登录排查");
  });

  it("还没有会议（刚点「新建会议」）：不显示标题，聊天区「暂无记录」", () => {
    const html = chatHtml(inMeeting({ meeting: undefined, meetingId: undefined, freshMeeting: true }));
    expect(html).not.toContain("data-rename-meeting");
    expect(html).toContain("暂无记录");
    expect(html).toContain("btn-new-session armed");
  });

  it("没有选中主题：提示从左侧进入", () => {
    expect(chatHtml({ ...initialState, configured: true })).toContain("从左侧选择一个员工或项目");
  });
});

describe("员工 Markdown 渲染 / 老板原样（UI 层）", () => {
  it("员工消息按 Markdown 渲染，容器带 md 类", () => {
    const html = messageHtml(employeeMessage("3", "**加粗**\n\n- 项"));
    expect(html).toContain('class="msg-text md"');
    expect(html).toContain("<strong>加粗</strong>");
    expect(html).toContain("<li>项</li>");
  });

  it("老板消息原样：Markdown 语法字面展示、HTML 转义、不带 md 类", () => {
    const html = messageHtml(bossMessage("4", "**不是加粗** <b>标签</b>"));
    expect(html).not.toContain("<strong>");
    expect(html).toContain("**不是加粗**");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("msg-text md");
  });

  it("进行中气泡：昵称取 alias、状态行常驻（转圈 + 当前在做的事）、失败气泡保持原样转义", () => {
    const state = inMeeting({
      employees: [{ id: "alice", alias: "爱丽丝", model: "faux/faux-model" }],
      live: { "dm:a": { convId: "dm:a", memberId: "alice", text: "**粗**", thinking: "", tools: [], activity: "正在执行 shell…" } },
    });
    const html = liveHtml(state);
    expect(html).toContain('class="msg-text md"');
    expect(html).toContain("<strong>粗</strong>");
    expect(html).toContain('class="live-spinner"');
    expect(html).toContain("正在执行 shell…");
    expect(html).toContain('class="msg-name">爱丽丝</div>');
    expect(html).not.toContain('class="msg-name">alice</div>');

    const failed = { ...state, live: { "dm:a": { convId: "dm:a", memberId: "alice", text: "半句", thinking: "", tools: [], activity: "", error: "<崩>" } } };
    const html2 = liveHtml(failed);
    expect(html2).toContain("⚠️ &lt;崩&gt;");
    expect(html2).not.toContain("msg-text md");
    expect(html2).not.toContain("live-spinner");
  });

  it("进行中气泡：没有正文时也占着「…」+ 状态行，org 里查不到该人时回落 id", () => {
    const state = inMeeting({ live: { "dm:a": { convId: "dm:a", memberId: "ghost", text: "", thinking: "", tools: [], activity: "" } } });
    const html = liveHtml(state);
    expect(html).toContain("…");
    expect(html).toContain('class="msg-name">ghost</div>');
    expect(html).toContain("正在思考…");
  });
});

describe("群聊定向（输入框上方复选框）", () => {
  it("群聊：罗列成员复选框（展示名转义 + id），发送按钮初始禁用", () => {
    const state = inMeeting({
      subjectKey: "group:yt",
      meeting: { ...meeting, kind: "group", subjectId: "yt", subjectLabel: "油管", participants: ["alice", "bob"] },
      projects: [{ id: "yt", alias: "油管", members: [{ id: "alice", alias: "爱丽丝<b>" }, { id: "bob" }] }],
    });
    const html = chatHtml(state);
    expect(html).toContain('id="composer-targets"');
    expect(html).toContain('data-target="alice"');
    expect(html).toContain("爱丽丝&lt;b&gt;");
    expect(html).toContain('data-target="bob"');
    expect(html).toMatch(/<button id="composer-send" disabled>发送<\/button>/u);
  });

  it("私聊：不出现成员复选框，发送按钮不初始禁用", () => {
    const html = chatHtml(inMeeting({ employees: [{ id: "alice", alias: "爱丽丝", model: "faux/x" }] }));
    expect(html).not.toContain("composer-targets");
    expect(html).not.toMatch(/<button id="composer-send" disabled>/u);
  });

  it("空成员群：给出占位提示", () => {
    const state = inMeeting({
      subjectKey: "group:yt",
      meeting: { ...meeting, kind: "group", subjectId: "yt", subjectLabel: "空群", participants: [] },
      projects: [{ id: "yt", alias: "空群", members: [] }],
    });
    expect(chatHtml(state)).toContain("还没有成员");
  });
});

describe("授权卡片", () => {
  const request = {
    id: "pr_1",
    agentId: "alice",
    meetingId: "mtg_1",
    tools: ["read", "write"],
    paths: ["/x/<script>"],
    reason: "整理素材",
    createdAt: "t",
    agentName: "爱丽丝<b>",
    where: "群聊「演示」",
  };

  it("卡片：发起人/来源/理由/路径转义、接受与拒绝按钮", () => {
    const state = inMeeting({ permissionRequests: [request] });
    const html = permissionCardsHtml(state);
    expect(html).toContain("授权请求");
    expect(html).toContain("爱丽丝&lt;b&gt;");
    expect(html).toContain("群聊「演示」");
    expect(html).toContain('<span class="perm-tools">[read+write]</span>'); // 原样展示，不翻译成「读 / 写」
    expect(html).toContain("理由：整理素材");
    expect(html).toContain("/x/&lt;script&gt;");
    expect(html).toContain('data-perm-accept="pr_1"');
    expect(html).toContain('data-perm-reject="pr_1"');
    expect(html).not.toContain("<script>");
  });

  it("处理中禁用按钮、错误行显示；私聊来源标签", () => {
    const state = inMeeting({ permissionRequests: [{ ...request, where: "私聊 · 爱丽丝", busy: true, error: "写盘失败" }] });
    const html = permissionCardsHtml(state);
    expect(html).toMatch(/data-perm-accept="pr_1" disabled/u);
    expect(html).toContain("写盘失败");
    expect(html).toContain("私聊");
  });

  it("空列表 → 空容器", () => {
    expect(permissionCardsHtml(initialState)).toBe('<div class="perm-cards" id="perm-cards"></div>');
  });
});

describe("排队中的消息（待发队列）与「新建会议」", () => {
  const queued: QueuedItemView = { submissionId: "11", meetingId: "mtg_1", memberId: "alice", messageId: "rm_1", text: "在吗" };

  it("还没落盘的排队消息：独立占位气泡（灰底 + 排队标识 + 撤回），不进 toolbar", () => {
    const html = messagesHtml([], "老板", [], [queued]);
    expect(html).toContain('class="msg boss queued"');
    expect(html).toContain('data-room-message="rm_1"');
    expect(html).toContain("排队中：alice");
    expect(html).toContain('data-action="unqueue"');
    expect(html).toContain("在吗");
    expect(html).not.toContain('data-action="pin"');
  });

  it("已有真气泡（群里只有忙的那位还在排）：排队标识贴上去，不出两个气泡", () => {
    const html = messagesHtml([bossMessage("5", "在吗", "rm_1")], "老板", [], [{ ...queued, memberId: "bob" }]);
    expect(html.match(/class="msg boss/g)).toHaveLength(1);
    expect(html).toContain("排队中：bob");
    expect(html).toContain('data-action="pin"');
  });

  it("同一次多投递：一条占位气泡、列出全部等待成员；不同消息按投递顺序排列", () => {
    const html = messagesHtml([], "老板", [], [queued, { ...queued, submissionId: "12", memberId: "bob" }, { ...queued, submissionId: "13", messageId: "rm_2", text: "第二句" }]);
    expect(html.match(/class="msg boss queued/g)).toHaveLength(2);
    expect(html).toContain("排队中：alice、bob");
    expect(html.indexOf("在吗")).toBeLessThan(html.indexOf("第二句"));
  });

  it("点了「新建会议」就清空聊天区（旧记录立刻不显示）；取消后恢复", () => {
    const base = inMeeting({ messages: [bossMessage("1", "上一轮的话")] });
    expect(messageListHtml(base)).toContain("上一轮的话");
    const armed = messageListHtml({ ...base, freshMeeting: true });
    expect(armed).not.toContain("上一轮的话");
    expect(armed).toContain("暂无记录");
    expect(armed).not.toContain("log-divider");
    expect(messageListHtml({ ...base, freshMeeting: false })).toContain("上一轮的话");
  });

  it("会议没有「结束」：旧会议照样可编辑、可发送（不再有只读提示条 / 禁用输入框）", () => {
    const old = inMeeting({ messages: [bossMessage("1", "旧话")] });
    expect(messageListHtml(old)).not.toContain("这场会议已结束");
    const html = chatHtml(old);
    expect(html).not.toContain("只读回看");
    expect(html).not.toMatch(/<textarea id="composer-input" placeholder="[^"]*" disabled>/u);
    // 删除入口只在「历史」页面出现，聊天头部不放
    expect(html).not.toContain('id="btn-delete-meeting"');
  });
});

describe("历史会议页", () => {
  const old: MeetingView = { ...meeting, meetingId: "mtg_old", kind: "group", subjectId: "yt", subjectLabel: "油管", participants: ["alice", "bob"] };
  const latest: MeetingView = { ...meeting, meetingId: "mtg_new", kind: "group", subjectId: "yt", subjectLabel: "油管", participants: ["alice"] };
  const state = inMeeting({
    subjectKey: "group:yt",
    meetingId: latest.meetingId,
    meeting: latest,
    meetings: [latest, old],
    projects: [{ id: "yt", alias: "油管", members: [{ id: "alice" }, { id: "bob" }] }],
    employees: [{ id: "alice", alias: "爱丽丝", model: "faux/x" }, { id: "bob", model: "faux/y" }],
  });

  it("列出该主题全部会议：可查看 / 改名 / 删除，不在聊天页里", () => {
    const html = historyHtml(state);
    expect(html).toContain("历史会议 · 油管");
    expect(html).toContain('data-meeting="mtg_new"');
    expect(html).toContain('data-meeting="mtg_old"');
    expect(html).toContain('data-delete-meeting="mtg_old"');
    expect(html).toContain('data-rename-meeting="mtg_old"');
    expect(html).toContain("爱丽丝");
    expect(html).toContain("bob");
    expect(html).toContain('id="btn-history-back"');
    expect(html).not.toContain('id="composer-input"');
    expect(html).not.toContain("data-target=");
  });

  it("没有会议：显示空态，仍能返回聊天", () => {
    const html = historyHtml({ ...state, meetings: [] });
    expect(html).toContain("还没有会议");
    expect(html).toContain('id="btn-history-back"');
  });
});

describe("会议列表与删除", () => {
  const older: MeetingView = { ...meeting, meetingId: "mtg_old", kind: "group", subjectId: "yt", subjectLabel: "油管", participants: ["alice", "bob"] };
  const state = inMeeting({
    subjectKey: "group:yt",
    meetingId: older.meetingId,
    meeting: older,
    meetings: [older],
    projects: [{ id: "yt", alias: "油管", members: [{ id: "alice" }, { id: "bob" }] }],
  });

  it("旧会议（非最新）也能继续聊：显示当前成员勾选与输入框，不再有「回到最新会议」", () => {
    const html = chatHtml(state);
    expect(html).toContain('id="composer-targets"');
    expect(html).toContain('data-target="alice"');
    expect(html).toContain('data-target="bob"');
    expect(html).not.toContain('id="btn-current-meeting"');
  });

  it("删除入口不在聊天头部（只在「历史」页面出现）", () => {
    expect(chatHtml(state)).not.toContain('id="btn-delete-meeting"');
    expect(chatHtml(state)).not.toContain(">删除<");
  });
});

describe("气泡工具栏与 pin 高亮", () => {
  const employee = employeeMessage("2", "好");
  const other = employeeMessage("3", "再");

  it("每条消息带消息键与工具栏（复制 / pin），默认未 pin", () => {
    const html = messageHtml(employee);
    expect(html).toContain('data-conv-id="store"');
    expect(html).toContain('data-entry-id="2"');
    expect(html).toContain('data-action="copy"');
    expect(html).toContain('data-action="pin"');
    expect(html).not.toContain("pinned");
  });

  it("pinned 消息：加 pinned 类名（淡红底/图钉由样式负责）", () => {
    expect(messageHtml(employee, "老板", true)).toContain('class="msg employee pinned"');
  });

  it("messagesHtml 按 pinned 集合标记对应气泡", () => {
    expect(messagesHtml([employee, other], "老板", ["store:3"])).toContain('<div class="msg employee pinned" data-conv-id="store" data-entry-id="3">');
    expect(messagesHtml([employee, other], "老板", [])).not.toContain("pinned");
  });

  it("chatHtml 把当前会议 pinned 集合透传给气泡", () => {
    const state = inMeeting({ messages: [employeeMessage("5", "x")], pinned: ["store:5"] });
    expect(chatHtml(state)).toContain('class="msg employee pinned"');
  });

  it("sidebarHtml：红点 = 该主题 pin 计数", () => {
    const state = {
      ...initialState,
      configured: true,
      employees: [{ id: "alice", alias: "爱丽丝", model: "faux/x" }],
      projects: [{ id: "yt", alias: "油管", members: [] }],
      pins: { "dm:alice": 2, "group:yt": 1 },
    };
    const html = sidebarHtml(state);
    expect(html).toContain('<span class="badge">2</span>');
    expect(html).toContain('<span class="badge">1</span>');
  });
});

describe("侧栏部门树", () => {
  const ORG = {
    path: "",
    name: "办公室",
    people: [{ id: "staff0", model: "faux/faux-model" }],
    departments: [
      {
        path: "eng",
        name: "研发",
        people: [{ id: "alice", alias: "爱丽丝", model: "faux/x" }],
        departments: [{ path: "eng/platform", name: "平台", people: [{ id: "bob", model: "faux/y" }], departments: [] }],
      },
    ],
  };

  it("sidebarHtml：部门树（嵌套 + 折叠时不渲染正文 + 空部门仍出部门头）", () => {
    const state = { ...initialState, configured: true, org: ORG, pins: { "dm:bob": 1 } };
    const html = sidebarHtml(state);
    expect(html).toContain('data-toggle-dept="eng"');
    expect(html).toContain('data-toggle-dept="eng/platform"');
    expect(html).toContain('data-subject="dm:alice"');
    expect(html).toContain('data-subject="dm:bob"');
    expect(html).toContain('<span class="badge">1</span>');
    expect(html).toContain("爱丽丝");
    expect(html).toContain('aria-expanded="true"');

    const collapsed = sidebarHtml({ ...state, collapsedDepts: ["eng"] });
    expect(collapsed).toContain('data-toggle-dept="eng"');
    expect(collapsed).not.toContain('data-subject="dm:alice"');
    expect(collapsed).not.toContain('data-subject="dm:bob"');
    expect(collapsed).toContain('aria-expanded="false"');

    const empty = sidebarHtml({
      ...initialState,
      configured: true,
      org: { path: "", name: "办公室", people: [], departments: [{ path: "eng", name: "研发", people: [], departments: [] }] },
    });
    expect(empty).toContain('data-toggle-dept="eng"');
    expect(empty).not.toContain("暂无员工");
  });

  it("sidebarHtml：无 org 数据时回落平铺（首帧不白屏）；都没有才出提示", () => {
    const flat = sidebarHtml({ ...initialState, configured: true, employees: [{ id: "alice", alias: "爱丽丝", model: "faux/x" }] });
    expect(flat).toContain('data-subject="dm:alice"');
    expect(flat).toContain('data-config-scope="agent"');
    expect(flat).toContain('data-config-id="alice"');
    const empty = sidebarHtml({ ...initialState, configured: true });
    expect(empty).toContain("<p class=\"hint\">暂无员工</p>");
    expect(empty).toContain("<p class=\"hint\">暂无项目</p>");
    expect(empty).not.toContain("agent.config.json（见 README.md）");
  });

  it("高亮按 subjectKey：同一员工换会议仍高亮", () => {
    const state = { ...initialState, configured: true, subjectKey: "group:yt", projects: [{ id: "yt", alias: "油管", members: [] }] };
    expect(sidebarHtml(state)).toContain('class="item item-main active" data-subject="group:yt"');
  });
});

describe("会话详情 / 定义文件面板", () => {
  // 用本地时间造 ISO：断言才不受跑测机器的时区影响
  const session: EmployeeSession = {
    convId: "conv_dm",
    meetingId: "mtg_1",
    kind: "dm",
    subjectKey: "dm:alice",
    title: "登录排查",
    running: true,
    model: "faux/faux-model",
    thinkingLevel: "high",
    contextUsed: 166_000,
    contextWindow: 1_000_000,
  };
  const context: SessionContextView = {
    ...session,
    instructions: "你是 alice。<系统>",
    cwd: "/office/work/alice",
    items: [
      { role: "user", text: "写个文件", at: new Date(2026, 9, 25, 10, 0, 5).toISOString() },
      { role: "assistant", text: "", at: new Date(2026, 9, 25, 10, 0, 9).toISOString(), toolCalls: [{ id: "call_1", name: "write", arguments: { path: "a.md", content: "<x>" } }] },
      { role: "tool", text: "ok", toolCallId: "call_1", toolName: "write", at: new Date(2026, 9, 25, 10, 0, 12).toISOString() },
      { role: "assistant", text: "完成", at: new Date(2026, 9, 25, 10, 0, 20).toISOString() },
    ],
  };

  it("时间按本地时区、上下文用量与聊天信息条同口径、每步带本地时间", () => {
    const html = sessionPanelHtml({ ...initialState, configured: true }, context);
    expect(html).toContain('title="2026-10-25 10:00"');
    expect(html).toContain(">10:00:05<");
    const head = html.slice(html.indexOf('<div class="ctx-header">'), html.indexOf('id="ctx-items"'));
    expect(head).not.toContain("T02:00:00");
    expect(html).toContain("上下文 166K / 1M，17%");
    expect(html).not.toContain("166000 / 1000000 tokens");
    expect(html).toContain("10:00:05");
    expect(html).toContain("10:00:09");
    expect(html).toContain("10:00:20");
    expect(html).toContain('class="ctx-time"');
    expect(html.indexOf('class="ctx-time"')).toBeLessThan(html.indexOf("<strong>用户</strong>"));
    expect(html).not.toContain("margin-left: auto");

    const notime = sessionPanelHtml({ ...initialState, configured: true }, { ...context, items: [{ role: "user", text: "没有时间戳" }] });
    expect(notime).not.toContain('class="ctx-time"');
  });

  it("会话详情：只有当前这一条会话（无 Tab），来源按会议、标题可改名", () => {
    const html = sessionPanelHtml({ ...initialState, configured: true }, context);
    expect(html).toContain("会话详情（只读）");
    expect(html).toContain("私聊会议");
    expect(html).toContain('data-rename-meeting="mtg_1"');
    expect(html).not.toContain('id="session-panel-refresh"');
    expect(html).not.toContain("有新内容");
    expect(html).toContain('id="session-panel-back"');
    expect(html).not.toContain("data-agent-conv");
    expect(html).toContain("系统提示词");
    expect(html).toContain("你是 alice。&lt;系统&gt;");
    expect(html).toContain("工具调用：write");
    expect(html).toContain("&lt;x&gt;");
    expect(html).toContain("完成");
    expect(html).not.toContain("<系统>");
  });

  it("群聊来源标签带项目名", () => {
    const html = sessionPanelHtml({ ...initialState, configured: true }, { ...context, kind: "group", projectId: "yt", projectAlias: "油管项目" });
    expect(html).toContain("群 · 油管项目");
  });

  it("工具调用与结果合成一条（不默认展开）；配不上的结果仍单独成条", () => {
    const html = sessionPanelHtml({ ...initialState, configured: true }, context);
    expect(html).not.toContain("<strong>工具结果</strong>");
    expect(html.split("工具调用：write").length - 1).toBe(1);
    expect(html).toContain("已完成");
    expect(html).toContain('<details class="ctx-block ctx-call" data-key=');
    expect(html).not.toContain(" open");

    const orphan = sessionPanelHtml({ ...initialState, configured: true }, {
      ...context,
      items: [{ role: "tool", text: "孤立结果", toolCallId: "call_x", toolName: "bash" }],
    });
    expect(orphan).toContain("<strong>工具结果</strong>");
    expect(orphan).toContain("工具结果：bash");
    expect(orphan).toContain("孤立结果");
    expect(orphan).not.toContain(" open");
  });

  it("条目区新的在最上面（逆序）；配对不受顺序影响", () => {
    const html = sessionPanelHtml({ ...initialState, configured: true }, context);
    const first = html.indexOf("完成");
    const last = html.indexOf("写个文件");
    expect(first).toBeGreaterThan(-1);
    expect(last).toBeGreaterThan(-1);
    expect(first).toBeLessThan(last);
    expect(html).not.toContain("<strong>工具结果</strong>");
    expect(html.split("工具调用：write").length - 1).toBe(1);
  });

  it("系统提示词在第一张卡片（基础信息）里，不再单独成块", () => {
    const html = sessionPanelHtml({ ...initialState, configured: true }, context);
    const header = html.indexOf('<div class="ctx-header">');
    const system = html.indexOf('<details class="ctx-system">');
    const items = html.indexOf('id="ctx-items"');
    expect(header).toBeGreaterThan(-1);
    expect(system).toBeGreaterThan(header);
    expect(system).toBeLessThan(items);
    expect(html).toContain('<div class="ctx-system-body">');
    expect(html).toContain('class="ctx-text"');
  });

  it("会话详情：拿不到上下文时给出提示，不留空白", () => {
    const html = sessionPanelHtml({ ...initialState, configured: true }, undefined);
    expect(html).toContain("无法读取该会话上下文");
  });

  it("定义文件面板：原文原样转义进 pre；缺文件时说明", () => {
    const view = { scope: "agent" as const, id: "alice", file: "alice 的定义文件", text: '{\n  "prompt": "<你>是 alice"\n}' };
    const html = configPanelHtml({ ...initialState, configured: true }, view, "alice");
    expect(html).toContain('class="ctx-text config-text"');
    expect(html).toContain("alice 的定义文件");
    expect(html).toContain("&lt;你&gt;是 alice");
    expect(html).toContain('id="config-panel-back"');

    const missing = configPanelHtml({ ...initialState, configured: true }, { ...view, text: null }, "alice");
    expect(missing).toContain("该层没有配置文件");
  });
});
