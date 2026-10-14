import test, { after } from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedDb, waitFor } from "./helpers/testEnv.ts";
import type { Approval } from "../src/types.ts";

const env = setupIsolatedDb("memory-notifications");
const { db } = await import("../src/db/index.ts");
const { createWorkspace } = await import("../src/services/workspaceService.ts");
const { taskManager } = await import("../src/services/taskManager.ts");
const { listMemoryEntries } = await import("../src/services/memoryService.ts");
const { listNotifications, markAllNotificationsRead } = await import("../src/services/notificationService.ts");

after(() => {
  db.close();
  env.cleanup();
});

test("task lifecycle records approval notifications, status notifications, and task memory", async () => {
  const workspace = createWorkspace({
    name: "Memory Workspace",
    path: env.root,
    allowedAgentKinds: ["mock"],
  });

  const task = taskManager.createTask({
    agentId: "mock",
    workspaceId: workspace.id,
    prompt: "remember this finished path",
    permissionMode: "supervised",
    actor: "test",
  });

  const installApproval = await waitFor<Approval>(
    () => taskManager.listApprovals(task.id).find((approval) => approval.status === "pending" && approval.command.includes("npm install")),
    { timeoutMs: 5000, description: "install approval" }
  );
  assert.equal(listNotifications({ unreadOnly: true }).some((notification) => notification.sourceKey === `approval:${installApproval.id}`), true);
  taskManager.approveAction(task.id, installApproval.id, "approve_once", undefined, "test");

  await waitFor(
    () => {
      const notification = listNotifications().find((item) => item.sourceKey === `approval:${installApproval.id}`);
      return notification?.readAt ? notification : null;
    },
    { timeoutMs: 5000, description: "install approval notification read" }
  );

  const pushApproval = await waitFor<Approval>(
    () => taskManager.listApprovals(task.id).find((approval) => approval.status === "pending" && approval.command.includes("git push")),
    { timeoutMs: 5000, description: "push approval" }
  );
  taskManager.approveAction(task.id, pushApproval.id, "deny", "blocked by test", "test");

  await waitFor(
    () => {
      const current = taskManager.getTask(task.id);
      return current?.status === "review" ? current : null;
    },
    { timeoutMs: 5000, description: "review status" }
  );

  const memories = listMemoryEntries({ taskId: task.id });
  assert.equal(memories.length, 1);
  assert.equal(memories[0]?.workspaceId, workspace.id);
  assert.equal(memories[0]?.kind, "task_summary");
  assert.match(memories[0]?.content ?? "", /remember this finished path/);
  assert.match(memories[0]?.content ?? "", /src\/utils\/helper\.ts/);

  const notifications = listNotifications();
  assert.equal(notifications.some((notification) => notification.sourceKey === `task:${task.id}:status:review`), true);
  assert.equal(notifications.find((notification) => notification.sourceKey === `approval:${pushApproval.id}`)?.readAt != null, true);
  assert.ok(markAllNotificationsRead() >= 1);
  assert.equal(listNotifications({ unreadOnly: true }).length, 0);
});
