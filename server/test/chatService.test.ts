import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { setupIsolatedDb } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("chat-service");
const { db } = await import("../src/db/index.ts");
const { waitForSnapshotsIdle } = await import("../src/services/workspaceSnapshotService.ts");
const { chatService } = await import("../src/services/chatService.ts");
const { createCustomAgent, deleteCustomAgent } = await import("../src/services/customAgentService.ts");
const { createMcpServer, deleteMcpServer } = await import("../src/services/mcpServerService.ts");

after(async () => {
  await waitForSnapshotsIdle();
  db.close();
  env.cleanup();
});

/** 起一个本地 OpenAI 兼容 echo 服务：把收到的请求体原样记下来，回一句看得出来的假回复。 */
function startEchoServer(): Promise<{ baseUrl: string; lastRequestBody: () => any; close: () => Promise<void> }> {
  let lastBody: any = null;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        lastBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        lastBody = null;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: `echo:${lastBody?.model ?? "no-model"}` } }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("failed to bind echo server");
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        lastRequestBody: () => lastBody,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

test("createChat persists model and mcpServerIds, and round-trips them through getChat", () => {
  const agent = createCustomAgent({ template: "api", name: "测试 Echo Agent", baseUrl: "http://127.0.0.1:1", apiKey: "k" });
  const mcp = createMcpServer({ name: "测试 MCP", transport: "stdio", command: "node", args: ["-e", "1"] });
  try {
    const chat = chatService.createChat({ agentId: agent.id, title: "带模型和 MCP 的聊天", model: "gpt-test", mcpServerIds: [mcp.id] });
    assert.equal(chat.model, "gpt-test");
    assert.deepEqual(chat.mcpServerIds, [mcp.id]);

    const reloaded = chatService.getChat(chat.id);
    assert.equal(reloaded?.model, "gpt-test");
    assert.deepEqual(reloaded?.mcpServerIds, [mcp.id]);
  } finally {
    deleteCustomAgent(agent.id);
    deleteMcpServer(mcp.id);
  }
});

test("setChatMcpServers updates and dedupes mcpServerIds without touching model", () => {
  const agent = createCustomAgent({ template: "api", name: "测试 Echo Agent 2", baseUrl: "http://127.0.0.1:1", apiKey: "k" });
  const mcpA = createMcpServer({ name: "MCP A", transport: "stdio", command: "node" });
  const mcpB = createMcpServer({ name: "MCP B", transport: "stdio", command: "node" });
  try {
    const chat = chatService.createChat({ agentId: agent.id, title: "待改 MCP 的聊天", model: "keep-me" });
    const updated = chatService.setChatMcpServers(chat.id, [mcpA.id, mcpB.id, mcpA.id]);
    assert.deepEqual(new Set(updated.mcpServerIds), new Set([mcpA.id, mcpB.id]));
    assert.equal(updated.mcpServerIds.length, 2);
    assert.equal(updated.model, "keep-me", "setChatMcpServers 不应该动 model 字段");
  } finally {
    deleteCustomAgent(agent.id);
    deleteMcpServer(mcpA.id);
    deleteMcpServer(mcpB.id);
  }
});

test("updateChatAgent switches agent and clears model, but leaves mcpServerIds untouched", () => {
  const agentA = createCustomAgent({ template: "api", name: "Agent A", baseUrl: "http://127.0.0.1:1", apiKey: "k" });
  const agentB = createCustomAgent({ template: "api", name: "Agent B", baseUrl: "http://127.0.0.1:1", apiKey: "k" });
  const mcp = createMcpServer({ name: "切 Agent 后还在的 MCP", transport: "stdio", command: "node" });
  try {
    const chat = chatService.createChat({ agentId: agentA.id, title: "切 Agent 测试", model: "agent-a-model", mcpServerIds: [mcp.id] });
    const updated = chatService.updateChatAgent(chat.id, agentB.id);
    assert.equal(updated.agentId, agentB.id);
    assert.equal(updated.model, null, "切换 Agent 之后旧的 model 可能不适用于新 Agent，应该清空");
    assert.deepEqual(updated.mcpServerIds, [mcp.id], "MCP 选择不是 Agent 专属的，切 Agent 不应该被清空");
  } finally {
    deleteCustomAgent(agentA.id);
    deleteCustomAgent(agentB.id);
    deleteMcpServer(mcp.id);
  }
});

