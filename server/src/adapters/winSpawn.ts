import { spawn as nodeSpawn, type ChildProcess, type SpawnOptionsWithoutStdio } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { withSystemProxy } from "./systemProxy.ts";

// Windows 上 npm 全局命令通常同时生成 .cmd 和 .ps1 shim。
// 默认优先 .ps1，它能通过 PowerShell argv 数组传参，避免长 prompt / 多行 prompt 被 cmd.exe 拆坏。
// 少数 CLI（例如 Codex exec 使用 -C/--cd）会触发 PowerShell shim 的参数绑定 bug，
// 这些调用可以显式 preferCmdShim，在 prompt 已经走 stdin 时改用 .cmd 更稳。

export type CliSpawnOptions = SpawnOptionsWithoutStdio & {
  preferCmdShim?: boolean;
};

function winQuoteArg(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[\s"&|<>^%,;()!]/.test(arg)) return arg;
  // CRT 参数解析规则：反斜杠只有紧跟在它后面的字符是 " 时才需要成对转义
  let result = arg.replace(/(\\*)"/g, (_m, backslashes: string) => backslashes + backslashes + '\\"');
  result = result.replace(/(\\+)$/, (m) => m + m);
  return `"${result}"`;
}

function windowsExtensions(preferCmdShim = false): string[] {
  const raw = process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD";
  const exts = raw
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean);
  const result: string[] = [];
  const add = (ext: string) => {
    const normalized = ext.startsWith(".") ? ext.toUpperCase() : `.${ext.toUpperCase()}`;
    if (!result.includes(normalized)) result.push(normalized);
  };

  if (preferCmdShim) {
    for (const ext of [".CMD", ".BAT"]) add(ext);
    add(".PS1");
    for (const ext of exts) add(ext);
  } else {
    for (const ext of exts) {
      const normalized = ext.toUpperCase();
      if (normalized === ".CMD" || normalized === ".BAT") add(".PS1");
      add(ext);
    }
    add(".PS1");
  }
  return result;
}

function hasExtension(file: string): boolean {
  return Boolean(path.extname(file));
}

function isCmdShim(file: string): boolean {
  const ext = path.extname(file).toLowerCase();
  return ext === ".cmd" || ext === ".bat";
}

function isPowerShellShim(file: string): boolean {
  return path.extname(file).toLowerCase() === ".ps1";
}

function resolveWindowsCommand(bin: string, preferCmdShim = false): string {
  const hasPath = path.isAbsolute(bin) || bin.includes("\\") || bin.includes("/");
  const candidates: string[] = [];

  if (hasPath) {
    if (hasExtension(bin)) candidates.push(bin);
    else {
      for (const ext of windowsExtensions(preferCmdShim)) candidates.push(`${bin}${ext.toLowerCase()}`, `${bin}${ext.toUpperCase()}`);
      candidates.push(bin);
    }
  } else {
    for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
      if (hasExtension(bin)) candidates.push(path.join(dir, bin));
      else {
        for (const ext of windowsExtensions(preferCmdShim)) candidates.push(path.join(dir, `${bin}${ext.toLowerCase()}`), path.join(dir, `${bin}${ext.toUpperCase()}`));
      }
    }
    if (hasExtension(bin)) candidates.push(bin);
  }

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? bin;
}

export function resolveCliBinary(bin: string, opts: { preferCmdShim?: boolean } = {}): string | null {
  if (!bin.trim()) return null;

  if (process.platform === "win32") {
    const resolved = resolveWindowsCommand(bin, Boolean(opts.preferCmdShim));
    return fs.existsSync(resolved) ? resolved : null;
  }

  const hasPath = path.isAbsolute(bin) || bin.includes("/") || bin.includes("\\");
  if (hasPath) return fs.existsSync(bin) ? bin : null;

  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, bin);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const availabilityCache = new Map<string, { ok: boolean; at: number }>();

/** 刚装好 CLI 后清掉缓存，Agent 列表马上显示「已配置」，不用等 15 秒。 */
export function clearCliAvailabilityCache(): void {
  availabilityCache.clear();
}

