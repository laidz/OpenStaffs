import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import {
  PermissionRequestStore, normalizeTools, readPermissionRequests, requestsFile,
} from "../../src/domain/permission-requests.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-pre-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function seedConfig(content: string) {
  fs.mkdirSync(path.join(root, "openstaffs/.data"), { recursive: true });
  fs.writeFileSync(path.join(root, "openstaffs/.data", "permission-requests.json"), content);
}

describe("normalizeTools", () => {
  it("去空白 / 去重 / 丢非字符串与空串；单值兼容成数组", () => {
    expect(normalizeTools([" read ", "write", "read", "", 1, null])).toEqual(["read", "write"]);
    expect(normalizeTools("read")).toEqual(["read"]);
    expect(normalizeTools(undefined)).toEqual([]);
    expect(normalizeTools([])).toEqual([]);
  });
});

describe("授权请求存储", () => {
  it("缺失/坏 JSON/坏条目 → 安全降级", () => {
    const ws = createWorkspace(root);
    expect(readPermissionRequests(ws)).toEqual([]);
    seedConfig("{坏");
    expect(readPermissionRequests(ws)).toEqual([]);
    seedConfig(JSON.stringify({ requests: [{ id: "pr_1" }, { id: "pr_2", agentId: "a", meetingId: "mtg_a", tools: ["read"], paths: ["/x"], reason: "r", createdAt: "t" }] }));
    const ok = readPermissionRequests(ws);
    expect(ok.map((r) => r.id)).toEqual(["pr_2"]); // 坏条目跳过，好条目保留
    expect(ok[0]!.tools).toEqual(["read"]);
  });

  it("旧档兼容：只有 tool / 没有 tool 的待处理请求归一成 tools（别让升级丢掉没处理的卡）", () => {
    const ws = createWorkspace(root);
    seedConfig(JSON.stringify({
      requests: [
        { id: "pr_old_read", agentId: "a", meetingId: "mtg_a", tool: "read", paths: ["/r"], reason: "r", createdAt: "t1" },
        { id: "pr_old_write", agentId: "a", meetingId: "mtg_a", paths: ["/w"], reason: "r", createdAt: "t0" },
        { id: "pr_old_empty", agentId: "a", meetingId: "mtg_a", tool: "", paths: ["/e"], reason: "r", createdAt: "t-1" },
      ],
    }));
    const requests = readPermissionRequests(ws);
    expect(requests.find((r) => r.id === "pr_old_read")!.tools).toEqual(["read"]);
    expect(requests.find((r) => r.id === "pr_old_write")!.tools).toEqual(["write"]);
    expect(requests.find((r) => r.id === "pr_old_empty")!.tools).toEqual(["write"]);
  });

  it("add：生成 id/createdAt、新在前、原子落盘可读回（无 .tmp 残留）", () => {
    const ws = createWorkspace(root);
    const store = new PermissionRequestStore(ws);
    const first = store.add({ agentId: "alice", meetingId: "mtg_a", tools: ["write"], paths: ["/a"], reason: "r1" });
    const second = store.add({ agentId: "bob", meetingId: "mtg_g", tools: ["read", "write"], paths: ["/b"], reason: "r2" });
    expect(first.request.id).toMatch(/^pr_/u);
    expect(second.request.id).toMatch(/^pr_/u);
    expect(second.request.id).not.toBe(first.request.id);
    expect(Number.isNaN(Date.parse(second.request.createdAt))).toBe(false);
    expect(store.list().map((r) => r.id)).toEqual([second.request.id, first.request.id]); // 新的在前
    expect(readPermissionRequests(ws).map((r) => r.id)).toEqual([second.request.id, first.request.id]);
    expect(fs.existsSync(`${requestsFile(ws)}.tmp`)).toBe(false);
    // 重启（新的 store 从盘恢复）
    expect(new PermissionRequestStore(ws).list()).toHaveLength(2);
  });

  it("remove：命中返回 true 并落盘；不存在返回 false", () => {
    const ws = createWorkspace(root);
    const store = new PermissionRequestStore(ws);
    const { request } = store.add({ agentId: "alice", meetingId: "mtg_a", tools: ["write"], paths: ["/a"], reason: "r" });
    expect(store.remove("pr_none")).toBe(false);
    expect(store.remove(request.id)).toBe(true);
    expect(store.list()).toEqual([]);
    expect(readPermissionRequests(ws)).toEqual([]);
  });

  it("同人 + 同会议 + 同目录组：合并工具（不新建卡）；完全重复 = addedTools 为空", () => {
    const ws = createWorkspace(root);
    const store = new PermissionRequestStore(ws);
    const first = store.add({ agentId: "alice", meetingId: "mtg_a", tools: ["write"], paths: ["/dir"], reason: "要写" });
    expect(first.merged).toBe(false);

    const merged = store.add({ agentId: "alice", meetingId: "mtg_a", tools: ["read"], paths: ["/dir"], reason: "要读" });
    expect(merged.merged).toBe(true);
    expect(merged.addedTools).toEqual(["read"]);
    expect(merged.request.id).toBe(first.request.id); // 同一张卡
    expect(merged.request.tools).toEqual(["write", "read"]);
    expect(merged.request.reason).toBe("要写"); // 保留最早那条理由
    expect(store.list()).toHaveLength(1);

    const duplicate = store.add({ agentId: "alice", meetingId: "mtg_a", tools: ["read", "write"], paths: ["/dir"], reason: "再来一次" });
    expect(duplicate.merged).toBe(true);
    expect(duplicate.addedTools).toEqual([]);
    expect(store.list()).toHaveLength(1);
  });

  it("路径顺序无关；不同目录 / 不同会议 / 不同人不合并", () => {
    const ws = createWorkspace(root);
    const store = new PermissionRequestStore(ws);
    store.add({ agentId: "alice", meetingId: "mtg_a", tools: ["write"], paths: ["/a", "/b"], reason: "r" });
    expect(store.findMergeTarget("alice", "mtg_a", ["/b", "/a"])).toBeDefined();
    expect(store.findMergeTarget("alice", "mtg_a", ["/a"])).toBeUndefined();
    expect(store.findMergeTarget("alice", "mtg_b", ["/a", "/b"])).toBeUndefined();
    expect(store.findMergeTarget("bob", "mtg_a", ["/a", "/b"])).toBeUndefined();
  });

  it("启动加载时合并旧残留：同人同会议同目录的多条 → 一条（工具并集）并落盘", () => {
    const ws = createWorkspace(root);
    seedConfig(JSON.stringify({
      requests: [
        { id: "pr_read", agentId: "alice", meetingId: "mtg_a", tools: ["read"], paths: ["/dir"], reason: "要读", createdAt: "t2" },
        { id: "pr_write", agentId: "alice", meetingId: "mtg_a", tools: ["write"], paths: ["/dir"], reason: "要写", createdAt: "t1" },
        { id: "pr_other", agentId: "alice", meetingId: "mtg_a", tools: ["write"], paths: ["/other"], reason: "别的", createdAt: "t0" },
      ],
    }));
    const store = new PermissionRequestStore(ws);
    expect(store.list()).toHaveLength(2);
    const merged = store.list().find((r) => r.paths[0] === "/dir")!;
    expect(merged.id).toBe("pr_read"); // 保留最新的那条
    expect(merged.tools).toEqual(["read", "write"]);
    // 落盘也已归一：再开一次不会重复合并 / 丢工具
    const again = new PermissionRequestStore(ws);
    expect(again.list().find((r) => r.id === "pr_read")!.tools).toEqual(["read", "write"]);
  });

  it("tools 为空 → 拒绝创建（新请求必须明确权限）", () => {
    const ws = createWorkspace(root);
    const store = new PermissionRequestStore(ws);
    expect(() => store.add({ agentId: "alice", meetingId: "mtg_a", tools: [], paths: ["/a"], reason: "r" })).toThrow("tools 不能为空");
    expect(() => store.add({ agentId: "alice", meetingId: "mtg_a", tools: ["  "], paths: ["/a"], reason: "r" })).toThrow("tools 不能为空");
    expect(store.list()).toEqual([]);
  });
});
