import test, { after } from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedDb, waitFor } from "./helpers/testEnv.ts";
import type { Approval } from "../src/types.ts";

const env = setupIsolatedDb("approval-rules");
const { db } = await import("../src/db/index.ts");
const { createWorkspace } = await import("../src/services/workspaceService.ts");
const { taskManager } = await import("../src/services/taskManager.ts");

after(() => {
  db.close();
  env.cleanup();
});

async function denyPush(taskId: string) {
  const pushApproval = await waitFor<Approval>(
    () => taskManager.listApprovals(taskId).find((approval) => approval.status === "pending" && approval.command.includes("git push")),
    { timeoutMs: 5000, description: "mock push approval" }
  );
  taskManager.approveAction(taskId, pushApproval.id, "deny", "blocked by test", "test");
  await waitFor(
    () => {
      const current = taskManager.getTask(taskId);
      return current?.status === "review" ? current : null;
    },
    { timeoutMs: 5000, description: "mock review status" }
  );
}

test("approve_always persists a scoped rule, auto-allows matching commands, and can be removed", async () => {
  const workspace = createWorkspace({
    name: "Approval Rules Workspace",
    path: env.root,
    allowedAgentKinds: ["mock"],
  });

  const firstTask = taskManager.createTask({
    agentId: "mock",
    workspaceId: workspace.id,
    prompt: "create always allow rule",
    permissionMode: "supervised",
    actor: "test",
  });
  const installApproval = await waitFor<Approval>(
    () => taskManager.listApprovals(firstTask.id).find((approval) => approval.status === "pending" && approval.command.includes("npm install")),
    { timeoutMs: 5000, description: "first install approval" }
  );
  const resolvedInstall = taskManager.approveAction(firstTask.id, installApproval.id, "approve_always", undefined, "test");
  assert.equal(resolvedInstall.status, "always_allowed");
  assert.match(resolvedInstall.note ?? "", /总是允许规则/);
  await denyPush(firstTask.id);

  const rules = taskManager.listAlwaysAllowRules();
  assert.equal(rules.length, 1);
  assert.equal(rules[0]?.workspaceId, workspace.id);
  assert.equal(rules[0]?.agentId, "mock");
  assert.equal(rules[0]?.pattern, "npm install left-pad");

  const secondTask = taskManager.createTask({
    agentId: "mock",
    workspaceId: workspace.id,
    prompt: "reuse always allow rule",
    permissionMode: "supervised",
    actor: "test",
  });
  const autoInstall = await waitFor<Approval>(
    () => taskManager.listApprovals(secondTask.id).find((approval) => approval.status === "always_allowed" && approval.command.includes("npm install")),
    { timeoutMs: 5000, description: "auto-allowed install approval" }
  );
  assert.match(autoInstall.note ?? "", /命中总是允许规则/);
  await denyPush(secondTask.id);

  const auditRows = db
    .prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'approval_auto_allowed'")
    .get() as { count: number };
  assert.equal(auditRows.count, 1);

  taskManager.deleteAlwaysAllowRule(rules[0]!.id, "test");
  assert.equal(taskManager.listAlwaysAllowRules().length, 0);

  const thirdTask = taskManager.createTask({
    agentId: "mock",
    workspaceId: workspace.id,
    prompt: "rule removed",
    permissionMode: "supervised",
    actor: "test",
  });
  const pendingInstall = await waitFor<Approval>(
    () => taskManager.listApprovals(thirdTask.id).find((approval) => approval.status === "pending" && approval.command.includes("npm install")),
    { timeoutMs: 5000, description: "install approval after rule deletion" }
  );
  taskManager.approveAction(thirdTask.id, pendingInstall.id, "approve_once", undefined, "test");
  await denyPush(thirdTask.id);
});
