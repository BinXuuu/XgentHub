import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupIsolatedDb, waitFor } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("cli-accounts");
// 新账号目录建在测试目录里，不碰真实的 ~/.xgent。
process.env.XGENT_ACCOUNTS_DIR = path.join(env.root, "accounts");
// CodeBuddy 用假 claude 冒充（同一套协议），记下启动时带的账号环境变量。
const fakeScript = path.resolve(import.meta.dirname, "fixtures", "fake-claude.cjs");
const shim = path.join(env.root, process.platform === "win32" ? "fake-codebuddy.cmd" : "fake-codebuddy.sh");
if (process.platform === "win32") fs.writeFileSync(shim, `@"${process.execPath}" "${fakeScript}" %*\r\n`);
else fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fakeScript}" "$@"\n`, { mode: 0o755 });
const envFile = path.join(env.root, "codebuddy-env.jsonl");
process.env.CODEBUDDY_BIN = shim;
process.env.FAKE_CLAUDE_ENV_FILE = envFile;
process.env.FAKE_CLI_ENV_KEYS = "USERPROFILE,CODEBUDDY_CONFIG_DIR";

const { db } = await import("../src/db/index.ts");
const { createWorkspace } = await import("../src/services/workspaceService.ts");
const { taskManager } = await import("../src/services/taskManager.ts");
const { getAdapter, listAdapters, toDescriptor } = await import("../src/adapters/registry.ts");
const { createAgentAccount, renameAgentAccount, deleteAgentAccount } = await import("../src/services/agentAccountService.ts");
const { cliAccountEnv, getCliAccount } = await import("../src/services/cliAccountService.ts");
const { waitForSnapshotsIdle } = await import("../src/services/workspaceSnapshotService.ts");

after(async () => {
  await waitForSnapshotsIdle();
  db.close();
  env.cleanup();
});

test("each kind isolates its account the way it was verified on a real machine", () => {
  assert.deepEqual(cliAccountEnv("deepseek-harness", "D:\\acc"), { DSH_HOME: "D:\\acc" });
  assert.deepEqual(cliAccountEnv("ark-cli", "D:\\acc"), { USERPROFILE: "D:\\acc", HOME: "D:\\acc" });
  assert.deepEqual(cliAccountEnv("codebuddy", "D:\\acc"), { USERPROFILE: "D:\\acc", HOME: "D:\\acc", CODEBUDDY_CONFIG_DIR: path.join("D:\\acc", ".codebuddy") });
  assert.deepEqual(cliAccountEnv("codebuddy", null), {}, "the default account keeps the machine's own login");
});

test("added accounts show up under their agent, report login from their own directory, and can be renamed / removed", () => {
  const ids = (["codebuddy", "deepseek-harness", "ark-cli"] as const).map((kind) => createAgentAccount({ kind, name: "工作号" }).id);
  assert.deepEqual(ids, ["codebuddy:account", "deepseek-harness:account", "ark-cli:account"].map((id) => id.replace("account", "account-2")));

  const names = listAdapters().map((adapter) => adapter.name);
  for (const name of ["WorkBuddy（工作号）", "DeepSeek Harness（工作号）", "Ark CLI（工作号）"]) assert.ok(names.includes(name), name);
  // 账号紧跟在自己的内置 Agent 后面。
  assert.equal(names[names.indexOf("WorkBuddy（CodeBuddy）") + 1], "WorkBuddy（工作号）");

  const [codebuddyId, dshId, arkId] = ids;
  const loggedIn = (id: string) => toDescriptor(getAdapter(id)!).account?.loggedIn;
  assert.equal(loggedIn(codebuddyId), false);
  assert.equal(loggedIn(dshId), false);
  assert.equal(loggedIn(arkId), false);

  // 照着真实登录后会出现的文件放一份（内容无所谓，只看在不在）。
  const home = (id: string) => getCliAccount(id)!.home;
  const authDir =
    process.platform === "win32"
      ? path.join(home(codebuddyId), "AppData", "Local", "CodeBuddyExtension", "Data", "Public", "auth")
      : process.platform === "darwin"
        ? path.join(home(codebuddyId), "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth")
        : path.join(home(codebuddyId), ".local", "share", "CodeBuddyExtension", "Data", "Public", "auth");
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(path.join(authDir, "x.info"), "x");
  fs.writeFileSync(path.join(home(dshId), ".credentials.yaml"), "version: 1\nrecords:\n  deepseek-account-platform/default:\n    kind: x\n");
  fs.mkdirSync(path.join(home(arkId), ".arkcli", "identities"), { recursive: true });
  fs.writeFileSync(path.join(home(arkId), ".arkcli", "identities", "a.json"), "{}");
  const codebuddyAccount = toDescriptor(getAdapter(codebuddyId)!).account!;
  assert.equal(codebuddyAccount.loggedIn, true);
  assert.equal(codebuddyAccount.authMode, "workbuddy");
  assert.equal(codebuddyAccount.isDefault, false);
  assert.equal(loggedIn(dshId), true);
  assert.equal(loggedIn(arkId), true);

  renameAgentAccount(arkId, "备用号");
  assert.equal(getAdapter(arkId)!.name, "Ark CLI（备用号）");
  assert.equal(deleteAgentAccount(arkId), home(dshId).replace("deepseek-harness-accounts", "ark-cli-accounts"));
  assert.equal(getAdapter(arkId), undefined);
});

test("a task on an added WorkBuddy account runs codebuddy with that account's own user directory", async () => {
  const account = getCliAccount("codebuddy:account-2")!;
  const dir = path.join(env.root, "ws");
  fs.mkdirSync(dir, { recursive: true });
  const workspace = createWorkspace({ name: "cli-accounts", path: dir, allowedAgentKinds: [] });
  const task = taskManager.createTask({ agentId: account.id, workspaceId: workspace.id, title: "x", prompt: "建一个 out-dir", permissionMode: "full", actor: "test" });
  await waitFor(() => (["review", "failed"].includes(taskManager.getTask(task.id)?.status ?? "") ? true : null), { timeoutMs: 15_000, description: "task finishes" });
  const call = JSON.parse(fs.readFileSync(envFile, "utf8").trim().split("\n").at(-1)!);
  assert.deepEqual(call, { USERPROFILE: account.home, CODEBUDDY_CONFIG_DIR: path.join(account.home, ".codebuddy") });

  // 默认账号不改环境：用的是本机原来那份登录。
  const plain = taskManager.createTask({ agentId: "codebuddy", workspaceId: workspace.id, title: "y", prompt: "建一个 out-dir", permissionMode: "full", actor: "test" });
  await waitFor(() => (["review", "failed"].includes(taskManager.getTask(plain.id)?.status ?? "") ? true : null), { timeoutMs: 15_000, description: "default task finishes" });
  const defaultCall = JSON.parse(fs.readFileSync(envFile, "utf8").trim().split("\n").at(-1)!);
  assert.notEqual(defaultCall.USERPROFILE, account.home);
  assert.equal(defaultCall.CODEBUDDY_CONFIG_DIR, process.env.CODEBUDDY_CONFIG_DIR ?? null);
});
