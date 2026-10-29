import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { probeHttpMcp, probeStdioMcp } from "../src/services/mcpProbe.ts";

const fakeServer = path.resolve(import.meta.dirname, "fixtures", "fake-mcp-stdio.cjs");

test("stdio: real handshake lists every tool across pages, args with spaces arrive whole", async () => {
  const result = await probeStdioMcp({ command: process.execPath, args: [fakeServer, "tool with space"] }, 10_000);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.serverName, "fake-mcp 9.9");
  assert.deepEqual(result.tools, ["alpha", "tool with space", "gamma"]);
  assert.match(result.message, /握手成功：fake-mcp 9\.9，协议 2025-06-18，发现 3 个工具/);
});

test("stdio: a program that exits or never speaks MCP is a failure, not a success", async () => {
  const crashed = await probeStdioMcp({ command: process.execPath, args: [fakeServer], env: { FAKE_MCP_MODE: "crash" } }, 10_000);
  assert.equal(crashed.ok, false);
  assert.match(crashed.message, /握手完成前退出了（exit 3）.*boom: missing config/);

  const silent = await probeStdioMcp({ command: process.execPath, args: [fakeServer], env: { FAKE_MCP_MODE: "silent" } }, 1500);
  assert.equal(silent.ok, false);
  assert.match(silent.message, /没有完成 MCP 握手/);

  const missing = await probeStdioMcp({ command: path.join(import.meta.dirname, "no-such-binary.exe"), args: [] }, 5000);
  assert.equal(missing.ok, false);
});

// 假的 Streamable HTTP MCP：initialize 用 JSON 回并发会话 ID，tools/list 用 SSE 回；带错令牌给 401。
const sessions: string[] = [];
const server = http.createServer((req, res) => {
  if (req.headers.authorization !== "Bearer good") {
    res.writeHead(401).end();
    return;
  }
  if (req.method === "DELETE") {
    res.writeHead(200).end();
    return;
  }
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const msg = JSON.parse(body);
    if (msg.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    if (msg.method === "initialize") {
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s-1" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-http" } } }));
      return;
    }
    sessions.push(String(req.headers["mcp-session-id"]));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": ping\n\n");
    res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "search" }] } })}\n\n`);
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
after(() => server.close());

test("http: handshake over JSON + SSE replies and keeps the session id", async () => {
  const result = await probeHttpMcp({ url, headers: { Authorization: "Bearer good" } }, 5000);
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.tools, ["search"]);
  assert.deepEqual(sessions, ["s-1"]);
});

test("http: auth failure and unreachable address are explained", async () => {
  const denied = await probeHttpMcp({ url, headers: { Authorization: "Bearer bad" } }, 5000);
  assert.equal(denied.ok, false);
  assert.match(denied.message, /没通过认证（HTTP 401）/);

  const unreachable = await probeHttpMcp({ url: "http://127.0.0.1:1/mcp" }, 5000);
  assert.equal(unreachable.ok, false);
  assert.match(unreachable.message, /连接失败/);
});
