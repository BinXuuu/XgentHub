import test, { after } from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedDb, waitFor } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("subtask-dispatch");
const { db } = await import("../src/db/index.ts");
const { waitForSnapshotsIdle } = await import("../src/services/workspaceSnapshotService.ts");
const { createWorkspace } = await import("../src/services/workspaceService.ts");
const { taskManager } = await import("../src/services/taskManager.ts");
const { createCustomAgent, deleteCustomAgent } = await import("../src/services/customAgentService.ts");
const { listSubtasks, listTaskRuns } = await import("../src/services/coreModelService.ts");
const { listAgentRequests, listRunnableSubtasksForTask, orchestrator } = await import("../src/orchestrator/orchestratorService.ts");
const { listAudit } = await import("../src/services/auditService.ts");
const { listNotifications } = await import("../src/services/notificationService.ts");

after(async () => {
  await waitForSnapshotsIdle();
  db.close();
  env.cleanup();
});

test("TaskManager dispatches only the next dependency-ready planned subtask", async () => {
  const workspace = createWorkspace({
    name: "Subtask Dispatch Workspace",
    path: env.root,
    allowedAgentKinds: ["mock"],
  });

  const task = taskManager.createTask({
    agentId: "mock",
    workspaceId: workspace.id,
    prompt: "请按阶段完成：\n1. 准备输入\n2. 执行实现\n3. 验证交付",
    permissionMode: "full",
    autoPlanSubtasks: true,
    actor: "test",
  });

  await waitFor(
    () => {
      const current = taskManager.getTask(task.id);
      return current?.status === "review" ? current : null;
    },
    { timeoutMs: 7000, description: "initial planned task review gate" }
  );

  const planned = listSubtasks(task.id).filter((subtask) => subtask.parentSubtaskId);
  assert.equal(planned.length, 3);
  assert.deepEqual(
    listRunnableSubtasksForTask(task.id).map((subtask) => subtask.id),
    [planned[0]!.id]
  );

  const result = taskManager.dispatchNextSubtask(
    task.id,
    {
      agentId: "mock",
      prompt: "先处理第一个可执行计划子任务。",
    },
    "test"
  );
  assert.equal(result.subtask.id, planned[0]!.id);
  assert.equal(result.subtask.status, "running");
  assert.equal(result.request.source, "subtask_dispatch");
  assert.equal(result.run.subtaskId, planned[0]!.id);

  await waitFor(
    () => {
      const runs = listTaskRuns(task.id);
      return runs.length === 2 && runs[1]?.status === "done" ? runs : null;
    },
    { timeoutMs: 7000, description: "first dispatched subtask completion" }
  );

  const updated = listSubtasks(task.id).filter((subtask) => subtask.parentSubtaskId);
  assert.equal(updated[0]?.status, "done");
  assert.equal(updated[1]?.status, "queued");
  assert.equal(updated[2]?.status, "queued");
  assert.deepEqual(
    listRunnableSubtasksForTask(task.id).map((subtask) => subtask.id),
    [updated[1]!.id]
  );
  assert.equal(taskManager.getTask(task.id)?.status, "review");

  const requests = listAgentRequests(task.id);
  const dispatchRequest = requests.find((request) => request.source === "subtask_dispatch");
  assert.ok(dispatchRequest);
  assert.equal(dispatchRequest.status, "done");
  assert.equal(dispatchRequest.targetRunId, result.run.id);

  const flow = taskManager.getFlowSnapshot(task.id)!;
  assert.equal(flow.domainEvents.some((event) => event.name === "subtask.dispatched"), true);
  assert.equal(flow.domainEvents.some((event) => event.name === "subtask.ready"), true);
  assert.equal(flow.agentRequests.some((request) => request.source === "subtask_dispatch"), true);

  assert.equal(listAudit().some((entry) => entry.action === "dispatch_subtask" && entry.taskId === task.id), true);
  assert.equal(listNotifications().some((notification) => notification.source === "subtask_dispatch" && notification.taskId === task.id), true);
  assert.equal(listNotifications().some((notification) => notification.source === "subtask_ready" && notification.taskId === task.id), true);
});

