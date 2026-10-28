import { describe, expect, test, vi } from "vitest";
import type { Models } from "@earendil-works/pi-ai/models";
import { NAMING_INPUT_MAX, NAMING_TITLE_MAX, cleanTitle, createNamer } from "../../src/app/naming.ts";

type FakeReply = { text?: string; stopReason?: string; error?: string; throw?: boolean };

/** 假 Models：getModel 给假模型对象（带 reasoning / thinkingLevelMap），completeSimple 不打网络。 */
function fakeModels(options: {
  model?: object | undefined;
  reply?: FakeReply;
  seen?: { systemPrompt?: string; user?: string }[];
  /** completeSimple 收到的第三参（sessionId 等）。 */
  optionsSeen?: { sessionId?: string }[];
}): Models {
  const model = "model" in options ? options.model : { id: "m", provider: "faux", api: "openai-completions", reasoning: false };
  return {
    getModel: () => (model === undefined ? undefined : model),
    completeSimple: async (_m: unknown, context: { systemPrompt?: string; messages: { content: string }[] }, streamOptions?: { sessionId?: string }) => {
      options.seen?.push({ systemPrompt: context.systemPrompt, user: String(context.messages[0]?.content) });
      options.optionsSeen?.push({ ...(streamOptions?.sessionId === undefined ? {} : { sessionId: streamOptions.sessionId }) });
      const reply = options.reply ?? {};
      if (reply.throw === true) throw new Error("boom");
      return {
        role: "assistant",
        content: [{ type: "text", text: reply.text ?? "标题" }],
        stopReason: reply.stopReason ?? "stop",
        ...(reply.error === undefined ? {} : { errorMessage: reply.error }),
      };
    },
  } as unknown as Models;
}

const thinkingModel = {
  id: "t", provider: "faux", api: "openai-completions", reasoning: true,
  thinkingLevelMap: { off: null, low: "low" },
};

describe("cleanTitle", () => {
  test("去包裹符号与结尾标点", () => {
    expect(cleanTitle("「帮我修复登录 Bug。」")).toBe("帮我修复登录 Bug");
  });

  test("取第一行、去「标题：」前缀", () => {
    expect(cleanTitle("标题：部署流程梳理\n第二行不要")).toBe("部署流程梳理");
  });

  test("纯空白 → 空串（调用方视为失败）", () => {
    expect(cleanTitle("   \n \n")).toBe("");
  });

  test("超长截断到上限（按字符计，含省略号）", () => {
    const title = cleanTitle("很长".repeat(40));
    expect([...title].length).toBeLessThanOrEqual(NAMING_TITLE_MAX);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("createNamer", () => {
  test("非思考模型 + 合法引用 → 可用的 namer；只注入命名 prompt", async () => {
    const seen: { systemPrompt?: string; user?: string }[] = [];
    const namer = createNamer({ models: fakeModels({ seen }), namingModel: "faux/m" });
    expect(namer).toBeTypeOf("function");
    await expect(namer!("帮我看看登录为什么 500")).resolves.toBe("标题");
    expect(seen[0]?.systemPrompt).toContain("起标题");
    expect(seen[0]?.user).toBe("帮我看看登录为什么 500");
  });

  test("未指定 namingModel → 不可用（返回 undefined）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(createNamer({ models: fakeModels({}), namingModel: undefined })).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  test("模型引用格式非法 → 不可用", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(createNamer({ models: fakeModels({}), namingModel: "not-a-ref" })).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  test("模型目录查不到 → fail closed（不可用）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(createNamer({ models: fakeModels({ model: undefined }), namingModel: "faux/m" })).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  test("思考模型也可用（已取消「必须非思考模型」限制）", async () => {
    const namer = createNamer({ models: fakeModels({ model: thinkingModel }), namingModel: "faux/m" });
    expect(namer).toBeTypeOf("function");
    await expect(namer!("帮我看看登录")).resolves.toBe("标题");
  });

  test("抛错 / 非 stop 结束 / 空标题 → undefined（失败不重试）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const throwing = createNamer({ models: fakeModels({ reply: { throw: true } }), namingModel: "faux/m" })!;
      await expect(throwing("你好")).resolves.toBeUndefined();
      const aborted = createNamer({ models: fakeModels({ reply: { stopReason: "aborted" } }), namingModel: "faux/m" })!;
      await expect(aborted("你好")).resolves.toBeUndefined();
      const blank = createNamer({ models: fakeModels({ reply: { text: "   " } }), namingModel: "faux/m" })!;
      await expect(blank("你好")).resolves.toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  test("completeSimple 必须带 sessionId（opencode-go 的 x-opencode-session 头来源，缺了会 400）", async () => {
    const optionsSeen: { sessionId?: string }[] = [];
    const namer = createNamer({ models: fakeModels({ optionsSeen }), namingModel: "faux/m" })!;
    await namer!("你好");
    expect(optionsSeen[0]?.sessionId).toBeTruthy();
  });

  test("失败日志带 errorMessage（便于定位供应商 400，而不是只看到 error）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const namer = createNamer({
        models: fakeModels({ reply: { stopReason: "error", error: "400: MissingSessionID" } }),
        namingModel: "faux/m",
      })!;
      await expect(namer("你好")).resolves.toBeUndefined();
      expect(warn.mock.calls.flat().join(" ")).toContain("MissingSessionID");
    } finally {
      warn.mockRestore();
    }
  });

  test("首条消息超长 → 截断到 NAMING_INPUT_MAX 再喂模型", async () => {
    const seen: { systemPrompt?: string; user?: string }[] = [];
    const namer = createNamer({ models: fakeModels({ seen }), namingModel: "faux/m" })!;
    await namer("字".repeat(100_000));
    expect(seen[0]?.user?.length).toBe(NAMING_INPUT_MAX);
  });
});
