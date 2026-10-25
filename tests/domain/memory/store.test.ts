import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../../../src/domain/paths.ts";
import {
  archiveDir, createEntity, findEntity, loadMemory, memoryDir, readProfile, readState,
  removeEntity, touch, updateEntity, writeProfile,
} from "../../../src/domain/memory/store.ts";
import { PROFILE_MAX_BYTES } from "../../../src/domain/memory/types.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-mem-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const ws = createWorkspace(root);

describe("记忆存储", () => {
  it("创建：生成 id、落盘、续期；同名自动加序号", () => {
    const a = createEntity(ws, "alice", { title: "VIP 口径", description: "谈 VIP 时先看", body: "内容" });
    expect(a.id).toBe("vip-口径");
    expect(fs.existsSync(path.join(memoryDir(ws, "alice"), "vip-口径.md"))).toBe(true);
    expect(readState(ws, "alice")["vip-口径"]).toBeTruthy();
    const b = createEntity(ws, "alice", { title: "VIP 口径", description: "第二条", body: "内容" });
    expect(b.id).toBe("vip-口径-2");
  });

  it("标题命中 profile 时避开常驻 profile 文件名", () => {
    const e = createEntity(ws, "alice", { title: "Profile", description: "d", body: "b" });
    expect(e.id).toBe("profile-2");
    expect(fs.existsSync(path.join(memoryDir(ws, "alice"), "profile.md"))).toBe(false);
    writeProfile(ws, "alice", "常驻");
    expect(readProfile(ws, "alice")).toBe("常驻");
  });

  it("创建校验：标题为空 / 正文为空 → 报错", () => {
    expect(() => createEntity(ws, "alice", { title: "!!!", description: "d", body: "b" })).toThrow("标题无法生成合法 id");
    expect(() => createEntity(ws, "alice", { title: "ok", description: "d", body: "  " })).toThrow("正文不能为空");
  });

  it("更新：改简介、追加正文、置顶；无变更 → 报错；body 与 append 互斥", () => {
    const e = createEntity(ws, "alice", { title: "a", description: "d", body: "第一行" });
    const u = updateEntity(ws, "alice", e.id, { description: "新简介", append: "第二行", pinned: true });
    expect(u.description).toBe("新简介");
    expect(u.body).toBe("第一行\n第二行");
    expect(u.pinned).toBe(true);
    expect(() => updateEntity(ws, "alice", e.id, {})).toThrow("没有要更新的内容");
    expect(() => updateEntity(ws, "alice", e.id, { body: "x", append: "y" })).toThrow("不能同时使用");
  });

  it("归档：pinned 先取消；归档不占用 id", () => {
    const e = createEntity(ws, "alice", { title: "a", description: "d", body: "b", pinned: true });
    expect(() => removeEntity(ws, "alice", e.id)).toThrow("已置顶");
    updateEntity(ws, "alice", e.id, { pinned: false });
    removeEntity(ws, "alice", e.id);
    expect(findEntity(ws, "alice", e.id)).toBeUndefined();
    expect(fs.existsSync(path.join(archiveDir(ws, "alice"), `${e.id}.md`))).toBe(true);
    expect(createEntity(ws, "alice", { title: "a", description: "d", body: "b" }).id).toBe(e.id);
  });

  it("扫描跳过坏文件；状态损坏按空处理", () => {
    createEntity(ws, "alice", { title: "ok", description: "d", body: "b" });
    fs.writeFileSync(path.join(memoryDir(ws, "alice"), "AGENTS.md"), "目录说明，不是实体");
    fs.writeFileSync(path.join(memoryDir(ws, "alice"), "broken.md"), "没有头");
    fs.writeFileSync(path.join(memoryDir(ws, "alice"), "bad-id.md"), "---\nid: other\ntitle: t\ndescription: d\n---\n\nx");
    fs.writeFileSync(path.join(memoryDir(ws, "alice"), ".state.json"), "{坏");
    const loaded = loadMemory(ws, "alice");
    expect(loaded.entities.map((e) => e.title)).toEqual(["ok"]);
    expect(loaded.errors).toHaveLength(2);
    expect(readState(ws, "alice")).toEqual({});
  });

  it("profile：读写 trim、空正文拒绝、超上限拒绝", () => {
    expect(readProfile(ws, "alice")).toBe("");
    expect(writeProfile(ws, "alice", "  身份  ")).toBe(Buffer.byteLength("身份"));
    expect(readProfile(ws, "alice")).toBe("身份");
    expect(() => writeProfile(ws, "alice", "   ")).toThrow("不能为空");
    expect(() => writeProfile(ws, "alice", "x".repeat(PROFILE_MAX_BYTES + 1))).toThrow("超过上限");
  });

  it("touch 写状态", () => {
    touch(ws, "alice", "x", "2026-01-01T00:00:00+08:00");
    expect(readState(ws, "alice")["x"]).toBe("2026-01-01T00:00:00+08:00");
  });
});