test("sendMessage resolves chat.model and forwards it all the way down to the real HTTP call", async () => {
  const echo = await startEchoServer();
  const agent = createCustomAgent({ template: "api", name: "真实转发测试 Agent", baseUrl: echo.baseUrl, apiKey: "k" });
  try {
    const chat = chatService.createChat({ agentId: agent.id, title: "模型转发测试", model: "forwarded-model" });
    const { userMessage, agentMessage } = await chatService.sendMessage(chat.id, "你好");

    assert.equal(userMessage.content, "你好");
    assert.equal(agentMessage.content, "echo:forwarded-model", "chat.model 应该原样出现在真实发出的 HTTP 请求体里");
    assert.equal(echo.lastRequestBody()?.model, "forwarded-model");

    const finished = chatService.getChat(chat.id);
    assert.equal(finished?.status, "idle", "成功完成一轮之后应该回到 idle，而不是停在 running");

    const messages = chatService.listMessages(chat.id);
    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.role, "user");
    assert.equal(messages[1]?.role, "agent");
  } finally {
    deleteCustomAgent(agent.id);
    await echo.close();
  }
});

test("sendMessage never gets stuck on running when the underlying call fails, and rejects a second send while one is in flight", async () => {
  // 延迟 400ms 再回 500：既给了测试窗口去观察中间的 running 状态（验证并发保护），
  // 又能让第一条请求最终走到 dispatch() 的失败分支（验证不会卡在 running 上出不来）。
  const server = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("boom");
    }, 400);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind stall server");
  const agent = createCustomAgent({
    template: "api",
    name: "挂起测试 Agent",
    baseUrl: `http://127.0.0.1:${address.port}`,
    apiKey: "k",
    defaultModel: "stall-test-model",
  });
  try {
    const chat = chatService.createChat({ agentId: agent.id, title: "并发发送测试" });
    const firstSend = chatService.sendMessage(chat.id, "第一条消息");
    // 给第一条一点时间真正把状态改成 running，再发第二条去验证并发保护。
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(chatService.getChat(chat.id)?.status, "running");
    await assert.rejects(() => chatService.sendMessage(chat.id, "第二条消息"), /正在回复/);

    // ask() 失败时会抛出带原因的错误：这一轮标成"失败"，并把 HTTP 状态和响应体告诉用户。
    const { agentMessage } = await firstSend;
    assert.equal(agentMessage.content, "调用失败：挂起测试 Agent 返回 HTTP 500：boom");
    assert.equal(chatService.getChat(chat.id)?.status, "failed");
  } finally {
    deleteCustomAgent(agent.id);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a failed chat call shows the real reason: the API's own error message, or that the service is unreachable", async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid API key provided" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind error server");
  const rejecting = createCustomAgent({ template: "api", name: "密钥错误 Agent", baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "bad", defaultModel: "m" });
  const unreachable = createCustomAgent({ template: "api", name: "没启动的 Agent", baseUrl: "http://127.0.0.1:1", apiKey: "k", defaultModel: "m" });
  try {
    const chat = chatService.createChat({ agentId: rejecting.id, title: "密钥错误" });
    const { agentMessage } = await chatService.sendMessage(chat.id, "你好");
    assert.equal(agentMessage.content, "调用失败：密钥错误 Agent 返回 HTTP 401：Invalid API key provided");
    assert.equal(chatService.getChat(chat.id)?.status, "failed");

    const offline = chatService.createChat({ agentId: unreachable.id, title: "服务没启动" });
    const reply = await chatService.sendMessage(offline.id, "你好");
    assert.match(reply.agentMessage.content, /^调用失败：连不上 没启动的 Agent：/);
    assert.equal(chatService.getChat(offline.id)?.status, "failed");

    // 失败之后还能接着发（状态没卡在 running）。
    const retry = await chatService.sendMessage(offline.id, "再试一次");
    assert.match(retry.agentMessage.content, /^调用失败：连不上/);
  } finally {
    deleteCustomAgent(rejecting.id);
    deleteCustomAgent(unreachable.id);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
