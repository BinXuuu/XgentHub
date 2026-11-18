import test, { after } from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedDb, waitFor } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("adapter-stop");
const { db } = await import("../src/db/index.ts");
const { waitForSnapshotsIdle } = await import("../src/services/workspaceSnapshotService.ts");
const { createWorkspace } = await import("../src/services/workspaceService.ts");
const { taskManager } = await import("../src/services/taskManager.ts");
const { createCustomAgent, deleteCustomAgent } = await import("../src/services/customAgentService.ts");
const { listTaskRuns } = await import("../src/services/coreModelService.ts");

after(async () => {
  await waitForSnapshotsIdle();
  db.close();
  env.cleanup();
});

test("stopTask actually kills the underlying custom-cli child process instead of just flipping the status flag", async () => {
  const workspace = createWorkspace({ name: "Adapter Stop Workspace", path: env.root, allowedAgentKinds: ["custom-cli"] });
  // 睡 8 秒不输出任何东西：如果 stop() 真的把进程杀了，任务应该在远小于 8 秒内变成 stopped；
  // 如果 stop() 只是摆设（没有真正杀掉子进程），dispatch() 里等 runCommand 的 promise 要等满 8 秒才会 resolve。
  const agent = createCustomAgent({
    template: "cli",
    name: "测试长时间运行 Agent",
    command: process.execPath,
    argsTemplate: '-e "setTimeout(() => {}, 8000)"',
  });

  try {
    const task = taskManager.createTask({
      agentId: agent.id,
      workspaceId: workspace.id,
      title: "停止长时间运行的自定义 CLI",
      prompt: "开始一个会长时间运行的命令",
      permissionMode: "full",
      actor: "test",
    });

    // 派发前要先拍工作区快照，status=running 时子进程可能还没起来；等快照落库（之后马上启动 adapter），
    // 再给子进程一点时间真正 spawn 出来，这样停止验证的才是"杀掉正在跑的进程"。
    await waitFor(() => (taskManager.listSnapshots(task.id).length > 0 ? true : null), {
      timeoutMs: 15000,
      description: "before_run snapshot taken so the child process is about to spawn",
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(taskManager.getTask(task.id)?.status, "running");

    const startedStoppingAt = Date.now();
    await taskManager.stopTask(task.id, "test");
    const stopCallDurationMs = Date.now() - startedStoppingAt;

    // stopTask 调用本身应该很快返回（kill + close 事件是同步/近乎同步的，不应该卡住等 8 秒的 timeout）。
    assert.ok(stopCallDurationMs < 4000, `stopTask() 耗时 ${stopCallDurationMs}ms，看起来没有真的杀掉子进程，而是在等它自然结束`);
    assert.equal(taskManager.getTask(task.id)?.status, "stopped");

    const runs = listTaskRuns(task.id);
    assert.equal(runs.at(-1)?.status, "stopped");

    // stop() 只是发出 kill 信号就同步返回了；子进程真正被操作系统终止、触发 close 事件、
    // 让 dispatch() 里挂着的 runCommand() promise 落地，这些都是异步的。测试结束前留点时间
    // 让它们收尾，不然 db.close() 跑在前面，close 事件里的收尾代码会摸到一个已经关闭的数据库。
    await new Promise((resolve) => setTimeout(resolve, 1500));
  } finally {
    deleteCustomAgent(agent.id);
  }
});

test("stopping a task while parallel subtasks run kills every one of them (even two runs of the same agent) and does not start the summary", async () => {
  const workspace = createWorkspace({ name: "Parallel Stop Workspace", path: env.root, allowedAgentKinds: [] });
  const agent = createCustomAgent({
    template: "cli",
    name: "测试并行长时间运行 Agent",
    command: process.execPath,
    argsTemplate: '-e "setTimeout(() => {}, 8000)"',
  });
  const { listSubtasks } = await import("../src/services/coreModelService.ts");
  const { isPlanSummarySubtask } = await import("../src/services/subtaskPlannerService.ts");

  try {
    const task = taskManager.createTask({
      agentId: "mock",
      workspaceId: workspace.id,
      title: "并行停止测试",
      prompt: "两个子任务同时跑",
      permissionMode: "full",
      multiAgentPlan: {
        prompt: "两个子任务同时跑",
        source: "llm",
        plannerAgentId: "mock",
        reasoning: "test",
        warnings: [],
        subtasks: [
          { index: 1, title: "长任务 A", description: "", dependsOn: [], targetAgentId: agent.id, skillIds: [], prompt: "跑 A" },
          { index: 2, title: "长任务 B", description: "", dependsOn: [], targetAgentId: agent.id, skillIds: [], prompt: "跑 B" },
        ],
      },
      autoAdvancePlan: true,
      actor: "test",
    });

    const branchRunIds = await waitFor(
      () => {
        const runs = listTaskRuns(task.id).filter((run) => run.agentId === agent.id && run.status === "running");
        return runs.length === 2 ? runs.map((run) => run.id) : null;
      },
      { timeoutMs: 15_000, description: "both branches of the same custom agent running at once" }
    );
    // 给两个子进程一点时间真正 spawn 出来。
    await new Promise((resolve) => setTimeout(resolve, 800));

    const startedStoppingAt = Date.now();
    await taskManager.stopTask(task.id, "test");
    assert.ok(Date.now() - startedStoppingAt < 4000, "两个进程都应该被直接杀掉，而不是等它们自然结束");

    const runs = listTaskRuns(task.id).filter((run) => branchRunIds.includes(run.id));
    assert.deepEqual(runs.map((run) => run.status), ["stopped", "stopped"], "同一个 Agent 的两份并行运行都要停掉，不能只停一个");
    assert.equal(taskManager.getTask(task.id)?.status, "stopped");
    assert.equal(taskManager.getTask(task.id)?.autoAdvancePlan, false, "停止后暂停自动执行，不再派出新的子任务");

    await new Promise((resolve) => setTimeout(resolve, 1500));
    const summary = listSubtasks(task.id).find((subtask) => isPlanSummarySubtask(subtask))!;
    assert.equal(listTaskRuns(task.id).some((run) => run.subtaskId === summary.id), false, "停止后不应该开始汇总");
  } finally {
    deleteCustomAgent(agent.id);
  }
});
