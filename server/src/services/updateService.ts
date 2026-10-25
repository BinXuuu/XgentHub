import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { db } from "../db/index.ts";

// 在线更新：去 GitHub 看开源仓库有没有更高版本的标签（v1.2.3），有的话由 scripts/update-agenthub.ps1（Windows）或 update-agenthub.sh（macOS / Linux）
// 停服务 → 备份 → 下载替换（或 git 切到新标签）→ npm install → 构建 → 重启；失败自动恢复备份。
// 用户自己的 .env、server/data、logs、backups 永远不动。

const repoRoot = path.resolve(config.serverRoot, "..");
const UPDATE_REPO = (process.env.AGENTHUB_UPDATE_REPO || "BinXuuu/XgentHub").trim();
// 测试时指向本机的假 GitHub；平时用 GitHub 官方地址。
const API_BASE = (process.env.AGENTHUB_UPDATE_API_BASE || "https://api.github.com").replace(/\/+$/, "");
const RAW_BASE = (process.env.AGENTHUB_UPDATE_RAW_BASE || "https://raw.githubusercontent.com").replace(/\/+$/, "");
const ARCHIVE_BASE = (process.env.AGENTHUB_UPDATE_ARCHIVE_BASE || "https://codeload.github.com").replace(/\/+$/, "");
const CHECK_TTL_MS = 6 * 60 * 60 * 1000;
const STATUS_FILE = path.join(repoRoot, "logs", "update-status.json");

export type InstallMode = "archive" | "git" | "dev";

export interface UpdateInfo {
  repo: string;
  currentVersion: string;
  latestVersion: string | null;
  latestTag: string | null;
  available: boolean;
  notes: string;
  mode: InstallMode;
  /** mode 为 dev 时说明为什么不能自动更新。 */
  modeReason: string | null;
  checkedAt: string;
  error: string | null;
}

export interface UpdateStatus {
  state: "running" | "done" | "failed";
  step: string;
  fromVersion: string;
  toVersion: string;
  tag: string;
  mode: string;
  updatedAt: string;
  error: string;
  log: string;
}

export function currentVersion(): string {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version || "0.0.0");
  } catch {
    return "0.0.0";
  }
}

export function parseVersion(text: string): [number, number, number] | null {
  const match = text.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** a 比 b 新返回正数。认不出的版本号当成最旧。 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
}

/** 从 CHANGELOG.md 里取出 "## v1.2.3"（或 "## 1.2.3"）这一节的内容。 */
export function extractChangelogSection(markdown: string, version: string): string {
  const lines = markdown.split(/\r?\n/);
  const target = version.replace(/^v/, "");
  const start = lines.findIndex((line) => {
    const match = line.match(/^##\s+v?(\d+\.\d+\.\d+)\b/);
    return match?.[1] === target;
  });
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
}

/**
 * archive：安装包 / 解压安装（没有 .git），下载新版本的压缩包覆盖程序文件。
 * git：从这个开源仓库 git clone 下来的，直接切到新版本标签。
 * dev：开发用的仓库（没关联到更新仓库），不自动更新，免得覆盖开发中的代码。
 */
/** root 默认是程序所在目录；测试会传一个临时仓库进来。 */
export function detectInstallMode(root: string = repoRoot): { mode: InstallMode; reason: string | null } {
  const forced = process.env.AGENTHUB_UPDATE_MODE;
  if (forced === "archive" || forced === "git" || forced === "dev") return { mode: forced, reason: forced === "dev" ? "已通过 AGENTHUB_UPDATE_MODE=dev 关闭自动更新" : null };
  // Docker 版（镜像里设了 AGENTHUB_UPDATE_MODE=docker）：程序在镜像里，换新版本是拉新镜像，不能在容器里改文件。
  if (forced === "docker") return { mode: "dev", reason: "Docker 版不在程序里更新：在宿主机的项目目录运行 git pull && docker compose up -d --build 换成新版本（用发布好的镜像则是 docker compose pull && docker compose up -d），数据卷里的数据不受影响。" };
  if (!fs.existsSync(path.join(root, ".git"))) return { mode: "archive", reason: null };
  let origin = "";
  try {
    origin = execFileSync("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf8", windowsHide: true }).trim();
  } catch {
    origin = "";
  }
  const normalized = origin.toLowerCase().replace(/\.git$/, "");
  if (normalized.endsWith(`github.com/${UPDATE_REPO.toLowerCase()}`) || normalized.endsWith(`github.com:${UPDATE_REPO.toLowerCase()}`)) {
    return { mode: "git", reason: null };
  }
  return {
    mode: "dev",
    reason: `这是开发用的项目（git 仓库没有关联到 ${UPDATE_REPO}），不会自动更新，请用 git 自己管理。`,
  };
}

async function fetchText(url: string): Promise<{ ok: boolean; status: number; text: string }> {
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "XgentHub-updater" },
    signal: AbortSignal.timeout(10_000),
  });
  return { ok: res.ok, status: res.status, text: await res.text() };
}

let cache: { at: number; info: UpdateInfo } | null = null;

