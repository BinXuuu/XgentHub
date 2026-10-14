import test, { after } from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedDb } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("core-model");
const { db } = await import("../src/db/index.ts");
const { createWorkspace } = await import("../src/services/workspaceService.ts");
const { taskManager } = await import("../src/services/taskManager.ts");
const core = await import("../src/services/coreModelService.ts");
const { waitForSnapshotsIdle } = await import("../src/services/workspaceSnapshotService.ts");

after(async () => {
  // 任务派发前会在后台给工作区拍快照（spawn git），等它结束再关库、删临时目录。
  await waitForSnapshotsIdle();
  db.close();
  env.cleanup();
});

test("coreModelService syncs agent descriptors and exposes persisted records", () => {
  const descriptor = taskManager.listAgents().find((agent) => agent.id === "mock");
  assert.ok(descriptor);

  const record = core.getAgentRecord("mock");
  assert.equal(record?.kind, "mock");
  assert.equal(record?.runtimeKind, "mock");
  assert.equal(core.listAgentRecords().some((agent) => agent.id === "mock"), true);
});

test("core model tables cascade when a task is deleted", async () => {
  const workspace = createWorkspace({
    name: "Core Model Workspace",
    path: env.root,
    allowedAgentKinds: ["ollama"],
  });
  const task = taskManager.createTask({
    agentId: "ollama",
    workspaceId: workspace.id,
    prompt: "this will fail before creating external state",
    actor: "test",
  });

  const runs = core.listTaskRuns(task.id);
  assert.equal(core.listSubtasks(task.id).length, 1);
  assert.equal(runs.length, 1);
  core.recordArtifact({ taskId: task.id, runId: runs[0]?.id, kind: "other", name: "manual artifact" });
  assert.equal(core.listArtifacts(task.id).length, 1);

  await taskManager.stopTask(task.id, "test");
  taskManager.deleteTask(task.id, "test");

  assert.equal(core.listSubtasks(task.id).length, 0);
  assert.equal(core.listTaskRuns(task.id).length, 0);
  assert.equal(core.listArtifacts(task.id).length, 0);
});
