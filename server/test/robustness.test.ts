import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupIsolatedDb, waitFor } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("robustness");
process.env.CODEX_HOME = path.join(env.root, "codex-home");
process.env.CODEX_ACCOUNTS_DIR = path.join(env.root, "codex-accounts");
fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
// 假 codex：读完 stdin 回一句话就结束（见 fixtures/fake-codex.cjs）。
const fakeCodex = path.resolve(import.meta.dirname, "fixtures", "fake-codex.cjs");
const codexShim = path.join(env.root, process.platform === "win32" ? "fake-codex.cmd" : "fake-codex.sh");
if (process.platform === "win32") fs.writeFileSync(codexShim, `@"${process.execPath}" "${fakeCodex}" %*
`);
else fs.writeFileSync(codexShim, `#!/bin/sh
exec "${process.execPath}" "${fakeCodex}" "$@"
`, { mode: 0o755 });
process.env.CODEX_BIN = codexShim;

const { db } = await import("../src/db/index.ts");
const { createWorkspace } = await import("../src/services/workspaceService.ts");
const { taskManager } = await import("../src/services/taskManager.ts");
const { readJsonFile, writeJsonAtomic } = await import("../src/services/jsonStore.ts");
const { registerErrorHandler } = await import("../src/errorHandler.ts");
const { registerAuthRoutes } = await import("../src/routes/auth.ts");
const { registerAgentRoutes } = await import("../src/routes/agents.ts");
const { registerTaskRoutes } = await import("../src/routes/tasks.ts");
const { waitForSnapshotsIdle } = await import("../src/services/workspaceSnapshotService.ts");
const Fastify = (await import("fastify")).default;
const cookie = (await import("@fastify/cookie")).default;

after(async () => {
  // 停掉的任务适配器还要收尾（注销运行、处理排队消息），留点时间再关库。
  await new Promise((resolve) => setTimeout(resolve, 800));
  await waitForSnapshotsIdle();
  db.close();
  env.cleanup();
});

test("配置文件：先写临时文件再替换并留上一版；写坏了用上一版恢复，坏文件改名留着", () => {
  const file = path.join(env.root, "store", "items.json");
  writeJsonAtomic(file, [1]);
  writeJsonAtomic(file, [1, 2]);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, "utf8")), [1]);
  assert.deepEqual(readJsonFile(file, [], Array.isArray), [1, 2]);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp")), [], "no temp files left behind");

  fs.writeFileSync(file, "[1, 2"); // 写到一半
  assert.deepEqual(readJsonFile(file, [], Array.isArray), [1], "recovered from the previous version");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), [1], "the recovered version is put back in place");
  assert.equal(fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".corrupt-")).length, 1, "the broken file is kept");

  // 没有可用的上一版：返回空，但坏文件不会被下一次保存覆盖掉
  const lonely = path.join(env.root, "store", "lonely.json");
  fs.writeFileSync(lonely, "{oops");
  assert.deepEqual(readJsonFile(lonely, [], Array.isArray), []);
  writeJsonAtomic(lonely, ["new"]);
  const kept = fs.readdirSync(path.dirname(lonely)).find((name) => name.startsWith("lonely.json.corrupt-"));
  assert.ok(kept);
  assert.equal(fs.readFileSync(path.join(path.dirname(lonely), kept!), "utf8"), "{oops");
});

