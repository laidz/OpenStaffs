import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace, officeDbFile, stateDir } from "../../src/domain/paths.ts";
import { openStaffsToolDefs, type ToolContext } from "../../src/tools/registry.ts";
import { seedOffice } from "../helpers/office.ts";
import { touch } from "../../src/domain/memory/store.ts";
import type { Relation } from "../../src/domain/types.ts";
import { openSessionStore } from "../../src/store/sessions.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-memtools-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function ctx(employee = "alice"): ToolContext {
  seedOffice(root, {
    agents: [
      { id: "alice", model: "faux/faux-model" },
      { id: "bob", model: "faux/faux-model", memory: false },
    ],
  });
  const ws = createWorkspace(root);
  const relation: Relation = { kind: "dm", employeeId: employee };
  fs.mkdirSync(stateDir(ws), { recursive: true });
  return { ws, selfId: employee, relation, harness: {} as never, sessions: openSessionStore(officeDbFile(ws)) };
}

function tool(name: string) {
  const found = openStaffsToolDefs.find((t) => t.name === name);
  if (found === undefined) throw new Error(`工具不存在：${name}`);
  return found;
}

describe("memory_* 工具", () => {
  it("add → list → get → update → remove", async () => {
    const c = ctx();
    const added = await tool("memory_add").run({ title: "VIP 口径", description: "谈 VIP 时看", body: "正文" }, c);
    expect(added).toContain("vip-口径");
    expect(await tool("memory_list").run({}, c)).toContain("VIP 口径");
    const got = await tool("memory_get").run({ id: "vip-口径" }, c);
    expect(got).toContain("正文");
    await tool("memory_update").run({ id: "vip-口径", append: "追加" }, c);
    expect(await tool("memory_get").run({ id: "vip-口径" }, c)).toContain("追加");
    await tool("memory_remove").run({ id: "vip-口径" }, c);
    expect(await tool("memory_list").run({}, c)).toBe("（暂无记忆）");
  });

  it("profile show/set", async () => {
    const c = ctx();
    expect(await tool("memory_profile").run({ action: "show" }, c)).toBe("（还没有 profile）");
    expect(await tool("memory_profile").run({ action: "set", body: "我是 alice" }, c)).toContain("已写入 profile");
    expect(await tool("memory_profile").run({ action: "show" }, c)).toBe("我是 alice");
  });

  it("查询过滤、无变更报错、找不到报错", async () => {
    const c = ctx();
    await tool("memory_add").run({ title: "A", description: "做 A", body: "x" }, c);
    await tool("memory_add").run({ title: "B", description: "做 B", body: "y" }, c);
    expect(await tool("memory_list").run({ query: "做 b" }, c)).toContain("B");
    expect(await tool("memory_list").run({ query: "做 b" }, c)).not.toContain("A");
    await expect(tool("memory_update").run({ id: "a" }, c)).rejects.toThrow("没有要更新的内容");
    await expect(tool("memory_get").run({ id: "nope" }, c)).rejects.toThrow("找不到记忆");
  });

  it("过期：默认列表不显示，include_stale 可见，get 复活", async () => {
    const c = ctx();
    await tool("memory_add").run({ title: "老记忆", description: "旧", body: "x" }, c);
    touch(c.ws, "alice", "老记忆", "2025-01-01T00:00:00+08:00");
    expect(await tool("memory_list").run({}, c)).toBe("（暂无记忆）");
    expect(await tool("memory_list").run({ include_stale: true }, c)).toContain("老记忆");
    await tool("memory_get").run({ id: "老记忆" }, c);
    expect(await tool("memory_list").run({}, c)).toContain("老记忆");
  });

  it("关闭开关 → 统一报错", async () => {
    const c = ctx("bob");
    await expect(tool("memory_list").run({}, c)).rejects.toThrow("记忆未启用");
  });
});
