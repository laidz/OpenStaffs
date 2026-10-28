import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import path from "node:path";
import { createModels, getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai/models";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import {
  AssistantEntry, Harness, watchEvents, createRegistry,
  type AgentEvent as PiAgentEvent, type Conversation, type ConversationId, type EntryRecord, type Extension,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import type { Message } from "@earendil-works/pi-ai";
import { createAccessExtension } from "./access-extension.ts";
import { WriteGuard } from "./write-guard.ts";
import type { AccessContext } from "../domain/access-control.ts";
import type { Relation } from "../domain/types.ts";
import type { ChatMessage, ContextItem, HarnessEvent, HarnessPort, PostEntry, SessionContext } from "./port.ts";

export type PiHarnessOptions = {
  root: string;
  sqlitePath: string;
  models?: Models;
  /** 额外安装的扩展（如 OpenStaffs 自有工具）。 */
  extensions?: readonly Extension[];
  /** MCP 扩展：安装但不默认选中，由会话的 mcpExtensions 选择。 */
  mcpExtensions?: readonly Extension[];
  /** 工具较多时安装并默认选中 tool_search。 */
  toolSearch?: boolean;
};

/** 会话归属的登记表（「我是谁、我在哪个房间」）：只由 startSession / attach / bindSession 写入，**不从 cwd 推断**。
 *  群聊与私聊共用员工工作目录（D25/D27：项目没有工作目录），cwd 分不出房间，猜就是串台。 */

function textOf(message: Message | undefined): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => (block && block.type === "text" ? [String(block.text ?? "")] : []))
    .join("")
    .trim();
}

/** 一条模型消息 → 上下文条目（保留工具调用 / 思考 / 工具结果）。 */
function toContextItem(message: Message, kind?: string): ContextItem | undefined {
  const rawRole = (message as { role?: unknown }).role;
  const role = rawRole === "toolResult" ? "tool" : rawRole;
  if (role !== "user" && role !== "assistant" && role !== "tool") return undefined;
  const text = textOf(message);
  // 每条消息自带毫秒时间戳：转成 ISO 带下去，前端按浏览器本地时区展示
  const timestamp = (message as { timestamp?: unknown }).timestamp;
  const at = typeof timestamp === "number" && Number.isFinite(timestamp) ? { at: new Date(timestamp).toISOString() } : {};
  if (role === "assistant") {
    const blocks = Array.isArray((message as { content?: unknown }).content)
      ? ((message as { content: unknown[] }).content)
      : [];
    const thinking = blocks
      .flatMap((block) => (block && (block as { type?: unknown }).type === "thinking" ? [String((block as { thinking?: unknown }).thinking ?? "")] : []))
      .join("\n")
      .trim();
    const toolCalls = blocks.flatMap((block) => {
      if (!block || (block as { type?: unknown }).type !== "toolCall") return [];
      const call = block as { id?: unknown; name?: unknown; arguments?: unknown };
      // id 要留着：会话详情里用它把「调用」和「结果」配成一条（UI 不再分成两源）
      return [{ ...(typeof call.id === "string" ? { id: call.id } : {}), name: String(call.name ?? ""), arguments: call.arguments ?? {} }];
    });
    return {
      role: "assistant",
      text,
      ...at,
      ...(kind === undefined ? {} : { kind }),
      ...(thinking === "" ? {} : { thinking }),
      ...(toolCalls.length === 0 ? {} : { toolCalls }),
    };
  }
  if (role === "tool") {
    const toolCallId = (message as { toolCallId?: unknown }).toolCallId;
    const toolName = (message as { toolName?: unknown }).toolName;
    const isError = (message as { isError?: unknown }).isError;
    return {
      role: "tool",
      text,
      ...at,
      ...(kind === undefined ? {} : { kind }),
      ...(typeof toolCallId === "string" ? { toolCallId } : {}),
      ...(typeof toolName === "string" ? { toolName } : {}),
      ...(isError === true ? { isError: true } : {}),
    };
  }
  return { role: "user", text, ...at, ...(kind === undefined ? {} : { kind }) };
}

/** entry → 单条聊天消息（只认 user/assistant；工具结果等跳过）。 */
function entryToChatMessage(entry: EntryRecord): ChatMessage | undefined {
  for (const message of entry.model ?? []) {
    const role = (message as { role?: unknown }).role;
    if (role !== "user" && role !== "assistant") continue;
    const body = textOf(message);
    if (body === "") continue;
    return {
      id: String(entry.id),
      role,
      text: body,
      kind: entry.kind,
      ...(entry.data === undefined ? {} : { data: entry.data }),
    };
  }
  return undefined;
}

