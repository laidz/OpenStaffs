import { describe, expect, it } from "vitest";
import { chatHtml, liveHtml, messageHtml, messagesHtml, permissionCardsHtml, setupPage, sidebarHtml } from "../../web/render.ts";
import { initialState } from "../../web/state.ts";
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
