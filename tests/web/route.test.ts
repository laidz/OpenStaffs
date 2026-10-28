import { describe, expect, it } from "vitest";
import { parseRoute, routeUrl, type Route } from "../../web/route.ts";

describe("Web 路由（URL ↔ 视图）", () => {
  it("空路由 / 会议 / 主题", () => {
    expect(parseRoute("")).toEqual({});
    expect(parseRoute("?meeting=mtg_1")).toEqual({ view: "meeting", meetingId: "mtg_1" });
    expect(parseRoute("?subject=dm%3Aalice")).toEqual({ view: "subject", subjectKey: "dm:alice" });
    expect(parseRoute("?subject=group%3Ayt")).toEqual({ view: "subject", subjectKey: "group:yt" });
  });

  it("历史页：?view=history&subject=…（独立视图）", () => {
    expect(parseRoute("?view=history&subject=group%3Ayt")).toEqual({ view: "history", subjectKey: "group:yt" });
    expect(parseRoute("?view=history")).toEqual({ view: "history" });
    // history 优先于 meeting/subject（手改 URL 也以历史页为准）
    expect(parseRoute("?view=history&subject=dm%3Aalice&meeting=mtg_1")).toEqual({ view: "history", subjectKey: "dm:alice" });
  });

  it("routeUrl 与 parseRoute 互逆；空路由返回空串", () => {
    const routes: Route[] = [
      {},
      { view: "meeting" as const, meetingId: "mtg_1" },
      { view: "subject" as const, subjectKey: "dm:alice" },
      { view: "history" as const, subjectKey: "group:yt" },
      { view: "history" as const },
    ];
    for (const route of routes) {
      expect(parseRoute(routeUrl(route))).toEqual(route);
    }
    expect(routeUrl({})).toBe("");
  });
});
