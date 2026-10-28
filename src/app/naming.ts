/**
 * 会话自动命名 agent：**只加载一个 prompt**（`src/prompts/naming.md`），
 * 不装配环境段 / 会话前缀 / 记忆 / 技能——直接调模型，不新开 Pi 会话（无残留、易测）。
 *
 * 模型由空间配置 `namingModel` 指定；未指定 / 引用非法 / 模型目录查不到 = 自动命名不可用。
 * 失败一律不重试：调用方保留「时间标题」兜底。
 */
import { randomUUID } from "node:crypto";
import type { Models } from "@earendil-works/pi-ai/models";
import { SYSTEM_PROMPT_TEMPLATES } from "../capabilities/system-prompt.ts";
import { parseModelRef } from "../domain/config.ts";

/** 首条消息喂给命名模型的字数上限（标题只需要「在说什么」）。 */
export const NAMING_INPUT_MAX = 500;
/** 清洗后标题的字数上限。 */
export const NAMING_TITLE_MAX = 20;
/** 命名请求超时：超时即失败（不重试）。 */
export const NAMING_TIMEOUT_MS = 20_000;

/** 命名器：返回 undefined = 失败（调用方保留兜底标题）。 */
export type Namer = (firstMessage: string) => Promise<string | undefined>;

const WRAP_PAIRS: readonly (readonly [string, string])[] = [
  ["「", "」"], ["『", "』"], ['"', '"'], ["'", "'"], ["《", "》"], ["“", "”"], ["‘", "’"],
];

/**
 * 模型输出 → 可用标题（"" = 不可用）：
 * 第一行非空 → 去 `标题:` 前缀 → 去包裹符号 → 折叠空白 → 去结尾标点 → 截断到上限。
 */
export function cleanTitle(raw: string): string {
  const firstLine = raw.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";
  let text = firstLine.replace(/^(标题|title)\s*[:：]\s*/iu, "").trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [head, tail] of WRAP_PAIRS) {
      if (text.length > head.length + tail.length && text.startsWith(head) && text.endsWith(tail)) {
        text = text.slice(head.length, text.length - tail.length).trim();
        changed = true;
      }
    }
  }
  text = text.replace(/\s+/gu, " ").trim();
  text = text.replace(/[。，,.;；!！?？~～]+$/u, "").trim();
  const chars = [...text];
  if (chars.length > NAMING_TITLE_MAX) {
    return `${chars.slice(0, NAMING_TITLE_MAX - 1).join("")}…`;
  }
  return text;
}

/**
 * 造一个命名器；返回 undefined = 自动命名不可用（未配置 / 引用非法 / 模型目录查不到）。
 * 原因会打一条 warn，方便老板在启动日志里一眼看到。
 *
 * 说明：**不限制模型是否支持思考档**（曾经要求「必须是非思考模型」，按老板口径取消）。
 * 调用走 `completeSimple` 且不传思考档 → 用模型自己的默认行为。
 */
export function createNamer(options: { models: Models; namingModel?: string }): Namer | undefined {
  const ref = options.namingModel === undefined ? undefined : parseModelRef(options.namingModel);
  if (ref === undefined) {
    console.warn(
      options.namingModel === undefined
        ? "[openstaffs] 自动命名不可用：空间配置 space.config.json 未指定 namingModel（会话只会有时间标题）"
        : `[openstaffs] 自动命名不可用：namingModel 写法非法（${options.namingModel}），应为「供应商/模型 id」`,
    );
    return undefined;
  }
  const model = options.models.getModel(ref.provider, ref.modelId);
  if (model === undefined) {
    console.warn(
      `[openstaffs] 自动命名不可用：模型目录查不到 ${options.namingModel}（供应商是否已配密钥？）`,
    );
    return undefined;
  }
  // opencode-go 要求每个请求带 `x-opencode-session`（由 pi-ai 从 sessionId 生成）：
  // 缺了会直接 400 MissingSessionID——命名请求不走会话，必须自己给一个稳定 id。
  const sessionId = `openstaffs-naming-${randomUUID()}`;
  return async (firstMessage: string): Promise<string | undefined> => {
    const input = [...firstMessage].slice(0, NAMING_INPUT_MAX).join("");
    try {
      const timeout = new Promise<undefined>((resolve) => {
        const timer = setTimeout(() => resolve(undefined), NAMING_TIMEOUT_MS);
        timer.unref?.();
      });
      const answer = await Promise.race([
        options.models.completeSimple(
          model,
          {
            systemPrompt: SYSTEM_PROMPT_TEMPLATES.naming,
            messages: [{ role: "user", content: input, timestamp: Date.now() }],
          },
          { sessionId },
        ),
        timeout,
      ]);
      if (answer === undefined) {
        console.warn("[openstaffs] 会话命名失败：超时（保留时间标题，不重试）");
        return undefined;
      }
      if (answer.stopReason !== "stop") {
        // 带 errorMessage：供应商 400 / 鉴权等问题只看 stopReason=error 无法定位。
        const detail = answer.errorMessage === undefined || answer.errorMessage === "" ? "" : `：${answer.errorMessage}`;
        console.warn(`[openstaffs] 会话命名失败：模型未正常结束（${answer.stopReason}${detail}）`);
        return undefined;
      }
      const text = answer.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
      const title = cleanTitle(text);
      if (title === "") {
        console.warn("[openstaffs] 会话命名失败：模型没给出可用标题");
        return undefined;
      }
      return title;
    } catch (error) {
      console.warn(`[openstaffs] 会话命名失败：${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };
}
