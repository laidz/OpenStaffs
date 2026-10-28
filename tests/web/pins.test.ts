import { describe, expect, it } from "vitest";
import { sidebarHtml } from "../../web/render.ts";
import { initialState, reduce, type State } from "../../web/state.ts";
import type { MeetingView } from "../../src/app/meetings.ts";

const meeting: MeetingView = {
  meetingId: "m1",
  kind: "dm",
  subjectId: "staff0",
  subjectLabel: "0 号员工",
  participants: ["staff0"],
  createdAt: "2026-10-26T00:00:00.000Z",
};

/** 进入某主题的当前会议（subject 事件 + meeting 事件，与真实首屏流程同序）。 */
function inMeeting(): State {
  const state = reduce(initialState, {
    type: "subject",
    subjectKey: "dm:staff0",
    current: meeting,
    meetings: [meeting],
  });
  return reduce(state, { type: "meeting", meetingId: "m1", meeting, messages: [], pinned: [] });
}

describe("侧栏红点（pins）", () => {
  it("pins 事件：服务端按主题键返回红点，状态照存且侧栏能渲染", () => {
    const state = reduce(
      { ...inMeeting(), employees: [{ id: "staff0", alias: "0 号员工", model: "faux/x" }] },
      { type: "pins", pins: { total: 1, subjects: { "dm:staff0": 1 } } },
    );
    expect(state.pins).toEqual({ "dm:staff0": 1 });
    // 回归：曾把服务端的 subjects 读成 meetings → pins 变 undefined，侧栏索引时抛
    // 「Cannot read properties of undefined (reading 'dm:staff0')」，整页显示「服务不可用」。
    expect(() => sidebarHtml(state)).not.toThrow();
    expect(sidebarHtml(state)).toContain('<span class="badge">1</span>');
  });

  it("pin 事件：按主题更新红点，不写会议 id 键", () => {
    let state = inMeeting();
    state = reduce(state, { type: "pin", meetingId: "m1", key: "store:1", pinned: true });
    expect(state.pinned).toEqual(["store:1"]);
    expect(state.pins).toEqual({ "dm:staff0": 1 });
    expect(state.pins).not.toHaveProperty("m1");

    state = reduce(state, { type: "pin", meetingId: "m1", key: "store:1", pinned: false });
    expect(state.pinned).toEqual([]);
    expect(state.pins).toEqual({ "dm:staff0": 0 });
  });

  it("meeting.pins（SSE）：只更新当前会议所属主题，别的会议忽略", () => {
    const state = inMeeting();
    const updated = reduce(state, { type: "sse", event: { type: "meeting.pins", meetingId: "m1", count: 3 } });
    expect(updated.pins).toEqual({ "dm:staff0": 3 });
    expect(updated.pins).not.toHaveProperty("m1");

    const other = reduce(state, { type: "sse", event: { type: "meeting.pins", meetingId: "m9", count: 3 } });
    expect(other).toBe(state);
  });
});
