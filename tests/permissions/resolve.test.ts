import { expect, test } from "vitest";
import { accumulatePermissions, resolvePermissionTable } from "../../src/permissions/resolve.ts";
import { DEFAULT_PERMISSIONS } from "../../src/permissions/defaults.ts";

test("相对路径按 baseDir 归一；绝对路径原样；空工具名跳过", () => {
  const table = resolvePermissionTable(
    { write: ["../shared"], read: ["./"], bash: ["/"], "  ": ["./x"] },
    "/office/agents/alice",
  );
  expect(table["write"]).toEqual(["/office/agents/shared"]);
  expect(table["read"]).toEqual(["/office/agents/alice"]);
  expect(table["bash"]).toEqual(["/"]);
  expect(table[""]).toBeUndefined();
});

test("累加：同名工具按来源顺序拼接、接受同值重复、不覆盖", () => {
  const merged = accumulatePermissions([
    { write: ["/a"] },
    { write: ["/b"], read: ["/c"] },
    { write: ["/a"] },
    {},
  ]);
  expect(merged["write"]).toEqual(["/a", "/b", "/a"]);
  expect(merged["read"]).toEqual(["/c"]);
});

test("默认值：write 空、read/bash 为 ./（D14）", () => {
  expect(DEFAULT_PERMISSIONS).toEqual({ write: [], read: ["./"], bash: ["./"] });
});