/** 工具参数里的人话提示：取第一个像样的字符串字段并截断（命令 > 路径 > 模式 > …），
 *  供 UI 状态行展示「正在执行的到底是什么」。一个都没有就返回 undefined（不硬塞 JSON）。 */
const HINT_KEYS = ["command", "path", "pattern", "query", "url", "prompt", "text", "content", "reason", "name"] as const;
const HINT_MAX = 60;

export function argsHint(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of HINT_KEYS) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const text = value.replace(/\s+/gu, " ").trim();
    if (text === "") continue;
    return [...text].length > HINT_MAX ? `${[...text].slice(0, HINT_MAX).join("")}…` : text;
  }
  return undefined;
}

/** Pi 事件 → 归一化事件（不泄漏 Pi 类型）。 */
export function mapPiEvent(event: PiAgentEvent, convId: string): HarnessEvent[] {
  switch (event.type) {
    case "message_update": {
      const out: HarnessEvent[] = [];
      for (const change of event.changes) {
        if (change.type === "text_delta") out.push({ type: "delta", convId, channel: "text", delta: change.delta });
        else if (change.type === "thinking_delta") out.push({ type: "delta", convId, channel: "thinking", delta: change.delta });
        // 工具调用参数开始流出：状态行显「正在准备调用 X」（后面可能还要好几秒才真正执行）
        else if (change.type === "toolcall_start") out.push({ type: "toolCall", convId, name: change.block.type === "toolCall" ? change.block.name : "" });
      }
      return out;
    }
    // 实测（Pi 1.3.0）：run 产生的 entry（用户输入、assistant 回复）经 message_end 到达，
    // entry_appended 只出现在展示型写入（type:"write"）；两者都映射，由 watch 按 entry.id 去重。
    case "message_end":
    case "entry_appended": {
      const message = entryToChatMessage(event.entry);
      return message === undefined ? [] : [{ type: "message", convId, message }];
    }
    // 订阅晚于投递时（新会话首轮、服务端重启）收不到 run_start；snapshot.run 补上「已在跑」。
    case "snapshot":
      return event.run === undefined ? [] : [{ type: "run", convId, phase: "start" }];
    case "run_start":
      return [{ type: "run", convId, phase: "start" }];
    case "run_end":
      return [{ type: "run", convId, phase: "end" }];
    case "tool_execution_start": {
      const hint = argsHint(event.args);
      return [{ type: "tool", convId, name: event.toolName, phase: "start", ...(hint === undefined ? {} : { hint }) }];
    }
    case "tool_execution_end":
      return [{ type: "tool", convId, name: event.toolName, phase: "end" }];
    case "task_failed":
      return [{ type: "failed", convId, message: event.message, kind: event.kind }];
    // 输入受理状态：queued（排队中）→ placed（进 transcript）→ done / unanswered（撤回、中断等）。
    case "submission":
      return [{ type: "submission", convId, id: String(event.record.id), status: event.record.status }];
    default:
      return [];
  }
}

