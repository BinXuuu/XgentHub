import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupIsolatedDb, waitFor } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("claude-accounts");
const defaultHome = path.join(env.root, "default-claude-home");
const accountsDir = path.join(env.root, "claude-accounts");
const geminiDir = path.join(env.root, "gemini");
fs.mkdirSync(defaultHome, { recursive: true });
fs.writeFileSync(path.join(defaultHome, "settings.json"), '{"permissions":{}}\n');
fs.writeFileSync(path.join(defaultHome, ".credentials.json"), JSON.stringify({ claudeAiOauth: { refreshToken: "secret-default", subscriptionType: "pro" } }));
process.env.CLAUDE_CONFIG_DIR = defaultHome;
process.env.CLAUDE_ACCOUNTS_DIR = accountsDir;
process.env.ANTIGRAVITY_GEMINI_DIR = geminiDir;
// 跑测试的机器上可能本来就设了这些，先清掉，下面才看得出是 Xgent 带上的。
for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]) delete process.env[key];

// 假 claude（完全访问模式下读完 stdin 直接干完），顺便记下每次启动带的环境变量。
const fakeScript = path.resolve(import.meta.dirname, "fixtures", "fake-claude.cjs");
const envFile = path.join(env.root, "claude-env.jsonl");
const shim = path.join(env.root, process.platform === "win32" ? "fake-claude.cmd" : "fake-claude.sh");
if (process.platform === "win32") fs.writeFileSync(shim, `@"${process.execPath}" "${fakeScript}" %*\r\n`);
else fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fakeScript}" "$@"\n`, { mode: 0o755 });
process.env.CLAUDE_CODE_BIN = shim;
process.env.CLAUDE_CODE_ARGS = "--print --output-format stream-json --verbose";
process.env.FAKE_CLAUDE_ENV_FILE = envFile;

const { db } = await import("../src/db/index.ts");
const { createWorkspace } = await import("../src/services/workspaceService.ts");
const { taskManager } = await import("../src/services/taskManager.ts");
const { createClaudeAccount, setClaudeApiKey, clearClaudeApiKey, readClaudeAccountInfo } = await import("../src/services/claudeAccountService.ts");
const { readAntigravityAccountInfo } = await import("../src/services/antigravityAccountService.ts");
const { waitForSnapshotsIdle } = await import("../src/services/workspaceSnapshotService.ts");
const { listTaskRuns } = await import("../src/services/coreModelService.ts");

after(async () => {
  await new Promise((resolve) => setTimeout(resolve, 500));
  await waitForSnapshotsIdle();
  db.close();
  env.cleanup();
});

type EnvRecord = Record<"CLAUDE_CONFIG_DIR" | "ANTHROPIC_API_KEY" | "ANTHROPIC_BASE_URL" | "ANTHROPIC_AUTH_TOKEN", string | null>;

