import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupIsolatedDb, waitFor } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("codex-accounts");
const defaultHome = path.join(env.root, "default-codex-home");
const accountsDir = path.join(env.root, "codex-accounts");
fs.mkdirSync(defaultHome, { recursive: true });
fs.writeFileSync(path.join(defaultHome, "config.toml"), 'model = "gpt-test"\n');
fs.writeFileSync(path.join(defaultHome, "AGENTS.md"), "全局说明\n");
fs.writeFileSync(path.join(defaultHome, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-default-9999" }));
process.env.CODEX_HOME = defaultHome;
process.env.CODEX_ACCOUNTS_DIR = accountsDir;

// 假 codex：记下每次启动带的 CODEX_HOME。Windows 上通过 .cmd 包一层 node。
const fakeScript = path.resolve(import.meta.dirname, "fixtures", "fake-codex.cjs");
const logFile = path.join(env.root, "codex-calls.jsonl");
const shim = path.join(env.root, process.platform === "win32" ? "fake-codex.cmd" : "fake-codex.sh");
if (process.platform === "win32") fs.writeFileSync(shim, `@"${process.execPath}" "${fakeScript}" %*\r\n`);
else fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fakeScript}" "$@"\n`, { mode: 0o755 });
process.env.CODEX_BIN = shim;
process.env.FAKE_CODEX_LOG = logFile;

const { db } = await import("../src/db/index.ts");
const { createWorkspace } = await import("../src/services/workspaceService.ts");
const { taskManager } = await import("../src/services/taskManager.ts");
const { createCodexAccount, deleteCodexAccount, readCodexAccountInfo } = await import("../src/services/codexAccountService.ts");
const { waitForSnapshotsIdle } = await import("../src/services/workspaceSnapshotService.ts");
const { listTaskRuns } = await import("../src/services/coreModelService.ts");

after(async () => {
  // 状态变成待验收后，适配器还要等 codex 进程退出才收尾（注销运行、处理排队消息），留点时间再关库。
  await new Promise((resolve) => setTimeout(resolve, 500));
  await waitForSnapshotsIdle();
  db.close();
  env.cleanup();
});

function fakeJwt(payload: object): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(payload)}.sig`;
}

function codexCalls(): { args: string[]; codexHome: string | null }[] {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function runTask(agentId: string, title: string, expected = "review") {
  const dir = path.join(env.root, `ws-${title}`);
  fs.mkdirSync(dir, { recursive: true });
  const workspace = createWorkspace({ name: title, path: dir, allowedAgentKinds: [] });
  const before = codexCalls().length;
  const task = taskManager.createTask({ agentId, workspaceId: workspace.id, title, prompt: "说一句话", permissionMode: "supervised", actor: "test" });
  // 等这次运行彻底结束（不只是状态变了），免得测试结束后它还在写数据库。
  await waitFor(() => (taskManager.getTask(task.id)?.status === expected && listTaskRuns(task.id).at(-1)?.finishedAt ? true : null), {
    timeoutMs: 15_000,
    description: `${title} to reach ${expected}`,
  });
  return { task, call: codexCalls().slice(before).find((item) => item.args[0] === "exec") };
}

test("reads the logged-in account from auth.json without exposing tokens", () => {
  const home = path.join(env.root, "jwt-home");
  fs.mkdirSync(home, { recursive: true });
  const base = { id: "codex:x", name: "x", home, isDefault: false };
  assert.equal(readCodexAccountInfo(base).loggedIn, false);

  fs.writeFileSync(
    path.join(home, "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        id_token: fakeJwt({ email: "someone@example.com", "https://api.openai.com/auth": { chatgpt_plan_type: "pro" } }),
        access_token: "secret-access",
        refresh_token: "secret-refresh",
      },
    })
  );
  const info = readCodexAccountInfo(base);
  assert.deepEqual(
    { loggedIn: info.loggedIn, authMode: info.authMode, email: info.email, plan: info.plan },
    { loggedIn: true, authMode: "chatgpt", email: "someone@example.com", plan: "pro" }
  );
  assert.equal(JSON.stringify(info).includes("secret"), false);
});

test("an added Codex account gets its own directory, shows up right after Codex, and runs with its own CODEX_HOME", async () => {
  const account = createCodexAccount({ name: "Work" });
  assert.equal(account.id, "codex:work");
  assert.equal(path.dirname(account.home), accountsDir);
  // 复制了设置，没复制登录。
  assert.equal(fs.readFileSync(path.join(account.home, "config.toml"), "utf8"), 'model = "gpt-test"\n');
  assert.ok(fs.existsSync(path.join(account.home, "AGENTS.md")));
  assert.equal(fs.existsSync(path.join(account.home, "auth.json")), false);
  assert.throws(() => createCodexAccount({ name: "Work" }), /已经有/);

  const agents = taskManager.listAgents();
  const ids = agents.map((agent) => agent.id);
  assert.equal(ids.indexOf("codex:work"), ids.indexOf("codex") + 1);
  const added = agents.find((agent) => agent.id === "codex:work")!;
  assert.equal(added.name, "Codex（Work）");
  assert.equal(added.kind, "codex");
  assert.deepEqual([added.account?.isDefault, added.account?.loggedIn], [false, false]);
  const builtin = agents.find((agent) => agent.id === "codex")!;
  assert.deepEqual([builtin.account?.isDefault, builtin.account?.authMode, builtin.account?.apiKeyHint], [true, "apikey", "9999"]);

  // 没登录：不启动 codex，直接告诉用户去登录。
  const blocked = await runTask("codex:work", "blocked", "failed");
  assert.equal(blocked.call, undefined);
  assert.ok(taskManager.listMessages(blocked.task.id).some((message) => message.content.includes("还没登录")));

  fs.writeFileSync(path.join(account.home, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-work-1234" }));
  const work = await runTask("codex:work", "work");
  assert.equal(work.call?.codexHome, account.home);
  assert.ok(taskManager.listMessages(work.task.id).some((message) => message.content.includes(account.home)));

  // 默认账号不改环境变量，沿用当前的 CODEX_HOME。
  const main = await runTask("codex", "main");
  assert.equal(main.call?.codexHome, defaultHome);
});

test("deleting an account removes it from the list but keeps its directory", () => {
  const account = createCodexAccount({ name: "Temp" });
  assert.equal(deleteCodexAccount(account.id), account.home);
  assert.equal(taskManager.listAgents().some((agent) => agent.id === account.id), false);
  assert.ok(fs.existsSync(account.home));
});
