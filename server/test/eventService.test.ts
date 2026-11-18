import test, { after } from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedDb } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("event-service");
const { db } = await import("../src/db/index.ts");
const { createWorkspace } = await import("../src/services/workspaceService.ts");
const {
  domainNameForLegacyEvent,
  emitTaskEvent,
  emitTaskStatusChanged,
  listDomainEvents,
  recordDomainEvent,
} = await import("../src/services/eventService.ts");

const workspace = createWorkspace({
  name: "Event Workspace",
  path: env.root,
  allowedAgentKinds: ["mock"],
});

after(() => {
  db.close();
  env.cleanup();
});

function insertTask(): string {
  const taskId = "event-task";
  const stamp = new Date().toISOString();
  db.prepare(
    `INSERT INTO tasks (
      id, agent_id, agent_kind, workspace_id, title, prompt, status, session_key,
      model, permission_mode, sub_agent_id, budget_limit_cny, created_at, updated_at
    ) VALUES (?, 'mock', 'mock', ?, 'Event Task', 'prompt', 'running', NULL, NULL, 'supervised', NULL, NULL, ?, ?)`
  ).run(taskId, workspace.id, stamp, stamp);
  return taskId;
}

test("eventService records canonical events while preserving legacy task events", () => {
  const taskId = insertTask();
  assert.equal(domainNameForLegacyEvent("approval_requested"), "approval.requested");

  const legacy = emitTaskEvent({
    taskId,
    type: "log",
    payload: { message: "hello" },
  });
  emitTaskStatusChanged({ taskId, status: "review" });
  recordDomainEvent({ name: "task.created", taskId, payload: { title: "Event Task" } });

  const legacyRows = db.prepare("SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC").all(taskId) as any[];
  assert.equal(legacyRows.length, 1);
  assert.equal(legacyRows[0]?.id, legacy.id);
  assert.equal(legacyRows[0]?.type, "log");

  assert.deepEqual(
    listDomainEvents(taskId).map((event) => event.name),
    ["task.log.created", "task.status.changed", "task.created"]
  );
});

test("eventService drops stale run references instead of failing status events", () => {
  const taskId = "event-task-stale-run";
  const stamp = new Date().toISOString();
  db.prepare(
    `INSERT INTO tasks (
      id, agent_id, agent_kind, workspace_id, title, prompt, status, session_key,
      model, permission_mode, sub_agent_id, budget_limit_cny, created_at, updated_at
    ) VALUES (?, 'mock', 'mock', ?, 'Event Task', 'prompt', 'running', NULL, NULL, 'supervised', NULL, NULL, ?, ?)`
  ).run(taskId, workspace.id, stamp, stamp);

  assert.doesNotThrow(() => emitTaskStatusChanged({ taskId, status: "review", runId: "missing-run" }));

  const row = db
    .prepare("SELECT run_id FROM domain_events WHERE task_id = ? AND name = 'task.status.changed' ORDER BY created_at DESC LIMIT 1")
    .get(taskId) as { run_id: string | null } | undefined;
  assert.equal(row?.run_id, null);
});