test("接口错误：业务提示是 400 且原样带回中文，参数类型错是 400，程序 bug 才是 500", async () => {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  registerErrorHandler(app);
  registerAuthRoutes(app);
  registerAgentRoutes(app);
  registerTaskRoutes(app);
  app.get("/boom", async () => {
    throw new TypeError("x is not a function");
  });
  await app.ready();
  const login = await app.inject({ method: "POST", url: "/api/login", payload: { token: "test-token" } });
  const cookieHeader = String(login.headers["set-cookie"]).split(";")[0];
  const call = (method: "POST" | "PUT" | "GET", url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: { cookie: cookieHeader } });

  assert.equal((await call("POST", "/api/agents/accounts", { kind: "codex", name: "dup" })).statusCode, 200);
  const dup = await call("POST", "/api/agents/accounts", { kind: "codex", name: "dup" });
  assert.equal(dup.statusCode, 400);
  assert.match(dup.json().error, /已经有叫「dup」的 Codex 账号了/);

  const badType = await call("POST", "/api/tasks/plan-subtasks", { prompt: 123 });
  assert.equal(badType.statusCode, 400);
  assert.equal(badType.json().error, "参数 prompt 应该是文字");

  const bug = await call("GET", "/boom");
  assert.equal(bug.statusCode, 500);
  assert.match(bug.json().error, /服务器内部错误：x is not a function/);

  const badJson = await app.inject({ method: "POST", url: "/api/agents/accounts", payload: "{", headers: { cookie: cookieHeader, "content-type": "application/json" } });
  assert.equal(badJson.statusCode, 400);
  await app.close();
});

test("工作区文件夹不在了：建任务直接说清楚；已有任务继续对话也给出同样的原因，而不是“找不到 codex”", async () => {
  const dir = path.join(env.root, "ws-moved");
  fs.mkdirSync(dir);
  const workspace = createWorkspace({ name: "moved", path: dir, allowedAgentKinds: [] });
  const task = taskManager.createTask({ agentId: "codex", workspaceId: workspace.id, title: "先建好", actor: "test" });
  fs.rmSync(dir, { recursive: true });

  assert.throws(
    () => taskManager.createTask({ agentId: "codex", workspaceId: workspace.id, title: "t", prompt: "hi", actor: "test" }),
    /工作区文件夹不存在/
  );

  taskManager.sendMessage(task.id, "继续", [], "test");
  await waitFor(() => (taskManager.getTask(task.id)?.status === "failed" ? true : null), { timeoutMs: 10_000, description: "task to fail" });
  const replies = taskManager.listMessages(task.id).filter((message) => message.role === "agent");
  assert.equal(replies.length, 1);
  assert.match(replies[0]!.content, /工作区文件夹不存在/);
});

test("服务重启后：上次没跑完的任务、运行、子任务、审批都改成已中断并留说明，排队中的子任务不动", async () => {
  const { orchestrator } = await import("../src/orchestrator/orchestratorService.ts");
  const { listTaskRuns } = await import("../src/services/coreModelService.ts");
  const addSubtask = (id: string, status: string) => {
    const at = new Date().toISOString();
    db.prepare("INSERT INTO subtasks (id, task_id, parent_subtask_id, title, status, assigned_agent_id, dependency_ids, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, NULL, '[]', ?, ?)").run(id, task.id, id, status, at, at);
    return { id };
  };
  const dir = path.join(env.root, "ws-restart");
  fs.mkdirSync(dir);
  const workspace = createWorkspace({ name: "restart", path: dir, allowedAgentKinds: [] });
  const task = taskManager.createTask({ agentId: "codex", workspaceId: workspace.id, title: "跑到一半", actor: "test" });
  // 造出"服务被杀时"的样子：一次运行中的 run、任务停在等审批、一条待审批、一个运行中和一个排队中的子任务。
  const { run } = orchestrator.startRun({ task, prompt: "x", images: [], source: "create_task" });
  const running = addSubtask("sub-running", "running");
  const queued = addSubtask("sub-queued", "queued");
  db.prepare("UPDATE tasks SET status = 'needs_approval' WHERE id = ?").run(task.id);
  db.prepare("INSERT INTO approvals (id, task_id, command, cwd, risk_level, reason, status, created_at) VALUES ('ap-1', ?, 'rm x', ?, 'high', '', 'pending', ?)").run(
    task.id,
    dir,
    new Date().toISOString()
  );

  const result = taskManager.recoverInterruptedWork();
  assert.deepEqual(result, { tasks: 1, runs: 1, approvals: 1 });
  assert.equal(taskManager.getTask(task.id)?.status, "stopped");
  const stoppedRun = listTaskRuns(task.id).find((item) => item.id === run.id)!;
  assert.equal(stoppedRun.status, "stopped");
  assert.ok(stoppedRun.finishedAt);
  assert.match(stoppedRun.error ?? "", /服务重启/);
  const approval = taskManager.listApprovals(task.id)[0]!;
  assert.equal(approval.status, "denied");
  assert.match(approval.note ?? "", /服务重启/);
  const statuses = Object.fromEntries((db.prepare("SELECT id, status FROM subtasks WHERE task_id = ?").all(task.id) as any[]).map((row) => [row.id, row.status]));
  assert.equal(statuses[running.id], "stopped");
  assert.equal(statuses[queued.id], "queued");
  assert.ok(taskManager.listMessages(task.id).some((message) => message.role === "system" && /服务重启/.test(message.content)));

  // 再启动一次不会重复处理
  assert.deepEqual(taskManager.recoverInterruptedWork(), { tasks: 0, runs: 0, approvals: 0 });
});

