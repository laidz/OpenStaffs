import { BOSS_ID, parseMentions } from "../domain/mention.ts";

export type Delivery = { to: string; body: string };

export function planRouting(text: string, memberIds: string[]): { deliveries: Delivery[]; broadcast: boolean } {
  const mention = parseMentions(text, memberIds);
  if (mention.broadcast) {
    return { deliveries: memberIds.map((to) => ({ to, body: mention.body })), broadcast: true };
  }
  const deliveries = mention.targets
    .filter((target) => target !== BOSS_ID && memberIds.includes(target))
    .map((to) => ({ to, body: mention.body }));
  return { deliveries, broadcast: false };
}
