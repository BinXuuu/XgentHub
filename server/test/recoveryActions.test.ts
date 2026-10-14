import test, { after } from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedDb, waitFor } from "./helpers/testEnv.ts";
import type { Approval } from "../src/types.ts";

const env = setupIsolatedDb("recovery-actions");
const { db } = await import("../src/db/index.ts");
const { createWorkspace } = await import("../src/services/workspaceService.ts");
const { taskManager } = await import("../src/services/taskManager.ts");
const { listTaskRuns } = await import("../src/services/coreModelService.ts");
const { listRecoveryActions } = await import("../src/services/recoveryService.ts");
const { listNotifications } = await import("../src/services/notificationService.ts");
const { orchestrator } = await import("../src/orchestrator/orchestratorService.ts");

after(() => {
  db.close();
  env.cleanup();
});

async function moveMockTaskToReview(taskId: string) {
  const installApproval = await waitFor<Approval>(
    () => taskManager.listApprovals(taskId).find((approval) => approval.status === "pending" && approval.command.includes("npm install")),
    { timeoutMs: 5000, description: "mock install approval" }
  );
  taskManager.approveAction(taskId, installApproval.id, "approve_once", undefined, "test");

  const pushApproval = await waitFor<Approval>(
    () => taskManager.listApprovals(taskId).find((approval) => approval.status === "pending" && approval.command.includes("git push")),
    { timeoutMs: 5000, description: "mock push approval" }
  );
  taskManager.approveAction(taskId, pushApproval.id, "deny", "send to review", "test");

  await waitFor(
    () => {
      const current = taskManager.getTask(taskId);
      return current?.status === "review" ? current : null;
    },
    { timeoutMs: 5000, description: "mock review status" }
  );
}

test("manual retry and human handoff are recorded as recovery actions", async () => {
  const workspace = createWorkspace({
    name: "Recovery Workspace",
    path: env.root,
    allowedAgentKinds: ["mock"],
  });

  const task = taskManager.createTask({
    agentId: "mock",
    workspaceId: workspace.id,
    prompt: "exercise recovery path",
    permissionMode: "supervised",
    actor: "test",
  });

  await moveMockTaskToReview(task.id);
  const firstRun = listTaskRuns(task.id)[0];
  assert.ok(firstRun);

  const retryAction = taskManager.retryTask(task.id, "rerun after review", "test");
  assert.equal(retryAction.kind, "retry");
  assert.equal(retryAction.status, "dispatched");
  assert.equal(retryAction.runId, firstRun.id);

  const retryRun = await waitFor(
    () => {
      const runs = listTaskRuns(task.id);
      return runs.length === 2 ? runs[1] : null;
    },
    { timeoutMs: 5000, description: "retry run" }
  );
  assert.equal(retryRun.attempt, 2);

  await waitFor(
    () => {
      const current = taskManager.getTask(task.id);
      return current?.status === "review" ? current : null;
    },
    { timeoutMs: 5000, description: "retry review status" }
  );

  const retryRequest = orchestrator.listAgentRequests(task.id).find((request) => request.source === "retry");
  assert.ok(retryRequest);
  assert.equal(retryRequest.sourceRunId, firstRun.id);
  assert.equal(retryRequest.targetRunId, retryRun.id);

  const handoffAction = taskManager.handoffToHuman(task.id, "needs product decision", "test");
  assert.equal(handoffAction.kind, "human_handoff");
  assert.equal(handoffAction.status, "open");
  assert.equal(handoffAction.runId, retryRun.id);

  const actions = listRecoveryActions(task.id);
  assert.deepEqual(actions.map((action) => action.kind), ["retry", "human_handoff"]);
  assert.equal(taskManager.getFlowSnapshot(task.id)?.recoveryActions.length, 2);

  const notifications = listNotifications();
  assert.equal(notifications.some((notification) => notification.sourceKey === `recovery:${retryAction.id}`), true);
  assert.equal(notifications.some((notification) => notification.sourceKey === `recovery:${handoffAction.id}`), true);

  const auditRows = db.prepare("SELECT action FROM audit_log WHERE task_id = ? ORDER BY created_at ASC").all(task.id) as { action: string }[];
  assert.equal(auditRows.some((row) => row.action === "retry_task"), true);
  assert.equal(auditRows.some((row) => row.action === "handoff_to_human"), true);
});
