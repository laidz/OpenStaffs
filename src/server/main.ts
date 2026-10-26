import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createWorkspace, officeDbFile, stateDir } from "../domain/paths.ts";
import { spaceConfigFile } from "../domain/space.ts";
import { loadSpaceConfig } from "../config/load.ts";
import { staff0File } from "../domain/staff0.ts";
import { DEFAULT_PORT, configFile, readConfig } from "../domain/config.ts";
import { PermissionRequestStore } from "../domain/permission-requests.ts";
import { permissionRequestView } from "../app/permission-flow.ts";
import { sessionDefaults } from "../app/conversations.ts";
import { createNamer } from "../app/naming.ts";
import type { SessionTitleDeps } from "../app/sessions.ts";
import { KeyedQueue } from "../app/send.ts";
import { Outbox } from "../app/outbox.ts";
import { openMessageStore, type MessageStore } from "../store/messages.ts";
import { openSessionStore, type SessionStore } from "../store/sessions.ts";
import { importLegacyChains } from "../store/chain-import.ts";
import { createPiHarness } from "../harness/pi-durable.ts";
import { McpManager } from "../harness/mcp-manager.ts";
import { createOpenStaffsToolsExtension } from "../tools/extension.ts";
import { ensureSpace } from "./bootstrap.ts";
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
  // 启动探测（P4）：新建空间写入空 space.config.json + 首次启动自动建 Staff0；失败不抛（逐项记 failed）。
  const bootstrap = ensureSpace(ws);
  if (bootstrap.newSpace) console.log(`[openstaffs] 新建空间：已生成 ${spaceConfigFile(ws)}`);
  if (bootstrap.staff0 === "created") console.log(`[openstaffs] 已创建 0 号员工：${staff0File(ws)}`);
  if (bootstrap.spaceConfig === "failed" || bootstrap.staff0 === "failed") {
    console.error("[openstaffs] 空间初始化未完成（空间目录可能不可写）：请检查目录权限后重启");
  }
  const getConfig = () => readConfig(ws);
  const config = getConfig();
  const hub = new SseHub();
  // 与 HTTP 发送共享：同成员的老板消息与群回复 @触发按同一队列串行进入。
  const queue = new KeyedQueue();
  // 与 HTTP 端点共享：排队中的老板消息（前端展示「排队中」与单条撤回）。
  const outbox = new Outbox();
  const permissionRequests = new PermissionRequestStore(ws);
  // 自有消息库（P1）：全进程唯一实例，注入 pump 与 HTTP 发送路径。
  // openMessageStore 现在会自建父目录；这里仍先确保 stateDir 存在（state.sqlite 等也落在同目录）。
  // 开库失败（坏库 / 非 SQLite 文件 / 权限）走与下方一致的「启动失败」提示后退出，而不是裸崩未处理 rejection。
  fs.mkdirSync(stateDir(ws), { recursive: true });
  let store: MessageStore;
  let sessionStore: SessionStore;
  try {
    store = openMessageStore(officeDbFile(ws));
    // 会话表 = 会话的唯一真相（convId 就是 Pi 的 conversation id）；与消息同一库文件。
    sessionStore = openSessionStore(officeDbFile(ws));
    // 一次性迁移：老的会话链 markdown（`work/<人>/conversation_ids.md`、`.data/chains/group-*/<人>.md`）导入会话表后退役。
    const imported = importLegacyChains(ws, sessionStore);
    if (imported.imported > 0) console.log(`[openstaffs] 会话链已迁移入库：${imported.imported} 条（旧文件已备份到 .data/legacy-chains）`);
  } catch (error) {
    console.error(`[openstaffs] 启动失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  let pump: Pump | undefined;
  let mcp: McpManager | undefined;
  // 会话标题依赖：new 会话命名 / 改名端点写入，全进程一份（与 HTTP 注入同一个）。
  let titles: SessionTitleDeps = { store: sessionStore };

  let harness: ReturnType<typeof createPiHarness> | undefined;
  if (config !== undefined) {
    try {
      const models = await createConfiguredModels(config.providers);
      // 自动命名：模型由空间配置 namingModel 指定（必须是非思考模型）；不可用则只留时间标题。
      const namingModel = loadSpaceConfig(ws)?.fields.namingModel;
      const namer = createNamer({ models, ...(namingModel === undefined ? {} : { namingModel }) });
      titles = {
        store: sessionStore,
        notify: (event) => hub.broadcast({ type: "session.title", ...event }),
        ...(namer === undefined ? {} : { namer }),
      };
      mcp = new McpManager({ ws });
      await mcp.start();
      if (mcp.errors().length > 0) {
        console.error(`[openstaffs] MCP 启动有 ${mcp.errors().length} 个问题（详见上方日志）`);
      }
      const tools = createOpenStaffsToolsExtension({
        ws,
        getHarness: () => harness!,
        mcp,
        sessions: sessionStore,
        permissions: {
          store: permissionRequests,
          notify: (request) => hub.broadcast({ type: "permission.request", request: permissionRequestView(ws, request) }),
        },
        // 员工发言（send_message）落库后广播库行（R-P1-12「谁写谁广播」）。
        broadcast: (roomKey, message) => hub.broadcast({ type: "room.message", roomKey, message }),
      });
      harness = createPiHarness({
        root,
        sqlitePath: path.join(stateDir(ws), "state.sqlite"),
        models,
        extensions: [tools],
        mcpExtensions: mcp.extensions(),
        toolSearch: mcp.needsToolSearch(),
      });
      await harness.open();
      pump = new Pump({
        ws,
        harness,
        hub,
        queue,
        outbox,
        store,
        sessions: sessionStore,
        mcp,
        getDefaults: () => sessionDefaults(getConfig()),
      });
      await pump.registerAll();
    } catch (error) {
      console.error(`[openstaffs] 启动失败：${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  } else {
    console.log(`[openstaffs] 未配置：请编辑 ${configFile(ws)} 后重启服务`);
  }

  const port = startup.port ?? config?.port ?? DEFAULT_PORT;
  const server = createHttpServer({
    ws,
    store,
    sessions: sessionStore,
    getConfig,
    getHarness: () => harness,
    queue,
    outbox,
    publicDir: path.join(here, "..", "..", "public"),
    pump,
    hub,
    port,
    permissionRequests,
    titles,
    ...(mcp === undefined ? {} : { mcp }),
  });
  // 端口占用等监听失败：打印中文原因后退出（spec §3.1），不抛未捕获异常。
  server.on("error", (error: Error) => {
    console.error(`[openstaffs] 无法监听端口 ${port}：${error.message}（可在 openstaffs/.data/config.json 修改 port）`);
    process.exit(1);
  });
  server.listen(port, () => {
    console.log(`[openstaffs] 服务已启动：http://localhost:${port}（根目录 ${root}）`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[openstaffs] 收到 ${signal}，正在退出…`);
    await mcp?.close().catch(() => undefined);
    await harness?.close().catch(() => undefined);
    store.close();
    sessionStore.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

void main();
