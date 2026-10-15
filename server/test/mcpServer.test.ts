import test, { after } from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedDb } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("mcp-server");
const { db } = await import("../src/db/index.ts");
const { waitForSnapshotsIdle } = await import("../src/services/workspaceSnapshotService.ts");
const { createWorkspace, getWorkspace, updateWorkspaceResources } = await import("../src/services/workspaceService.ts");
const { taskManager } = await import("../src/services/taskManager.ts");
const { resolveEffectiveResources } = await import("../src/services/taskResourceService.ts");
const { createMcpServer, deleteMcpServer, getMcpServer, getMcpServerUsage, listMcpServers, resolveMcpServers, updateMcpServer } = await import(
  "../src/services/mcpServerService.ts"
);

after(async () => {
  await waitForSnapshotsIdle();
  db.close();
  env.cleanup();
});

test("mcpServerService CRUD round-trips stdio and http definitions correctly", () => {
  const stdio = createMcpServer({ name: "CAD 绘图", transport: "stdio", command: "python", args: ["-m", "cad_mcp.server"], env: { FOO: "bar" } });
  const http = createMcpServer({ name: "Sentry", transport: "http", url: "https://mcp.sentry.dev/mcp", headers: { Authorization: "Bearer x" } });

  try {
    assert.equal(stdio.transport, "stdio");
    assert.equal(stdio.command, "python");
    assert.deepEqual(stdio.args, ["-m", "cad_mcp.server"]);
    assert.deepEqual(stdio.env, { FOO: "bar" });
    assert.equal(stdio.enabled, true);

    assert.equal(http.transport, "http");
    assert.equal(http.url, "https://mcp.sentry.dev/mcp");
    assert.deepEqual(http.headers, { Authorization: "Bearer x" });

    const all = listMcpServers();
    assert.ok(all.some((item) => item.id === stdio.id));
    assert.ok(all.some((item) => item.id === http.id));

    const disabled = updateMcpServer(stdio.id, { enabled: false });
    assert.equal(disabled.enabled, false);
    assert.equal(getMcpServer(stdio.id)?.enabled, false);
  } finally {
    deleteMcpServer(stdio.id);
    deleteMcpServer(http.id);
  }

  assert.equal(getMcpServer(stdio.id), undefined);
  assert.equal(getMcpServer(http.id), undefined);
});

test("createMcpServer rejects stdio without a command and http without a url", () => {
  assert.throws(() => createMcpServer({ name: "bad stdio", transport: "stdio" }), /启动命令/);
  assert.throws(() => createMcpServer({ name: "bad http", transport: "http" }), /URL/);
});

test("tasks inherit MCP servers from their workspace, only enabled servers resolve, and usage points at the workspace", () => {
  const workspace = createWorkspace({ name: "MCP Task Workspace", path: env.root, allowedAgentKinds: ["mock"] });
  const enabledServer = createMcpServer({ name: "启用的", transport: "stdio", command: "node", args: ["server.js"] });
  const disabledServer = createMcpServer({ name: "禁用的", transport: "stdio", command: "node", args: ["other.js"], enabled: false });

  try {
    updateWorkspaceResources(workspace.id, { mcpServerIds: [enabledServer.id, disabledServer.id] });
    const task = taskManager.createTask({ agentId: "mock", workspaceId: workspace.id, title: "MCP 工作区继承测试", actor: "test" });

    assert.deepEqual(new Set(resolveEffectiveResources(task).mcpServerIds), new Set([enabledServer.id, disabledServer.id]));
    assert.deepEqual(
      taskManager.getTaskResources(task.id).mcpServers.map((server) => [server.name, server.sources]),
      [["启用的", ["workspace"]]],
      "the read-only view only lists servers that will actually be mounted"
    );
    assert.deepEqual(getMcpServerUsage(enabledServer.id).workspaces, [{ id: workspace.id, title: "MCP Task Workspace" }]);

    // 工作区改了，任务下一轮自然生效，不需要动任务本身。
    updateWorkspaceResources(workspace.id, { mcpServerIds: [] });
    assert.deepEqual(resolveEffectiveResources(task).mcpServerIds, []);

    // resolveMcpServers 是 createCtx()/chatService.sendMessage 每次都会重新调用的那个函数：
    // 只取 enabled 的，名字要带 agenthub- 前缀。disabledServer 即使还在 mcpServerIds 里也不该被解析出来。
    const resolvedBothIds = resolveMcpServers([enabledServer.id, disabledServer.id]);
    assert.equal(resolvedBothIds.length, 1);
    assert.equal(resolvedBothIds[0]?.name, `agenthub-${enabledServer.id.slice(4)}`);
    assert.equal(resolvedBothIds[0]?.command, "node");
    assert.deepEqual(resolvedBothIds[0]?.args, ["server.js"]);
  } finally {
    deleteMcpServer(enabledServer.id);
    deleteMcpServer(disabledServer.id);
  }
});

