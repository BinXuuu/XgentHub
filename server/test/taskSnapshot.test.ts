import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupIsolatedDb, waitFor } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("task-snapshot");
const { db } = await import("../src/db/index.ts");
const { waitForSnapshotsIdle } = await import("../src/services/workspaceSnapshotService.ts");
const { createWorkspace } = await import("../src/services/workspaceService.ts");
const { taskManager } = await import("../src/services/taskManager.ts");
const { createCustomAgent, deleteCustomAgent } = await import("../src/services/customAgentService.ts");

after(async () => {
  await waitForSnapshotsIdle();
  db.close();
  env.cleanup();
});

test("each user round snapshots the workspace and can be undone, including undoing the undo", async () => {
  const wsPath = path.join(env.root, "project");
  fs.mkdirSync(wsPath, { recursive: true });
  fs.writeFileSync(path.join(wsPath, "app.txt"), "v1", "utf8");
  const workspace = createWorkspace({ name: "Snapshot Workspace", path: wsPath, allowedAgentKinds: ["mock"] });

  const task = taskManager.createTask({ agentId: "mock", workspaceId: workspace.id, title: "快照", prompt: "改一下 app.txt", permissionMode: "full", actor: "test" });
  const snapshot = await waitFor(() => taskManager.listSnapshots(task.id)[0], { timeoutMs: 15000, description: "before_run snapshot" });
  const userMessage = taskManager.listMessages(task.id).find((message) => message.role === "user");
  assert.equal(snapshot.kind, "before_run");
  assert.equal(snapshot.messageId, userMessage?.id);
  await waitFor(() => {
    const current = taskManager.getTask(task.id);
    return current && !["running", "queued", "waiting", "needs_approval"].includes(current.status) ? current : null;
  }, { timeoutMs: 15000, description: "mock run to finish" });

  fs.writeFileSync(path.join(wsPath, "app.txt"), "v2 from agent", "utf8");
  fs.writeFileSync(path.join(wsPath, "new.txt"), "added", "utf8");

  const preview = await taskManager.previewSnapshotRestore(task.id, snapshot.id);
  assert.deepEqual(preview, { restore: ["app.txt"], remove: ["new.txt"], recreate: [] });

  await taskManager.restoreSnapshot(task.id, snapshot.id, "test");
  assert.equal(fs.readFileSync(path.join(wsPath, "app.txt"), "utf8"), "v1");
  assert.equal(fs.existsSync(path.join(wsPath, "new.txt")), false);

  const notice = taskManager.listMessages(task.id).filter((message) => message.role === "system").at(-1);
  assert.match(notice?.content ?? "", /已把工作区文件回退到/);
  const safety = taskManager.listSnapshots(task.id).find((item) => item.kind === "before_restore");
  assert.equal(safety?.messageId, notice?.id);

  await taskManager.restoreSnapshot(task.id, safety!.id, "test");
  assert.equal(fs.readFileSync(path.join(wsPath, "app.txt"), "utf8"), "v2 from agent");
  assert.equal(fs.readFileSync(path.join(wsPath, "new.txt"), "utf8"), "added");

  taskManager.deleteTask(task.id, "test");
  assert.equal(taskManager.listSnapshots(task.id).length, 0);
});

test("stopping while the pre-run snapshot is still being taken never starts the agent", async () => {
  const wsPath = path.join(env.root, "stop-during-snapshot");
  fs.mkdirSync(wsPath, { recursive: true });
  const marker = path.join(wsPath, "agent-ran.txt");
  const workspace = createWorkspace({ name: "Stop During Snapshot", path: wsPath, allowedAgentKinds: ["custom-cli"] });
  const agent = createCustomAgent({
    template: "cli",
    name: "写标记文件的 Agent",
    command: process.execPath,
    argsTemplate: `-e "require('fs').writeFileSync('${marker.replace(/\\/g, "/")}', 'ran')"`,
  });
  try {
    const task = taskManager.createTask({ agentId: agent.id, workspaceId: workspace.id, title: "立刻停止", prompt: "写个文件", permissionMode: "full", actor: "test" });
    await taskManager.stopTask(task.id, "test");
    await waitFor(() => (taskManager.listSnapshots(task.id).length > 0 ? true : null), { timeoutMs: 15000, description: "snapshot to finish" });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(fs.existsSync(marker), false, "agent was started after the task had been stopped");
    assert.equal(taskManager.getTask(task.id)?.status, "stopped");
  } finally {
    deleteCustomAgent(agent.id);
  }
});
