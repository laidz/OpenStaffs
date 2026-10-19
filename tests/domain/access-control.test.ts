import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseMembers, projectsOf } from "../../src/domain/access-control.ts";
import { seedOffice } from "../helpers/office.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-acl-"));
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("parseMembers", () => {
  it("读项目 config 的 members（D22）", () => {
    const ws = seedOffice(tmp, { projects: [{ id: "yt", members: ["alice", "bob"] }] });
    expect(parseMembers(ws, "yt")).toEqual(["alice", "bob"]);
  });

  it("项目缺失 / 坏 JSON → 返回空（权限从严）", () => {
    const ws = seedOffice(tmp, { projects: [{ id: "yt", members: ["alice"] }] });
    expect(parseMembers(ws, "missing")).toEqual([]);
    fs.writeFileSync(path.join(tmp, "projects", "broken.project.config.json"), "{坏");
    expect(parseMembers(ws, "broken")).toEqual([]);
  });
});

describe("projectsOf", () => {
  it("找出员工是成员的项目", () => {
    const ws = seedOffice(tmp, { projects: [{ id: "yt", members: ["alice"] }, { id: "xhs", members: ["bob"] }] });
    expect(projectsOf(ws, "alice")).toEqual(["yt"]);
    expect(projectsOf(ws, "bob")).toEqual(["xhs"]);
    expect(projectsOf(ws, "carol")).toEqual([]);
  });
});
