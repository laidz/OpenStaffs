import { describe, expect, it } from "vitest";
import { memSlug, nowIso, parseFrontmatter, serializeEntity, validateMeta } from "../../../src/domain/memory/frontmatter.ts";
import { DESC_MAX, TITLE_MAX, type MemMeta } from "../../../src/domain/memory/types.ts";

const meta: MemMeta = {
  id: "vip-policy",
  title: "VIP 口径",
  description: "谈 VIP 时先看",
  pinned: false,
  created: "2026-10-25T10:00:00+08:00",
  updated: "2026-10-25T10:00:00+08:00",
};

describe("frontmatter", () => {
  it("序列化后能原样解析回来", () => {
    const parsed = parseFrontmatter(serializeEntity(meta, "正文第一行\n第二行"));
    expect(parsed.error).toBeUndefined();
    expect(parsed.meta).toEqual(meta);
    expect(parsed.body).toBe("正文第一行\n第二行");
  });

  it("pinned 只认 true", () => {
    const yes = parseFrontmatter(["---", "id: a", "title: t", "description: d", "pinned: true", "---", "", "x"].join("\n"));
    expect(yes.meta?.pinned).toBe(true);
    const no = parseFrontmatter(["---", "id: a", "title: t", "description: d", "pinned: yes", "---", "", "x"].join("\n"));
    expect(no.meta?.pinned).toBe(false);
  });

  it("缺 frontmatter / 未闭合 / 坏行 → error", () => {
    expect(parseFrontmatter("没有头").error).toContain("缺少 frontmatter");
    expect(parseFrontmatter("---\nid: a").error).toContain("未闭合");
    expect(parseFrontmatter("---\n坏行\n---\n").error).toContain("格式错误");
  });

  it("校验 id 一致与标题/简介长度", () => {
    expect(validateMeta(meta, "vip-policy")).toEqual([]);
    expect(validateMeta({ ...meta, id: "other" }, "vip-policy")[0]).toContain("不一致");
    expect(validateMeta({ ...meta, title: "字".repeat(TITLE_MAX + 1) }, "vip-policy")[0]).toContain("title 超过");
    expect(validateMeta({ ...meta, description: "字".repeat(DESC_MAX + 1) }, "vip-policy")[0]).toContain("description 超过");
  });

  it("标题 / 简介不能含换行或控制字符", () => {
    expect(validateMeta({ ...meta, title: "第一行\n第二行" }, "vip-policy")[0]).toContain("不能包含换行");
    expect(validateMeta({ ...meta, description: "a\tb" }, "vip-policy")[0]).toContain("不能包含换行");
  });

  it("memSlug 保留中文、折叠符号、限长", () => {
    expect(memSlug("VIP 客户 口径")).toBe("vip-客户-口径");
    expect(memSlug("  --你好!!  ")).toBe("你好");
    expect(memSlug("字".repeat(60))).toHaveLength(40);
  });

  it("nowIso 是本地时区秒级 ISO", () => {
    expect(nowIso(new Date("2026-10-25T02:03:04Z"))).toMatch(/^2026-10-25T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  });
});
