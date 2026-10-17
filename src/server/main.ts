import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkspace } from "../domain/paths.ts";
import { DEFAULT_PORT, readConfig } from "../domain/config.ts";
import { PermissionRequestStore } from "../domain/permission-requests.ts";
import { permissionRequestView } from "../app/permission-flow.ts";
import { KeyedQueue } from "../app/send.ts";
import { Outbox } from "../app/outbox.ts";
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
  // 与 HTTP 发送共享：同成员的老板消息与群回复 @触发按同一队列串行进入。
  const queue = new KeyedQueue();
  // 与 HTTP 端点共享：排队中的老板消息（前端展示「排队中」与单条撤回）。
  const outbox = new Outbox();
  const permissionRequests = new PermissionRequestStore(ws);
  let pump: Pump | undefined;

  let harness: ReturnType<typeof createPiHarness> | undefined;
  if (config !== undefined) {
    try {
      const models = await createConfiguredModels(config.providers);
      const tools = createOpenStaffsToolsExtension({
        ws,
        getHarness: () => harness!,
        permissions: {
          store: permissionRequests,
          notify: (request) => hub.broadcast({ type: "permission.request", request: permissionRequestView(ws, request) }),
        },
      });
      harness = createPiHarness({ root, sqlitePath: path.join(root, ".openstaffs", "state.sqlite"), models, extensions: [tools] });
      await harness.open();
      pump = new Pump({
        ws,
        harness,
        hub,
        queue,
        outbox,
        getDefaults: () => {
          const current = getConfig();
          return current === undefined ? undefined : { model: current.model };
        },
      });
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
    queue,
    outbox,
    publicDir: path.join(here, "..", "..", "public"),
    pump,
    hub,
    port,
    permissionRequests,
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
