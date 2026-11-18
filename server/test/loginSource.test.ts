import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { loginSourceFor } from "../src/services/loginSource.ts";
import type { AgentAccountInfo } from "../src/types.ts";

function account(home: string, isDefault = true): AgentAccountInfo {
  return { id: "x", name: "默认账号", home, isDefault, supportsMultiple: true, loggedIn: true, authMode: null, email: null, plan: null, apiKeyHint: null, baseUrl: null };
}

test("Codex / Claude Code: the usual folder is shared with the desktop app, the desktop app's own folder is not", () => {
  const shared = loginSourceFor("codex", account(path.join(os.homedir(), ".codex")));
  assert.equal(shared?.shared, true);
  assert.match(shared?.sharedWith ?? "", /Codex 桌面版/);
  assert.equal(shared?.location, path.join(os.homedir(), ".codex", "auth.json"));

  const own = loginSourceFor("claude-code", account(path.join("C:", "Users", "u", "AppData", "Roaming", "Xgent Hub", "accounts", "claude")));
  assert.equal(own?.shared, false);
  assert.equal(own?.sharedWith, null);
});

test("WorkBuddy / Ark / DeepSeek / Antigravity default accounts are always shared, and say where they are read from", () => {
  const home = os.homedir();
  assert.equal(loginSourceFor("ark-cli", account(home))?.location, path.join(home, ".arkcli", "identities"));
  assert.match(loginSourceFor("codebuddy", account(home))?.sharedWith ?? "", /WorkBuddy/);
  assert.match(loginSourceFor("deepseek-harness", account(path.join(home, ".dsh")))?.location ?? "", /\.credentials\.yaml$/);
  const agy = loginSourceFor("antigravity", account(path.join(home, ".gemini")));
  assert.equal(agy?.shared, true);
  assert.match(agy?.location ?? "", /google_accounts\.json/);
});

test("accounts added in Xgent have their own folder and are never shared", () => {
  const added = loginSourceFor("ark-cli", account(path.join(os.tmpdir(), "xgent-accounts", "ark-work"), false));
  assert.equal(added?.shared, false);
});

test("agents without a login (OpenClaw, custom) have no source", () => {
  assert.equal(loginSourceFor("openclaw", account(os.homedir())), null);
});
