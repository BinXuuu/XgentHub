import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupIsolatedDb, waitFor } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("claude-permissions");
// 用假 claude（按真实协议说话）替换本机 CLI；Windows 上通过 .cmd 包一层 node。
const fakeScript = path.resolve(import.meta.dirname, "fixtures", "fake-claude.cjs");
const argsFile = path.join(env.root, "claude-args.jsonl");
const shim = path.join(env.root, process.platform === "win32" ? "fake-claude.cmd" : "fake-claude.sh");
if (process.platform === "win32") fs.writeFileSync(shim, `@"${process.execPath}" "${fakeScript}" %*\r\n`);
else fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fakeScript}" "$@"\n`, { mode: 0o755 });
process.env.CLAUDE_CODE_BIN = shim;
process.env.CLAUDE_CODE_ARGS = "--print --output-format stream-json --verbose";
process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;

const { db } = await import("../src/db/index.ts");
const { createWorkspace } = await import("../src/services/workspaceService.ts");
const { taskManager } = await import("../src/services/taskManager.ts");
const { describeToolPermission } = await import("../src/adapters/claudeCode.ts");
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

function waitPendingApproval(taskId: string) {
  return waitFor(() => taskManager.listApprovals(taskId).find((approval) => approval.status === "pending") ?? null, {
    timeoutMs: 15_000,
    description: "Claude Code permission request to show up as a pending approval",
  });
}

function waitStatus(taskId: string, statuses: string[]) {
  return waitFor(() => (statuses.includes(taskManager.getTask(taskId)?.status ?? "") ? taskManager.getTask(taskId) : null), {
    timeoutMs: 15_000,
    description: `task to reach ${statuses.join("/")}`,
  });
}

test("a tool permission request becomes a readable approval", () => {
  assert.deepEqual(
    describeToolPermission({ tool_name: "PowerShell", display_name: "PowerShell", input: { command: "mkdir out" }, description: "Create out" }),
    { command: "mkdir out", reason: "Claude Code 请求使用 PowerShell：Create out", riskLevel: "medium" }
  );
  const destructive = describeToolPermission({ tool_name: "Bash", display_name: "Bash", input: { command: "rm -rf build" } });
  assert.equal(destructive.riskLevel, "high");
  assert.match(destructive.reason, /风险：包含批量\/强制删除类命令/);
  assert.equal(describeToolPermission({ tool_name: "Write", display_name: "Write", input: { file_path: "D:\\x\\a.txt", content: "hi" } }).command, "Write D:\\x\\a.txt");
});

test("请求批准: Claude Code waits in the approval queue, task shows needs_approval, and approving lets it continue", async () => {
  const { dir, workspace } = newWorkspace("claude-approve");
  const task = taskManager.createTask({ agentId: "claude-code", workspaceId: workspace.id, title: "建目录", prompt: "建一个 out-dir", permissionMode: "supervised", actor: "test" });

  const approval = await waitPendingApproval(task.id);
  assert.equal(approval.command, "mkdir out-dir");
  assert.match(approval.reason, /Claude Code 请求使用 PowerShell/);
  assert.equal(taskManager.getTask(task.id)?.status, "needs_approval");
  assert.equal(fs.existsSync(path.join(dir, "out-dir")), false, "nothing runs before approval");
  const lastArgs = JSON.parse(fs.readFileSync(argsFile, "utf8").trim().split("\n").at(-1)!);
  assert.ok(lastArgs.includes("--permission-prompt-tool") && lastArgs.includes("stdio"));
  assert.ok(lastArgs.includes("--input-format"));

  taskManager.approveAction(task.id, approval.id, "approve_once", undefined, "test");
  await waitStatus(task.id, ["review"]);
  assert.ok(fs.existsSync(path.join(dir, "out-dir")), "the approved command actually ran");
  assert.ok(taskManager.listMessages(task.id).some((message) => message.content.includes("已建好 out-dir")));
  assert.equal(taskManager.listApprovals(task.id)[0]?.status, "approved");
});

test("denying sends the reason back to Claude Code and nothing runs", async () => {
  const { dir, workspace } = newWorkspace("claude-deny");
  const task = taskManager.createTask({ agentId: "claude-code", workspaceId: workspace.id, title: "建目录", prompt: "建一个 out-dir", permissionMode: "supervised", actor: "test" });
  const approval = await waitPendingApproval(task.id);

  taskManager.approveAction(task.id, approval.id, "deny", "先别建", "test");
  await waitStatus(task.id, ["review"]);
  assert.equal(fs.existsSync(path.join(dir, "out-dir")), false);
  assert.ok(taskManager.listMessages(task.id).some((message) => message.content.includes("被拒绝了：用户在 AgentHub 拒绝了这一步：先别建")));
});

test("stopping while Claude Code waits cancels the pending approval instead of leaving a dead button", async () => {
  const { workspace } = newWorkspace("claude-stop");
  const task = taskManager.createTask({ agentId: "claude-code", workspaceId: workspace.id, title: "建目录", prompt: "建一个 out-dir", permissionMode: "supervised", actor: "test" });
  const approval = await waitPendingApproval(task.id);

  await taskManager.stopTask(task.id, "test");
  await waitStatus(task.id, ["stopped"]);
  const cancelled = taskManager.listApprovals(task.id).find((item) => item.id === approval.id);
  assert.equal(cancelled?.status, "denied");
  assert.match(cancelled?.note ?? "", /任务已停止/);
  assert.throws(() => taskManager.approveAction(task.id, approval.id, "approve_once", undefined, "test"), /已处理/);
});

test("完全访问 never asks: no permission prompt tool, runs straight through", async () => {
  const { dir, workspace } = newWorkspace("claude-full");
  const task = taskManager.createTask({ agentId: "claude-code", workspaceId: workspace.id, title: "建目录", prompt: "建一个 out-dir", permissionMode: "full", actor: "test" });
  await waitStatus(task.id, ["review"]);
  assert.ok(fs.existsSync(path.join(dir, "out-dir")));
  assert.equal(taskManager.listApprovals(task.id).length, 0);
  const lastArgs = JSON.parse(fs.readFileSync(argsFile, "utf8").trim().split("\n").at(-1)!);
  assert.ok(lastArgs.includes("--dangerously-skip-permissions"));
  assert.equal(lastArgs.includes("--permission-prompt-tool"), false);
});
