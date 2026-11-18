import test, { after } from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedDb } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("butler");
const { db } = await import("../src/db/index.ts");
const { createWorkspace } = await import("../src/services/workspaceService.ts");
const { listButlerIntents, planButlerIntent } = await import("../src/services/butlerService.ts");

after(() => {
  db.close();
  env.cleanup();
});

test("butler plans intent into an agent recommendation and stores the plan", () => {
  const workspace = createWorkspace({
    name: "Butler Workspace",
    path: env.root,
    allowedAgentKinds: ["mock"],
  });

  const demoPlan = planButlerIntent({
    prompt: "用 mock 演示完整任务生命周期",
    workspaceId: workspace.id,
  });
  assert.equal(demoPlan.workspaceId, workspace.id);
  assert.equal(demoPlan.recommendedAgentId, "mock");
  assert.equal(demoPlan.recommendedPermissionMode, "supervised");
  assert.equal(demoPlan.signals.includes("demo"), true);
  assert.ok(demoPlan.confidence > 0);

  const codingPlan = planButlerIntent({
    prompt: "修复 React 前端 bug 并运行 npm test",
    workspaceId: workspace.id,
  });
  assert.equal(codingPlan.recommendedAgentId, "mock");
  assert.equal(codingPlan.signals.includes("coding"), true);
  assert.equal(codingPlan.signals.includes("command_execution"), true);
  assert.equal(codingPlan.agentScores.some((score) => score.blockedReasons.some((reason) => reason.includes("未授权"))), true);

  const stored = listButlerIntents({ limit: 5 });
  assert.equal(stored.length, 2);
  assert.equal(stored[0]?.id, codingPlan.id);
  assert.equal(stored[1]?.id, demoPlan.id);
});
