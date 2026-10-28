/**
 * Web 路由（URL ↔ 视图）。聊天与历史都在同一个 SPA 里，靠 URL 决定当前视图：
 * - `?meeting=<id>`：某场会议（可发送 / 继续聊）；
 * - `?subject=<dm:x | group:y>`：该主题（有最新会议就进它，没有就等第一条消息）；
 * - `?view=history&subject=<key>`：该主题的历史会议列表（可刷新 / 前进后退）；
 * - 无参数：上次看到的会议 / 主题，否则第一个。
 */
export type Route =
  | { view: "history"; subjectKey?: string }
  | { view: "meeting"; meetingId: string }
  | { view: "subject"; subjectKey: string }
  | Record<string, never>;

/** URLSearchParams → 路由。`view=history` 优先于 meeting/subject（历史页是独立视图）。 */
export function parseRoute(search: string): Route {
  const params = new URLSearchParams(search);
  const subjectKey = params.get("subject");
  if (params.get("view") === "history") {
    return { view: "history", ...(subjectKey === null || subjectKey === "" ? {} : { subjectKey }) };
  }
  const meetingId = params.get("meeting");
  if (meetingId !== null && meetingId !== "") return { view: "meeting", meetingId };
  if (subjectKey !== null && subjectKey !== "") return { view: "subject", subjectKey };
  return {};
}

/** 路由 → 查询串（`?…`；空路由 = 当前路径）。 */
export function routeUrl(route: Route): string {
  if ("view" in route && route.view === "history") {
    const subject = route.subjectKey === undefined ? "" : `&subject=${encodeURIComponent(route.subjectKey)}`;
    return `?view=history${subject}`;
  }
  if ("meetingId" in route) return `?meeting=${encodeURIComponent(route.meetingId)}`;
  if ("subjectKey" in route && route.subjectKey !== undefined) return `?subject=${encodeURIComponent(route.subjectKey)}`;
  return "";
}
