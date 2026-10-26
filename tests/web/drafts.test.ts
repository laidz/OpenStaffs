import { describe, expect, it } from "vitest";
import { createDraftStore, type DraftStorage } from "../../web/drafts.ts";

/** 假 localStorage：只实现草稿 store 用到的那三个方法。 */
function fakeStorage(initial: Record<string, string> = {}): DraftStorage & { readonly map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

describe("输入框草稿的本地缓存", () => {
  it("按房间键各自保存 / 读取（切会话不串台，多行与中文原样保留）", () => {
    const store = createDraftStore(fakeStorage());
    store.save("dm:alice", "第一行\n第二行");
    store.save("group:yt", "@alice 在吗");

    expect(store.load("dm:alice")).toBe("第一行\n第二行");
    expect(store.load("group:yt")).toBe("@alice 在吗");
    expect(store.load("dm:bob")).toBe("");
  });

  it("空白内容 = 删除该条（别把空串 / 纯空格存成草稿）", () => {
    const storage = fakeStorage();
    const store = createDraftStore(storage);
    store.save("dm:alice", "没发出去的话");
    expect(store.load("dm:alice")).toBe("没发出去的话");

    store.save("dm:alice", "   \n ");
    expect(store.load("dm:alice")).toBe("");
    expect(storage.map.size).toBe(0); // 全空了就连 key 一起清掉
  });

  it("损坏的 JSON / 形状不对 / 非字符串条目：一律当空，不抛错", () => {
    const broken = createDraftStore(fakeStorage({ "openstaffs.drafts.v1": "{不是 JSON" }));
    expect(broken.load("dm:alice")).toBe("");

    const array = createDraftStore(fakeStorage({ "openstaffs.drafts.v1": "[1,2]" }));
    expect(array.load("dm:alice")).toBe("");

    const wrongShape = createDraftStore(fakeStorage({ "openstaffs.drafts.v1": '{"dm:alice":1,"dm:bob":"好"}' }));
    expect(wrongShape.load("dm:alice")).toBe("");
    expect(wrongShape.load("dm:bob")).toBe("好");

    // 坏数据上继续写：能正常覆盖成合法结构
    wrongShape.save("dm:carol", "继续");
    expect(wrongShape.load("dm:carol")).toBe("继续");
  });

  it("storage 不可用（隐私模式）时退化成不缓存，调用方无感", () => {
    const store = createDraftStore(undefined);
    expect(() => store.save("dm:alice", "写不进去")).not.toThrow();
    expect(store.load("dm:alice")).toBe("");
  });

  it("写入失败（配额满 / 禁用存储）不抛错：草稿丢了也不影响发送", () => {
    const store = createDraftStore({
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
    });
    expect(() => store.save("dm:alice", "试试")).not.toThrow();
    expect(store.load("dm:alice")).toBe(""); // 读侧自己也没存上 → 空
  });
});
