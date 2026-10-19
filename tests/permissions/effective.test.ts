import { expect, test } from "vitest";
import { effectivePermissions, pathsFor } from "../../src/permissions/effective.ts";

const runtime = {
  workdir: "/office/work/alice",
  readRoots: ["/office/openstaffs/skills", "/framework/skills"],
  managedWriteDirs: ["/office/agents/eng"],
};

test("有效集 = 落盘累加 + 运行时工作目录（所有工具）+ 主管写权（write）+ 技能根（read）", () => {
  const perms = effectivePermissions({
    onDisk: [
      { table: { write: [], read: ["./"], bash: ["./"] }, baseDir: "/office/projects" },
      { table: { write: [], read: ["./"], bash: ["./"] }, baseDir: "/office/agents/eng" },
    ],
    runtime,
  });
  expect(perms["write"]).toEqual(["/office/work/alice", "/office/agents/eng"]);
  expect(perms["read"]).toEqual([
    "/office/projects", "/office/agents/eng", "/office/work/alice", "/office/openstaffs/skills", "/framework/skills",
  ]);
  expect(perms["bash"]).toEqual(["/office/projects", "/office/agents/eng", "/office/work/alice"]);
});

// 只带工作目录的运行时授予（无 readRoots / managedWriteDirs）——隔离「工作目录对所有工具生效」。
const workdirOnly = { workdir: "/office/work/alice", readRoots: [], managedWriteDirs: [] };

test("未登记的工具：pathsFor 只回运行时工作目录（D13① / 新工具默认空 D14）", () => {
  const perms = effectivePermissions({ onDisk: [], runtime: workdirOnly });
  expect(perms["write"]).toEqual(["/office/work/alice"]);
  expect(pathsFor(perms, "future_tool", "/office/work/alice")).toEqual(["/office/work/alice"]);
  expect(pathsFor(perms, "write", "/office/work/alice")).toEqual(["/office/work/alice"]);
});
