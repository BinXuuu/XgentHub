import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 「网址 + 浏览器」式登录：用假的登录命令（输出照实测的 codex / claude），不真的打开浏览器。
process.env.XGENT_NO_OPEN_BROWSER = "1";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-browser-login-"));
const script = path.resolve(import.meta.dirname, "fixtures", "fake-login.cjs");
const shim = path.join(root, process.platform === "win32" ? "fake-login.cmd" : "fake-login.sh");
if (process.platform === "win32") fs.writeFileSync(shim, `@"${process.execPath}" "${script}" %*\r\n`);
else fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });

const { startBrowserLogin, getBrowserLogin, submitBrowserLoginCode, cancelBrowserLogin } = await import("../src/services/browserLogin.ts");

after(() => fs.rmSync(root, { recursive: true, force: true }));

async function waitFor(id: string, done: (status: string) => boolean) {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    const session = getBrowserLogin(id)!;
    if (done(session.status)) return session;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`login ${id} stuck at ${getBrowserLogin(id)?.status}`);
}

test("codex: opens the sign-in URL (not the local callback server) and finishes by itself", async () => {
  const session = startBrowserLogin({ agentId: "codex", label: "Codex", exe: shim, args: ["codex"], openBrowser: true });
  const done = await waitFor(session.id, (s) => s === "succeeded" || s === "failed");
  assert.equal(done.status, "succeeded", done.error ?? "");
  assert.match(done.url ?? "", /^https:\/\/auth\.openai\.com\/oauth\/authorize/);
  assert.equal(done.openedBrowser, true);
  assert.equal(done.acceptsCode, false);
});

test("claude: asks for the code from the browser page and logs in after it is pasted", async () => {
  const session = startBrowserLogin({ agentId: "claude-code", label: "Claude Code", exe: shim, args: ["claude"], openBrowser: false });
  const waiting = await waitFor(session.id, (s) => s === "needs_code");
  assert.match(waiting.url ?? "", /^https:\/\/claude\.com\/cai\/oauth\/authorize/);
  assert.equal(waiting.openedBrowser, false, "claude opens the browser itself");
  assert.throws(() => submitBrowserLoginCode(session.id, "two\nlines"), /格式不对/);
  submitBrowserLoginCode(session.id, "  good-code  ");
  const done = await waitFor(session.id, (s) => s === "succeeded" || s === "failed");
  assert.equal(done.status, "succeeded", done.error ?? "");
});

test("claude: a wrong code says so in plain words", async () => {
  const session = startBrowserLogin({ agentId: "claude-code:work", label: "Work", exe: shim, args: ["claude"], openBrowser: false });
  await waitFor(session.id, (s) => s === "needs_code");
  submitBrowserLoginCode(session.id, "wrong");
  const done = await waitFor(session.id, (s) => s === "succeeded" || s === "failed");
  assert.equal(done.status, "failed");
  assert.match(done.error ?? "", /验证码不对或者过期了/);
});

test("claude: blocked by the server (no proxy) says to check the proxy, and keeps the real error", async () => {
  const session = startBrowserLogin({ agentId: "claude-code:blocked", label: "Blocked", exe: shim, args: ["claude"], openBrowser: false });
  await waitFor(session.id, (s) => s === "needs_code");
  submitBrowserLoginCode(session.id, "blocked");
  const done = await waitFor(session.id, (s) => s === "succeeded" || s === "failed");
  assert.equal(done.status, "failed");
  assert.match(done.error ?? "", /代理/);
  assert.match(done.error ?? "", /status code 403/);
  assert.doesNotMatch(done.error ?? "", /oauth\/authorize/, "the long sign-in URL is not repeated in the error");
});

test("starting again cancels the earlier login for the same account, and cancel stops it", async () => {
  const first = startBrowserLogin({ agentId: "claude-code", label: "Claude Code", exe: shim, args: ["claude"], openBrowser: false });
  await waitFor(first.id, (s) => s === "needs_code");
  const second = startBrowserLogin({ agentId: "claude-code", label: "Claude Code", exe: shim, args: ["claude"], openBrowser: false });
  assert.equal(getBrowserLogin(first.id)?.status, "cancelled");
  await waitFor(second.id, (s) => s === "needs_code");
  assert.equal(cancelBrowserLogin(second.id)?.status, "cancelled");
  assert.throws(() => submitBrowserLoginCode(second.id, "good-code"), /已经结束/);
});

test("a command that fails shows its last output", async () => {
  const session = startBrowserLogin({ agentId: "ark-cli:default", label: "Ark", exe: shim, args: ["fail"], openBrowser: false });
  const done = await waitFor(session.id, (s) => s === "failed");
  assert.match(done.error ?? "", /退出码 3[\s\S]*something went wrong/);
});
