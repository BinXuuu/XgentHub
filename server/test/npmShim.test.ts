import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { npmShimTarget, spawnCli } from "../src/adapters/winSpawn.ts";

// npm 装的 CLI 在 Windows 上是 cmd-shim 生成的 .ps1 / .cmd 启动脚本。
// 经过 PowerShell 5.1 转一手，stdin 里的中文会变成 ???，所以要直接启动脚本指向的程序。
const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-npm-shim-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

// 照 npm 生成的原样（2026-11-10 从测试电脑上的 claude.ps1 抄的格式）。
function nativeShim(target: string) {
  return `#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent

$exe=""
if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {
  $exe=".exe"
}
# Support pipeline input
if ($MyInvocation.ExpectingInput) {
  $input | & "$basedir/${target}"   $args
} else {
  & "$basedir/${target}"   $args
}
exit $LASTEXITCODE
`;
}

function nodeShim(script: string) {
  return `#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent

$exe=""
if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {
  $exe=".exe"
}
$ret=0
if (Test-Path "$basedir/node$exe") {
  # Support pipeline input
  if ($MyInvocation.ExpectingInput) {
    $input | & "$basedir/node$exe"  "$basedir/${script}" $args
  } else {
    & "$basedir/node$exe"  "$basedir/${script}" $args
  }
  $ret=$LASTEXITCODE
} else {
  # Support pipeline input
  if ($MyInvocation.ExpectingInput) {
    $input | & "node$exe"  "$basedir/${script}" $args
  } else {
    & "node$exe"  "$basedir/${script}" $args
  }
  $ret=$LASTEXITCODE
}
exit $ret
`;
}

test("a shim for a native program points at that program", () => {
  const exe = path.join(root, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, "");
  const shim = path.join(root, "claude.ps1");
  fs.writeFileSync(shim, nativeShim("node_modules/@anthropic-ai/claude-code/bin/claude.exe"));
  assert.deepEqual(npmShimTarget(shim), { command: path.normalize(exe), args: [] });
});

// 回退到 PATH 上的 node.exe：只有 Windows 有（这个功能也只在 Windows 上用）。
test("a shim for a node script runs node with the script", { skip: process.platform !== "win32" }, () => {
  const script = path.join(root, "node_modules", "tool", "cli.js");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, "");
  const shim = path.join(root, "tool.ps1");
  fs.writeFileSync(shim, nodeShim("node_modules/tool/cli.js"));
  const target = npmShimTarget(shim);
  assert.match(target?.command ?? "", /node\.exe$/i, "falls back to node on PATH when there is no node.exe next to the shim");
  assert.deepEqual(target?.args, [path.normalize(script)]);
});

test("scripts that are not npm shims are left alone", () => {
  const shim = path.join(root, "custom.ps1");
  fs.writeFileSync(shim, "Write-Host hello\n");
  assert.equal(npmShimTarget(shim), null);
  assert.equal(npmShimTarget(path.join(root, "missing.ps1")), null);
});

test("Chinese sent on stdin arrives intact (no ??? from PowerShell)", { skip: process.platform !== "win32" }, async () => {
  const script = path.join(root, "node_modules", "echo", "cli.js");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(
    script,
    `let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify({stdin:s,args:process.argv.slice(2)})));`
  );
  fs.writeFileSync(path.join(root, "echo.ps1"), nodeShim("node_modules/echo/cli.js"));
  fs.writeFileSync(path.join(root, "echo.cmd"), "@echo off\r\n");
  const prompt = "帮我做一个 logo，名字叫「小鹿」，要有 emoji 🦌\n第二行";
  const child = spawnCli(path.join(root, "echo"), ["-p", "参数里的中文 和空格"], {});
  let out = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => (out += chunk));
  child.stdin!.end(prompt);
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out), { stdin: prompt, args: ["-p", "参数里的中文 和空格"] });
});
