import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 一键安装：只用临时目录里的假 npm，绝不碰这台电脑真的 npm（也不把系统 PATH 补进来）。
const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-cli-install-"));
const withNpm = path.join(root, "with-npm");
const empty = path.join(root, "empty");
fs.mkdirSync(withNpm, { recursive: true });
fs.mkdirSync(empty, { recursive: true });
const npmLog = path.join(root, "npm-args.txt");
if (process.platform === "win32") {
  // 装 openclaw 时模拟网络失败，装 codebuddy 时模拟 Node.js 太旧（测试电脑上的真实输出，前面还夹着一行 EPERM），其它成功；记下收到的参数。
  fs.writeFileSync(
    path.join(withNpm, "npm.cmd"),
    `@echo %* >> "${npmLog}"\r\n@if "%3"=="openclaw@latest" (echo npm ERR! code ETIMEDOUT & exit /b 1)\r\n` +
      `@if "%3"=="@tencent-ai/codebuddy-code@latest" (echo npm warn cleanup EPERM & echo npm error [x] error: this release requires Node ^>=24.16.0 ^<25 & echo npm error [x] detected Node 24.14.1 & exit /b 1)\r\n` +
      `@echo added 1 package\r\n@exit /b 0\r\n`
  );
} else {
  fs.writeFileSync(
    path.join(withNpm, "npm"),
    `#!/bin/sh\necho "$@" >> "${npmLog}"\nif [ "$3" = "openclaw@latest" ]; then echo "npm ERR! code ETIMEDOUT"; exit 1; fi\n` +
      `if [ "$3" = "@tencent-ai/codebuddy-code@latest" ]; then echo "npm warn cleanup EPERM"; echo "npm error [x] error: this release requires Node >=24.16.0 <25"; echo "npm error [x] detected Node 24.14.1"; exit 1; fi\n` +
      `echo "added 1 package"\n`,
    { mode: 0o755 }
  );
}
process.env.XGENT_NO_SYSTEM_PATH_REFRESH = "1";
const originalPath = process.env.PATH;

const { isCliInstallTarget, startCliInstall, getCliInstallJob } = await import("../src/services/cliInstallService.ts");

after(() => {
  process.env.PATH = originalPath;
  fs.rmSync(root, { recursive: true, force: true });
});

async function waitDone(id: string) {
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    const job = getCliInstallJob(id)!;
    if (job.status !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("install job did not finish");
}

test("only the fixed install targets are accepted", () => {
  assert.equal(isCliInstallTarget("codex"), true);
  assert.equal(isCliInstallTarget("ark-cli"), true);
  for (const bad of ["rm -rf /", "__proto__", "toString", "", 1, null]) assert.equal(isCliInstallTarget(bad), false, String(bad));
});

test("installs an npm CLI through npm (npm.cmd on Windows) and reports success", async () => {
  process.env.PATH = withNpm;
  const job = startCliInstall("codex");
  assert.equal(job.command, "npm install -g @openai/codex@latest");
  // 同一个还在装时再点，返回同一个任务，不会装两遍。
  assert.equal(startCliInstall("codex").id, job.id);
  const done = await waitDone(job.id);
  assert.equal(done.status, "succeeded", done.log);
  assert.match(done.log, /added 1 package/);
  assert.match(fs.readFileSync(npmLog, "utf8"), /install -g @openai\/codex@latest/);
});

test("a failed install says why in plain words", async () => {
  process.env.PATH = withNpm;
  const done = await waitDone(startCliInstall("openclaw").id);
  assert.equal(done.status, "failed");
  assert.match(done.error ?? "", /网络/);
});

test("a too-old Node.js is reported as such, not as a permission problem (real output from a test PC)", async () => {
  process.env.PATH = withNpm;
  const done = await waitDone(startCliInstall("codebuddy").id);
  assert.equal(done.status, "failed");
  assert.match(done.error ?? "", /Node\.js 版本太旧（现在是 24\.14\.1，需要 >=24\.16\.0）/);
});

test("without Node.js / npm it asks to install Node.js first instead of failing obscurely", async () => {
  process.env.PATH = empty;
  const done = await waitDone(startCliInstall("ark-cli").id);
  assert.equal(done.status, "failed");
  assert.match(done.error ?? "", /Node\.js/);
});
