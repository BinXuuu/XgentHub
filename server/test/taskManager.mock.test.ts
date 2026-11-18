import test, { after } from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedDb, waitFor } from "./helpers/testEnv.ts";
import type { Approval } from "../src/types.ts";

const env = setupIsolatedDb("task-manager");
const { db } = await import("../src/db/index.ts");
const { waitForSnapshotsIdle } = await import("../src/services/workspaceSnapshotService.ts");
const { createWorkspace } = await import("../src/services/workspaceService.ts");
const { taskManager } = await import("../src/services/taskManager.ts");
const { listArtifacts, listSubtasks, listTaskRuns } = await import("../src/services/coreModelService.ts");
const { listAgentRequests, listRunCheckpoints } = await import("../src/orchestrator/orchestratorService.ts");

after(async () => {
  await waitForSnapshotsIdle();
  db.close();
  env.cleanup();
});

test("TaskManager can create a named chat without starting an agent run", () => {
  const workspace = createWorkspace({
    name: "Draft Chat Workspace",
    path: env.root,
    allowedAgentKinds: ["mock"],
  });
  const nextWorkspace = createWorkspace({
    name: "Draft Chat Workspace 2",
    path: env.root,
    allowedAgentKinds: ["mock"],
  });

  const task = taskManager.createTask({
    agentId: "mock",
    workspaceId: workspace.id,
    title: "只创建对话",
    prompt: "",
    permissionMode: "full",
    actor: "test",
  });

  assert.equal(task.title, "只创建对话");
  assert.equal(task.prompt, "");
  assert.equal(task.status, "stopped");
  assert.equal(taskManager.listMessages(task.id).length, 0);
  assert.equal(listTaskRuns(task.id).length, 0);
  assert.equal(listSubtasks(task.id).length, 0);

  const moved = taskManager.changeTaskWorkspace(task.id, nextWorkspace.id, false, "test");
  assert.equal(moved.workspaceId, nextWorkspace.id);
  assert.equal(taskManager.listMessages(task.id).at(-1)?.role, "system");
});

test("TaskManager requires confirmation before changing workspace after history exists", async () => {
  const workspace = createWorkspace({
    name: "Historical Workspace",
    path: env.root,
    allowedAgentKinds: ["mock"],
  });
  const nextWorkspace = createWorkspace({
    name: "Historical Workspace 2",
    path: env.root,
    allowedAgentKinds: ["mock"],
  });
  const task = taskManager.createTask({
    agentId: "mock",
    workspaceId: workspace.id,
    title: "已有历史的任务",
    prompt: "finish without approval gates",
    permissionMode: "full",
    actor: "test",
  });

  await waitFor(
    () => {
      const current = taskManager.getTask(task.id);
      return current?.status === "review" || current?.status === "done" ? current : null;
    },
    { timeoutMs: 5000, description: "historical task review status" }
  );

  assert.throws(() => taskManager.changeTaskWorkspace(task.id, nextWorkspace.id, false, "test"), /需要确认/);
  const moved = taskManager.changeTaskWorkspace(task.id, nextWorkspace.id, true, "test");
  assert.equal(moved.workspaceId, nextWorkspace.id);
  assert.equal(taskManager.listMessages(task.id).some((message) => message.role === "system" && message.content.includes("后续 Agent 将在新工作区执行")), true);
  assert.equal(taskManager.listDomainEvents(task.id).some((event) => event.name === "task.workspace.changed"), true);
});

