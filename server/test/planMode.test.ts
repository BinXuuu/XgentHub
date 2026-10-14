import test, { after } from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedDb, waitFor } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("plan-mode");
const { db } = await import("../src/db/index.ts");
const { createWorkspace } = await import("../src/services/workspaceService.ts");
const { taskManager, PLAN_APPROVED_MESSAGE } = await import("../src/services/taskManager.ts");

after(() => {
  db.close();
  env.cleanup();
});

function waitIdle(taskId: string) {
  return waitFor(
    () => {
      const current = taskManager.getTask(taskId);
      return current && !["running", "queued", "waiting", "needs_approval"].includes(current.status) ? current : null;
    },
    { timeoutMs: 10000, description: "task to finish its turn" }
  );
}

test("plan mode stays on until approved, then approval turns it off and dispatches the execute turn", async () => {
  const workspace = createWorkspace({ name: "Plan Mode Workspace", path: env.root, allowedAgentKinds: ["mock"] });
  const task = taskManager.createTask({
    agentId: "mock",
    workspaceId: workspace.id,
    title: "计划模式测试",
    prompt: "给项目加一个 lint 命令",
    permissionMode: "full",
    planMode: true,
    actor: "test",
  });
  assert.equal(task.planMode, true);
  assert.throws(() => taskManager.approvePlan(task.id, "test"), /还在处理中/);

  await waitIdle(task.id);
  assert.equal(taskManager.getTask(task.id)?.planMode, true);

  const approved = taskManager.approvePlan(task.id, "test");
  assert.equal(approved.planMode, false);
  const userMessages = taskManager.listMessages(task.id).filter((message) => message.role === "user");
  assert.equal(userMessages.at(-1)?.content, PLAN_APPROVED_MESSAGE);

  await waitIdle(task.id);
  assert.throws(() => taskManager.approvePlan(task.id, "test"), /不在计划模式/);

  // 已经有过回复的任务再打开计划模式：旧回复不算方案，必须等这之后的新回复才能批准。
  const reenabled = taskManager.setTaskPlanMode(task.id, true, "test");
  assert.ok(reenabled.planModeSince);
  assert.throws(() => taskManager.approvePlan(task.id, "test"), /还没给出方案/);
});

test("plan mode can be toggled without executing anything", () => {
  const workspace = createWorkspace({ name: "Plan Toggle Workspace", path: env.root, allowedAgentKinds: ["mock"] });
  const task = taskManager.createTask({ agentId: "mock", workspaceId: workspace.id, title: "只切换", actor: "test" });
  assert.equal(task.planMode, false);
  assert.equal(taskManager.setTaskPlanMode(task.id, true, "test").planMode, true);
  assert.equal(taskManager.setTaskPlanMode(task.id, false, "test").planMode, false);
  assert.equal(taskManager.listMessages(task.id).length, 0);
});