/** CLI 能不能在本机找到（带 15 秒缓存）。Agent 列表每次刷新都会问，不能每次都扫一遍 PATH。 */
export function cliAvailable(bin: string, opts: { preferCmdShim?: boolean } = {}): boolean {
  const key = `${opts.preferCmdShim ? "cmd" : "any"}:${bin}`;
  const cached = availabilityCache.get(key);
  if (cached && Date.now() - cached.at < 15_000) return cached.ok;
  const ok = Boolean(resolveCliBinary(bin, opts));
  availabilityCache.set(key, { ok, at: Date.now() });
  return ok;
}

/**
 * npm 生成的 PowerShell 启动脚本（cmd-shim）里真正要运行的程序。
 *
 * 不能让 PowerShell 5.1 转一手：脚本里是 `$input | & "...\claude.exe" $args`，PowerShell 把我们从 stdin 送进去的 prompt
 * 按 $OutputEncoding（默认 ASCII）重新编码再交给程序，中文全变成 ???（2026-11-10 在一台用 npm 装 Claude Code 的电脑上实测）。
 * 直接启动脚本指向的程序：stdin 原样是 UTF-8，参数也不用经过 PowerShell / cmd 转义。
 * 认不出来的脚本（不是 npm 生成的）返回 null，照旧用 PowerShell 跑。
 */
export function npmShimTarget(ps1: string): { command: string; args: string[] } | null {
  let text: string;
  try {
    text = fs.readFileSync(ps1, "utf8");
  } catch {
    return null;
  }
  if (!text.includes("$basedir")) return null;
  const dir = path.dirname(ps1);
  const expand = (value: string) => path.normalize(value.replace(/\$basedir/g, dir).replace(/\$exe/g, ".exe"));
  // 只看不带 `$input |` 的那几行：& "程序" ["脚本"] $args
  const lineRe = /^[ \t]*&[ \t]+"([^"]+)"(?:[ \t]+"([^"]+)")?[ \t]+\$args[ \t]*$/gm;
  for (const match of text.matchAll(lineRe)) {
    const program = expand(match[1]);
    const script = match[2] ? expand(match[2]) : null;
    if (script && !fs.existsSync(script)) continue;
    const hasDir = program.includes("\\") || program.includes("/");
    const command = hasDir ? (fs.existsSync(program) ? program : null) : resolveCliBinary(program);
    if (!command || !/\.exe$/i.test(command)) continue;
    return { command, args: script ? [script] : [] };
  }
  return null;
}

export function spawnCli(bin: string, args: string[], opts: CliSpawnOptions): ChildProcess {
  if (process.platform === "win32") {
    const { preferCmdShim: _preferCmdShim, ...rest } = opts;
    // 应用版：把系统代理交给命令行（见 systemProxy.ts）。
    const spawnOpts = { ...rest, env: withSystemProxy(rest.env) };
    const resolved = resolveWindowsCommand(bin, Boolean(opts.preferCmdShim));
    if (isPowerShellShim(resolved)) {
      const target = npmShimTarget(resolved);
      if (target) return nodeSpawn(target.command, [...target.args, ...args], { ...spawnOpts, windowsHide: true });
      return nodeSpawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolved, ...args],
        { ...spawnOpts, windowsHide: true }
      );
    }
    if (isCmdShim(resolved)) {
      const command = ["call", resolved, ...args].map(winQuoteArg).join(" ");
      // 命令行要原样交给 cmd.exe（/s 会剥掉最外层这对引号）。不加 windowsVerbatimArguments 的话 Node 会把里面的 " 再转义成 \"，
      // 带空格的参数到 CLI 那边就断成两半（"C:\Program Files\nodejs\node.exe" 变成 "C:\Program 和 Files\nodejs\node.exe"）。
      return nodeSpawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${command}"`], {
        ...spawnOpts,
        windowsHide: true,
        windowsVerbatimArguments: true,
      });
    }
    return nodeSpawn(resolved, args, { ...spawnOpts, windowsHide: true });
  }
  return nodeSpawn(bin, args, opts);
}

export function killProcessTree(child: ChildProcess): void {
  if (child.killed) return;
  if (process.platform === "win32" && child.pid) {
    const killer = nodeSpawn("taskkill.exe", ["/F", "/T", "/PID", String(child.pid)], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("error", () => child.kill());
    return;
  }
  child.kill();
}
