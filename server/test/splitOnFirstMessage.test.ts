import test, { after } from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedDb, waitFor } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("split-on-first-message");
const { db } = await import("../src/db/index.ts");
const { waitForSnapshotsIdle } = await import("../src/services/workspaceSnapshotService.ts");
const { createWorkspace } = await import("../src/services/workspaceService.ts");
const { taskManager } = await import("../src/services/taskManager.ts");
const { planMultiAgentTask } = await import("../src/services/multiAgentPlannerService.ts");
const { listSubtasks, listTaskRuns } = await import("../src/services/coreModelService.ts");
const { isPlanSummarySubtask } = await import("../src/services/subtaskPlannerService.ts");

after(async () => {
  await waitForSnapshotsIdle();
  db.close();
  env.cleanup();
});

const workspace = createWorkspace({ name: "Split On First Message", path: env.root, allowedAgentKinds: [] });

test("the planner only assigns within the chosen pool, and says so when none of the pool is usable", async () => {
  const plan = await planMultiAgentTask({ prompt: "做一个落地页", workspaceId: workspace.id, plannerAgentId: "mock", agentPool: ["mock"] });
  assert.ok(plan.subtasks.length > 0);
  assert.ok(plan.subtasks.every((item) => item.targetAgentId === "mock"));

  const fallback = await planMultiAgentTask({ prompt: "做一个落地页", workspaceId: workspace.id, plannerAgentId: "mock", agentPool: ["no-such-agent"] });
  assert.match(fallback.warnings[0] ?? "", /勾选的 Agent 在这个工作区都用不了/);
});

test("create first, say what to do later: the first message is split and the plan starts by itself", async () => {
  const task = taskManager.createTask({ agentId: "mock", workspaceId: workspace.id, title: "先建任务后说需求", splitAgentPool: ["mock"], permissionMode: "full", actor: "test" });
  assert.deepEqual(task.splitAgentPool, ["mock"]);
  assert.equal(task.status, "stopped", "no requirement yet, nothing runs");
  assert.equal(task.autoAdvancePlan, true);
  assert.equal(listSubtasks(task.id).length, 0);
  assert.ok(taskManager.listEvents(task.id).some((event) => /第一条需求会由 .* 拆成子任务/.test(String(event.payload?.message ?? ""))));

  taskManager.sendMessage(task.id, "做一个落地页，要文案和页面", [], "test");
  // 拆分要等总管家回话，这期间用户的需求已经显示在对话里。
  assert.deepEqual(taskManager.listMessages(task.id).filter((m) => m.role === "user").map((m) => m.content), ["做一个落地页，要文案和页面"]);
  assert.throws(() => taskManager.sendMessage(task.id, "再加一条", [], "test"), /正在拆分/);

  const planned = await waitFor(() => {
    const items = listSubtasks(task.id).filter((s) => s.parentSubtaskId && !isPlanSummarySubtask(s));
    return items.length >= 2 ? items : null;
  }, { timeoutMs: 10_000, description: "subtasks planned from the first message" });
  assert.ok(planned.every((s) => s.assignedAgentId === "mock"));
  assert.equal(taskManager.getTask(task.id)?.prompt, "做一个落地页，要文案和页面");
  assert.equal(taskManager.listMessages(task.id).filter((m) => m.role === "user").length, 1, "the first requirement is recorded once");

  // 计划自动推进：子任务都跑完、汇总也跑完，不用人点。
  await waitFor(() => {
    const summary = listSubtasks(task.id).find((s) => isPlanSummarySubtask(s));
    return summary && (summary.status === "done" || summary.status === "review") ? summary : null;
  }, { timeoutMs: 20_000, description: "summary finishes" });
  assert.ok(listTaskRuns(task.id).length >= 4, "coordinator + 2 subtasks + summary");

  // 拆过以后，后面的消息就是普通的继续对话，不会再拆一次。
  const before = listSubtasks(task.id).length;
  await waitFor(() => (["review", "done"].includes(taskManager.getTask(task.id)?.status ?? "") ? true : null), { timeoutMs: 10_000, description: "task idle" });
  taskManager.sendMessage(task.id, "谢谢", [], "test");
  await waitFor(() => (taskManager.listMessages(task.id).filter((m) => m.role === "user").length >= 2 ? true : null), { description: "follow-up recorded" });
  assert.equal(listSubtasks(task.id).length, before);
  await waitFor(() => (listTaskRuns(task.id).every((run) => run.finishedAt) ? true : null), { timeoutMs: 10_000, description: "follow-up run finishes" });
});
