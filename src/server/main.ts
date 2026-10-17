import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkspace } from "../domain/paths.ts";
import { DEFAULT_PORT, readConfig } from "../domain/config.ts";
import { KeyedQueue } from "../app/send.ts";
import { createPiHarness } from "../harness/pi-durable.ts";
import { createOpenStaffsToolsExtension } from "../tools/extension.ts";
import { createConfiguredModels } from "./models.ts";
import { createHttpServer } from "./http.ts";
import { SseHub } from "./sse.ts";
import { Pump } from "./pump.ts";
import { resolveStartOptions } from "./startup.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const startup = resolveStartOptions({
    argv: process.argv,
    env: process.env,
    frameworkDir: path.resolve(here, "..", ".."),
  });
  if (!startup.ok) {
    console.error(`[openstaffs] ${startup.error}`);
    process.exit(1);
  }
  const root = startup.root;
  const ws = createWorkspace(root);
  const getConfig = () => readConfig(ws);
  const config = getConfig();
  const hub = new SseHub();
  let pump: Pump | undefined;

  let harness: ReturnType<typeof createPiHarness> | undefined;
  if (config !== undefined) {
    try {
      const models = await createConfiguredModels(config.providers);
      const tools = createOpenStaffsToolsExtension({ ws, getHarness: () => harness! });
      harness = createPiHarness({ root, sqlitePath: path.join(root, ".openstaffs", "state.sqlite"), models, extensions: [tools] });
      await harness.open();
      pump = new Pump({ ws, harness, hub });
      await pump.registerAll();
    } catch (error) {
      console.error(`[openstaffs] 启动失败：${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  } else {
    console.log(`[openstaffs] 未配置：请编辑 ${path.join(root, ".openstaffs", "config.json")} 后重启服务`);
  }

  const port = startup.port ?? config?.port ?? DEFAULT_PORT;
  const server = createHttpServer({
    ws,
    getConfig,
    getHarness: () => harness,
    queue: new KeyedQueue(),
    publicDir: path.join(here, "..", "..", "public"),
    pump,
    hub,
    port,
  });
  // 端口占用等监听失败：打印中文原因后退出（spec §3.1），不抛未捕获异常。
  server.on("error", (error: Error) => {
    console.error(`[openstaffs] 无法监听端口 ${port}：${error.message}（可在 .openstaffs/config.json 修改 port）`);
    process.exit(1);
  });
  server.listen(port, () => {
    console.log(`[openstaffs] 服务已启动：http://localhost:${port}（根目录 ${root}）`);
  });
}

void main();
