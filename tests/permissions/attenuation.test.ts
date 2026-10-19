import { expect, test } from "vitest";
import { checkAttenuation } from "../../src/permissions/attenuation.ts";
import { effectivePermissions } from "../../src/permissions/effective.ts";

const writer = effectivePermissions({
  onDisk: [{ table: { write: ["../eng", "../../work/alice"], read: ["./"], bash: [] }, baseDir: "/office/agents/alice" }],
  runtime: { workdir: "/office/work/alice", readRoots: [], managedWriteDirs: [] },
});

test("请求 ⊆ 写者有效集 → ok（子目录可授）", () => {
  expect(checkAttenuation({ write: ["./platform"] }, "/office/agents/eng", writer, "/office/work/alice")).toEqual({ ok: true });
  expect(checkAttenuation({}, "/office/agents/eng", writer, "/office/work/alice")).toEqual({ ok: true });
  expect(checkAttenuation({ write: [] }, "/office/agents/eng", writer, "/office/work/alice")).toEqual({ ok: true });
});

test("越界 → 报出越界的工具与路径（父目录 / 界外 / 别的工具）", () => {
  const bad = checkAttenuation(
    { write: ["/etc", "../..", "/office/agents/eng"], read: ["/office/agents/bob"] },
    "/office/agents/eng/platform",
    writer,
    "/office/work/alice",
  );
  expect(bad.ok).toBe(false);
  if (bad.ok) return;
  expect(bad.violations).toEqual([
    { tool: "write", paths: ["/etc", "/office/agents"] },
    { tool: "read", paths: ["/office/agents/bob"] },
  ]);
});

test("大小写敏感：只差大小写的路径判越界", () => {
  const bad = checkAttenuation({ write: ["/office/agents/ENG"] }, "/", writer, "/office/work/alice");
  expect(bad).toEqual({ ok: false, violations: [{ tool: "write", paths: ["/office/agents/ENG"] }] });
});

test("授权 \"/\" 可写全盘；未授权 \"/\" 时请求 \"/\" 越界", () => {
  const rootWriter = effectivePermissions({
    onDisk: [{ table: { write: ["/"] }, baseDir: "/" }],
    runtime: { workdir: "/office/work/alice", readRoots: [], managedWriteDirs: [] },
  });
  expect(checkAttenuation({ write: ["/etc/passwd"] }, "/", rootWriter, "/office/work/alice")).toEqual({ ok: true });
  const bad = checkAttenuation({ write: ["/"] }, "/", writer, "/office/work/alice");
  expect(bad.ok).toBe(false);
  if (bad.ok) return;
  expect(bad.violations).toEqual([{ tool: "write", paths: ["/"] }]);
});

test("空集恒 ⊆ 任意集（含写者无该工具授权）", () => {
  expect(checkAttenuation({ future_tool: [] }, "/office/agents/eng", writer, "/office/work/alice")).toEqual({ ok: true });
  expect(checkAttenuation({ bash: [] }, "/office/agents/eng", writer, "/office/work/alice")).toEqual({ ok: true });
});