export async function checkForUpdate(force = false): Promise<UpdateInfo> {
  if (!force && cache && Date.now() - cache.at < CHECK_TTL_MS) return cache.info;
  const { mode, reason } = detectInstallMode();
  const info: UpdateInfo = {
    repo: UPDATE_REPO,
    currentVersion: currentVersion(),
    latestVersion: null,
    latestTag: null,
    available: false,
    notes: "",
    mode,
    modeReason: reason,
    checkedAt: new Date().toISOString(),
    error: null,
  };
  try {
    const tags = await fetchText(`${API_BASE}/repos/${UPDATE_REPO}/tags?per_page=100`);
    if (tags.status === 404) throw new Error(`找不到更新源 ${UPDATE_REPO}：仓库不存在或还没有公开`);
    if (tags.status === 403) throw new Error("GitHub 暂时拒绝了查询（可能是访问次数超限），过一会儿再试");
    if (!tags.ok) throw new Error(`查询新版本失败：HTTP ${tags.status}`);
    const names = (JSON.parse(tags.text) as Array<{ name?: string }>).map((tag) => String(tag.name ?? "")).filter((name) => parseVersion(name));
    const latestTag = names.sort((a, b) => compareVersions(b, a))[0] ?? null;
    if (latestTag) {
      info.latestTag = latestTag;
      info.latestVersion = latestTag.replace(/^v/, "");
      info.available = compareVersions(info.latestVersion, info.currentVersion) > 0;
      if (info.available) {
        try {
          const changelog = await fetchText(`${RAW_BASE}/${UPDATE_REPO}/${latestTag}/CHANGELOG.md`);
          if (changelog.ok) info.notes = extractChangelogSection(changelog.text, info.latestVersion);
        } catch {
          // 拿不到更新说明不影响更新本身
        }
      }
    }
  } catch (err) {
    info.error = err instanceof Error && err.name === "TimeoutError" ? "连不上 GitHub，检查一下网络" : (err as Error).message;
  }
  cache = { at: Date.now(), info };
  return info;
}

export function readUpdateStatus(): UpdateStatus | null {
  try {
    return JSON.parse(fs.readFileSync(STATUS_FILE, "utf8").replace(/^﻿/, "")) as UpdateStatus;
  } catch {
    return null;
  }
}

function runningTaskCount(): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status IN ('running', 'needs_approval')").get() as { count: number };
  return row.count;
}

export async function startUpdate(): Promise<{ started: true; fromVersion: string; toVersion: string }> {
  const info = await checkForUpdate(true);
  if (info.mode === "dev") throw new Error(info.modeReason ?? "当前安装方式不支持自动更新");
  if (info.error) throw new Error(info.error);
  if (!info.available || !info.latestTag || !info.latestVersion) throw new Error(`已经是最新版本（${info.currentVersion}）`);
  const status = readUpdateStatus();
  if (status?.state === "running" && Date.now() - new Date(status.updatedAt).getTime() < 30 * 60 * 1000) {
    throw new Error("已经在更新了，等这次更新结束");
  }
  const running = runningTaskCount();
  if (running > 0) throw new Error(`有 ${running} 个任务正在运行或等待审批，等它们结束（或先停止）再更新`);

  // Windows 用 update-agenthub.ps1（下载 zip），macOS / Linux 用 update-agenthub.sh（下载 tar.gz，系统自带 tar 就能解）。
  const windows = process.platform === "win32";
  const archiveUrl = `${ARCHIVE_BASE}/${UPDATE_REPO}/${windows ? "zip" : "tar.gz"}/refs/tags/${info.latestTag}`;
  const [command, args] = windows
    ? [
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join(repoRoot, "scripts", "update-agenthub.ps1"),
          "-Launch",
          "-Root",
          repoRoot,
          "-Tag",
          info.latestTag,
          "-Mode",
          info.mode,
          "-FromVersion",
          info.currentVersion,
          "-ToVersion",
          info.latestVersion,
          ...(info.mode === "archive" ? ["-ArchiveUrl", archiveUrl] : []),
        ],
      ]
    : [
        "bash",
        [
          path.join(repoRoot, "scripts", "update-agenthub.sh"),
          "--launch",
          "--root",
          repoRoot,
          "--tag",
          info.latestTag,
          "--mode",
          info.mode,
          "--from",
          info.currentVersion,
          "--to",
          info.latestVersion,
          ...(info.mode === "archive" ? ["--archive-url", archiveUrl] : []),
        ],
      ];

  // 带 launch 参数只是把脚本拷到临时目录、另起一个和本服务没有父子关系的进程去跑，然后马上返回：
  // 更新脚本要先停掉本服务，不能是它的子进程。
  await new Promise<void>((resolve, reject) => {
    execFile(command, args as string[], { cwd: repoRoot, windowsHide: true, timeout: 30_000 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`启动更新失败：${stderr?.trim() || err.message}`));
      else resolve();
    });
  });
  cache = null;
  return { started: true, fromVersion: info.currentVersion, toVersion: info.latestVersion };
}
