// src/tools/memory.ts —— 记忆工具：员工只通过工具读写自己的 `work/<id>/memory/`。
import { Type } from "typebox";
import { loadEmployee } from "../domain/employee.ts";
import {
  createEntity, findEntity, loadMemory, readProfile, readState, removeEntity, touch, updateEntity, writeProfile,
} from "../domain/memory/store.ts";
import { buildIndex, renderEntry } from "../domain/memory/view.ts";
import { DESC_MAX, PROFILE_MAX_BYTES, TITLE_MAX } from "../domain/memory/types.ts";
import type { ToolContext, ToolDef } from "./registry.ts";

/** 统一开关闸门：关闭时不注入，工具也不可用（数据保留）。 */
function requireEnabled(ctx: ToolContext): void {
  if (!loadEmployee(ctx.ws, ctx.selfId).memoryEnabled) {
    throw new Error("记忆未启用：请在员工或空间配置里把 memory 设为 true");
  }
}

const memoryList: ToolDef = {
  name: "memory_list",
  description:
    "列出你的记忆索引（只有标题与简介，不含正文）。先 list / query 找到相关条目，再用 memory_get 取正文。include_stale 可连已过期（不再自动注入）的记忆一起看。",
  parameters: Type.Object({
    query: Type.Optional(Type.String({ description: "关键词（大小写不敏感，匹配 id / 标题 / 简介）" })),
    include_stale: Type.Optional(Type.Boolean({ description: "true = 连已过期的记忆一起列（缺省只看未过期）" })),
  }),
  async run(args, ctx) {
    requireEnabled(ctx);
    const { entities, errors } = loadMemory(ctx.ws, ctx.selfId);
    const index = buildIndex(entities, readState(ctx.ws, ctx.selfId), undefined, {
      includeEvicted: args["include_stale"] === true,
      cap: false,
    });
    const query = typeof args["query"] === "string" ? args["query"].trim().toLowerCase() : "";
    const hits =
      query === ""
        ? index.entries
        : index.entries.filter((entry) => `${entry.id} ${entry.title} ${entry.description}`.toLowerCase().includes(query));
    const lines = hits.map(renderEntry);
    if (errors.length > 0) {
      lines.push("", `（${errors.length} 个记忆文件格式有误，已跳过：${errors.map((error) => error.file).join("、")}）`);
    }
    return lines.length === 0 ? "（暂无记忆）" : lines.join("\n");
  },
};

const memoryGet: ToolDef = {
  name: "memory_get",
  description:
    "取一条记忆的正文。取用会续期（即使已过期，取到即回到索引）。找 id 先用 memory_list / memory_list(query)。",
  parameters: Type.Object({ id: Type.String({ description: "记忆 id（memory_list 里每条开头的那个）" }) }),
  async run(args, ctx) {
    requireEnabled(ctx);
    const id = String(args["id"]).trim();
    const entity = findEntity(ctx.ws, ctx.selfId, id);
    if (entity === undefined) throw new Error(`找不到记忆：${id}`);
    touch(ctx.ws, ctx.selfId, entity.id);
    return [`记忆：${entity.id} · ${entity.title}`, `简介：${entity.description}`, "", entity.body].join("\n");
  },
};

const memoryAdd: ToolDef = {
  name: "memory_add",
  description:
    "新建一条普通记忆（只注入标题 + 简介，正文按需取）。适合长期有用的经验、结论、口径、事实；不要把流水账写进来。id 由标题生成。",
  parameters: Type.Object({
    title: Type.String({ description: `标题（单行，≤ ${TITLE_MAX} 字）` }),
    description: Type.String({ description: `简介：是什么 + 什么时候该用（单行，≤ ${DESC_MAX} 字）` }),
    body: Type.String({ description: "正文（Markdown）" }),
    pinned: Type.Optional(Type.Boolean({ description: "true = 置顶且永不自动遗忘；只给真正长期重要的记忆" })),
  }),
  async run(args, ctx) {
    requireEnabled(ctx);
    const entity = createEntity(ctx.ws, ctx.selfId, {
      title: String(args["title"]),
      description: String(args["description"]),
      body: String(args["body"]),
      ...(typeof args["pinned"] === "boolean" ? { pinned: args["pinned"] } : {}),
    });
    return `已保存记忆：${entity.id}（正文用 memory_get ${entity.id} 查看）`;
  },
};

