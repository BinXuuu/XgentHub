import test, { after } from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedDb } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("queue");
const { db } = await import("../src/db/index.ts");
const queue = await import("../src/services/queueService.ts");

after(() => {
  db.close();
  env.cleanup();
});

test("queueService enqueues, reorders, removes, and dequeues messages", () => {
  const createdAt = new Date().toISOString();
  db.prepare("INSERT INTO workspaces (id, host_id, name, path, allowed_agent_kinds, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    "workspace-1",
    "local",
    "Queue Workspace",
    env.root,
    "[]",
    createdAt
  );
  db.prepare(
    `INSERT INTO tasks (id, agent_id, agent_kind, workspace_id, title, prompt, status, session_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("task-1", "mock", "mock", "workspace-1", "Queue Task", "prompt", "review", null, createdAt, createdAt);

  const first = queue.enqueue("task-1", "first", []);
  const second = queue.enqueue("task-1", "second", ["C:\\tmp\\image.png"]);
  const third = queue.enqueue("task-1", "third", []);

  assert.deepEqual(
    queue.listQueue("task-1").map((item) => item.content),
    ["first", "second", "third"]
  );

  queue.reorder("task-1", [third.id, first.id, second.id]);
  assert.deepEqual(
    queue.listQueue("task-1").map((item) => item.content),
    ["third", "first", "second"]
  );

  queue.removeItem("task-1", first.id);
  assert.deepEqual(
    queue.listQueue("task-1").map((item) => item.content),
    ["third", "second"]
  );

  assert.equal(queue.dequeueNext("task-1")?.content, "third");
  assert.equal(queue.dequeueNext("task-1")?.content, "second");
  assert.equal(queue.dequeueNext("task-1"), null);
});
