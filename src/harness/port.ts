import type { AccessContext } from "../domain/access-control.ts";

export type ModelRef = { provider: string; modelId: string };

export type ConversationSpec = {
  cwd: string;
  instructions: string;
  model: ModelRef;
  thinkingLevel?: string;
  access: AccessContext;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

export interface HarnessPort {
  open(): Promise<void>;
  close(): Promise<void>;
  ensureActive(key: string, spec: ConversationSpec): Promise<string>;
  attach(key: string, convId: string, spec: ConversationSpec): Promise<boolean>;
  startSession(key: string, spec: ConversationSpec): Promise<string>;
  send(convId: string, text: string): Promise<ChatMessage>;
  transcript(convId: string): Promise<ChatMessage[]>;
}
