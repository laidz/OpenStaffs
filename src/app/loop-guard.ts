/**
 * 模型输出重复循环检测（防御性护栏）。
 *
 * 真实事故：opencode-go / deepseek-v4.1-flash 在一轮「准备发多个工具调用」时卡死，
 * 正文反复输出「Emit. / Output. / 现在.」直到 19KB（57 秒），既污染历史、又触发不了工具。
 * 这不是 prompt 能完全约束的模型退化，运行时必须在**流式阶段**识别并中止、在**落库阶段**兜底丢弃。
 *
 * 判定口径保守：只看最后 200 行非空文本里**同一行**的重复次数；重复行要够多（≥25 次）
 * 且占窗口比例够高（≥25%），避免把正常日志 / 表格里的分隔线误判成循环。
 */
export function looksDegenerate(text: string): boolean {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length >= 4);
  if (lines.length < 30) return false;
  const window = lines.slice(-200);
  const counts = new Map<string, number>();
  let max = 0;
  for (const line of window) {
    const count = (counts.get(line) ?? 0) + 1;
    counts.set(line, count);
    if (count > max) max = count;
  }
  return max >= 25 && max / window.length >= 0.25;
}