export function createPiHarness(options: PiHarnessOptions): HarnessPort {
  const ctx = BACKGROUND_CONTEXT;
  const models = options.models ?? (() => {
    const m = createModels();
    m.setProvider(opencodeGoProvider());
    return m;
  })();
  const registry = createRegistry();
  registry.install(CodingTools);

  let harness: Harness | undefined;
  const accessByConv = new Map<string, AccessContext>();
  const sessionInfoByConv = new Map<string, { selfId: string; relation: Relation; meetingId: string }>();
  const accessExtension = createAccessExtension((id) => accessByConv.get(id), new WriteGuard(options.root));
  registry.install(accessExtension);

  // 默认扩展集固定：MCP 扩展只安装、不默认选中（由会话的 mcpExtensions 选择）。
  const baseExtensions: Extension[] = [CodingTools, accessExtension];
  for (const extension of options.extensions ?? []) {
    registry.install(extension);
    baseExtensions.push(extension);
  }
  if (options.toolSearch === true) {
    const toolSearch = createToolSearchExtension();
    registry.install(toolSearch);
    baseExtensions.push(toolSearch);
  }
  for (const extension of options.mcpExtensions ?? []) registry.install(extension);

  async function conversation(id: ConversationId): Promise<Conversation> {
    const found = await harness!.conversation(id, ctx);
    if (!found) throw new Error(`会话不存在: ${id}`);
    return found;
  }

  return {
    async open() {
      harness = await Harness.open(
        await openNodeSqliteStorage(options.sqlitePath),
        {
          models,
          registry,
          settings: { extensions: baseExtensions },
          env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? options.root }),
        },
        ctx,
      );
      harness.resume();
    },
    async close() {
      if (harness) await harness.close(ctx);
      harness = undefined;
    },
    async startSession(spec) {
      // AgentChange.extensions 接受扩展对象而非名字；未知名字（启动失败 / 未安装）直接忽略。
      const mcpByName = new Map((options.mcpExtensions ?? []).map((extension) => [extension.name, extension]));
      const selectedMcp = (spec.mcpExtensions ?? []).flatMap((name) => {
        const extension = mcpByName.get(name);
        return extension === undefined ? [] : [extension];
      });
      const conv = await harness!.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: {
            model: spec.model,
            ...(spec.thinkingLevel === undefined ? {} : { thinkingLevel: spec.thinkingLevel as never }),
            instructions: spec.instructions,
            cwd: spec.cwd,
            ...(selectedMcp.length === 0 ? {} : { extensions: { add: [...selectedMcp] } }),
          },
        },
        ctx,
      );
      accessByConv.set(String(conv.id), spec.access);
      sessionInfoByConv.set(String(conv.id), { selfId: spec.access.selfId, relation: spec.relation, meetingId: spec.meetingId });
      return String(conv.id);
    },
    async attach(convId, access, relation, meetingId) {
      const found = await harness!.conversation(convId as unknown as ConversationId, ctx);
      if (!found) return false;
      accessByConv.set(String(found.id), access);
      sessionInfoByConv.set(String(found.id), { selfId: access.selfId, relation, meetingId });
      return true;
    },
    bindSession(convId, session) {
      // 身份与访问控制一起补登记：重启后工具调用先过 access 钩子，
      // 只登记身份 → 员工每个工具都被「访问控制：未注册的会话」拦掉。
      accessByConv.set(convId, session.access);
      sessionInfoByConv.set(convId, { selfId: session.selfId, relation: session.relation, meetingId: session.meetingId });
    },
    sessionInfo(convId) {
      return sessionInfoByConv.get(convId);
    },
    async sessionUsage(convId) {
      const conv = await conversation(convId as unknown as ConversationId);
      // 会话快照：agent.model / thinkingLevel 是创建时固化 + Pi 解析后的实际值，不是配置现值。
      const agent = await conv.agent(ctx);
      if (agent.model === undefined) throw new Error(`会话没有模型: ${convId}`);
      const model = models.getModel(agent.model.provider, agent.model.modelId);
      const context = await conv.context(ctx);
      return {
        model: { provider: agent.model.provider, modelId: agent.model.modelId },
        thinkingLevel: agent.thinkingLevel,
        ...(model === undefined ? {} : { supportedThinkingLevels: getSupportedThinkingLevels(model) }),
        contextUsed: estimateContextTokens(context.messages).tokens,
        ...(model?.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      };
    },
    async send(convId, text) {
      const conv = await conversation(convId as unknown as ConversationId);
      const submission = await conv.submit({ type: "input", content: text }, ctx);
      const settled = await submission.wait(ctx);
      if (settled.status !== "done" || settled.answer === undefined) {
        throw new Error(`提交未完成: ${settled.status}`);
      }
      const entry = await conv.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
      const message = entry?.model?.[0];
      const body = textOf(message);
      return { id: String(settled.answer), role: "assistant", text: body };
    },
    async submit(convId, text, meta) {
      const conv = await conversation(convId as unknown as ConversationId);
      const submission = await conv.submit(
        {
          type: "input",
          content: text,
          ...(meta?.kind === undefined
            ? {}
            : { entry: { kind: meta.kind, ...(meta.data === undefined ? {} : { data: meta.data as never }) } }),
          ...(meta?.requestId === undefined ? {} : { requestId: meta.requestId }),
        },
        ctx,
      );
      // 受理回执：状态在提交事务内定稿——queued = 会话忙，输入进了 Pi 的 inbox（排队中）。
      const record = await submission.status(ctx);
      return { id: String(submission.id), status: record.status };
    },
    async withdrawSubmission(convId, submissionId) {
      const conv = await conversation(convId as unknown as ConversationId);
      // 必须换成数值 id：Pi 在 inbox 里用严格比较找条目，字符串 id 会「settle 了记录、却漏删 inbox 条目」——
      // 表现为撤回成功但输入照旧排到下一轮投递给员工。回执里的 id 是字符串（要能过 JSON/SSE），这里转回来。
      const id = Number(submissionId);
      if (!Number.isInteger(id)) return false;
      const result = await harness!.abortSubmission(id as unknown as SubmissionId, ctx, conv.id);
      return result === "aborted"; // 只有 queued 能撤；placed/settled/not_found 都表示撤不回
    },
    async append(convId, entry) {
      const conv = await conversation(convId as unknown as ConversationId);
      // 员工主动发言（send_message）：以 assistant 形态落盘——模型视角是「我自己说过的话」。
      // 不能写成 user：带 model 的写条目会在下一轮生成时进入上下文，user 形态会被模型当成
      // 用户新输入而再回复一次（自我回显）；assistant 形态则不会。
      // usage 零值：Pi 的上下文估算只把 usage>0 的消息当计量基准，零值会被跳过（不污染估算）。
      const ref = (await conv.agent(ctx)).model;
      const resolved = ref === undefined ? undefined : models.getModel(ref.provider, ref.modelId);
      await conv.submit(
        {
          type: "write",
          entry: {
            kind: entry.kind,
            ...(entry.data === undefined ? {} : { data: entry.data as never }),
            model: [
              {
                role: "assistant",
                content: [{ type: "text", text: entry.text }],
                api: resolved?.api ?? "openstaffs",
                provider: ref?.provider ?? "openstaffs",
                model: resolved?.id ?? ref?.modelId ?? "append",
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "stop",
                timestamp: Date.now(),
              },
            ],
          },
        },
        ctx,
      );
    },
    async abort(convId) {
      const conv = await conversation(convId as unknown as ConversationId);
      await conv.abort(ctx);
    },
    async watch(convId, listener) {
      // Pi 文档地址要求数值 ConversationId（字符串会被 resolveAddress 拒绝）；借会话读回拿到规范 id。
      const conv = await conversation(convId as unknown as ConversationId);
      const stream = await watchEvents(harness!, conv.id, ctx);
      // 同一 entry 可能同时经 message_end 与 entry_appended 到达：按 entry.id 只发一次。
      const seenEntries = new Set<string>();
      stream.start(async (events) => {
        for (const event of events) {
          for (const mapped of mapPiEvent(event, String(convId))) {
            if (mapped.type === "message") {
              if (seenEntries.has(mapped.message.id)) continue;
              seenEntries.add(mapped.message.id);
            }
            listener(mapped);
          }
        }
      });
      return async () => {
        await stream.stop();
      };
    },
    async context(convId) {
      const conv = await conversation(convId as unknown as ConversationId);
      const agent = await conv.agent(ctx);
      const context = await conv.context(ctx);
      // entry kind（如 pi.compaction）按 contributions 回填，messages 本身不带 kind。
      const kinds = new WeakMap<object, string>();
      for (const [index, entry] of context.entries.entries()) {
        for (const message of context.contributions[index] ?? []) kinds.set(message as object, entry.kind);
      }
      const system = context.messages
        .filter((message) => (message as { role?: unknown }).role === "system")
        .map((message) => textOf(message))
        .filter((text) => text !== "");
      const items: ContextItem[] = [];
      for (const message of context.messages) {
        if ((message as { role?: unknown }).role === "system") continue;
        const item = toContextItem(message, kinds.get(message as object));
        if (item !== undefined) items.push(item);
      }
      const result: SessionContext = {
        instructions: system.length > 0 ? system.join("\n\n") : (agent.instructions ?? ""),
        items,
        ...(agent.cwd === undefined ? {} : { cwd: agent.cwd }),
      };
      return result;
    },
    async transcript(convId) {
      const conv = await conversation(convId as unknown as ConversationId);
      const view = await conv.viewState(ctx);
      const messages: ChatMessage[] = [];
      for (const entry of view.value.entries) {
        for (const message of entry.model ?? []) {
          const role = (message as { role?: unknown }).role;
          if (role !== "user" && role !== "assistant") continue;
          const body = textOf(message);
          if (body === "") continue;
          messages.push({
            id: String(entry.id),
            role,
            text: body,
            kind: entry.kind,
            ...(entry.data === undefined ? {} : { data: entry.data }),
          });
        }
      }
      return messages;
    },
  };
}