function envCalls(): EnvRecord[] {
  if (!fs.existsSync(envFile)) return [];
  return fs.readFileSync(envFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

let taskCount = 0;
async function runTask(agentId: string, expected = "review") {
  const dir = path.join(env.root, `ws-${++taskCount}`);
  fs.mkdirSync(dir, { recursive: true });
  const workspace = createWorkspace({ name: `ws-${taskCount}`, path: dir, allowedAgentKinds: [] });
  const before = envCalls().length;
  const task = taskManager.createTask({ agentId, workspaceId: workspace.id, title: "建目录", prompt: "建一个 out-dir", permissionMode: "full", actor: "test" });
  await waitFor(() => (taskManager.getTask(task.id)?.status === expected && listTaskRuns(task.id).at(-1)?.finishedAt ? true : null), {
    timeoutMs: 15_000,
    description: `${agentId} task to reach ${expected}`,
  });
  return { task, call: envCalls().slice(before)[0] };
}

test("an added Claude Code account gets its own CLAUDE_CONFIG_DIR and shows up right after Claude Code", async () => {
  const account = createClaudeAccount({ name: "Work" });
  assert.equal(account.id, "claude-code:work");
  assert.equal(path.dirname(account.home), accountsDir);
  assert.ok(fs.existsSync(path.join(account.home, "settings.json")), "settings are copied");
  assert.equal(fs.existsSync(path.join(account.home, ".credentials.json")), false, "login is not copied");

  const agents = taskManager.listAgents();
  const ids = agents.map((agent) => agent.id);
  assert.equal(ids.indexOf("claude-code:work"), ids.indexOf("claude-code") + 1);
  const added = agents.find((agent) => agent.id === "claude-code:work")!;
  assert.equal(added.name, "Claude Code（Work）");
  assert.deepEqual([added.account?.isDefault, added.account?.loggedIn], [false, false]);
  const builtin = agents.find((agent) => agent.id === "claude-code")!;
  assert.deepEqual([builtin.account?.authMode, builtin.account?.plan], ["claudeai", "pro"]);

  // 没登录：不启动 claude，直接提示去登录。
  const blocked = await runTask(account.id, "failed");
  assert.equal(blocked.call, undefined);
  assert.ok(taskManager.listMessages(blocked.task.id).some((message) => message.content.includes("还没登录")));

  // 订阅登录：读 .credentials.json + .claude.json；启动时带上这个账号的目录。
  fs.writeFileSync(path.join(account.home, ".credentials.json"), JSON.stringify({ claudeAiOauth: { refreshToken: "secret-work", subscriptionType: "max" } }));
  fs.writeFileSync(path.join(account.home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "work@example.com" } }));
  const info = readClaudeAccountInfo({ id: account.id, name: account.name, home: account.home, isDefault: false });
  assert.deepEqual([info.loggedIn, info.authMode, info.email, info.plan], [true, "claudeai", "work@example.com", "max"]);
  assert.equal(JSON.stringify(info).includes("secret"), false);
  const work = await runTask(account.id);
  assert.deepEqual(work.call, { CLAUDE_CONFIG_DIR: account.home, ANTHROPIC_API_KEY: null, ANTHROPIC_BASE_URL: null, ANTHROPIC_AUTH_TOKEN: null });

  // 改走中转站：Key 走 ANTHROPIC_AUTH_TOKEN，地址走 ANTHROPIC_BASE_URL。
  setClaudeApiKey(account.id, "relay-key-5678", "https://relay.example.com/");
  const relayInfo = readClaudeAccountInfo({ id: account.id, name: account.name, home: account.home, isDefault: false });
  assert.deepEqual([relayInfo.authMode, relayInfo.apiKeyHint, relayInfo.baseUrl], ["apikey", "5678", "https://relay.example.com"]);
  const relay = await runTask(account.id);
  assert.deepEqual(relay.call, {
    CLAUDE_CONFIG_DIR: account.home,
    ANTHROPIC_API_KEY: null,
    ANTHROPIC_BASE_URL: "https://relay.example.com",
    ANTHROPIC_AUTH_TOKEN: "relay-key-5678",
  });
  clearClaudeApiKey(account.id);
});

test("the default Claude Code account can switch to an official API key without touching CLAUDE_CONFIG_DIR", async () => {
  setClaudeApiKey("claude-code", "sk-ant-9999", "");
  const run = await runTask("claude-code");
  assert.deepEqual(run.call, { CLAUDE_CONFIG_DIR: defaultHome, ANTHROPIC_API_KEY: "sk-ant-9999", ANTHROPIC_BASE_URL: null, ANTHROPIC_AUTH_TOKEN: null });
  clearClaudeApiKey("claude-code");
  const plain = await runTask("claude-code");
  assert.equal(plain.call?.ANTHROPIC_API_KEY, null);
  assert.throws(() => setClaudeApiKey("claude-code", "k", "ftp://x"), /http/);
});

test("Antigravity shows the signed-in Google account from google_accounts.json, falling back to the CLI log", () => {
  assert.deepEqual([readAntigravityAccountInfo().email, readAntigravityAccountInfo().supportsMultiple], [null, false]);
  const logDir = path.join(geminiDir, "antigravity-cli", "log");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, "cli-1.log"), "I1023 server_oauth.go:229] OAuth: authenticated successfully as log@example.com\n");
  assert.equal(readAntigravityAccountInfo().email, "log@example.com");
  fs.writeFileSync(path.join(geminiDir, "google_accounts.json"), JSON.stringify({ active: "active@example.com", old: [] }));
  const info = readAntigravityAccountInfo();
  assert.deepEqual([info.email, info.loggedIn, info.authMode], ["active@example.com", true, "google"]);
});
