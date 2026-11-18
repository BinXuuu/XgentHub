import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupIsolatedDb, waitFor } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("codex-mcp-sync");
const home = path.join(env.root, "codex-home");
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-test-0000" }));
process.env.CODEX_HOME = home;
process.env.CODEX_ACCOUNTS_DIR = path.join(env.root, "codex-accounts");

const fakeScript = path.resolve(import.meta.dirname, "fixtures", "fake-codex.cjs");
const logFile = path.join(env.root, "codex-calls.jsonl");
const listFile = path.join(env.root, "mcp-list.json");
const shim = path.join(env.root, process.platform === "win32" ? "fake-codex.cmd" : "fake-codex.sh");
if (process.platform === "win32") fs.writeFileSync(shim, `@"${process.execPath}" "${fakeScript}" %*\r\n`);
else fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fakeScript}" "$@"\n`, { mode: 0o755 });
process.env.CODEX_BIN = shim;
process.env.FAKE_CODEX_LOG = logFile;
process.env.FAKE_CODEX_MCP_LIST = listFile;

const { db } = await import("../src/db/index.ts");
const { createWorkspace } = await import("../src/services/workspaceService.ts");
const { taskManager } = await import("../src/services/taskManager.ts");
const { createMcpServer } = await import("../src/services/mcpServerService.ts");
const { createRole, roleAgentId } = await import("../src/services/roleService.ts");
const { waitForSnapshotsIdle } = await import("../src/services/workspaceSnapshotService.ts");
const { listTaskRuns } = await import("../src/services/coreModelService.ts");

after(async () => {
  await new Promise((resolve) => setTimeout(resolve, 500));
  await waitForSnapshotsIdle();
  db.close();
  env.cleanup();
});

const mcpAdds = () =>
  fs.existsSync(logFile)
    ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).args as string[]).filter((args) => args[0] === "mcp" && args[1] === "add")
    : [];

async function runRoleTask(agentId: string, title: string) {
  const dir = path.join(env.root, `ws-${title}`);
  fs.mkdirSync(dir, { recursive: true });
  const workspace = createWorkspace({ name: title, path: dir, allowedAgentKinds: [] });
  const task = taskManager.createTask({ agentId, workspaceId: workspace.id, title, prompt: "检查一下", permissionMode: "supervised", actor: "test" });
  await waitFor(() => (taskManager.getTask(task.id)?.status === "review" && listTaskRuns(task.id).at(-1)?.finishedAt ? true : null), {
    timeoutMs: 15_000,
    description: `${title} to finish`,
  });
}

test("a same-name Codex MCP entry with the wrong command is re-registered, and paths with spaces stay whole", async () => {
  const mcp = createMcpServer({
    name: "ops core",
    transport: "stdio",
    command: "C:\\Program Files\\nodejs\\node.exe",
    args: ["D:\\工具\\运维桥接\\dist\\mcp-stdio.js"],
    env: { OPS_CORE_TOKEN_FILE: "D:\\工具\\运维桥接\\.data\\token" },
  });
  const role = createRole({ name: "运维", baseAgentId: "codex", baseAgentKind: "codex", mcpServerIds: [mcp.id] });
  // 以前写坏的条目：名字一样，但 command 在空格处被拆开了。
  fs.writeFileSync(
    listFile,
    JSON.stringify([
      {
        name: "agenthub-ops-core",
        transport: { type: "stdio", command: '"C:\\Program', args: ['Files\\nodejs\\node.exe"', "D:\\工具\\运维桥接\\dist\\mcp-stdio.js"], env: { OPS_CORE_TOKEN_FILE: "D:\\工具\\运维桥接\\.data\\token" } },
      },
    ])
  );

  await runRoleTask(roleAgentId(role.id), "first");
  assert.deepEqual(mcpAdds(), [
    ["mcp", "add", "agenthub-ops-core", "--env", "OPS_CORE_TOKEN_FILE=D:\\工具\\运维桥接\\.data\\token", "--", "C:\\Program Files\\nodejs\\node.exe", "D:\\工具\\运维桥接\\dist\\mcp-stdio.js"],
  ]);

  // 注册好之后同一个进程里不再重复 add。
  await runRoleTask(roleAgentId(role.id), "second");
  assert.equal(mcpAdds().length, 1);
});

test("an HTTP MCP that needs OAuth login is skipped instead of running `codex mcp add` (which would open a browser and wait 5 minutes)", async () => {
  const http = await import("node:http");
  // 一个要登录的（401），一个能直接握手的。
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.url === "/locked") {
        res.writeHead(401, { "www-authenticate": 'Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource"' }).end();
        return;
      }
      const message = body ? JSON.parse(body) : {};
      if (message.id === undefined) return void res.writeHead(202).end();
      const result = message.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "open" } } : {};
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const locked = createMcpServer({ name: "locked", transport: "http", url: `http://127.0.0.1:${port}/locked` });
    const open = createMcpServer({ name: "open", transport: "http", url: `http://127.0.0.1:${port}/open` });
    const role = createRole({ name: "http", baseAgentId: "codex", baseAgentKind: "codex", mcpServerIds: [locked.id, open.id] });
    fs.writeFileSync(listFile, "[]");
    const before = mcpAdds().length;

    await runRoleTask(roleAgentId(role.id), "http");
    assert.deepEqual(mcpAdds().slice(before), [["mcp", "add", "agenthub-open", "--url", `http://127.0.0.1:${port}/open`]]);
    const task = taskManager.listTasks().find((item) => item.title === "http")!;
    const logs = taskManager.listEvents(task.id).filter((event) => event.type === "log").map((event) => String((event.payload as { message?: string }).message));
    assert.ok(logs.some((message) => message.includes("「agenthub-locked」要先登录授权") && message.includes("已跳过")), logs.join("\n"));
  } finally {
    server.close();
  }
});
