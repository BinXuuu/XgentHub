import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCliBinary } from "./winSpawn.ts";

// Claude 桌面版把自带的 Claude Code 放在 ...\Claude\claude-code\<版本>\<哈希>\claude.exe，
// 每次自动升级都会多一个新版本目录、旧的随后被清掉。CLAUDE_CODE_BIN 里写死某个版本的完整路径，
// 升级后就会找不到（已经踩过好几次）。这里在每次要用时现找：配置的路径落在这种按版本存放的目录里，
// 就换成同一目录下最新的版本；配置的路径不存在，就去桌面版的默认位置找。别的路径（比如 npm 装的 claude）原样用。

const VERSIONED_EXE = /^(.*[\\/]claude-code)[\\/](\d+(?:\.\d+)*)[\\/][^\\/]+[\\/]claude(?:\.exe)?$/i;
const CACHE_MS = 30_000;
let cache: { configured: string; resolved: string; at: number } | null = null;

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** 在一个 claude-code 目录里找最新版本的 claude.exe（<版本>\<任意子目录>\claude.exe）。 */
export function newestClaudeIn(claudeCodeDir: string): string | null {
  let versions: string[];
  try {
    versions = fs.readdirSync(claudeCodeDir).filter((name) => /^\d+(?:\.\d+)*$/.test(name));
  } catch {
    return null;
  }
  for (const version of versions.sort(compareVersions).reverse()) {
    const versionDir = path.join(claudeCodeDir, version);
    let children: string[];
    try {
      children = fs.readdirSync(versionDir);
    } catch {
      continue;
    }
    for (const child of children) {
      for (const exe of ["claude.exe", "claude"]) {
        const candidate = path.join(versionDir, child, exe);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

/** 桌面版可能放 claude-code 的位置（普通安装 / Microsoft Store 版的虚拟化目录）。 */
function desktopClaudeCodeDirs(): string[] {
  if (process.platform !== "win32") return [];
  const dirs: string[] = [];
  const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  dirs.push(path.join(appData, "Claude", "claude-code"));
  try {
    for (const pkg of fs.readdirSync(path.join(localAppData, "Packages")).filter((name) => /^Claude_/i.test(name))) {
      dirs.push(path.join(localAppData, "Packages", pkg, "LocalCache", "Roaming", "Claude", "claude-code"));
    }
  } catch {
    // 没有 Store 版就算了
  }
  return dirs;
}

export function resolveClaudeCodeBin(configured: string): string {
  const now = Date.now();
  if (cache && cache.configured === configured && now - cache.at < CACHE_MS) return cache.resolved;
  const resolved = resolveUncached(configured);
  cache = { configured, resolved, at: now };
  return resolved;
}

function resolveUncached(configured: string): string {
  const match = configured.match(VERSIONED_EXE);
  if (match) {
    const newest = newestClaudeIn(match[1]);
    if (newest) return newest;
  }
  const looksLikePath = /[\\/]/.test(configured);
  if (looksLikePath && fs.existsSync(configured)) return configured;
  // 只写了命令名（比如 npm 装的 claude）且 PATH 里能找到，就用它，不去抢桌面版的。
  if (!looksLikePath && resolveCliBinary(configured)) return configured;
  // 配置的是带版本的路径但整个目录都没了，或者只写了 "claude" 而 PATH 里可能没有：去桌面版默认位置找。
  if (match || looksLikePath || configured === "claude") {
    for (const dir of desktopClaudeCodeDirs()) {
      const found = newestClaudeIn(dir);
      if (found) return found;
    }
  }
  return configured;
}
