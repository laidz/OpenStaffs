/**
 * 会话标题的**唯一写入通道**：新建会话立即落下时间标题（兜底），命名 agent 成功后
 * 走同一个 `renameSession` 改写；老板手动改名也走它。写库 + 广播 SSE `session.title`。
 *
 * 覆盖规则由 store 的条件 UPSERT 保证（见 `TitleSource`）：飞行中的自动命名结果不会盖掉手动改名。
 */
import type { SessionRecord, SessionStore, TitleSource } from "../store/sessions.ts";
import type { Namer } from "./naming.ts";

/** 标题变更事件（广播给 UI；roomKey 用于前端过滤房间）。 */
export type TitleEvent = { roomKey: string; convId: string; title: string };

export type SessionTitleDeps = {
  store: Pick<SessionStore, "setTitle" | "get">;
  /** 广播（缺省不广播：测试 / 无 hub 场景）。 */
  notify?: (event: TitleEvent) => void;
  /** 命名器；缺省 = 自动命名不可用（只落时间标题）。 */
  namer?: Namer;
};

/** 时间缺省标题：`MM-DD HH:mm`（服务器本地时区，补零）。 */
export function fallbackTitle(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** 写标题 + 广播（广播的是落库后的**实际值**：没盖掉手动改名时前端仍显示正确标题）。 */
export function renameSession(
  deps: SessionTitleDeps,
  roomKey: string,
  convId: string,
  title: string,
  source: TitleSource,
): SessionRecord {
  const meta = deps.store.setTitle(convId, title, source);
  deps.notify?.({ roomKey, convId, title: meta.title ?? title });
  return meta;
}

/**
 * 新会话开张：**先**落时间标题（UI 从第一眼就有名字），**再**后台跑命名（不阻塞投递）。
 * 命名失败 / 不可用 → 什么都不做，时间标题就是兜底（不重试）。
 */
export function nameNewSession(
  deps: SessionTitleDeps,
  roomKey: string,
  convId: string,
  firstMessage: string,
): void {
  renameSession(deps, roomKey, convId, fallbackTitle(new Date()), "fallback");
  const namer = deps.namer;
  if (namer === undefined) return;
  void namer(firstMessage)
    .then((title) => {
      if (title === undefined || title === "") return;
      renameSession(deps, roomKey, convId, title, "auto");
    })
    .catch(() => undefined); // 命名器自己会 warn；这里只保证不产生未处理的 rejection
}
