import fs from "node:fs";
import path from "node:path";

export type StartupResolution =
  | { ok: true; root: string; port: number | undefined }
  | { ok: false; error: string };

const USAGE =
  "用法：npm start -- /path/to/your-office [port]；或 OPENSTAFFS_ROOT=/path/to/your-office OPENSTAFFS_PORT=4319 npm start";

/**
 * 解析启动选项：
 * - 办公空间目录**必填**（CLI 第二参优先，其次 `OPENSTAFFS_ROOT`）——不默认 cwd、不允许等于框架目录（框架与办公数据分离）；
 * - 端口可选（CLI 第三参优先，其次 `OPENSTAFFS_PORT`）——未提供时返回 undefined，由调用方回落 config.json / 默认值。
 */
export function resolveStartOptions(options: {
  argv: readonly string[];
  env: Record<string, string | undefined>;
  frameworkDir: string;
}): StartupResolution {
  const argRoot = options.argv[2];
  const envRoot = options.env.OPENSTAFFS_ROOT;
  const chosenRoot = argRoot !== undefined && argRoot.trim() !== "" ? argRoot : envRoot;
  if (chosenRoot === undefined || chosenRoot.trim() === "") {
    return { ok: false, error: `必须指定办公空间目录。${USAGE}` };
  }
  const resolved = path.resolve(chosenRoot);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return { ok: false, error: `办公空间目录不存在或不是目录：${resolved}` };
  }
  let root: string;
  let frameworkDir: string;
  try {
    root = fs.realpathSync(resolved);
    frameworkDir = fs.realpathSync(path.resolve(options.frameworkDir));
  } catch (error) {
    return { ok: false, error: `无法解析路径：${error instanceof Error ? error.message : String(error)}` };
  }
  if (root === frameworkDir) {
    return { ok: false, error: "办公空间目录不能是框架目录本身：办公数据请使用独立目录（框架与办公数据分离）" };
  }

  const argPort = options.argv[3];
  const chosenPort = argPort !== undefined ? argPort : options.env.OPENSTAFFS_PORT;
  let port: number | undefined;
  if (chosenPort !== undefined) {
    if (!/^\d+$/u.test(chosenPort)) {
      return { ok: false, error: `端口不合法：${JSON.stringify(chosenPort)}（必须是 1–65535 的整数）。${USAGE}` };
    }
    port = Number(chosenPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, error: `端口不合法：${JSON.stringify(chosenPort)}（必须是 1–65535 的整数）。${USAGE}` };
    }
  }
  return { ok: true, root, port };
}
