import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupIsolatedDb } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("data-isolation");
const { config } = await import("../src/config.ts");
const { db } = await import("../src/db/index.ts");
const { createCustomAgent, deleteCustomAgent, customAgentStorePath } = await import("../src/services/customAgentService.ts");
const { createMcpServer, deleteMcpServer } = await import("../src/services/mcpServerService.ts");
const { createResourceLibraryItem, deleteResourceLibraryItem } = await import("../src/services/resourceLibraryService.ts");

after(() => {
  db.close();
  env.cleanup();
});

// 以前这些 JSON 存储固定写在 server/data 下，测试建的自定义 Agent 一旦没清掉就会出现在真实的 Agent 列表里。
test("JSON stores live next to the database, so tests with a temp DB_PATH never touch the real data folder", () => {
  assert.equal(config.dataDir, env.root);
  assert.equal(path.dirname(customAgentStorePath), env.root);

  const agent = createCustomAgent({ template: "api", name: "隔离测试 Agent", baseUrl: "http://127.0.0.1:1", apiKey: "k" });
  const mcp = createMcpServer({ name: "隔离测试 MCP", transport: "stdio", command: "node", args: [] });
  const tool = createResourceLibraryItem("tool", { title: "隔离测试工具", content: "x" });
  try {
    for (const file of ["custom-agents.json", "mcp-servers.json", "resource-library.json"]) {
      assert.ok(fs.existsSync(path.join(env.root, file)), `${file} should be written into the temp data dir`);
    }
  } finally {
    deleteCustomAgent(agent.id);
    deleteMcpServer(mcp.id);
    deleteResourceLibraryItem("tool", tool.id);
  }
});
