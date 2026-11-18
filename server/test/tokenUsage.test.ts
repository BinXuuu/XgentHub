import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupIsolatedDb, waitFor } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("token-usage");
const { db } = await import("../src/db/index.ts");
const { normalizeUsage } = await import("../src/adapters/tokenUsage.ts");
const { createWorkspace } = await import("../src/services/workspaceService.ts");
const { taskManager } = await import("../src/services/taskManager.ts");
const { listTaskRuns } = await import("../src/services/coreModelService.ts");
const { waitForSnapshotsIdle } = await import("../src/services/workspaceSnapshotService.ts");

after(async () => {
  await waitForSnapshotsIdle();
  db.close();
  env.cleanup();
});

test("every agent's usage shape becomes input / output / cached / total", () => {
  // Claude Code / CodeBuddy：input_tokens 不含缓存
  assert.deepEqual(normalizeUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }), {
    inputTokens: 10, outputTokens: 5, cachedTokens: 120, totalTokens: 135,
  });
  // Codex：input_tokens 已经包含 cached_input_tokens
  assert.deepEqual(normalizeUsage({ input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 }), {
    inputTokens: 200, outputTokens: 50, cachedTokens: 800, totalTokens: 1050,
  });
  // OpenAI 兼容接口
  assert.deepEqual(normalizeUsage({ prompt_tokens: 300, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 100 } }), {
    inputTokens: 200, outputTokens: 40, cachedTokens: 100, totalTokens: 340,
  });
  // DeepSeek Harness 的 step_end.usage（实测样例）
  assert.deepEqual(normalizeUsage({ inputTokens: 5134, outputTokens: 135, cacheReadTokens: 5760, cacheWriteTokens: 0, totalTokens: 11029 }), {
    inputTokens: 5134, outputTokens: 135, cachedTokens: 5760, totalTokens: 11029,
  });
  assert.equal(normalizeUsage({}), null);
  assert.equal(normalizeUsage({ input_tokens: 0, output_tokens: 0 }), null);
  assert.equal(normalizeUsage("nope"), null);
});

test("usage reported during a run is stored on that run and adds up across steps", async () => {
  const dir = path.join(env.root, "ws");
  fs.mkdirSync(dir, { recursive: true });
  const workspace = createWorkspace({ name: "token-usage", path: dir, allowedAgentKinds: [] });
  const task = taskManager.createTask({ agentId: "mock", workspaceId: workspace.id, title: "t", prompt: "写个小功能", permissionMode: "full", actor: "test" });
  await waitFor(() => (["review", "done", "failed"].includes(taskManager.getTask(task.id)?.status ?? "") ? true : null), { timeoutMs: 20_000, description: "first run ends" });
  const [first] = listTaskRuns(task.id);
  assert.deepEqual(first.usage, { inputTokens: 1200, outputTokens: 300, cachedTokens: 500, totalTokens: 2000 });

  taskManager.sendMessage(task.id, "再改一下", [], "test");
  await waitFor(() => (listTaskRuns(task.id).length === 2 && listTaskRuns(task.id).every((run) => run.finishedAt) ? true : null), { timeoutMs: 20_000, description: "second run ends" });
  const runs = listTaskRuns(task.id);
  assert.deepEqual(runs[1].usage, { inputTokens: 200, outputTokens: 50, cachedTokens: 0, totalTokens: 250 }, "each run keeps its own usage");
  assert.deepEqual(runs[0].usage?.totalTokens, 2000);
});
