import test, { after } from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedDb } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("antigravity-hidden");
// 用 node 代替 agy：能把收到的参数原样打出来，检查 PowerShell 这层有没有把参数弄坏。
process.env.ANTIGRAVITY_BIN = process.execPath;
const { db } = await import("../src/db/index.ts");
const { psLiteral, windowsArg, runAgyHidden, summarizeUsageText } = await import("../src/adapters/antigravity.ts");

after(() => { db.close(); env.cleanup(); });

test("PowerShell literals and Windows arguments are quoted safely", () => {
  assert.equal(psLiteral("C:\\Users\\me\\agy.exe"), "'C:\\Users\\me\\agy.exe'");
  assert.equal(psLiteral("it's"), "'it''s'");
  assert.equal(windowsArg("/usage"), "/usage");
  assert.equal(windowsArg("a b"), "\"a b\"");
  assert.equal(windowsArg("say \"hi\""), "\"say \\\"hi\\\"\"");
  assert.equal(windowsArg(""), "\"\"");
});

test("the hidden Windows call really starts the binary and passes every argument through", { skip: process.platform !== "win32" }, async () => {
  const args = ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", "/usage", "--print-timeout", "10s", "a b", "it's"];
  const result = await runAgyHidden(args, process.cwd(), 30_000);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), ["/usage", "--print-timeout", "10s", "a b", "it's"]);
});

test("quota lines are translated, including per-model limits like Gemini 4 Argon", () => {
  const text = [
    "Gemini Models\tWeekly Limit Remaining\t99%\t2026-10-27T06:30:00Z",
    "Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-10-27T07:26:32Z",
    "Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t100%\t2026-11-03T02:26:08Z",
  ].join("\n");
  const summary = summarizeUsageText("模型额度", text)!;
  assert.match(summary, /Gemini 模型：本周额度剩余 99%/);
  assert.match(summary, /Claude\/GPT 模型：5 小时额度剩余 100%/);
  assert.match(summary, /Gemini 4 Argon：本周额度剩余 100%，2026\/11\/3 10:26 重置/);
});
