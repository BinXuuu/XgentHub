import test, { after } from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedDb, waitFor } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("backfill");
const { db, backfillCoreRecords } = await import("../src/db/index.ts");
const { waitForSnapshotsIdle } = await import("../src/services/workspaceSnapshotService.ts");
const { createWorkspace } = await import("../src/services/workspaceService.ts");
const { taskManager } = await import("../src/services/taskManager.ts");

after(async () => {
  await waitForSnapshotsIdle();
  db.close();
  env.cleanup();
});

const runIds = (taskId: string) => (db.prepare("SELECT id FROM task_runs WHERE task_id = ? ORDER BY rowid").all(taskId) as { id: string }[]).map((row) => row.id);
const primaryIds = (taskId: string) => (db.prepare("SELECT id FROM subtasks WHERE task_id = ? AND parent_subtask_id IS NULL ORDER BY rowid").all(taskId) as { id: string }[]).map((row) => row.id);

test("startup backfill leaves new tasks alone, cleans phantom rows from older versions, and still fills real legacy tasks", async () => {
  const workspace = createWorkspace({ name: "Backfill Workspace", path: env.root, allowedAgentKinds: ["mock"] });
  const task = taskManager.createTask({ agentId: "mock", workspaceId: workspace.id, prompt: "做一件小事", permissionMode: "full", autoPlanSubtasks: false, actor: "test" });
  await waitFor(() => (["review", "done"].includes(taskManager.getTask(task.id)?.status ?? "") ? true : null), { timeoutMs: 10_000, description: "task finished" });
  const runs = runIds(task.id);
  const primaries = primaryIds(task.id);
  assert.equal(runs.length, 1);
  assert.equal(primaries.length, 1);

  // 相当于服务重启了两次：新任务不能再被补出 initial: 运行和 primary: 子任务。
  backfillCoreRecords();
  backfillCoreRecords();
  assert.deepEqual(runIds(task.id), runs);
  assert.deepEqual(primaryIds(task.id), primaries);

  // 旧版本已经补出来的空记录：下次启动时清掉。
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as any;
  db.prepare("INSERT INTO subtasks (id, task_id, parent_subtask_id, title, status, assigned_agent_id, dependency_ids, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, '[]', ?, ?)")
    .run(`primary:${task.id}`, task.id, row.title, row.status, row.agent_id, row.created_at, row.updated_at);
  db.prepare("INSERT INTO task_runs (id, task_id, subtask_id, agent_id, agent_kind, runtime_kind, model, status, attempt, session_key, started_at, finished_at, error) VALUES (?, ?, ?, ?, ?, 'mock', NULL, ?, 1, NULL, ?, ?, NULL)")
    .run(`initial:${task.id}`, task.id, `primary:${task.id}`, row.agent_id, row.agent_kind, row.status, row.created_at, row.updated_at);
  assert.equal(runIds(task.id).length, 2);
  backfillCoreRecords();
  assert.deepEqual(runIds(task.id), runs, "phantom initial: run removed");
  assert.deepEqual(primaryIds(task.id), primaries, "phantom primary: subtask removed");

  // 真正的老任务（没有任何子任务和运行）照样补上，而且只补一次。
  const legacy = taskManager.createTask({ agentId: "mock", workspaceId: workspace.id, prompt: "老任务", permissionMode: "full", autoPlanSubtasks: false, actor: "test" });
  await waitFor(() => (["review", "done"].includes(taskManager.getTask(legacy.id)?.status ?? "") ? true : null), { timeoutMs: 10_000, description: "legacy task finished" });
  for (const table of ["agent_requests", "run_checkpoints", "domain_events", "file_changes", "artifacts"]) {
    try { db.prepare(`DELETE FROM ${table} WHERE task_id = ?`).run(legacy.id); } catch { /* 表里没有 task_id 列就跳过 */ }
  }
  db.prepare("DELETE FROM task_runs WHERE task_id = ?").run(legacy.id);
  db.prepare("DELETE FROM subtasks WHERE task_id = ?").run(legacy.id);
  backfillCoreRecords();
  backfillCoreRecords();
  assert.deepEqual(primaryIds(legacy.id), [`primary:${legacy.id}`]);
  assert.deepEqual(runIds(legacy.id), [`initial:${legacy.id}`]);
  assert.equal((db.prepare("SELECT subtask_id FROM task_runs WHERE id = ?").get(`initial:${legacy.id}`) as any).subtask_id, `primary:${legacy.id}`);
});