test("附件目录按目录层级判断：旁边名字相近的目录、链到外面的目录联接都不算，也不会被删", async () => {
  const { config } = await import("../src/config.ts");
  const { isAttachmentPath, deleteAttachmentFile } = await import("../src/services/attachmentService.ts");
  const root = path.join(config.dataDir, "attachments");
  fs.mkdirSync(path.join(root, "pending"), { recursive: true });
  const inside = path.join(root, "pending", "a.png");
  fs.writeFileSync(inside, "x");
  assert.equal(isAttachmentPath(inside), true);

  const siblingDir = path.join(config.dataDir, "attachments-old");
  fs.mkdirSync(siblingDir, { recursive: true });
  const sibling = path.join(siblingDir, "keep.txt");
  fs.writeFileSync(sibling, "keep");
  assert.equal(isAttachmentPath(sibling), false);
  deleteAttachmentFile(sibling);
  assert.ok(fs.existsSync(sibling), "files next to the attachments folder are never deleted");

  // 附件目录里一个指向外面的目录联接（Windows 上建 junction 不需要管理员）
  const outside = path.join(env.root, "outside");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "secret.txt"), "s");
  fs.symlinkSync(outside, path.join(root, "link"), "junction");
  assert.equal(isAttachmentPath(path.join(root, "link", "secret.txt")), false);

  deleteAttachmentFile(inside);
  assert.equal(fs.existsSync(inside), false);
});

test("任务原来用的账号被删了：继续对话说清楚原因并指向「切换 Agent」，切换后能接着跑", async () => {
  const { createCodexAccount, deleteCodexAccount } = await import("../src/services/codexAccountService.ts");
  const account = createCodexAccount({ name: "Gone" });
  const dir = path.join(env.root, "ws-gone-agent");
  fs.mkdirSync(dir);
  const workspace = createWorkspace({ name: "gone-agent", path: dir, allowedAgentKinds: [] });
  const task = taskManager.createTask({ agentId: account.id, workspaceId: workspace.id, title: "用了旧账号", actor: "test" });
  deleteCodexAccount(account.id);

  assert.throws(() => taskManager.sendMessage(task.id, "继续", [], "test"), /已经被删除了。可以在任务页点「切换 Agent」/);
  taskManager.dispatchAgentHandoff(task.id, { agentId: "codex", prompt: "接着做" }, "test");
  const { listTaskRuns } = await import("../src/services/coreModelService.ts");
  await waitFor(() => (taskManager.getTask(task.id)?.status === "review" && listTaskRuns(task.id).at(-1)?.finishedAt ? true : null), {
    timeoutMs: 10_000,
    description: "handoff to the default Codex to finish",
  });
  assert.equal(listTaskRuns(task.id).at(-1)?.agentId, "codex");
});

test("能不能停止按 Agent 实际实现算：Codex、Claude Code 都标成能停", () => {
  const agents = taskManager.listAgents();
  for (const id of ["codex", "claude-code", "mock"]) {
    assert.equal(agents.find((agent) => agent.id === id)?.runtime.supportsStop, true, id);
  }
});
