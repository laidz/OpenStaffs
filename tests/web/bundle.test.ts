import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

describe("web bundle 守卫", () => {
  it("web/main.ts 可打成浏览器 bundle（web → src 值导入不得引入 node 内置模块）", async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "openstaffs-bundle-"));
    try {
      await build({
        entryPoints: [path.join(process.cwd(), "web", "main.ts")],
        bundle: true,
        format: "esm",
        target: "es2022",
        outfile: path.join(outDir, "app.js"),
        logLevel: "silent",
      });
      const code = fs.readFileSync(path.join(outDir, "app.js"), "utf8");
      expect(code).not.toMatch(/["']node:/u);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
