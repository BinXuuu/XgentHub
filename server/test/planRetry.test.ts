import test, { after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { setupIsolatedDb, waitFor } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("plan-retry");
const { db } = await import("../src/db/index.ts");
const { waitForSnapshotsIdle } = await import("../src/services/workspaceSnapshotService.ts");
const { createWorkspace } = await import("../src/services/workspaceService.ts");
const { taskManager } = await import("../src/services/taskManager.ts");
const { createCustomAgent, deleteCustomAgent } = await import("../src/services/customAgentService.ts");
const { listSubtasks, listTaskRuns } = await import("../src/services/coreModelService.ts");
const { listAgentRequests } = await import("../src/orchestrator/orchestratorService.ts");
const { isPlanSummarySubtask } = await import("../src/services/subtaskPlannerService.ts");
const { fixPlannerPaths } = await import("../src/services/multiAgentPlannerService.ts");

after(async () => {
  await waitForSnapshotsIdle();
  db.close();
  env.cleanup();
});

test("planner paths that point at the Xgent server folder are rewritten to the real workspace", () => {
  const workspace = { path: "C:\\Users\\me\\Desktop\\ceshi" } as any;
  const server = "C:\\XgentHub\\server";
  const dirs = [server, path.dirname(server)];
  const prompt = "在当前工作区 C:\\XgentHub\\server 创建 timer.js；参考 c:/xgenthub/server/x.js 和 C:\\XgentHub\\README.md";
  const fixed = fixPlannerPaths(prompt, workspace, dirs);
  if (process.platform === "win32") {
    assert.equal(fixed, "在当前工作区 C:\\Users\\me\\Desktop\\ceshi 创建 timer.js；参考 C:\\Users\\me\\Desktop\\ceshi/x.js 和 C:\\Users\\me\\Desktop\\ceshi\\README.md");
  }
  assert.equal(fixPlannerPaths("C:\\XgentHub2\\a.txt", workspace, dirs), "C:\\XgentHub2\\a.txt", "a different folder with a longer name is left alone");
  assert.equal(fixPlannerPaths("没有路径", workspace, dirs), "没有路径");
  const insideRepo = { path: path.join(path.dirname(server), "playground") } as any;
  assert.ok(fixPlannerPaths(`改 ${path.dirname(server)}${path.sep}playground${path.sep}a.js`, insideRepo, dirs).includes("playground"), "a workspace inside the repo keeps its own paths");
});

test("retrying a stopped multi-agent task re-queues the stopped subtasks on their own agents and resumes auto-dispatch", async () => {
  const workspace = createWorkspace({ name: "Plan Retry Workspace", path: env.root, allowedAgentKinds: ["mock", "custom-cli"] });
  const slow = createCustomAgent({
    template: "cli",
    name: "慢速子任务 Agent",
    command: process.execPath,
    argsTemplate: "-e \"setTimeout(() => console.log('slow subtask done'), 2500)\"",
  });
  try {
    const task = taskManager.createTask({
      agentId: "mock",
      workspaceId: workspace.id,
      title: "重试测试",
      prompt: "做两件事",
      permissionMode: "full",
      multiAgentPlan: {
        prompt: "做两件事",
        source: "llm",
        plannerAgentId: "mock",
        reasoning: "test",
        warnings: [],
        subtasks: [
          { index: 1, title: "甲", description: "", dependsOn: [], targetAgentId: "mock", skillIds: [], prompt: "执行甲" },
          { index: 2, title: "乙", description: "", dependsOn: [], targetAgentId: slow.id, skillIds: [], prompt: "执行乙" },
        ],
      },
      autoAdvancePlan: true,
      actor: "test",
    });
    const planned = () => listSubtasks(task.id).filter((subtask) => subtask.parentSubtaskId);
    const byTitle = (title: string) => planned().find((subtask) => subtask.title === title)!;

    // 两条都派出去之后停止整个任务。
    await waitFor(() => (byTitle("乙").status === "running" && byTitle("甲").status !== "queued" ? true : null), { timeoutMs: 15_000, description: "both subtasks dispatched" });
    await taskManager.stopTask(task.id, "test");
    await waitFor(() => (byTitle("乙").status === "stopped" ? true : null), { timeoutMs: 10_000, description: "slow subtask stopped" });
    await waitFor(() => (!["running", "needs_approval"].includes(taskManager.getTask(task.id)!.status) ? true : null), { timeoutMs: 10_000, description: "task no longer running" });
    assert.equal(taskManager.getTask(task.id)?.autoAdvancePlan, false, "stop pauses auto-dispatch");
    const runsBefore = listTaskRuns(task.id).length;

    // 重试：停下来的子任务按各自分配的 Agent 重新派发，恢复说明附在原指令后面，自动执行重新打开。
    taskManager.retryTask(task.id, "上次没登录，现在登录好了", "test");
    assert.equal(taskManager.getTask(task.id)?.autoAdvancePlan, true);
    const retried = await waitFor(
      () => listTaskRuns(task.id).slice(runsBefore).find((run) => run.subtaskId === byTitle("乙").id) ?? null,
      { timeoutMs: 10_000, description: "slow subtask re-dispatched" }
    );
    assert.equal(retried.agentId, slow.id, "the retry uses the subtask's own agent, not the task's agent");
    const request = listAgentRequests(task.id).find((entry) => entry.targetRunId === retried.id);
    assert.ok(request, "the re-dispatch is recorded as an agent request");
    assert.match(request.prompt, /执行乙[\s\S]*这是一次重试，用户的恢复说明：上次没登录，现在登录好了/);
    assert.ok(!listTaskRuns(task.id).slice(runsBefore).some((run) => run.subtaskId === null), "no extra butler run on the whole task");

    // 全部跑完后照常汇总。
    const summary = await waitFor(
      () => {
        const item = planned().find((subtask) => isPlanSummarySubtask(subtask));
        return item && (item.status === "review" || item.status === "done") ? item : null;
      },
      { timeoutMs: 30_000, description: "summary runs after the retried subtasks finish" }
    );
    assert.ok(summary);
    assert.ok(planned().every((subtask) => subtask.status === "review" || subtask.status === "done"));
    await waitFor(() => (taskManager.getTask(task.id)?.status === "review" ? true : null), { timeoutMs: 10_000, description: "task ends in review" });
  } finally {
    deleteCustomAgent(slow.id);
  }
});
