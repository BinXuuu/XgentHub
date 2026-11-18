import test, { after } from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedDb } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("custom-args");
const { db } = await import("../src/db/index.ts");
const { splitTemplateArgs } = await import("../src/adapters/custom.ts");

after(() => { db.close(); env.cleanup(); });

test("Windows paths inside quotes keep their backslashes", () => {
  assert.deepEqual(
    splitTemplateArgs('"C:\\Users\\me\\agent.mjs" run {prompt}', { prompt: "做页面" }),
    ["C:\\Users\\me\\agent.mjs", "run", "做页面"]
  );
  assert.deepEqual(splitTemplateArgs("'\\\\server\\share\\x.js' --flag", {}), ["\\\\server\\share\\x.js", "--flag"]);
});

test('\\" inside double quotes is still a literal quote, and placeholders stay single arguments', () => {
  assert.deepEqual(splitTemplateArgs('--title "say \\"hi\\"" {prompt}', { prompt: "a b c" }), ["--title", 'say "hi"', "a b c"]);
  assert.deepEqual(splitTemplateArgs("{addDirArgs} -p {prompt}", { addDirArgs: ["--add-dir", "D:\\x"], prompt: "hi" }), ["--add-dir", "D:\\x", "-p", "hi"]);
});
