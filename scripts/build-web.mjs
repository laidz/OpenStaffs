import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const outDir = path.join(root, "public");
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(root, "web", "main.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: path.join(outDir, "app.js"),
  logLevel: "silent",
});

fs.copyFileSync(path.join(root, "web", "index.html"), path.join(outDir, "index.html"));
fs.copyFileSync(path.join(root, "web", "styles.css"), path.join(outDir, "styles.css"));
console.log("[build-web] public/ 已生成");
