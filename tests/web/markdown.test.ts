import { describe, expect, it } from "vitest";
import { markdownHtml } from "../../web/markdown.ts";

describe("员工消息 Markdown 渲染", () => {
  it("行内语法：加粗、行内代码", () => {
    expect(markdownHtml("**加粗**")).toContain("<strong>加粗</strong>");
    expect(markdownHtml("`code`")).toContain("<code>code</code>");
  });

  it("块级语法：列表、围栏代码块、表格", () => {
    expect(markdownHtml("- 甲\n- 乙")).toContain("<li>甲</li>");
    expect(markdownHtml("```ts\nconst a = 1;\n```")).toContain("<pre>");
    const table = markdownHtml("| 名称 | 值 |\n| --- | --- |\n| 甲 | 1 |");
    expect(table).toContain("<table>");
    expect(table).toContain("<th>名称</th>");
  });

  it("单换行渲染为换行（breaks），符合聊天书写习惯", () => {
    const html = markdownHtml("第一行\n第二行");
    expect(html).toContain("第一行<br>");
    expect(html).toContain("第二行");
  });

  it("原始 HTML 一律转义为文本（html:false，防 XSS）", () => {
    const html = markdownHtml("<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
  });

  it("危险协议链接不产出可点的 javascript: href", () => {
    const html = markdownHtml("[点我](javascript:alert(1))");
    expect(html).not.toMatch(/href="javascript:/iu);
  });

  it("裸 URL 自动变链接（linkify）", () => {
    expect(markdownHtml("见 https://example.com/a")).toContain('<a href="https://example.com/a"');
  });

  it("流式中间态：未闭合围栏代码块按代码块渲染、不报错", () => {
    const html = markdownHtml("说明：\n\n```ts\nconst a = 1;");
    expect(html).toContain("<pre>");
    expect(html).toContain("const a = 1;");
    expect(html).toContain("说明：");
  });
});
