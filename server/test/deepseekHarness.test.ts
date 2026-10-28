import test, { after } from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedDb } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("deepseek-harness");
const { db } = await import("../src/db/index.ts");
const { config } = await import("../src/config.ts");
const { buildPatch, createDshEventHandler } = await import("../src/adapters/deepseekHarness.ts");

after(() => {
  db.close();
  env.cleanup();
});

function collect() {
  const out = { messages: [] as string[], terminal: [] as string[], logs: [] as string[], session: "" };
  const handler = createDshEventHandler({
    agentMessage: (text) => out.messages.push(text),
    terminal: (chunk) => out.terminal.push(chunk),
    log: (line) => out.logs.push(line),
    setSessionKey: (key) => (out.session = key),
  });
  return { out, handler };
}

// 下面的事件行是 2026-10-27 从桌面版自带 dsh 的 `--profile headless --json` 实际输出里截的。
test("a normal run: session id kept, tool calls go to the terminal, text once (final is not repeated)", () => {
  const { out, handler } = collect();
  for (const line of [
    '{"type":"session","sessionId":"session-f176f0d0","cwd":"C:\\\\ws"}',
    '{"type":"status","phase":"turn_start","turn":1}',
    "[llm-deepseek-account] model listing from https://api.deepseek.com/models loaded 2 model(s), skipped 0 row(s)",
    '{"type":"tool_call","callId":"c1","tool":"write","input":{"file_path":"C:\\\\ws\\\\hello.txt","content":"hi"}}',
    '{"type":"tool_result","callId":"c1","status":"completed","result":"Created file"}',
    '{"type":"thinking","text":""}',
    '{"type":"text","text":"已完成"}',
    '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}',
    '{"type":"final","text":"已完成"}',
  ]) handler.handleLine(line);
  assert.equal(out.session, "session-f176f0d0");
  assert.deepEqual(out.messages, ["已完成"]);
  assert.match(out.terminal.join(""), /\$ \[write\] .*hello\.txt/);
  assert.match(out.logs.join("\n"), /model listing/);
  assert.equal(handler.error, null);
});

test("errors become plain-language hints: not signed in, missing API key, sandbox without file-permission rights", () => {
  const signIn = collect();
  signIn.handler.handleLine('{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"error","error":{"message":"Sign in to DeepSeek to use the account provider.","code":"ACCOUNT_SIGN_IN_REQUIRED"}}}');
  assert.match(signIn.handler.error ?? "", /打开 DeepSeek Harness 桌面版登录/);

  const apiKey = collect();
  apiKey.handler.handleLine('{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"error","error":{"message":"no API key","code":"MISSING_CREDENTIAL"}}}');
  assert.match(apiKey.handler.error ?? "", /DEEPSEEK_API_KEY/);

  const acl = collect();
  acl.handler.handleLine('{"type":"tool_result","callId":"c1","status":"error","result":"Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\\\\ws)"}');
  assert.equal(acl.handler.aclBlocked, true);
});

test("the patch switches headless to the desktop-signed-in account, or to the API key", () => {
  config.deepseekHarness.provider = "account";
  config.deepseekHarness.reasoningEffort = "high";
  const account = buildPatch("deepseek-v4-pro");
  for (const id of ["credentials", "authorization", "deepseek-account"]) assert.match(account, new RegExp(`- id: ${id}\\n  disabled: false`));
  assert.match(account, /provider: deepseek-account\n    model: "deepseek-v4-pro"\n    reasoningEffort: "high"/);

  config.deepseekHarness.provider = "api-key";
  config.deepseekHarness.reasoningEffort = "";
  const apiKey = buildPatch("deepseek-flash");
  assert.match(apiKey, /provider: deepseek-official\n    model: "deepseek-flash"\n$/);
  assert.equal(apiKey.includes("deepseek-account"), false);
  config.deepseekHarness.provider = "account";
});
