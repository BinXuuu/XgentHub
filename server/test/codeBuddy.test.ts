import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupIsolatedDb, waitFor } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("codebuddy");
// CodeBuddy 跟 Claude Code 说同一套协议，用假 claude 冒充，并打开它按真 codebuddy 2.177.0 实测出的几处差别：
// 不认 --permission-prompt-tool（stream-json 输入就会问）、权限答复用 { allowed, reason }。
const fakeScript = path.resolve(import.meta.dirname, "fixtures", "fake-claude.cjs");
const argsFile = path.join(env.root, "codebuddy-args.jsonl");
const shim = path.join(env.root, process.platform === "win32" ? "fake-codebuddy.cmd" : "fake-codebuddy.sh");
if (process.platform === "win32") fs.writeFileSync(shim, `@"${process.execPath}" "${fakeScript}" %*\r\n`);
else fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fakeScript}" "$@"\n`, { mode: 0o755 });
process.env.CODEBUDDY_BIN = shim;
process.env.CODEBUDDY_MODEL = "balanced-model";
process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
process.env.FAKE_CLI_ASK_ON_STREAM_INPUT = "1";
process.env.FAKE_CLI_ANSWER_STYLE = "codebuddy";

const { db } = await import("../src/db/index.ts");
const { createWorkspace } = await import("../src/services/workspaceService.ts");
const { taskManager } = await import("../src/services/taskManager.ts");
const { parseHelpModels, CodeBuddyAdapter } = await import("../src/adapters/codeBuddy.ts");
const { waitForSnapshotsIdle } = await import("../src/services/workspaceSnapshotService.ts");

after(async () => {
  await waitForSnapshotsIdle();
  db.close();
  env.cleanup();
});

function newWorkspace(name: string) {
  const dir = path.join(env.root, name);
  fs.mkdirSync(dir, { recursive: true });
  return { dir, workspace: createWorkspace({ name, path: dir, allowedAgentKinds: [] }) };
}

function waitStatus(taskId: string, statuses: string[]) {
  return waitFor(() => (statuses.includes(taskManager.getTask(taskId)?.status ?? "") ? taskManager.getTask(taskId) : null), {
    timeoutMs: 15_000,
    description: `task to reach ${statuses.join("/")}`,
  });
}

function waitPendingApproval(taskId: string) {
  return waitFor(() => taskManager.listApprovals(taskId).find((item) => item.status === "pending") ?? null, {
    timeoutMs: 15_000,
    description: "CodeBuddy permission request to show up as a pending approval",
  });
}

const lastArgs = (): string[] => JSON.parse(fs.readFileSync(argsFile, "utf8").trim().split("\n").at(-1)!);

test("model IDs come from the --model line of codebuddy --help", () => {
  const help = [
    "  --model <model>                                  Model for the current session. Please provide the model ID. Currently supported: (default-model, fast-model, deep-model, glm-5.3, kimi-k3)",
    "  --text-to-image-model <model>                    Model for text-to-image generation",
  ].join("\n");
  assert.deepEqual(parseHelpModels(help), [
    { id: "default-model", label: "默认模型" },
    { id: "fast-model", label: "快速" },
    { id: "deep-model", label: "深度思考" },
    { id: "glm-5.3", label: "glm-5.3" },
    { id: "kimi-k3", label: "kimi-k3" },
  ]);
  assert.deepEqual(parseHelpModels("no model line"), []);
});

test("not logged in: the task fails with how to log in instead of the raw English error", async () => {
  process.env.FAKE_CLI_NOT_LOGGED_IN = "1";
  try {
    const { workspace } = newWorkspace("cb-not-logged-in");
    const task = taskManager.createTask({ agentId: "codebuddy", workspaceId: workspace.id, title: "建目录", prompt: "建一个 out-dir", permissionMode: "full", actor: "test" });
    await waitStatus(task.id, ["failed"]);
    const texts = taskManager.listMessages(task.id).map((message) => message.content);
    assert.ok(texts.some((text) => /「WorkBuddy（CodeBuddy）」还没登录 WorkBuddy 账号：在左侧打开.*点「登录 WorkBuddy 账号」/.test(text)));
    assert.equal(texts.some((text) => text.includes("Authentication required")), false);
    await assert.rejects(new CodeBuddyAdapter().ask("hi"), /点「登录 WorkBuddy 账号」/);
  } finally {
    delete process.env.FAKE_CLI_NOT_LOGGED_IN;
  }
});

test("请求批准: approving answers in CodeBuddy's format, without --permission-prompt-tool, default model passed", async () => {
  const { dir, workspace } = newWorkspace("cb-approve");
  const task = taskManager.createTask({ agentId: "codebuddy", workspaceId: workspace.id, title: "建目录", prompt: "建一个 out-dir", permissionMode: "supervised", actor: "test" });
  const approval = await waitPendingApproval(task.id);
  assert.match(approval.reason, /CodeBuddy 请求使用 PowerShell/);
  const args = lastArgs();
  assert.equal(args.includes("--permission-prompt-tool"), false);
  assert.deepEqual(args.slice(args.indexOf("--input-format"), args.indexOf("--input-format") + 2), ["--input-format", "stream-json"]);
  assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "balanced-model"]);

  taskManager.approveAction(task.id, approval.id, "approve_once", undefined, "test");
  await waitStatus(task.id, ["review"]);
  assert.ok(fs.existsSync(path.join(dir, "out-dir", "result.txt")), "the fake CLI only runs the tool when it gets { allowed: true }");
});

test("denying sends CodeBuddy the reason", async () => {
  const { dir, workspace } = newWorkspace("cb-deny");
  const task = taskManager.createTask({ agentId: "codebuddy", workspaceId: workspace.id, title: "建目录", prompt: "建一个 out-dir", permissionMode: "supervised", actor: "test" });
  const approval = await waitPendingApproval(task.id);
  taskManager.approveAction(task.id, approval.id, "deny", "先别建", "test");
  await waitStatus(task.id, ["review"]);
  assert.equal(fs.existsSync(path.join(dir, "out-dir")), false);
  assert.ok(taskManager.listMessages(task.id).some((message) => message.content.includes("被拒绝了：用户在 AgentHub 拒绝了这一步：先别建")));
});

test("完全访问 skips permissions and never asks", async () => {
  const { dir, workspace } = newWorkspace("cb-full");
  const task = taskManager.createTask({ agentId: "codebuddy", workspaceId: workspace.id, title: "建目录", prompt: "建一个 out-dir", permissionMode: "full", actor: "test" });
  await waitStatus(task.id, ["review"]);
  assert.ok(fs.existsSync(path.join(dir, "out-dir")));
  assert.equal(taskManager.listApprovals(task.id).length, 0);
  assert.ok(lastArgs().includes("--dangerously-skip-permissions"));
});
