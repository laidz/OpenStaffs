import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import { createPiHarness } from "../../src/harness/pi-durable.ts";
import { SseHub, type ServerEvent } from "../../src/server/sse.ts";
import { Pump } from "../../src/server/pump.ts";
import { openGroup, sessionChains } from "../../src/app/conversations.ts";
import { mergeRoomMessages, type MemberTranscript } from "../../src/app/rooms.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-trigger-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function seedEmployee(id: string): void {
  const dir = path.join(root, "agents", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "AGENTS.md"), `你是 ${id}。`);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ model: "faux/faux-model" }));
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 15000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("群回复 @触发（pump 集成）", () => {
  it("alice 回复 @bob @carol → 两人都被触发并开工；新会话被订阅（有广播）；副本不重复显示；无 @ 的回复补 @老板", async () => {
    for (const id of ["alice", "bob", "carol"]) seedEmployee(id);
    const groupDir = path.join(root, "projects", "yt");
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, "members.md"), "# 成员\n- alice\n- bob\n- carol\n");

    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
    // 三个响应：alice 的回复（触发两人）、bob/carol 的回复（内容相同，避免并发消费顺序影响断言）
    faux.setResponses([fauxAssistantMessage("@bob @carol 都来收尾"), fauxAssistantMessage("收到！"), fauxAssistantMessage("收到！")]);
    const models = createModels();
    models.setProvider(faux.provider);
    const ws = createWorkspace(root);
    const harness = createPiHarness({ root, sqlitePath: path.join(root, ".openstaffs", "state.sqlite"), models });
    await harness.open();

    const events: ServerEvent[] = [];
    const hub = {
      broadcast: (event: ServerEvent) => events.push(event),
      add: () => ({ pending: 0, close: () => {} }),
      size: 0,
    } as unknown as SseHub;
    const pump = new Pump({ ws, harness, hub });
    try {
      const aliceConv = await openGroup(ws, harness, "yt", "alice");
      await pump.register(aliceConv, { roomKey: "group:yt", memberId: "alice" });
      await harness.submit(aliceConv, "请安排一下收尾");

      // bob 与 carol 都被触发：新会话收到带发送者标注的 chat.mention，并各自产出回复
      const readTarget = async (id: string) => {
        const chain = sessionChains(ws, { kind: "group", project: "yt" }).find((c) => c.memberId === id);
        const active = chain?.rows.filter((row) => row.ended === null).at(-1);
        if (active === undefined) return undefined;
        const messages = await harness.transcript(active.id);
        return messages.some((m) => m.role === "assistant") ? { convId: active.id, messages } : undefined;
      };
      const bobActive = await waitFor(() => readTarget("bob"));
      const carolActive = await waitFor(() => readTarget("carol"));
      for (const active of [bobActive, carolActive]) {
        const trigger = active.messages.find((m) => m.kind === "chat.mention");
        expect(trigger?.role).toBe("user");
        expect(trigger?.text).toBe("alice：@bob @carol 都来收尾");
      }

      // 新触发的会话被订阅：bob/carol 的回复走 SSE 广播（register-after-trigger 可观测）
      await waitFor(async () =>
        events.some((e) => e.type === "room.message" && e.roomKey === "group:yt" && e.message.speaker.kind === "employee" && e.message.speaker.id === "carol")
          ? true
          : undefined,
      );
      for (const id of ["bob", "carol"]) {
        expect(
          events.some((e) => e.type === "room.message" && e.message.speaker.kind === "employee" && e.message.speaker.id === id),
        ).toBe(true);
      }

      // 房间合并视图：原回复只出现一次（触发副本不显示）；没写 @ 的回复被补 @老板
      const chains = sessionChains(ws, { kind: "group", project: "yt" });
      const transcripts: MemberTranscript[] = [];
      for (const chain of chains) {
        const active = chain.rows.filter((row) => row.ended === null).at(-1);
        if (active === undefined) continue;
        transcripts.push({ memberId: chain.memberId, convId: active.id, messages: await harness.transcript(active.id) });
      }
      const merged = mergeRoomMessages("group:yt", transcripts, ["alice", "bob", "carol"]);
      expect(merged.map((m) => m.text)).toEqual([
        "请安排一下收尾",
        "@bob @carol 都来收尾",
        "@老板 收到！",
        "@老板 收到！",
      ]);
      expect(merged.filter((m) => m.text === "@bob @carol 都来收尾")).toHaveLength(1);
    } finally {
      await harness.close();
    }
  }, 30_000);

  it("称谓自定义：pump 广播的 fallback 文本用真称谓（读 config）", async () => {
    seedEmployee("alice");
    const groupDir = path.join(root, "projects", "yt");
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, "members.md"), "# 成员\n- alice\n");
    fs.mkdirSync(path.join(root, ".openstaffs"), { recursive: true });
    fs.writeFileSync(path.join(root, ".openstaffs", "config.json"), JSON.stringify({ bossName: "掌柜" }));

    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
    faux.setResponses([fauxAssistantMessage("收到！")]);
    const models = createModels();
    models.setProvider(faux.provider);
    const ws = createWorkspace(root);
    const harness = createPiHarness({ root, sqlitePath: path.join(root, ".openstaffs", "state.sqlite"), models });
    await harness.open();

    const events: ServerEvent[] = [];
    const hub = {
      broadcast: (event: ServerEvent) => events.push(event),
      add: () => ({ pending: 0, close: () => {} }),
      size: 0,
    } as unknown as SseHub;
    const pump = new Pump({ ws, harness, hub });
    try {
      const aliceConv = await openGroup(ws, harness, "yt", "alice");
      await pump.register(aliceConv, { roomKey: "group:yt", memberId: "alice" });
      await harness.submit(aliceConv, "请回答");
      await waitFor(async () =>
        events.some((e) => e.type === "room.message" && e.message.speaker.kind === "employee") ? true : undefined,
      );
      const message = events.find((e) => e.type === "room.message" && e.message.speaker.kind === "employee");
      expect(message?.type === "room.message" ? message.message.text : "").toBe("@掌柜 收到！");
    } finally {
      await harness.close();
    }
  }, 30_000);
});
