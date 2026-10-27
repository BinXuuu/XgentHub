import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setupIsolatedDb, waitFor } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("hidden-desktop");
const { db } = await import("../src/db/index.ts");
const { hiddenLauncherPath, hiddenLauncherError, quoteWindowsArg, spawnOnHiddenDesktop } = await import("../src/adapters/hiddenDesktop.ts");
const { killProcessTree } = await import("../src/adapters/winSpawn.ts");

after(() => { db.close(); env.cleanup(); });

function collect(child: NonNullable<ReturnType<typeof spawnOnHiddenDesktop>>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("Windows argument quoting follows CommandLineToArgvW rules", () => {
  assert.equal(quoteWindowsArg("/usage"), "/usage");
  assert.equal(quoteWindowsArg("a b"), "\"a b\"");
  assert.equal(quoteWindowsArg(""), "\"\"");
  assert.equal(quoteWindowsArg("say \"hi\""), "\"say \\\"hi\\\"\"");
  assert.equal(quoteWindowsArg("C:\\dir with space\\"), "\"C:\\dir with space\\\\\"");
});

test("the launcher passes arguments, output and the exit code through", { skip: process.platform !== "win32" }, async () => {
  const launcher = hiddenLauncherPath();
  assert.ok(launcher, `launcher should compile: ${hiddenLauncherError()}`);
  assert.ok(fs.existsSync(launcher!));
  const args = ["-e", "console.log(JSON.stringify(process.argv.slice(1))); console.error('err-line'); process.exit(3)", "a b", "say \"hi\"", "", "C:\\dir with space\\", "中文参数"];
  const child = spawnOnHiddenDesktop(process.execPath, args, { cwd: env.root });
  assert.ok(child);
  const result = await collect(child!);
  assert.equal(result.code, 3);
  assert.deepEqual(JSON.parse(result.stdout.trim()), ["a b", "say \"hi\"", "", "C:\\dir with space\\", "中文参数"]);
  assert.match(result.stderr, /err-line/);
  assert.equal(hiddenLauncherPath(), launcher, "compiled once and cached");
});

test("killProcessTree on the launcher ends the whole child tree", { skip: process.platform !== "win32" }, async () => {
  const script = "const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' }); console.log(c.pid); setTimeout(() => {}, 600000);";
  const child = spawnOnHiddenDesktop(process.execPath, ["-e", script], { cwd: env.root })!;
  let out = "";
  child.stdout?.on("data", (chunk) => (out += chunk));
  const grandchild = Number(await waitFor(() => (out.trim() ? out.trim() : null), { timeoutMs: 10_000, description: "grandchild pid" }));
  assert.ok(grandchild > 0);
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.ok(alive(grandchild));
  killProcessTree(child);
  await waitFor(() => (!alive(grandchild) ? true : null), { timeoutMs: 10_000, description: "grandchild ended with the launcher" });
});

test("non-exe targets are left to the normal spawn path", () => {
  assert.equal(spawnOnHiddenDesktop("C:\\tools\\agy.cmd", [], { cwd: env.root }), null);
});

test("processes left behind after the program exits keep running (only an explicit stop ends them)", { skip: process.platform !== "win32" }, async () => {
  const script = "const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', detached: true }); c.unref(); console.log(c.pid);";
  const child = spawnOnHiddenDesktop(process.execPath, ["-e", script], { cwd: env.root })!;
  const result = await collect(child);
  const leftover = Number(result.stdout.trim());
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.equal(result.code, 0);
  assert.ok(alive(leftover), "a background process the program started is not killed when it exits");
  process.kill(leftover);
});
