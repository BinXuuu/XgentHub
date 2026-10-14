import test, { after } from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedDb, waitFor } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("task-review");
const { db } = await import("../src/db/index.ts");
const { createWorkspace } = await import("../src/services/workspaceService.ts");
const { taskManager } = await import("../src/services/taskManager.ts");
const { listTaskRuns } = await import("../src/services/coreModelService.ts");
const { listRecoveryActions } = await import("../src/services/recoveryService.ts");
const { listReviewDecisions } = await import("../src/services/reviewService.ts");
const { listNotifications } = await import("../src/services/notificationService.ts");
const { listMemoryEntries } = await import("../src/services/memoryService.ts");
const { orchestrator } = await import("../src/orchestrator/orchestratorService.ts");

after(() => {
  db.close();
  env.cleanup();
});

function seedReviewTask(workspaceId: string, id: string): string {
  const createdAt = new Date().toISOString();
  const subtaskId = `primary-${id}`;
  const runId = `run-${id}`;
  db.prepare(
    `INSERT INTO tasks (
      id, agent_id, agent_kind, workspace_id, title, prompt, status, session_key,
      model, permission_mode, sub_agent_id, budget_limit_cny, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, ?, ?)`
  ).run(id, "mock", "mock", workspaceId, `Review ${id}`, "please review this task", "review", "supervised", createdAt, createdAt);
  db.prepare(
    `INSERT INTO subtasks (id, task_id, parent_subtask_id, title, status, assigned_agent_id, dependency_ids, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, ?, '[]', ?, ?)`
  ).run(subtaskId, id, `Review ${id}`, "review", "mock", createdAt, createdAt);
  db.prepare(
    `INSERT INTO task_runs (
      id, task_id, subtask_id, agent_id, agent_kind, runtime_kind, model, status,
      attempt, session_key, started_at, finished_at, error
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 1, NULL, ?, ?, NULL)`
  ).run(runId, id, subtaskId, "mock", "mock", "mock", "review", createdAt, createdAt);
  db.prepare("INSERT INTO task_messages (id, task_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)").run(
    `msg-${id}`,
    id,
    "agent",
    "Ready for review.",
    createdAt
  );
  return runId;
}

test("review approval records a decision and moves the task to done", () => {
  const workspace = createWorkspace({
    name: "Review Approval Workspace",
    path: env.root,
    allowedAgentKinds: ["mock"],
  });
  const runId = seedReviewTask(workspace.id, "task-review-approve");

  const decision = taskManager.approveTaskReview("task-review-approve", "looks good", "test");
  assert.equal(decision.decision, "approved");
  assert.equal(decision.runId, runId);

  const task = taskManager.getTask("task-review-approve");
  assert.equal(task?.status, "done");
  assert.equal(listReviewDecisions("task-review-approve").length, 1);
  assert.equal(taskManager.getFlowSnapshot("task-review-approve")?.reviewDecisions.length, 1);
  assert.equal(listMemoryEntries({ taskId: "task-review-approve" }).length, 1);
  assert.equal(listNotifications().some((notification) => notification.sourceKey === "task:task-review-approve:status:done"), true);

  const auditRows = db.prepare("SELECT action FROM audit_log WHERE task_id = ?").all("task-review-approve") as { action: string }[];
  assert.equal(auditRows.some((row) => row.action === "approve_task_review"), true);
});

test("requesting changes records review decision and dispatches retry", async () => {
  const workspace = createWorkspace({
    name: "Review Changes Workspace",
    path: env.root,
    allowedAgentKinds: ["mock"],
  });
  const runId = seedReviewTask(workspace.id, "task-review-changes");

  const decision = taskManager.requestTaskChanges("task-review-changes", "tighten the copy", "test");
  assert.equal(decision.decision, "changes_requested");
  assert.equal(decision.runId, runId);

  const retryRun = await waitFor(
    () => {
      const runs = listTaskRuns("task-review-changes");
      return runs.length === 2 ? runs[1] : null;
    },
    { timeoutMs: 5000, description: "review retry run" }
  );
  assert.equal(retryRun.attempt, 2);

  await waitFor(
    () => {
      const task = taskManager.getTask("task-review-changes");
      return task?.status === "review" ? task : null;
    },
    { timeoutMs: 5000, description: "review retry completion" }
  );

  const recoveryActions = listRecoveryActions("task-review-changes");
  assert.equal(recoveryActions.length, 1);
  assert.equal(recoveryActions[0].kind, "retry");
  assert.equal(recoveryActions[0].runId, runId);
  assert.equal(listReviewDecisions("task-review-changes").length, 1);

  const retryRequest = orchestrator.listAgentRequests("task-review-changes").find((request) => request.source === "retry");
  assert.ok(retryRequest);
  assert.equal(retryRequest.sourceRunId, runId);
  assert.equal(retryRequest.targetRunId, retryRun.id);

  const auditRows = db.prepare("SELECT action FROM audit_log WHERE task_id = ?").all("task-review-changes") as { action: string }[];
  assert.equal(auditRows.some((row) => row.action === "request_task_changes"), true);
  assert.equal(auditRows.some((row) => row.action === "retry_task"), true);
});
