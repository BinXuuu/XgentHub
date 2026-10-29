import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnCli } from "../src/adapters/winSpawn.ts";

// npm 装的 CLI 在 Windows 上是 .cmd，spawnCli 走 cmd.exe 转发。参数里有空格时以前会被拆成两半：
// `codex mcp add` 把 "C:\Program Files\nodejs\node.exe" 写成了 command = "C:\Program、args = Files\nodejs\node.exe"。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xgent-winspawn-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("arguments pass through a .cmd shim unchanged", { skip: process.platform !== "win32" }, async () => {
  fs.writeFileSync(path.join(dir, "argv.js"), "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
  fs.writeFileSync(path.join(dir, "echoargs.cmd"), `@ECHO off\r\n"${process.execPath}" "%~dp0argv.js" %*\r\n`);
  const sent = [
    "mcp",
    "add",
    "--env",
    "K=D:\\工具\\运维桥接\\.data\\token",
    "--",
    "C:\\Program Files\\nodejs\\node.exe",
    "D:\\工具\\运维桥接\\dist\\mcp-stdio.js",
    "hello world",
    "D:\\dir with space\\",
    'say "hi"',
    "a&b",
  ];
  const child = spawnCli(path.join(dir, "echoargs.cmd"), sent, { cwd: dir, preferCmdShim: true });
  let out = "";
  child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
  await new Promise((resolve) => child.on("close", resolve));
  assert.deepEqual(JSON.parse(out), sent);
});
