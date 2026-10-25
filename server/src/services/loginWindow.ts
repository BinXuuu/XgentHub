import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function shQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface LoginWindowInput {
  title: string;
  exe: string;
  args: string[];
  /** 没有图形界面、只能让用户自己在终端里跑时用的参数（比如 Codex 的 --device-auth：给网址和验证码，任何设备上都能完成登录）。 */
  headlessArgs?: string[];
  env?: Record<string, string>;
  intro: string[];
}

export interface LoginWindowResult {
  /** 是否真的在这台电脑上打开了一个窗口；false 时 message 里是要用户自己运行的命令。 */
  opened: boolean;
  message: string;
}

/**
 * 让用户登录 CLI（codex login / claude auth login / agy）。登录本身在 CLI 自己打开的浏览器里完成，Xgent 不碰账号密码。
 * - Windows：弹一个 PowerShell 窗口跑登录命令。
 * - macOS：打开「终端」跑登录命令。
 * - Linux / Docker：一般没有图形界面，返回完整的登录命令让用户在服务器终端里运行。
 */
export async function openLoginWindow(input: LoginWindowInput): Promise<LoginWindowResult> {
  if (process.platform === "win32") {
    openWindowsConsole(input);
    return { opened: true, message: "已在这台电脑上打开登录窗口，请在弹出的浏览器里完成登录。" };
  }
  if (process.platform === "darwin" && (await openMacTerminal(input))) {
    return { opened: true, message: "已在这台 Mac 上打开「终端」运行登录命令，请在弹出的浏览器里完成登录。" };
  }
  return { opened: false, message: manualLoginMessage(input) };
}

function openWindowsConsole(input: LoginWindowInput): void {
  const script = [
    ...Object.entries(input.env ?? {}).map(([key, value]) => `$env:${key} = ${psQuote(value)}`),
    ...input.intro.map((line) => `Write-Host ${psQuote(line)}`),
    `Write-Host ''`,
    `& ${psQuote(input.exe)} ${input.args.map(psQuote).join(" ")}`,
    `Write-Host ''`,
    `Write-Host ${psQuote("完成后可以关掉这个窗口，回到 Xgent 查看登录状态。")}`,
  ].join("\n");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  // 用 cmd 的 start 开一个新控制台窗口。实测直接 spawn powershell（detached + stdio ignore）拿不到控制台，
  // 一启动就退出、什么窗口都看不到。命令行自己拼（base64 里只有字母数字和 + / =，标题去掉引号）。
  const title = input.title.replace(/"/g, "");
  const commandLine = `/d /c start "${title}" powershell.exe -NoProfile -NoExit -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
  const child = spawn(process.env.ComSpec || "cmd.exe", [commandLine], {
    windowsVerbatimArguments: true,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => undefined);
  child.unref();
}

function shellCommand(input: LoginWindowInput, args: string[]): string {
  const env = Object.entries(input.env ?? {}).map(([key, value]) => `${key}=${shQuote(value)} `).join("");
  return `${env}${shQuote(input.exe)} ${args.map(shQuote).join(" ")}`.trim();
}

/**
 * macOS：写一个临时的 .command 脚本，用 `open -a Terminal` 打开（相当于双击运行它），「终端」会新开窗口跑登录命令。
 * 不用 AppleScript 去控制「终端」：那样第一次会弹「想要控制终端」的系统权限框，在后台服务里会一直卡着等人点。
 * 没有登录桌面（比如只通过 SSH 用）时 open 会失败，返回 false 改为提示手动运行。
 */
function openMacTerminal(input: LoginWindowInput): Promise<boolean> {
  const script = [
    "#!/bin/bash",
    ...input.intro.map((line) => `echo ${shQuote(line)}`),
    "echo",
    shellCommand(input, input.args),
    "echo",
    `echo ${shQuote("完成后可以关掉这个窗口，回到 Xgent 查看登录状态。")}`,
    'rm -f "$0"',
  ].join("\n");
  const file = path.join(os.tmpdir(), `xgent-login-${Date.now()}.command`);
  try {
    fs.writeFileSync(file, script + "\n", { mode: 0o700 });
  } catch {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    execFile("open", ["-a", "Terminal", file], { timeout: 15_000 }, (err) => {
      if (err) fs.rmSync(file, { force: true });
      resolve(!err);
    });
  });
}

function manualLoginMessage(input: LoginWindowInput): string {
  const args = input.headlessArgs ?? input.args;
  // Docker 版：命令要在宿主机上通过 docker exec 进到容器里跑（容器名按 docker-compose.yml，默认 xgenthub）。
  if (process.env.AGENTHUB_UPDATE_MODE === "docker") {
    const envFlags = Object.entries(input.env ?? {}).map(([key, value]) => `-e ${key}=${shQuote(value)} `).join("");
    // -u node：docker exec 默认是 root，用 root 登录会把登录文件建成 root 的，服务（node 用户）就读写不了。
    const command = `docker exec -it -u node ${envFlags}xgenthub ${shQuote(input.exe)} ${args.map(shQuote).join(" ")}`.trim();
    return `Docker 版没有弹窗可用。请在 NAS / 服务器的终端里运行下面的命令，按提示在任意设备的浏览器里完成登录：\n${command}`;
  }
  return `这台机器上没法自动打开登录窗口。请在它的终端里运行下面的命令，按提示在浏览器里完成登录：\n${shellCommand(input, args)}`;
}