test("deleting an MCP server also removes it from every workspace, chat and role that had it checked", async () => {
  const { chatService } = await import("../src/services/chatService.ts");
  const roles = await import("../src/services/roleService.ts");
  const doomed = createMcpServer({ name: "要删的", transport: "stdio", command: "node", args: ["a.js"] });
  const kept = createMcpServer({ name: "留着的", transport: "stdio", command: "node", args: ["b.js"] });
  try {
    const workspace = createWorkspace({ name: "MCP Delete Workspace", path: env.root, allowedAgentKinds: [] });
    updateWorkspaceResources(workspace.id, { mcpServerIds: [doomed.id, kept.id] });
    const chat = chatService.createChat({ agentId: "mock", title: "MCP 删除测试", mcpServerIds: [kept.id, doomed.id] });
    const role = roles.createRole({ name: "MCP 删除测试角色", baseAgentId: "mock", baseAgentKind: "mock", mcpServerIds: [doomed.id] });
    assert.equal(getMcpServerUsage(doomed.id).workspaces.length + getMcpServerUsage(doomed.id).chats.length + getMcpServerUsage(doomed.id).roles.length, 3);

    deleteMcpServer(doomed.id);

    assert.deepEqual(getWorkspace(workspace.id)?.mcpServerIds, [kept.id]);
    assert.deepEqual(chatService.getChat(chat.id)?.mcpServerIds, [kept.id]);
    assert.deepEqual(roles.getRole(role.id)?.mcpServerIds, []);
  } finally {
    deleteMcpServer(doomed.id);
    deleteMcpServer(kept.id);
  }
});

test("deleting a tool or Skill also removes it from workspaces, chats and roles", async () => {
  const { chatService } = await import("../src/services/chatService.ts");
  const roles = await import("../src/services/roleService.ts");
  const library = await import("../src/services/resourceLibraryService.ts");
  const tool = library.createResourceLibraryItem("tool", { title: "要删的工具", content: "x" });
  const skill = library.createResourceLibraryItem("skill", { title: "要删的 Skill", content: "y" });
  const workspace = createWorkspace({ name: "Library Delete Workspace", path: env.root, allowedAgentKinds: [] });
  updateWorkspaceResources(workspace.id, { toolIds: [tool.id], skillIds: [skill.id] });
  const role = roles.createRole({ name: "库删除测试角色", baseAgentId: "mock", baseAgentKind: "mock", toolIds: [tool.id], skillIds: [skill.id] });
  const chat = chatService.createChat({ agentId: roles.roleAgentId(role.id), title: "库删除测试" });
  assert.deepEqual([chat.toolIds, chat.skillIds], [[tool.id], [skill.id]]);

  library.deleteResourceLibraryItem("tool", tool.id);
  library.deleteResourceLibraryItem("skill", skill.id);

  assert.deepEqual([getWorkspace(workspace.id)?.toolIds, getWorkspace(workspace.id)?.skillIds], [[], []]);
  assert.deepEqual([roles.getRole(role.id)?.toolIds, roles.getRole(role.id)?.skillIds], [[], []]);
  assert.deepEqual([chatService.getChat(chat.id)?.toolIds, chatService.getChat(chat.id)?.skillIds], [[], []]);
});