const memoryUpdate: ToolDef = {
  name: "memory_update",
  description:
    "修改一条已有记忆：改标题 / 简介、整篇替换或追加正文、置顶 / 取消置顶。至少给一个变更项；body 与 append 不能同时用。",
  parameters: Type.Object({
    id: Type.String({ description: "记忆 id" }),
    title: Type.Optional(Type.String({ description: `新标题（单行，≤ ${TITLE_MAX} 字）` })),
    description: Type.Optional(Type.String({ description: `新简介（单行，≤ ${DESC_MAX} 字）` })),
    body: Type.Optional(Type.String({ description: "整篇替换正文" })),
    append: Type.Optional(Type.String({ description: "追加到正文末尾（与 body 互斥）" })),
    pinned: Type.Optional(Type.Boolean({ description: "true = 置顶；false = 取消置顶" })),
  }),
  async run(args, ctx) {
    requireEnabled(ctx);
    const patch = {
      ...(typeof args["title"] === "string" ? { title: args["title"] } : {}),
      ...(typeof args["description"] === "string" ? { description: args["description"] } : {}),
      ...(typeof args["body"] === "string" ? { body: args["body"] } : {}),
      ...(typeof args["append"] === "string" ? { append: args["append"] } : {}),
      ...(typeof args["pinned"] === "boolean" ? { pinned: args["pinned"] } : {}),
    };
    if (Object.keys(patch).length === 0) {
      throw new Error("没有要更新的内容：至少给 title / description / body / append / pinned 之一");
    }
    updateEntity(ctx.ws, ctx.selfId, String(args["id"]), patch);
    return `已更新记忆：${String(args["id"])}`;
  },
};

const memoryRemove: ToolDef = {
  name: "memory_remove",
  description: "删除一条记忆（归档，不物理销毁）。置顶的记忆要先取消置顶（memory_update pinned: false）再删。",
  parameters: Type.Object({ id: Type.String({ description: "记忆 id" }) }),
  async run(args, ctx) {
    requireEnabled(ctx);
    const id = String(args["id"]).trim();
    removeEntity(ctx.ws, ctx.selfId, id);
    return `已归档记忆：${id}`;
  },
};

const memoryProfile: ToolDef = {
  name: "memory_profile",
  description:
    `常驻记忆（profile）：每次新会话全文注入，只放身份、职责、当前重点和硬规则。action = show 看当前内容；action = set 整体重写（正文 ≤ ${PROFILE_MAX_BYTES} 字节，不能追加）。细节请拆到普通记忆。`,
  parameters: Type.Object({
    action: Type.Union([Type.Literal("show"), Type.Literal("set")], { description: "show = 查看；set = 整体重写" }),
    body: Type.Optional(Type.String({ description: `set 时必填：profile 正文（≤ ${PROFILE_MAX_BYTES} 字节）` })),
  }),
  async run(args, ctx) {
    requireEnabled(ctx);
    if (args["action"] === "show") {
      const profile = readProfile(ctx.ws, ctx.selfId);
      return profile === "" ? "（还没有 profile）" : profile;
    }
    if (typeof args["body"] !== "string") throw new Error("set 需要 body：profile 正文");
    const bytes = writeProfile(ctx.ws, ctx.selfId, args["body"]);
    return `已写入 profile（${bytes} / ${PROFILE_MAX_BYTES} 字节）`;
  },
};

export const memoryTools: readonly ToolDef[] = [
  memoryList,
  memoryGet,
  memoryAdd,
  memoryUpdate,
  memoryRemove,
  memoryProfile,
];
