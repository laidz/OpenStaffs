import MarkdownIt from "markdown-it";

/**
 * 员工消息的 Markdown 渲染（纯 UI 层；老板消息不走这里，保持原样展示）。
 * - html:false：原始 HTML 一律转义为文本，员工输出无法注入标签（防 XSS）；
 * - breaks:true：单个换行渲染为换行，符合聊天场景的书写习惯；
 * - linkify:true：裸 URL 自动变可点链接。
 */
const md = new MarkdownIt({ html: false, breaks: true, linkify: true });

export function markdownHtml(text: string): string {
  return md.render(text);
}