test("TaskManager dispatches a subtask to another agent without changing the parent task agent", async () => {
  const workspace = createWorkspace({
    name: "Subtask Cross Agent Workspace",
    path: env.root,
    allowedAgentKinds: ["mock", "custom-cli"],
  });
  const subtaskAgent = createCustomAgent({
    template: "cli",
    name: "测试子任务 Agent",
    command: process.execPath,
    argsTemplate: "-e \"console.log('custom subtask complete')\"",
  });

  try {
    const task = taskManager.createTask({
      agentId: "mock",
      workspaceId: workspace.id,
      prompt: "请按阶段完成：\n1. 收集信息\n2. 生成报告",
      permissionMode: "full",
      autoPlanSubtasks: true,
      actor: "test",
    });

    await waitFor(
      () => {
        const current = taskManager.getTask(task.id);
        return current?.status === "review" ? current : null;
      },
      { timeoutMs: 7000, description: "initial cross-agent planned task review gate" }
    );

    const result = taskManager.dispatchNextSubtask(
      task.id,
      {
        agentId: subtaskAgent.id,
        prompt: "只执行当前子任务。",
      },
      "test"
    );

    await waitFor(
      () => {
        const run = listTaskRuns(task.id).find((item) => item.id === result.run.id);
        return run?.status === "review" ? run : null;
      },
      { timeoutMs: 7000, description: "cross-agent subtask completion" }
    );

    const current = taskManager.getTask(task.id);
    assert.equal(current?.agentId, "mock");
    assert.equal(current?.agentKind, "mock");
    assert.equal(result.run.agentId, subtaskAgent.id);
    assert.equal(result.run.agentKind, "custom-cli");
  } finally {
    deleteCustomAgent(subtaskAgent.id);
  }
});

test("TaskManager continues a stopped planned child subtask instead of the primary subtask", async () => {
  const workspace = createWorkspace({
    name: "Stopped Subtask Resume Workspace",
    path: env.root,
    allowedAgentKinds: ["mock"],
  });

  const task = taskManager.createTask({
    agentId: "mock",
    workspaceId: workspace.id,
    prompt: "请按阶段完成：\n1. 收集信息\n2. 检查服务状态\n3. 输出报告",
    permissionMode: "full",
    autoPlanSubtasks: true,
    actor: "test",
  });

  await waitFor(
    () => {
      const current = taskManager.getTask(task.id);
      return current?.status === "review" ? current : null;
    },
    { timeoutMs: 7000, description: "initial stopped-resume planned task review gate" }
  );

  const planned = listSubtasks(task.id).filter((subtask) => subtask.parentSubtaskId);
  assert.equal(planned.length, 3);

  const stoppedTarget = planned[1]!;
  const currentTask = taskManager.getTask(task.id)!;
  const { run: stoppedRun } = orchestrator.startRun({
    task: currentTask,
    prompt: "模拟第二个子任务运行后被停止",
    images: [],
    source: "subtask_dispatch",
    subtaskId: stoppedTarget.id,
  });
  const stamp = new Date().toISOString();
  db.prepare("UPDATE task_runs SET status = 'stopped', finished_at = ? WHERE id = ?").run(stamp, stoppedRun.id);
  db.prepare("UPDATE subtasks SET status = 'stopped', updated_at = ? WHERE id = ?").run(stamp, stoppedTarget.id);
  db.prepare("UPDATE tasks SET status = 'stopped', updated_at = ? WHERE id = ?").run(stamp, task.id);

  taskManager.sendMessage(task.id, "继续", [], "test");

  await waitFor(
    () => {
      const runs = listTaskRuns(task.id);
      const latest = runs.at(-1);
      return latest?.subtaskId === stoppedTarget.id && latest.status === "review" ? latest : null;
    },
    { timeoutMs: 7000, description: "continued run returns to stopped planned subtask" }
  );

  const updatedStoppedTarget = listSubtasks(task.id).find((subtask) => subtask.id === stoppedTarget.id);
  assert.equal(updatedStoppedTarget?.status, "review");
  assert.equal(taskManager.getTask(task.id)?.status, "review");
});
