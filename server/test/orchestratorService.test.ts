import test, { after } from "node:test";
import assert from "node:assert/strict";
import { nanoid } from "nanoid";
import { setupIsolatedDb } from "./helpers/testEnv.ts";
import type { Task, TaskStatus } from "../src/types.ts";

const env = setupIsolatedDb("orchestrator");
const { db } = await import("../src/db/index.ts");
const { createWorkspace } = await import("../src/services/workspaceService.ts");
const { listTaskRuns } = await import("../src/services/coreModelService.ts");
const {
  listAgentRequests,
  listRunnableSubtasksForTask,
  listRunCheckpoints,
  markTimedOutRuns,
  planRetry,
  startRun,
  updateRunStatus,
} = await import("../src/orchestrator/orchestratorService.ts");

const workspace = createWorkspace({
  name: "Orchestrator Workspace",
  path: env.root,
  allowedAgentKinds: ["mock"],
});

after(() => {
  db.close();
  env.cleanup();
});

function insertTask(prompt: string, status: TaskStatus = "running"): Task {
  const id = `task-${nanoid()}`;
  const createdAt = new Date().toISOString();
  const title = prompt.length > 60 ? `${prompt.slice(0, 57)}...` : prompt;
  db.prepare(
    `INSERT INTO tasks (
      id, agent_id, agent_kind, workspace_id, title, prompt, status, session_key,
      model, permission_mode, sub_agent_id, budget_limit_cny, created_at, updated_at
    ) VALUES (?, 'mock', 'mock', ?, ?, ?, ?, NULL, NULL, 'supervised', NULL, NULL, ?, ?)`
  ).run(id, workspace.id, title, prompt, status, createdAt, createdAt);

  return {
    id,
    agentId: "mock",
    agentKind: "mock",
    workspaceId: workspace.id,
    title,
    prompt,
    status,
    sessionKey: null,
    model: null,
    permissionMode: "supervised",
    subAgentId: null,
    budgetLimitCny: null,
    createdAt,
    updatedAt: createdAt,
  };
}

test("orchestrator records agent requests and run checkpoints", () => {
  const task = insertTask("record the dispatch lifecycle");
  const { run, request } = startRun({
    task,
    prompt: task.prompt,
    images: ["C:\\tmp\\mock.png"],
    source: "create_task",
  });

  assert.equal(request.status, "running");
  assert.equal(request.targetRunId, run.id);
  assert.deepEqual(request.images, ["C:\\tmp\\mock.png"]);

  let checkpoints = listRunCheckpoints(run.id);
  assert.deepEqual(checkpoints.map((checkpoint) => checkpoint.label), ["run.started"]);

  updateRunStatus({ taskId: task.id, runId: run.id, status: "review" });

  const [updatedRequest] = listAgentRequests(task.id);
  assert.equal(updatedRequest?.status, "review");
  assert.ok(updatedRequest?.resolvedAt);

  const [updatedRun] = listTaskRuns(task.id);
  assert.equal(updatedRun?.status, "review");
  assert.ok(updatedRun?.finishedAt);

  checkpoints = listRunCheckpoints(run.id);
  assert.deepEqual(checkpoints.map((checkpoint) => checkpoint.label), ["run.started", "run.finished"]);
});

test("orchestrator evaluates dependencies, retry windows, and run timeouts", () => {
  const dependencyTask = insertTask("evaluate dependency graph");
  const stamp = new Date().toISOString();
  const doneId = `sub-${nanoid()}`;
  const readyId = `sub-${nanoid()}`;
  const blockedId = `sub-${nanoid()}`;
  const insertSubtask = db.prepare(
    `INSERT INTO subtasks (id, task_id, parent_subtask_id, title, status, assigned_agent_id, dependency_ids, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, 'mock', ?, ?, ?)`
  );
  insertSubtask.run(doneId, dependencyTask.id, "done dependency", "done", "[]", stamp, stamp);
  insertSubtask.run(readyId, dependencyTask.id, "ready child", "queued", JSON.stringify([doneId]), stamp, stamp);
  insertSubtask.run(blockedId, dependencyTask.id, "blocked child", "queued", JSON.stringify(["missing-subtask"]), stamp, stamp);

  assert.deepEqual(
    listRunnableSubtasksForTask(dependencyTask.id).map((subtask) => subtask.id),
    [readyId]
  );

  const retryTask = insertTask("retry failed run");
  const { run: failedRun } = startRun({ task: retryTask, prompt: retryTask.prompt, images: [], source: "create_task" });
  updateRunStatus({ taskId: retryTask.id, runId: failedRun.id, status: "failed", error: "boom" });
  assert.deepEqual(planRetry(retryTask.id, { maxAttempts: 2 }), {
    shouldRetry: true,
    sourceRunId: failedRun.id,
    nextAttempt: 2,
  });
  assert.equal(planRetry(retryTask.id, { maxAttempts: 1 }).shouldRetry, false);

  const timeoutTask = insertTask("timeout old run");
  const { run: oldRun } = startRun({ task: timeoutTask, prompt: timeoutTask.prompt, images: [], source: "create_task" });
  const oldStartedAt = new Date(Date.now() - 60_000).toISOString();
  db.prepare("UPDATE task_runs SET started_at = ? WHERE id = ?").run(oldStartedAt, oldRun.id);

  const timedOut = markTimedOutRuns(30_000, new Date());
  assert.equal(timedOut.some((run) => run.id === oldRun.id && run.status === "timed_out"), true);
  assert.equal((db.prepare("SELECT status FROM tasks WHERE id = ?").get(timeoutTask.id) as { status: string }).status, "failed");
  assert.equal(listRunCheckpoints(oldRun.id).some((checkpoint) => checkpoint.label === "run.timed_out"), true);
});
