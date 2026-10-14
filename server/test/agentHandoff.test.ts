import test, { after } from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedDb, waitFor } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("agent-handoff");
const { db } = await import("../src/db/index.ts");
const { createWorkspace } = await import("../src/services/workspaceService.ts");
const { taskManager } = await import("../src/services/taskManager.ts");
const { createCustomAgent, deleteCustomAgent } = await import("../src/services/customAgentService.ts");
const { listSubtasks, listTaskRuns } = await import("../src/services/coreModelService.ts");
const { listAgentRequests, listRunCheckpoints } = await import("../src/orchestrator/orchestratorService.ts");
const { listAudit } = await import("../src/services/auditService.ts");
const { listNotifications } = await import("../src/services/notificationService.ts");

after(() => {
  db.close();
  env.cleanup();
});

test("TaskManager dispatches a controlled agent handoff onto a planned subtask", async () => {
  const workspace = createWorkspace({
    name: "Agent Handoff Workspace",
    path: env.root,
    allowedAgentKinds: ["mock", "custom-cli"],
  });
  const handoffAgent = createCustomAgent({
    template: "cli",
    name: "测试转交 Agent",
    command: process.execPath,
    argsTemplate: "-e \"console.log('custom handoff complete')\"",
  });

  try {
    const task = taskManager.createTask({
      agentId: "mock",
      workspaceId: workspace.id,
      prompt: "请按阶段完成：\n1. 梳理需求\n2. 交给执行 Agent 处理\n3. 验证结果",
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

    const plannedSubtask = listSubtasks(task.id).find((subtask) => subtask.parentSubtaskId && subtask.title.includes("执行 Agent"));
    assert.ok(plannedSubtask);

    taskManager.dispatchAgentHandoff(
      task.id,
      {
        agentId: handoffAgent.id,
        prompt: "请接手这个计划子任务，完成执行 Agent 处理部分。",
        subtaskId: plannedSubtask.id,
      },
      "test"
    );

    const runs = await waitFor(
      () => {
        const currentRuns = listTaskRuns(task.id);
        return currentRuns.find((run) => run.agentId === handoffAgent.id && run.status === "review") ? currentRuns : null;
      },
      { timeoutMs: 7000, description: "agent handoff mock run" }
    );
    const handoffRun = runs.find((run) => run.agentId === handoffAgent.id)!;

    const reassignedTask = taskManager.getTask(task.id);
    assert.equal(reassignedTask?.agentId, handoffAgent.id);
    assert.equal(reassignedTask?.agentKind, "custom-cli");
    assert.equal(handoffRun.subtaskId, plannedSubtask.id);
    assert.equal(listRunCheckpoints(handoffRun.id).some((checkpoint) => checkpoint.label === "run.started"), true);

    const updatedSubtask = listSubtasks(task.id).find((subtask) => subtask.id === plannedSubtask.id);
    assert.equal(updatedSubtask?.assignedAgentId, handoffAgent.id);
    assert.equal(updatedSubtask?.status, "review");

    const requests = listAgentRequests(task.id);
    const handoffRequest = requests.find((request) => request.source === "agent_handoff");
    assert.ok(handoffRequest);
    assert.equal(handoffRequest.requestedAgentId, handoffAgent.id);
    assert.equal(handoffRequest.requestedAgentKind, "custom-cli");
    assert.equal(handoffRequest.sourceRunId, runs[0]?.id);
    assert.equal(handoffRequest.targetRunId, handoffRun.id);
    assert.equal(handoffRequest.status, "review");

    const flow = taskManager.getFlowSnapshot(task.id)!;
    assert.equal(flow.agentRequests.some((request) => request.source === "agent_handoff"), true);
    assert.equal(flow.domainEvents.some((event) => event.name === "agent.handoff.dispatched"), true);
    assert.equal(flow.domainEvents.some((event) => event.name === "subtask.ready"), true);

    assert.equal(listAudit().some((entry) => entry.action === "dispatch_agent_handoff" && entry.taskId === task.id), true);
    assert.equal(listNotifications().some((notification) => notification.source === "agent_handoff" && notification.taskId === task.id), true);
    assert.equal(listNotifications().some((notification) => notification.source === "subtask_ready" && notification.taskId === task.id), true);
  } finally {
    deleteCustomAgent(handoffAgent.id);
  }
});