test("TaskManager drives the mock adapter through messages, approvals, files, and review status", async () => {
  const workspace = createWorkspace({
    name: "Mock Workspace",
    path: env.root,
    allowedAgentKinds: ["mock"],
  });

  const task = taskManager.createTask({
    agentId: "mock",
    workspaceId: workspace.id,
    prompt: "exercise the regression path",
    permissionMode: "supervised",
    actor: "test",
  });

  const installApproval = await waitFor<Approval>(
    () => taskManager.listApprovals(task.id).find((approval) => approval.status === "pending" && approval.command.includes("npm install")),
    { timeoutMs: 5000, description: "mock install approval" }
  );
  taskManager.approveAction(task.id, installApproval.id, "approve_once", undefined, "test");

  const pushApproval = await waitFor<Approval>(
    () => taskManager.listApprovals(task.id).find((approval) => approval.status === "pending" && approval.command.includes("git push")),
    { timeoutMs: 5000, description: "mock push approval" }
  );
  taskManager.approveAction(task.id, pushApproval.id, "deny", "blocked by test", "test");

  await waitFor(
    () => {
      const current = taskManager.getTask(task.id);
      return current?.status === "review" ? current : null;
    },
    { timeoutMs: 5000, description: "mock task review status" }
  );

  const messages = taskManager.listMessages(task.id);
  assert.equal(messages[0]?.role, "user");
  assert.equal(messages.some((message) => message.role === "agent" && message.content.includes("已跳过 git push")), true);

  const files = taskManager.getFiles(task.id);
  assert.equal(files.length, 1);
  assert.equal(files[0]?.path, "src/utils/helper.ts");
  assert.match(taskManager.getDiff(task.id), /return 2/);

  const subtasks = listSubtasks(task.id);
  assert.equal(subtasks.length, 1);
  assert.equal(subtasks[0]?.assignedAgentId, "mock");
  assert.equal(subtasks[0]?.status, "review");

  const runs = listTaskRuns(task.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.agentId, "mock");
  assert.equal(runs[0]?.status, "review");
  assert.equal(runs[0]?.sessionKey, `mock-${task.id}`);
  assert.ok(runs[0]?.finishedAt);

  const artifacts = listArtifacts(task.id);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0]?.kind, "file");
  assert.equal(artifacts[0]?.path, "src/utils/helper.ts");

  const approvals = taskManager.listApprovals(task.id);
  assert.equal(approvals.length, 2);
  assert.equal(approvals.some((approval) => approval.status === "approved"), true);
  assert.equal(approvals.some((approval) => approval.status === "denied"), true);

  assert.equal(taskManager.listEvents(task.id).some((event) => event.type === "approval_requested"), true);

  const attachedImage = "C:\\XgentHub\\server\\data\\attachments\\pending\\test-image.png";
  taskManager.sendMessage(task.id, "continue once", [attachedImage], "test");
  await waitFor(
    () => {
      const currentRuns = listTaskRuns(task.id);
      return currentRuns.length === 2 && currentRuns[1]?.status === "review" ? currentRuns : null;
    },
    { timeoutMs: 5000, description: "second mock run" }
  );
  const allRuns = listTaskRuns(task.id);
  assert.equal(allRuns[1]?.attempt, 2);
  assert.deepEqual(
    taskManager.listMessages(task.id).find((message) => message.content === "continue once")?.images,
    [attachedImage]
  );

  const requests = listAgentRequests(task.id);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.source, "create_task");
  assert.equal(requests[0]?.status, "review");
  assert.equal(requests[1]?.source, "user_message");
  assert.equal(requests[1]?.status, "review");
  assert.equal(listRunCheckpoints(allRuns[0]!.id).some((checkpoint) => checkpoint.label === "run.started"), true);
  assert.equal(listRunCheckpoints(allRuns[0]!.id).some((checkpoint) => checkpoint.label === "run.finished"), true);

  const domainEventNames = taskManager.listDomainEvents(task.id).map((event) => event.name);
  for (const expected of [
    "task.created",
    "run.started",
    "task.message.created",
    "approval.requested",
    "approval.resolved",
    "task.status.changed",
    "run.finished",
  ]) {
    assert.equal(domainEventNames.includes(expected as any), true, `missing domain event ${expected}`);
  }

  const flow = taskManager.getFlowSnapshot(task.id)!;
  assert.equal(flow.task.id, task.id);
  assert.equal(flow.subtasks.length, 1);
  assert.equal(flow.runs.length, 2);
  assert.equal(flow.artifacts.length, 1);
  assert.equal(flow.agentRequests.length, 2);
  assert.equal(flow.runCheckpoints[flow.runs[0]!.id]?.some((checkpoint) => checkpoint.label === "run.started"), true);
  assert.equal(flow.domainEvents.some((event) => event.name === "task.created"), true);
});
