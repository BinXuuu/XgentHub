import test, { after } from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedDb, waitFor } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("subtask-planner");
const { db } = await import("../src/db/index.ts");
const { waitForSnapshotsIdle } = await import("../src/services/workspaceSnapshotService.ts");
const { createWorkspace } = await import("../src/services/workspaceService.ts");
const { planSubtasks } = await import("../src/services/subtaskPlannerService.ts");
const { taskManager } = await import("../src/services/taskManager.ts");

after(async () => {
  await waitForSnapshotsIdle();
  db.close();
  env.cleanup();
});

test("subtask planner leaves simple tasks as a single task", () => {
  const plan = planSubtasks("修复按钮文案");
  assert.equal(plan.shouldCreate, false);
  assert.equal(plan.subtasks.length < 2, true);
});

test("task creation stores planned subtasks for explicit phase prompts", async () => {
  const workspace = createWorkspace({
    name: "Subtask Planner Workspace",
    path: env.root,
    allowedAgentKinds: ["mock"],
  });

  const task = taskManager.createTask({
    agentId: "mock",
    workspaceId: workspace.id,
    prompt: "请按阶段完成：\n1. 后端 API 接入\n2. 前端验收界面\n3. 测试与回归验证",
    permissionMode: "full",
    autoPlanSubtasks: true,
    actor: "test",
  });

  const snapshot = taskManager.getFlowSnapshot(task.id);
  assert.ok(snapshot);
  const planned = snapshot.subtasks.filter((subtask) => subtask.parentSubtaskId);
  assert.equal(planned.length, 3);
  assert.deepEqual(planned.map((subtask) => subtask.title), ["后端 API 接入", "前端验收界面", "测试与回归验证"]);
  assert.equal(planned[0].dependencyIds.length, 0);
  assert.deepEqual(planned[1].dependencyIds, [planned[0].id]);
  assert.deepEqual(planned[2].dependencyIds, [planned[1].id]);
  assert.equal(snapshot.domainEvents.some((event) => event.name === "subtask.plan.created"), true);

  await waitFor(
    () => {
      const current = taskManager.getTask(task.id);
      return current?.status === "review" ? current : null;
    },
    { timeoutMs: 6000, description: "planned task review gate" }
  );

  const gatedSnapshot = taskManager.getFlowSnapshot(task.id);
  assert.equal(gatedSnapshot?.domainEvents.some((event) => event.name === "subtask.ready"), true);
});

test("subtask planner respects requested subtask count and ignores requirement bullets", () => {
  const plan = planSubtasks(`按阶段完成，只拆 2 个子任务：

1. 检查服务是否正常。
2. 输出一句话报告。

要求：
- 只生成 2 个子任务。
- 每次只做一个子任务。
- 完成后待复核。`);

  assert.equal(plan.shouldCreate, true);
  assert.deepEqual(plan.subtasks.map((subtask) => subtask.title), ["检查服务是否正常。", "输出一句话报告。"]);
});
