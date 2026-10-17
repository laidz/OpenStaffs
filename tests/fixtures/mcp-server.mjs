#!/usr/bin/env node
import fs from "node:fs";

const mode = process.env.MCP_TEST_MODE ?? "normal";
const marker = process.env.MCP_TEST_MARKER;
const outputFile = process.env.MCP_TEST_OUTPUT;
const pidFile = process.env.MCP_TEST_PID_FILE;

if (pidFile !== undefined) fs.writeFileSync(pidFile, `${process.pid}\n`);

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function tools() {
  const base = [
    {
      name: "echo",
      description: "回显文本",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    },
    {
      name: "fail",
      description: "返回错误结果",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "image",
      description: "返回图片",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "slow",
      description: "延迟返回",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "busy",
      description: "忙 300ms 后返回",
      inputSchema: { type: "object", properties: {} },
    },
  ];
  if (mode === "many") {
    for (let i = 0; i < 30; i += 1) {
      base.push({ name: `tool_${i}`, description: `工具 ${i}`, inputSchema: { type: "object", properties: {} } });
    }
  }
  if (mode === "duplicate") {
    base.push({ name: "dup", description: "重复 1", inputSchema: { type: "object", properties: {} } });
    base.push({ name: "dup", description: "重复 2", inputSchema: { type: "object", properties: {} } });
  }
  return base;
}

function handleCall(message) {
  const name = message.params?.name;
  const args = message.params?.arguments ?? {};
  if (name === "echo") {
    if (outputFile !== undefined) fs.writeFileSync(outputFile, `echo:${args.text ?? ""}\n`);
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `echo:${args.text ?? ""}` }] } });
    return;
  }
  if (name === "fail") {
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "boom" }], isError: true } });
    return;
  }
  if (name === "image") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "image", data: "aGk=", mimeType: "image/png" }] },
    });
    return;
  }
  if (name === "slow") {
    setTimeout(() => {
      send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "slow-done" }] } });
    }, 500);
    return;
  }
  if (name === "busy") {
    // 同步阻塞事件循环，模拟同步 handler：期间 ping 无法被处理。
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "busy-done" }] } });
    return;
  }
  send({
    jsonrpc: "2.0",
    id: message.id,
    result: { content: [{ type: "text", text: `unknown:${name}` }], isError: true },
  });
}

function handle(message) {
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "ping") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "tools/list") {
    if (mode === "hang-list") return;
    if (mode === "slow-list") {
      setTimeout(() => {
        send({ jsonrpc: "2.0", id: message.id, result: { tools: tools() } });
      }, 300);
      return;
    }
    if (mode === "infinite-pages") {
      const start = Number(message.params?.cursor ?? 0);
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { tools: [{ name: `page_${start}`, inputSchema: { type: "object", properties: {} } }], nextCursor: String(start + 1) },
      });
      return;
    }
    if (mode === "paged") {
      const start = Number(message.params?.cursor ?? 0);
      const page = tools().slice(start, start + 2);
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { tools: page, ...(start + 2 < tools().length ? { nextCursor: String(start + 2) } : {}) },
      });
      return;
    }
    send({ jsonrpc: "2.0", id: message.id, result: { tools: tools() } });
    return;
  }
  if (message.method === "tools/call") {
    handleCall(message);
    return;
  }
  if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
  }
}

if (mode === "hang") {
  setInterval(() => {}, 1000);
} else {
  if (mode === "crash") {
    setTimeout(() => process.exit(17), 100);
  }
  if (mode === "crash-once" && marker !== undefined && !fs.existsSync(marker)) {
    fs.writeFileSync(marker, "crashed\n");
    // 先完成 initialize / tools/list，让管理器建立好扩展，再模拟崩溃。
    setTimeout(() => process.exit(17), 400);
  }
  process.stdin.setEncoding("utf8");
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line === "") continue;
      try {
        handle(JSON.parse(line));
      } catch {
        // fixture 不需要处理坏输入
      }
    }
  });
  process.on("SIGTERM", () => process.exit(0));
}
