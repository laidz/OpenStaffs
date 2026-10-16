import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import {
  AssistantEntry, Harness, UserEntry, createRegistry, type Conversation, type ConversationId,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { Message } from "@earendil-works/pi-ai";
import { createAccessExtension } from "./access-extension.ts";
import type { AccessContext } from "../domain/access-control.ts";
import type { ChatMessage, ConversationSpec, HarnessPort } from "./port.ts";

export type PiHarnessOptions = {
  root: string;
  sqlitePath: string;
  models?: Models;
};

function textOf(message: Message | undefined): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => (block && block.type === "text" ? [String(block.text ?? "")] : []))
    .join("")
    .trim();
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
  const activeByKey = new Map<string, ConversationId>();
  const accessByConv = new Map<string, AccessContext>();
  registry.install(createAccessExtension((id) => accessByConv.get(id)));

  async function conversation(id: ConversationId): Promise<Conversation> {
    const found = await harness!.conversation(id, ctx);
    if (!found) throw new Error(`会话不存在: ${id}`);
    return found;
  }

  async function applyAgent(conv: Conversation, spec: ConversationSpec): Promise<void> {
    accessByConv.set(String(conv.id), spec.access);
    await conv.configure(
      {
        model: spec.model,
        ...(spec.thinkingLevel === undefined ? {} : { thinkingLevel: spec.thinkingLevel as never }),
        instructions: spec.instructions,
        cwd: spec.cwd,
      },
      ctx,
    );
  }

  return {
    async open() {
      harness = await Harness.open(
        await openNodeSqliteStorage(options.sqlitePath),
        { models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? options.root }) },
        ctx,
      );
    },
    async close() {
      if (harness) await harness.close(ctx);
      harness = undefined;
    },
    async ensureActive(key, spec) {
      const existing = activeByKey.get(key);
      if (existing !== undefined) {
        await applyAgent(await conversation(existing), spec);
        return String(existing);
      }
      const conv = await harness!.createConversation({ ownership: { kind: "ownerless" } }, ctx);
      activeByKey.set(key, conv.id);
      await applyAgent(conv, spec);
      return String(conv.id);
    },
    async startSession(key, spec) {
      activeByKey.delete(key);
      const conv = await harness!.createConversation({ ownership: { kind: "ownerless" } }, ctx);
      activeByKey.set(key, conv.id);
      await applyAgent(conv, spec);
      return String(conv.id);
    },
    async attach(key, convId, spec) {
      const found = await harness!.conversation(convId as unknown as ConversationId, ctx);
      if (!found) return false;
      activeByKey.set(key, found.id);
      await applyAgent(found, spec);
      return true;
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
    async transcript(convId) {
      const conv = await conversation(convId as unknown as ConversationId);
      const view = await conv.viewState(ctx);
      const messages: ChatMessage[] = [];
      for (const entry of view.value.entries) {
        if (!UserEntry.is(entry) && !AssistantEntry.is(entry)) continue;
        const role = entry.kind === UserEntry.kind ? "user" : "assistant";
        for (const message of entry.model ?? []) {
          const body = textOf(message);
          if (body !== "") messages.push({ id: String(entry.id), role, text: body });
        }
      }
      return messages;
    },
  };
}
