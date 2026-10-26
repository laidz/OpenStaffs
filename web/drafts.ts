/**
 * 输入框草稿的本地缓存（按房间键：`dm:<员工id>` / `group:<项目id>`）。
 *
 * 纯 UI 缓存——不进 `State`、不上服务端：切会话 / 进会话详情 / 全量重画后靠它把没发出去的字填回来。
 * 只依赖 `getItem` / `setItem` / `removeItem` 三个方法（便于测试注入假 storage）。
 */

/** localStorage 的最小接口；不可用时整个 store 退化成「什么都不存」（不影响聊天）。 */
export type DraftStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

const STORAGE_KEY = "openstaffs.drafts.v1";

export type DraftStore = {
  /** 读某房间的草稿；没有 / 读坏了都是空串。 */
  load(roomKey: string): string;
  /** 保存某房间的草稿；`text.trim() === ""` = 删除该条（别把空串存成一条）。 */
  save(roomKey: string, text: string): void;
};

/** 读全部草稿：JSON 坏 / 形状不对一律当空——本地缓存不值得报错，更不该拖垮聊天。 */
function readAll(storage: DraftStorage | undefined): Record<string, string> {
  if (storage === undefined) return {};
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      // 空白草稿等于没有；顺手把手工改坏的条目（非字符串）丢掉
      if (typeof value === "string" && value.trim() !== "") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function createDraftStore(storage: DraftStorage | undefined): DraftStore {
  return {
    load(roomKey) {
      return readAll(storage)[roomKey] ?? "";
    },
    save(roomKey, text) {
      if (storage === undefined) return;
      const drafts = readAll(storage);
      const had = drafts[roomKey] !== undefined;
      if (text.trim() === "") {
        if (!had) return; // 本来就没有：不必写一次
        delete drafts[roomKey];
      } else {
        if (drafts[roomKey] === text) return; // 内容没变：不写
        drafts[roomKey] = text;
      }
      try {
        if (Object.keys(drafts).length === 0) storage.removeItem(STORAGE_KEY);
        else storage.setItem(STORAGE_KEY, JSON.stringify(drafts));
      } catch {
        // 隐私模式 / 配额满：写失败只丢草稿，绝不影响发送
      }
    },
  };
}

/** 浏览器里的草稿 store：localStorage 可能直接抛错（隐私模式 / 禁用存储）→ 退化为不缓存。 */
export function localDraftStore(): DraftStore {
  let storage: DraftStorage | undefined;
  try {
    storage = window.localStorage;
  } catch {
    storage = undefined;
  }
  return createDraftStore(storage);
}
