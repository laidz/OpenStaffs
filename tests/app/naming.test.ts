import { describe, expect, test, vi } from "vitest";
import type { Models } from "@earendil-works/pi-ai/models";
import { NAMING_INPUT_MAX, NAMING_TITLE_MAX, cleanTitle, createNamer } from "../../src/app/naming.ts";

type FakeReply = { text?: string; stopReason?: string; throw?: boolean };

/** 假 Models：getModel 给假模型对象（带 reasoning / thinkingLevelMap），completeSimple 不打网络。 */
function fakeModels(options: {
  model?: object | undefined;
  reply?: FakeReply;
  seen?: { systemPrompt?: string; user?: string }[];
}): Models {
  const model = "model" in options ? options.model : { id: "m", provider: "faux", api: "openai-completions", reasoning: false };
  return {
    getModel: () => (model === undefined ? undefined : model),
    completeSimple: async (_m: unknown, context: { systemPrompt?: string; messages: { content: string }[] }) => {
      options.seen?.push({ systemPrompt: context.systemPrompt, user: String(context.messages[0]?.content) });
      const reply = options.reply ?? {};
      if (reply.throw === true) throw new Error("boom");
      return {
        role: "assistant",
        content: [{ type: "text", text: reply.text ?? "标题" }],
        stopReason: reply.stopReason ?? "stop",
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

  test("是思考模型 → 不可用（只允许非思考模型）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(createNamer({ models: fakeModels({ model: thinkingModel }), namingModel: "faux/m" })).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
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

  test("首条消息超长 → 截断到 NAMING_INPUT_MAX 再喂模型", async () => {
    const seen: { systemPrompt?: string; user?: string }[] = [];
    const namer = createNamer({ models: fakeModels({ seen }), namingModel: "faux/m" })!;
    await namer("字".repeat(100_000));
    expect(seen[0]?.user?.length).toBe(NAMING_INPUT_MAX);
  });
});
