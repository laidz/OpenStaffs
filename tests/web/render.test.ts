import { describe, expect, it } from "vitest";
import { chatHtml, configPanelHtml, freshSessionHint, liveHtml, messageHtml, messagesHtml, permissionCardsHtml, sessionInfoHtml, sessionPanelHtml, setupPage, sidebarHtml } from "../../web/render.ts";
import { initialState } from "../../web/state.ts";
import type { EmployeeSession, SessionContextView } from "../../web/api.ts";
import type { RoomMessage } from "../../src/app/rooms.ts";

describe("渲染", () => {
  it("HTML 转义与 boss/员工布局类名", () => {
    const boss: RoomMessage = { convId: "c1", entryId: "1", roomKey: "dm:a", speaker: { kind: "boss" }, text: "<script>alert(1)</script>", bossDirected: false };
    const html = messageHtml(boss);
    expect(html).toContain('class="msg boss"');
    expect(html).toContain("老板");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("员工消息显示 alias；空列表提示", () => {
    const employee: RoomMessage = { convId: "c1", entryId: "2", roomKey: "dm:a", speaker: { kind: "employee", id: "alice", alias: "爱丽丝" }, text: "好", bossDirected: true };
    expect(messageHtml(employee)).toContain('class="msg employee"');
    expect(messageHtml(employee)).toContain("爱丽丝");
    expect(messagesHtml([])).toContain("还没有消息");
  });

  it("老板消息发言人名消费 bossName（默认「老板」）", () => {
    const boss: RoomMessage = { convId: "c1", entryId: "1", roomKey: "dm:a", speaker: { kind: "boss" }, text: "你好", bossDirected: false };
    expect(messageHtml(boss, "掌柜")).toContain("掌柜");
    expect(messageHtml(boss, "掌柜")).not.toContain(">老板<");
    expect(messageHtml(boss)).toContain("老板");
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
    const state = {
      ...initialState,
      roomKey: "dm:alice",
      sessions: [
        { memberId: "alice", convId: "c1", model: "faux/faux-model", thinkingLevel: null, contextUsed: 12800, contextWindow: 128000 },
      ],
    };
    const html = sessionInfoHtml(state);
    expect(html).toContain("faux/faux-model");
    expect(html).toContain("思考 null");
    expect(html).toContain("12.8K / 128K，10%");
    expect(html).not.toContain("alice ·"); // 私聊不重复成员名
  });

  it("群聊按成员展示；窗口未知只给已用量；无会话渲染空容器", () => {
    const group = {
      ...initialState,
      roomKey: "group:yt",
      employees: [{ id: "alice", alias: "爱丽丝", model: "faux/faux-model" }],
      sessions: [
        { memberId: "alice", convId: "c1", model: "faux/faux-model", thinkingLevel: "high", contextUsed: 999, contextWindow: undefined },
        { memberId: "bob", convId: "c2", model: "other/m2", thinkingLevel: "off", contextUsed: 2000 },
      ],
    };
    const html = sessionInfoHtml(group);
    expect(html).toContain("爱丽丝");
    expect(html).toContain("bob");
    expect(html).toContain("999");
    expect(html).toContain("2K");
    expect(html).not.toContain("999 /");
    expect(sessionInfoHtml({ ...initialState, roomKey: "dm:alice" })).toBe(`<div class="session-info" id="session-info"></div>`);
  });
});

describe("员工 Markdown 渲染 / 老板原样（UI 层）", () => {
  it("员工消息按 Markdown 渲染，容器带 md 类", () => {
    const employee: RoomMessage = { convId: "c1", entryId: "3", roomKey: "dm:a", speaker: { kind: "employee", id: "alice" }, text: "**加粗**\n\n- 项", bossDirected: true };
    const html = messageHtml(employee);
    expect(html).toContain('class="msg-text md"');
    expect(html).toContain("<strong>加粗</strong>");
    expect(html).toContain("<li>项</li>");
  });

  it("老板消息原样：Markdown 语法字面展示、HTML 转义、不带 md 类", () => {
    const boss: RoomMessage = { convId: "c1", entryId: "4", roomKey: "dm:a", speaker: { kind: "boss" }, text: "**不是加粗** <b>标签</b>", bossDirected: false };
    const html = messageHtml(boss);
    expect(html).not.toContain("<strong>");
    expect(html).toContain("**不是加粗**");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("msg-text md");
  });

  it("流式气泡按 Markdown 渲染（含工具行）；失败气泡保持原样转义", () => {
    const live = { "dm:a": { convId: "dm:a", memberId: "alice", text: "**粗**", thinking: "", tools: ["shell"] } };
    const html = liveHtml(live);
    expect(html).toContain('class="msg-text md"');
    expect(html).toContain("<strong>粗</strong>");
    expect(html).toContain("正在执行 shell…");

    const failed = { "dm:a": { convId: "dm:a", memberId: "alice", text: "半句", thinking: "", tools: [], error: "<崩>" } };
    const html2 = liveHtml(failed);
    expect(html2).toContain("⚠️ &lt;崩&gt;");
    expect(html2).not.toContain("msg-text md");
  });

  it("流式正文尚未输出时显示省略号占位", () => {
    const live = { "dm:a": { convId: "dm:a", memberId: "alice", text: "", thinking: "", tools: [] } };
    expect(liveHtml(live)).toContain("…");
  });
});

describe("群聊定向（输入框上方复选框）", () => {
  it("群聊：罗列成员复选框（展示名转义 + id），发送按钮初始禁用", () => {
    const state = {
      ...initialState,
      configured: true,
      projects: [{ id: "yt", alias: "油管", members: [{ id: "alice", alias: "爱丽丝<b>" }, { id: "bob" }] }],
      roomKey: "group:yt",
    };
    const html = chatHtml(state);
    expect(html).toContain('id="composer-targets"');
    expect(html).toContain('data-target="alice"');
    expect(html).toContain("爱丽丝&lt;b&gt;");
    expect(html).toContain('data-target="bob"');
    expect(html).toMatch(/<button id="composer-send" disabled>发送<\/button>/u);
  });

  it("私聊：不出现成员复选框，发送按钮不初始禁用", () => {
    const state = {
      ...initialState,
      configured: true,
      employees: [{ id: "alice", alias: "爱丽丝", model: "faux/x" }],
      roomKey: "dm:alice",
    };
    const html = chatHtml(state);
    expect(html).not.toContain("composer-targets");
    expect(html).not.toMatch(/<button id="composer-send" disabled>/u);
  });

  it("空成员群：给出占位提示", () => {
    const state = { ...initialState, configured: true, projects: [{ id: "yt", alias: "油管", members: [] }], roomKey: "group:yt" };
    expect(chatHtml(state)).toContain("还没有成员");
  });
});

describe("授权卡片", () => {
  const request = {
    id: "pr_1", agentId: "alice", agentName: "爱丽丝<b>", roomKey: "group:yt",
    paths: ["/x/<script>"], reason: "整理素材", createdAt: "t",
  };

  it("卡片：发起人/来源/理由/路径转义、接受与拒绝按钮", () => {
    const state = { ...initialState, configured: true, projects: [{ id: "yt", alias: "演示", members: [] }], permissionRequests: [request] };
    const html = permissionCardsHtml(state);
    expect(html).toContain("授权请求");
    expect(html).toContain("爱丽丝&lt;b&gt;");
    expect(html).toContain("群聊「演示」");
    expect(html).toContain("理由：整理素材");
    expect(html).toContain("/x/&lt;script&gt;");
    expect(html).toContain('data-perm-accept="pr_1"');
    expect(html).toContain('data-perm-reject="pr_1"');
    expect(html).not.toContain("<script>");
  });

  it("处理中禁用按钮、错误行显示；私聊来源标签", () => {
    const state = {
      ...initialState,
      configured: true,
      permissionRequests: [{ ...request, roomKey: "dm:alice", busy: true, error: "写盘失败" }],
    };
    const html = permissionCardsHtml(state);
    expect(html).toMatch(/data-perm-accept="pr_1" disabled/u);
    expect(html).toContain("写盘失败");
    expect(html).toContain("私聊");
  });

  it("空列表 → 空容器", () => {
    expect(permissionCardsHtml(initialState)).toBe('<div class="perm-cards" id="perm-cards"></div>');
  });
});

describe("排队中的消息（待发队列）与「新开会话」提示", () => {
  const queued = { submissionId: "11", roomKey: "dm:a", memberId: "alice", roomMessageId: "rm_1", text: "在吗" };
  const real: RoomMessage = { convId: "c1", entryId: "5", roomKey: "dm:a", speaker: { kind: "boss" }, text: "在吗", bossDirected: false, roomMessageId: "rm_1" };

  it("还没落盘的排队消息：独立占位气泡（灰底 + 排队标识 + 撤回），不进 toolbar", () => {
    const html = messagesHtml([], "老板", [], [queued]);
    expect(html).toContain('class="msg boss queued"');
    expect(html).toContain('data-room-message="rm_1"');
    expect(html).toContain("排队中：alice");
    expect(html).toContain('data-action="unqueue"');
    expect(html).toContain("在吗");
    expect(html).not.toContain('data-action="pin"'); // 还没落盘：没有气泡工具栏
  });

  it("已有真气泡（群里只有忙的那位还在排）：排队标识贴上去，不出两个气泡", () => {
    const html = messagesHtml([real], "老板", [], [{ ...queued, memberId: "bob" }]);
    expect(html.match(/class="msg boss/g)).toHaveLength(1); // 只有一个气泡
    expect(html).toContain("排队中：bob");
    expect(html).toContain('data-action="unqueue"');
    expect(html).toContain('data-action="pin"'); // 真气泡照常有工具栏
  });

  it("同一次多投递：一条占位气泡、列出全部等待成员；不同消息按投递顺序排列", () => {
    const html = messagesHtml([], "老板", [], [queued, { ...queued, submissionId: "12", memberId: "bob" }, { ...queued, submissionId: "13", roomMessageId: "rm_2", text: "第二句" }]);
    expect(html.match(/class="msg boss queued/g)).toHaveLength(2);
    expect(html).toContain("排队中：alice、bob");
    expect(html.indexOf("在吗")).toBeLessThan(html.indexOf("第二句"));
  });

  it("chatHtml：透传排队态与「新开会话」就绪态（提示 + 按钮高亮）；成员下拉框已移除", () => {
    const base = { ...initialState, configured: true, projects: [{ id: "yt", alias: "油管", members: [{ id: "alice" }] }], roomKey: "group:yt" };
    const idle = chatHtml(base);
    expect(idle).toContain("还没有消息");
    expect(idle).not.toContain("fresh-hint");
    expect(idle).not.toContain("member-select");

    const armed = chatHtml({ ...base, freshSession: true, queued: [queued] });
    expect(armed).toContain('class="btn-new-session armed"');
    expect(armed).toContain("下一条消息将开启新会话");
    expect(armed).toContain("排队中：alice");
  });

  it("freshSessionHint：私聊 / 群聊文案区分；未就绪返回空串", () => {
    const dm = { ...initialState, roomKey: "dm:alice" };
    expect(freshSessionHint(dm)).toBe("");
    expect(freshSessionHint({ ...dm, freshSession: true })).toContain("当前会话将结束");
    expect(freshSessionHint({ ...initialState, roomKey: "group:yt", freshSession: true })).toContain("@ 到的成员各开一条");
  });
});

describe("气泡工具栏与 pin 高亮", () => {
  const employee: RoomMessage = { convId: "c1", entryId: "2", roomKey: "dm:a", speaker: { kind: "employee", id: "alice" }, text: "好", bossDirected: true };
  const other: RoomMessage = { convId: "c1", entryId: "3", roomKey: "dm:a", speaker: { kind: "employee", id: "alice" }, text: "再", bossDirected: true };

  it("每条消息带消息键与工具栏（复制 / pin），默认未 pin", () => {
    const html = messageHtml(employee);
    expect(html).toContain('data-conv-id="c1"');
    expect(html).toContain('data-entry-id="2"');
    expect(html).toContain('data-action="copy"');
    expect(html).toContain('data-action="pin"');
    expect(html).not.toContain("pinned");
  });

  it("pinned 消息：加 pinned 类名（淡红底/图钉由样式负责）", () => {
    expect(messageHtml(employee, "老板", true)).toContain('class="msg employee pinned"');
  });

  it("messagesHtml 按 pinned 集合标记对应气泡", () => {
    expect(messagesHtml([employee, other], "老板", ["c1:3"])).toContain('<div class="msg employee pinned" data-conv-id="c1" data-entry-id="3">');
    expect(messagesHtml([employee, other], "老板", [])).not.toContain("pinned");
  });

  it("chatHtml 把当前房间 pinned 集合透传给气泡", () => {
    const state = {
      ...initialState,
      configured: true,
      employees: [{ id: "alice", alias: "爱丽丝", model: "faux/x" }],
      roomKey: "dm:alice",
      messages: [{ convId: "c1", entryId: "5", roomKey: "dm:alice", speaker: { kind: "employee" as const, id: "alice" }, text: "x", bossDirected: true }],
      pinned: ["c1:5"],
    };
    expect(chatHtml(state)).toContain('class="msg employee pinned"');
  });

  it("sidebarHtml：红点 = 该房间 pin 计数", () => {
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
    expect(html).toContain('data-room="dm:alice"');
    expect(html).toContain('data-room="dm:bob"');
    expect(html).toContain('<span class="badge">1</span>');
    expect(html).toContain("爱丽丝");
    expect(html).toContain('aria-expanded="true"');

    const collapsed = sidebarHtml({ ...state, collapsedDepts: ["eng"] });
    expect(collapsed).toContain('data-toggle-dept="eng"');
    expect(collapsed).not.toContain('data-room="dm:alice"'); // 折叠后正文不渲染
    expect(collapsed).not.toContain('data-room="dm:bob"');
    expect(collapsed).toContain('aria-expanded="false"');

    const empty = sidebarHtml({
      ...initialState,
      configured: true,
      org: { path: "", name: "办公室", people: [], departments: [{ path: "eng", name: "研发", people: [], departments: [] }] },
    });
    expect(empty).toContain('data-toggle-dept="eng"');
    expect(empty).not.toContain("还没有员工");
  });

  it("sidebarHtml：无 org 数据时回落平铺（首帧不白屏）；都没有才出提示", () => {
    const flat = sidebarHtml({ ...initialState, configured: true, employees: [{ id: "alice", alias: "爱丽丝", model: "faux/x" }] });
    expect(flat).toContain('data-room="dm:alice"');
    expect(flat).toContain('data-config-scope="agent"');
    expect(flat).toContain('data-config-id="alice"');
    const empty = sidebarHtml({ ...initialState, configured: true });
    expect(empty).toContain("还没有员工");
    expect(empty).toContain("&lt;名字&gt;.agent.config.json");
  });
});

describe("会话详情 / 定义文件面板", () => {
  const dm: EmployeeSession = {
    convId: "conv_dm",
    kind: "dm",
    relationKey: "dm:alice",
    started: "2026-10-25T10:00:00+08:00",
    running: true,
    model: "faux/faux-model",
    thinkingLevel: "high",
    contextUsed: 10,
    contextWindow: 100,
  };
  const context: SessionContextView = {
    ...dm,
    instructions: "你是 alice。<系统>",
    cwd: "/office/work/alice",
    items: [
      { role: "user", text: "写个文件" },
      { role: "assistant", text: "", toolCalls: [{ name: "write", arguments: { path: "a.md", content: "<x>" } }] },
      { role: "tool", text: "ok", toolCallId: "call_1" },
      { role: "assistant", text: "完成" },
    ],
  };
  it("会话详情：只有当前这一条会话（无 Tab），系统提示词 / 工具调用全转义", () => {
    const html = sessionPanelHtml({ ...initialState, configured: true }, context);
    expect(html).toContain("会话详情（只读）");
    expect(html).toContain('id="session-panel-refresh"');
    expect(html).toContain('id="session-panel-back"');
    expect(html).not.toContain("data-agent-conv"); // Tab 切会话已移除
    expect(html).toContain("系统提示词");
    expect(html).toContain("你是 alice。&lt;系统&gt;");
    expect(html).toContain("工具调用：write");
    expect(html).toContain("&lt;x&gt;");
    expect(html).toContain("工具结果");
    expect(html).toContain("完成");
    expect(html).not.toContain("<系统>");
    // 顶部信息条的入口不在这里：详情就有「详情」按钮，不再需要面板内的会话列表
    expect(sessionInfoHtml({ ...initialState, configured: true, roomKey: "dm:alice", sessions: [{ memberId: "alice", ...dm }] })).toContain('data-session-detail="conv_dm"');
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
