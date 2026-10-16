import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isWriteAllowedByPermission, matchesPermission, readPermissionPaths,
} from "../../src/domain/permissions.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-perm-"));
beforeEach(() => { fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root, { recursive: true }); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe("readPermissionPaths", () => {
  it("读字符串数组", () => {
    const f = path.join(root, "permission.json");
    write(f, JSON.stringify(["./data/", "/abs/x"]));
    expect(readPermissionPaths(f)).toEqual(["./data/", "/abs/x"]);
  });

  it("缺失/坏 JSON/非数组 → 安全降级", () => {
    expect(readPermissionPaths(path.join(root, "nope.json"))).toEqual([]);
    const bad = path.join(root, "bad.json"); write(bad, "{ not json");
    expect(readPermissionPaths(bad)).toEqual([]);
    const obj = path.join(root, "obj.json"); write(obj, JSON.stringify({ write: [] }));
    expect(readPermissionPaths(obj)).toEqual([]);
  });

  it("含非字符串元素 → 整份忽略（spec §3/§6/§8）；空/空白条目跳过", () => {
    const mixed = path.join(root, "mixed.json"); write(mixed, JSON.stringify(["./a", 5]));
    expect(readPermissionPaths(mixed)).toEqual([]);
    const blanks = path.join(root, "blanks.json"); write(blanks, JSON.stringify(["./a", "", "  "]));
    expect(readPermissionPaths(blanks)).toEqual(["./a"]);
  });

  it("条目两端空白 trim（D12）", () => {
    const f = path.join(root, "spaced.json");
    write(f, JSON.stringify([" ./data ", "./x "]));
    expect(readPermissionPaths(f)).toEqual(["./data", "./x"]);
  });
});

describe("matchesPermission", () => {
  const dir = "/company/agents/alice";

  it("目录条目含其全部下级", () => {
    expect(matchesPermission(["./data/"], dir, "/company/agents/alice/data")).toBe(true);
    expect(matchesPermission(["./data/"], dir, "/company/agents/alice/data/a/b.md")).toBe(true);
  });

  it("不误命中兄弟目录", () => {
    expect(matchesPermission(["./data/"], dir, "/company/agents/alice/data2/x.md")).toBe(false);
    expect(matchesPermission(["./data/"], dir, "/company/agents/alice/dataX")).toBe(false);
  });

  it("../ 相对该文件所在目录归一", () => {
    expect(matchesPermission(["../bob/notes.md"], dir, "/company/agents/bob/notes.md")).toBe(true);
    expect(matchesPermission(["../bob/notes.md"], dir, "/company/agents/bob/other.md")).toBe(false);
  });

  it("绝对条目", () => {
    expect(matchesPermission(["/shared/x"], "/whatever", "/shared/x/y")).toBe(true);
    expect(matchesPermission(["/shared/x"], "/whatever", "/shared/y/x")).toBe(false);
  });

  it("大小写敏感", () => {
    expect(matchesPermission(["/Shared/"], "/", "/shared/a")).toBe(false);
  });

  it("条目 \"/\" = 授权全盘", () => {
    expect(matchesPermission(["/"], "/whatever", "/etc/passwd")).toBe(true);
    expect(matchesPermission(["/"], "/whatever", "/")).toBe(true);
  });

  it("trim 后的相对条目按目录子树命中", () => {
    const f = path.join(root, "subtree.json");
    write(f, JSON.stringify([" ./data "]));
    expect(matchesPermission(readPermissionPaths(f), dir, "/company/agents/alice/data/a.md")).toBe(true);
  });
});

describe("isWriteAllowedByPermission", () => {
  it("任一文件命中即 true", () => {
    const proj = path.join(root, "projects", "yt", "permission.json");
    write(proj, JSON.stringify(["../../agents/bob/"]));
    expect(isWriteAllowedByPermission([proj], path.join(root, "agents", "bob", "x.md"))).toBe(true);
    expect(isWriteAllowedByPermission([proj], path.join(root, "agents", "carol", "x.md"))).toBe(false);
  });

  it("坏/缺文件 → false（不放大权限）", () => {
    expect(isWriteAllowedByPermission([path.join(root, "nope.json")], path.join(root, "agents", "bob", "x.md"))).toBe(false);
  });
});
