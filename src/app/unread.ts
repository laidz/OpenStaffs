import type { ChatMessage } from "../harness/port.ts";

export type Unread = { relation: string; message: ChatMessage };

export function unreadForBoss(
  conversations: { relation: string; messages: ChatMessage[] }[],
  bossSeenCount: Record<string, number>,
): Unread[] {
  const unread: Unread[] = [];
  for (const conversation of conversations) {
    const seen = bossSeenCount[conversation.relation] ?? 0;
    conversation.messages.slice(seen).forEach((message) => {
      if (message.role !== "user") unread.push({ relation: conversation.relation, message });
    });
  }
  return unread;
}
