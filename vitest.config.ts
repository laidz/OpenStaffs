import { defineConfig, type Plugin } from "vitest/config";

/**
 * 测试环境专用的解析 shim，勿删。
 *
 * vite-node 2.1.9 的内置模块名单 `prefixedBuiltins` 只含 `node:test`，不认识实验性的 `node:sqlite`，
 * 于是把 `import ... from "node:sqlite"` 当裸包解析（报 "Failed to load url sqlite"）。
 * 生产走 node 原生支持（`npm start` 直接跑 TS，不经 vite），只有 vitest 需要这层重写：
 * 把该模块映射成等价虚拟模块，内部用 createRequire 加载真正的 `node:sqlite`。
 */
function nodeSqliteShim(): Plugin {
  const VIRTUAL_ID = "\0node-sqlite-shim";
  return {
    name: "node-sqlite-shim",
    enforce: "pre",
    resolveId(id) {
      if (id === "node:sqlite") return VIRTUAL_ID;
    },
    load(id) {
      if (id === VIRTUAL_ID) {
        return 'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\nexport const DatabaseSync = require("node:sqlite").DatabaseSync;';
      }
    },
  };
}

export default defineConfig({ plugins: [nodeSqliteShim()] });
