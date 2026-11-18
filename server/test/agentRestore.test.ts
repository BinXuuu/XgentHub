import test, { after } from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedDb } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("agent-restore");
const { db } = await import("../src/db/index.ts");
const { taskManager } = await import("../src/services/taskManager.ts");
const { hideAgent } = await import("../src/services/agentVisibilityService.ts");

after(() => {
  db.close();
  env.cleanup();
});

test("a deleted built-in agent can be found again on the add page and restored", () => {
  assert.deepEqual(taskManager.listHiddenAgents(), []);
  hideAgent("doubao");
  assert.equal(taskManager.listAgents().some((agent) => agent.id === "doubao"), false);
  assert.deepEqual(taskManager.listHiddenAgents().map((agent) => agent.id), ["doubao"]);

  const restored = taskManager.restoreAgent("doubao");
  assert.equal(restored.id, "doubao");
  assert.ok(taskManager.listAgents().some((agent) => agent.id === "doubao"));
  assert.deepEqual(taskManager.listHiddenAgents(), []);
  assert.throws(() => taskManager.restoreAgent("doubao"), /不需要恢复/);
});
