import { describe, expect, it } from "vitest";
import { chatHtml, liveHtml, messageHtml, messagesHtml, setupPage } from "../../web/render.ts";
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
