import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import path from "node:path";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import {
  AssistantEntry, Harness, watchEvents, createRegistry,
  type AgentEvent as PiAgentEvent, type Conversation, type ConversationId, type EntryRecord, type Extension,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { Message } from "@earendil-works/pi-ai";
import { createAccessExtension } from "./access-extension.ts";
import type { AccessContext } from "../domain/access-control.ts";
import type { Relation } from "../domain/types.ts";
import type { ChatMessage, HarnessEvent, HarnessPort, PostEntry } from "./port.ts";

export type PiHarnessOptions = {
  root: string;
  sqlitePath: string;
  models?: Models;
  /** 额外安装的扩展（如 OpenStaffs 自有工具）。 */
  extensions?: readonly Extension[];
};

/** 由会话 cwd 推断关系（根目录下：agents/<id> = 私聊；projects/<id> = 群聊）。 */
function relationFor(root: string, selfId: string, cwd: string): Relation {
  const segments = path.relative(root, cwd).split(path.sep);
  if (segments[0] === "projects" && segments.length === 2 && segments[1] !== undefined && segments[1] !== "") {
    return { kind: "group", project: segments[1] };
  }
  return { kind: "dm", employeeId: selfId };
}

function textOf(message: Message | undefined): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => (block && block.type === "text" ? [String(block.text ?? "")] : []))
    .join("")
    .trim();
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

/** Pi 事件 → 归一化事件（不泄漏 Pi 类型）。 */
export function mapPiEvent(event: PiAgentEvent, convId: string): HarnessEvent[] {
  switch (event.type) {
    case "message_update": {
      const out: HarnessEvent[] = [];
      for (const change of event.changes) {
        if (change.type === "text_delta") out.push({ type: "delta", convId, channel: "text", delta: change.delta });
        else if (change.type === "thinking_delta") out.push({ type: "delta", convId, channel: "thinking", delta: change.delta });
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
    case "run_start":
      return [{ type: "run", convId, phase: "start" }];
    case "run_end":
      return [{ type: "run", convId, phase: "end" }];
    case "tool_execution_start":
      return [{ type: "tool", convId, name: event.toolName, phase: "start" }];
    case "tool_execution_end":
      return [{ type: "tool", convId, name: event.toolName, phase: "end" }];
    case "task_failed":
      return [{ type: "failed", convId, message: event.message, kind: event.kind }];
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
  const sessionInfoByConv = new Map<string, { selfId: string; relation: Relation }>();
  registry.install(createAccessExtension((id) => accessByConv.get(id)));
  for (const extension of options.extensions ?? []) registry.install(extension);

  async function conversation(id: ConversationId): Promise<Conversation> {
    const found = await harness!.conversation(id, ctx);
    if (!found) throw new Error(`会话不存在: ${id}`);
    return found;
  }

  return {
    async open() {
      harness = await Harness.open(
        await openNodeSqliteStorage(options.sqlitePath),
        { models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? options.root }) },
        ctx,
      );
      harness.resume();
    },
    async close() {
      if (harness) await harness.close(ctx);
      harness = undefined;
    },
    async startSession(spec) {
      const conv = await harness!.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: {
            model: spec.model,
            ...(spec.thinkingLevel === undefined ? {} : { thinkingLevel: spec.thinkingLevel as never }),
            instructions: spec.instructions,
            cwd: spec.cwd,
          },
        },
        ctx,
      );
      accessByConv.set(String(conv.id), spec.access);
      sessionInfoByConv.set(String(conv.id), {
        selfId: spec.access.selfId,
        relation: relationFor(options.root, spec.access.selfId, spec.cwd),
      });
      return String(conv.id);
    },
    async attach(convId, access) {
      const found = await harness!.conversation(convId as unknown as ConversationId, ctx);
      if (!found) return false;
      accessByConv.set(String(found.id), access);
      sessionInfoByConv.set(String(found.id), {
        selfId: access.selfId,
        relation: relationFor(options.root, access.selfId, access.cwd),
      });
      return true;
    },
    sessionInfo(convId) {
      return sessionInfoByConv.get(convId);
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
      await conv.submit(
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
    },
    async append(convId, entry) {
      const conv = await conversation(convId as unknown as ConversationId);
      await conv.submit(
        {
          type: "write",
          entry: {
            kind: entry.kind,
            ...(entry.data === undefined ? {} : { data: entry.data as never }),
            model: [{ role: "user", content: entry.text, timestamp: Date.now() }],
          },
        },
        ctx,
      );
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
