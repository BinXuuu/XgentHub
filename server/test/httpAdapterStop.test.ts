import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { setupIsolatedDb, waitFor } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("http-adapter-stop");
const { db } = await import("../src/db/index.ts");
const { createWorkspace } = await import("../src/services/workspaceService.ts");
const { taskManager } = await import("../src/services/taskManager.ts");
const { createCustomAgent, deleteCustomAgent } = await import("../src/services/customAgentService.ts");

after(() => {
  db.close();
  env.cleanup();
});

// 自定义 API Agent（CustomApiAdapter）代表这一批走 fetch 的 HTTP adapter（Ollama/Doubao/
// TokenEZGO/Hermes 都是同一套 AbortController 写法）：起一个本地 SSE 服务端，发完一个 chunk
// 之后故意不关连接——如果 stop() 真的 abort 了底层 fetch，任务应该很快变成 stopped；
// 如果 stop() 只是摆设，dispatch() 会一直卡在 reader.read() 上，直到测试超时都不会收尾。
test("stopTask actually aborts the underlying fetch for HTTP-based adapters instead of just flipping the status flag", async () => {
  let requestReceived = false;
  const server = http.createServer((req, res) => {
    requestReceived = true;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "片段" } }] })}\n\n`);
    // 故意不调用 res.end()：模拟一个会一直流式吐内容、不主动结束的慢响应。
    req.on("aborted", () => res.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind test server");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const workspace = createWorkspace({ name: "HTTP Adapter Stop Workspace", path: env.root, allowedAgentKinds: ["custom-api"] });
  const agent = createCustomAgent({ template: "api", name: "测试慢速 HTTP Agent", baseUrl, apiKey: "test-key", defaultModel: "test-model" });

  try {
    const task = taskManager.createTask({
      agentId: agent.id,
      workspaceId: workspace.id,
      title: "停止一个挂起的 HTTP 流式请求",
      prompt: "开始一个会一直流式吐内容、不结束的请求",
      permissionMode: "full",
      actor: "test",
    });

    // 派发前要先拍工作区快照，所以光等 status=running 不够：要等服务端真的收到请求、fetch 挂在半路上再停。
    await waitFor(() => (requestReceived && taskManager.getTask(task.id)?.status === "running" ? true : null), {
      timeoutMs: 15000,
      description: "custom-api request is in flight before we stop it",
    });

    const startedStoppingAt = Date.now();
    await taskManager.stopTask(task.id, "test");
    const stopCallDurationMs = Date.now() - startedStoppingAt;

    assert.ok(stopCallDurationMs < 3000, `stopTask() 耗时 ${stopCallDurationMs}ms，看起来没有真的 abort 底层请求，而是在等它自然结束`);
    assert.equal(taskManager.getTask(task.id)?.status, "stopped");

    // abort 之后 dispatch() 的 catch 分支是异步落地的，给它一点时间收尾再进下一个 test/关库。
    await new Promise((resolve) => setTimeout(resolve, 500));
  } finally {
    deleteCustomAgent(agent.id);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
