import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../src/domain/paths.ts";
import {
  PermissionRequestStore, readPermissionRequests, requestsFile,
} from "../../src/domain/permission-requests.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-pre-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function seedConfig(content: string) {
  fs.mkdirSync(path.join(root, ".openstaffs"), { recursive: true });
  fs.writeFileSync(path.join(root, ".openstaffs", "permission-requests.json"), content);
}

describe("授权请求存储", () => {
  it("缺失/坏 JSON/坏条目 → 安全降级", () => {
    const ws = createWorkspace(root);
    expect(readPermissionRequests(ws)).toEqual([]);
    seedConfig("{坏");
    expect(readPermissionRequests(ws)).toEqual([]);
    seedConfig(JSON.stringify({ requests: [{ id: "pr_1" }, { id: "pr_2", agentId: "a", roomKey: "dm:a", paths: ["/x"], reason: "r", createdAt: "t" }] }));
    const ok = readPermissionRequests(ws);
    expect(ok.map((r) => r.id)).toEqual(["pr_2"]); // 坏条目跳过，好条目保留
  });

  it("add：生成 id/createdAt、新在前、原子落盘可读回（无 .tmp 残留）", () => {
    const ws = createWorkspace(root);
    const store = new PermissionRequestStore(ws);
    const first = store.add({ agentId: "alice", roomKey: "dm:alice", paths: ["/a"], reason: "r1" });
    const second = store.add({ agentId: "bob", roomKey: "group:yt", paths: ["/b"], reason: "r2" });
    expect(first.id).toMatch(/^pr_/u);
    expect(second.id).toMatch(/^pr_/u);
    expect(second.id).not.toBe(first.id);
    expect(Number.isNaN(Date.parse(second.createdAt))).toBe(false);
    expect(store.list().map((r) => r.id)).toEqual([second.id, first.id]); // 新的在前
    expect(readPermissionRequests(ws).map((r) => r.id)).toEqual([second.id, first.id]);
    expect(fs.existsSync(`${requestsFile(ws)}.tmp`)).toBe(false);
    // 重启（新的 store 从盘恢复）
    expect(new PermissionRequestStore(ws).list()).toHaveLength(2);
  });

  it("remove：命中返回 true 并落盘；不存在返回 false", () => {
    const ws = createWorkspace(root);
    const store = new PermissionRequestStore(ws);
    const request = store.add({ agentId: "alice", roomKey: "dm:alice", paths: ["/a"], reason: "r" });
    expect(store.remove("pr_none")).toBe(false);
    expect(store.remove(request.id)).toBe(true);
    expect(store.list()).toEqual([]);
    expect(readPermissionRequests(ws)).toEqual([]);
  });

  it("findDuplicate：同 agent + 路径集合相同（顺序无关）；顺序不同命中、路径不同不命中", () => {
    const ws = createWorkspace(root);
    const store = new PermissionRequestStore(ws);
    store.add({ agentId: "alice", roomKey: "dm:alice", paths: ["/a", "/b"], reason: "r" });
    expect(store.findDuplicate("alice", ["/b", "/a"])?.agentId).toBe("alice");
    expect(store.findDuplicate("alice", ["/a"])).toBeUndefined();
    expect(store.findDuplicate("bob", ["/a", "/b"])).toBeUndefined();
  });
});
