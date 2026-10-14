import { spawn as nodeSpawn, type ChildProcess, type SpawnOptionsWithoutStdio } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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

/** CLI 能不能在本机找到（带 15 秒缓存）。Agent 列表每次刷新都会问，不能每次都扫一遍 PATH。 */
export function cliAvailable(bin: string, opts: { preferCmdShim?: boolean } = {}): boolean {
  const key = `${opts.preferCmdShim ? "cmd" : "any"}:${bin}`;
  const cached = availabilityCache.get(key);
  if (cached && Date.now() - cached.at < 15_000) return cached.ok;
  const ok = Boolean(resolveCliBinary(bin, opts));
  availabilityCache.set(key, { ok, at: Date.now() });
  return ok;
}

export function spawnCli(bin: string, args: string[], opts: CliSpawnOptions): ChildProcess {
  if (process.platform === "win32") {
    const { preferCmdShim: _preferCmdShim, ...spawnOpts } = opts;
    const resolved = resolveWindowsCommand(bin, Boolean(opts.preferCmdShim));
    if (isPowerShellShim(resolved)) {
      return nodeSpawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolved, ...args],
        { ...spawnOpts, windowsHide: true }
      );
    }
    if (isCmdShim(resolved)) {
      const command = ["call", resolved, ...args].map(winQuoteArg).join(" ");
      return nodeSpawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], { ...spawnOpts, windowsHide: true });
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
