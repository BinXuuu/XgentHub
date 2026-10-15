import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setupIsolatedDb, waitFor } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("custom-agent-mcp");
const { db } = await import("../src/db/index.ts");
const { createWorkspace, updateWorkspaceResources } = await import("../src/services/workspaceService.ts");
const { taskManager } = await import("../src/services/taskManager.ts");
const { createCustomAgent, deleteCustomAgent } = await import("../src/services/customAgentService.ts");
const { createMcpServer, deleteMcpServer } = await import("../src/services/mcpServerService.ts");
const { createCustomAdapter } = await import("../src/adapters/custom.ts");
const { waitForSnapshotsIdle } = await import("../src/services/workspaceSnapshotService.ts");

after(async () => {
  await waitForSnapshotsIdle();
  db.close();
  env.cleanup();
});

// 这个脚本不读 {prompt}，只关心自己被传进来的 argv 里有没有 --mcp-config <file>，有的话就把那
// 份临时配置文件的路径和内容原样打印出来——这样测试能直接断言 AgentHub 真的生成了一份带正确
// MCP server 信息的配置文件，并且把路径传给了命令行，而不是只看"没报错"这种弱信号。
const probeScriptPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-mcp-probe-")), "probe.cjs");
fs.writeFileSync(
  probeScriptPath,
  `
const fs = require("fs");
const idx = process.argv.indexOf("--mcp-config");
const p = idx >= 0 ? process.argv[idx + 1] : null;
process.stdout.write(JSON.stringify({ mcpConfigPath: p, mcpConfigContent: p ? fs.readFileSync(p, "utf8") : null }));
`,
  "utf8"
);

test("CustomCliAdapter.supportsMcp only turns on once mcpArgTemplate is actually configured", () => {
  const withoutMcp = createCustomAgent({ template: "cli", name: "没配 MCP 的自定义 CLI", command: "node", argsTemplate: "{prompt}" });
  const withMcp = createCustomAgent({
    template: "cli",
    name: "配了 MCP 的自定义 CLI",
    command: "node",
    argsTemplate: "{prompt}",
    mcpArgTemplate: "--mcp-config {mcpConfig}",
  });
  try {
    assert.equal(createCustomAdapter(withoutMcp).supportsMcp, false);
    assert.equal(createCustomAdapter(withMcp).supportsMcp, true);
  } finally {
    deleteCustomAgent(withoutMcp.id);
    deleteCustomAgent(withMcp.id);
  }
});

test("a custom CLI agent configured with mcpArgTemplate actually receives a real --mcp-config file with the selected MCP servers", async () => {
  const workspace = createWorkspace({ name: "Custom Agent MCP Workspace", path: env.root, allowedAgentKinds: ["custom-cli"] });
  const mcp = createMcpServer({ name: "探针用 MCP", transport: "stdio", command: "node", args: ["-e", "1"], env: { FOO: "bar" } });
  const agent = createCustomAgent({
    template: "cli",
    name: "带 MCP 探针的自定义 CLI",
    command: process.execPath,
    argsTemplate: probeScriptPath,
    mcpArgTemplate: "--mcp-config {mcpConfig}",
  });

  try {
    updateWorkspaceResources(workspace.id, { mcpServerIds: [mcp.id] });
    const task = taskManager.createTask({
      agentId: agent.id,
      workspaceId: workspace.id,
      title: "自定义 CLI 的 MCP 探针任务",
      prompt: "随便什么内容，探针脚本不看这个",
      permissionMode: "full",
      actor: "test",
    });

    const finished = await waitFor(
      () => {
        const current = taskManager.getTask(task.id);
        return current && (current.status === "review" || current.status === "failed") ? current : null;
      },
      { timeoutMs: 8000, description: "custom-cli MCP probe task finishes" }
    );
    assert.equal(finished.status, "review", "探针脚本应该正常退出，不应该报失败");

    const messages = taskManager.listMessages(task.id);
    const agentMessage = messages.filter((m) => m.role === "agent").at(-1);
    const parsed = JSON.parse(agentMessage?.content ?? "{}") as { mcpConfigPath: string | null; mcpConfigContent: string | null };
    assert.ok(parsed.mcpConfigPath, "探针脚本应该在 argv 里收到 --mcp-config <path>");

    const slug = mcp.id.startsWith("mcp:") ? mcp.id.slice(4) : mcp.id;
    const config = JSON.parse(parsed.mcpConfigContent ?? "{}");
    const entry = config.mcpServers?.[`agenthub-${slug}`];
    assert.ok(entry, `生成的 MCP 配置文件里应该有 agenthub-${slug} 这个 server`);
    assert.equal(entry.command, "node");
    assert.deepEqual(entry.args, ["-e", "1"]);
    assert.deepEqual(entry.env, { FOO: "bar" });

    // 任务跑完之后临时文件应该被清理掉，不留在磁盘上。
    assert.equal(fs.existsSync(parsed.mcpConfigPath!), false, "任务结束后临时 MCP 配置文件应该被删除");
  } finally {
    deleteCustomAgent(agent.id);
    deleteMcpServer(mcp.id);
  }
});
