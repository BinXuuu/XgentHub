import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { clearCliAvailabilityCache, resolveCliBinary, spawnCli } from "../adapters/winSpawn.ts";
import { withSystemProxy } from "../adapters/systemProxy.ts";

/**
 * 「配置向导」里的一键安装：在运行 Xgent 的这台电脑上装各家 Agent 的命令行（CLI）。
 *
 * 只跑下面这张表里写死的官方安装命令，页面只能传表里的名字，不能传任意命令。
 * - npm 包用 npm.cmd 装（不经过 npm.ps1）：有的电脑 PowerShell 禁止运行脚本（执行策略），
 *   在 PowerShell 里敲 npm install 会报「因为在此系统上禁止运行脚本」，npm.cmd 不受影响。
 * - 只有 PowerShell 安装脚本的（Antigravity），用 -ExecutionPolicy Bypass 只对这一次安装进程放行，不改系统设置。
 * - 装完重新读一遍系统 PATH（安装程序可能刚把目录加进去），不用重启 Xgent 就能找到新装的命令。
 */

export type CliInstallTarget = "codex" | "claude-code" | "openclaw" | "codebuddy" | "antigravity" | "ark-cli";

interface InstallRecipe {
  label: string;
  /** npm 全局包（带版本标签）。 */
  npmPackage?: string;
  /** Windows 上没有 npm 包时用的官方 PowerShell 安装脚本地址。 */
  windowsScript?: string;
}

const RECIPES: Record<CliInstallTarget, InstallRecipe> = {
  codex: { label: "Codex CLI", npmPackage: "@openai/codex@latest" },
  "claude-code": { label: "Claude Code CLI", npmPackage: "@anthropic-ai/claude-code@latest" },
  openclaw: { label: "OpenClaw CLI", npmPackage: "openclaw@latest" },
  codebuddy: { label: "CodeBuddy Code", npmPackage: "@tencent-ai/codebuddy-code@latest" },
  antigravity: { label: "Antigravity CLI", windowsScript: "https://antigravity.google/cli/install.ps1" },
  "ark-cli": { label: "Ark CLI", npmPackage: "@volcengine/ark-cli@latest" },
};

export function isCliInstallTarget(value: unknown): value is CliInstallTarget {
  return typeof value === "string" && Object.hasOwn(RECIPES, value);
}

/** 这台电脑上能不能一键安装（npm 包要有 npm；PowerShell 脚本只在 Windows 上有）。配置向导据此决定显不显示按钮。 */
export function canInstallCli(target: CliInstallTarget): boolean {
  const recipe = RECIPES[target];
  if (recipe.npmPackage) return true; // 没装 Node.js 时点了会提示先装 Node.js，比不显示按钮更好懂。
  return Boolean(recipe.windowsScript) && process.platform === "win32";
}

export interface CliInstallJob {
  id: string;
  target: CliInstallTarget;
  label: string;
  command: string;
  status: "running" | "succeeded" | "failed";
  log: string;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

const MAX_LOG = 64 * 1024;
const TIMEOUT_MS = 10 * 60 * 1000;
const jobs = new Map<string, CliInstallJob>();
const running = new Map<CliInstallTarget, string>();

function appendLog(job: CliInstallJob, text: string) {
  job.log += text;
  if (job.log.length > MAX_LOG) job.log = `…（前面的输出省略了）\n${job.log.slice(-MAX_LOG)}`;
}

function finish(job: CliInstallJob, ok: boolean, error: string | null) {
  if (job.status !== "running") return;
  job.status = ok ? "succeeded" : "failed";
  job.error = error;
  job.finishedAt = new Date().toISOString();
  running.delete(job.target);
  if (ok) {
    refreshPathFromSystem();
    clearCliAvailabilityCache();
  }
}

/**
 * Windows：把系统和当前用户的 PATH 里新出现的目录补进本进程的 PATH。
 * 安装程序（Node.js、Antigravity 等）改的是注册表里的 PATH，已经在跑的程序看不到，不补的话要重启 Xgent 才找得到新命令。
 * 用 -Command 读环境变量不是运行脚本文件，不受执行策略限制。
 */
export function refreshPathFromSystem(): void {
  if (process.platform !== "win32") return;
  // 测试用假的 npm 时不能把系统 PATH 补进来，不然会找到真的 npm、真的去装。
  if (process.env.XGENT_NO_SYSTEM_PATH_REFRESH === "1") return;
  try {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetEnvironmentVariable('Path','Machine'); [Environment]::GetEnvironmentVariable('Path','User')"],
      { encoding: "utf8", windowsHide: true, timeout: 15_000 }
    );
    mergePath(out.split(/\r?\n/).join(path.delimiter));
  } catch {
    // 读不到就算了，重启 Xgent 后也能找到。
  }
}

function mergePath(extra: string) {
  const current = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const seen = new Set(current.map((dir) => path.normalize(dir).toLowerCase()));
  for (const raw of extra.split(path.delimiter)) {
    const dir = raw.trim().replace(/%([^%]+)%/g, (_m, name: string) => process.env[name] ?? `%${name}%`);
    if (!dir || dir.includes("%")) continue;
    const key = path.normalize(dir).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    current.push(dir);
  }
  process.env.PATH = current.join(path.delimiter);
}

function nodeMissingMessage(): string {
  return (
    "这台电脑还没装 Node.js（npm 跟着 Node.js 一起装），所以没法装这个命令行。\n" +
    "请先到 https://nodejs.org 下载 LTS 版安装（一路下一步），装好后回来再点「一键安装」。"
  );
}

function startProcess(job: CliInstallJob, recipe: InstallRecipe): ChildProcess {
  if (recipe.npmPackage) {
    // preferCmdShim：Windows 上用 npm.cmd，不走 npm.ps1（执行策略会拦）。
    return spawnCli("npm", ["install", "-g", recipe.npmPackage], { preferCmdShim: true, env: process.env });
  }
  return spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `irm ${recipe.windowsScript} | iex`],
    { windowsHide: true, env: withSystemProxy(process.env) }
  );
}

export function startCliInstall(target: CliInstallTarget): CliInstallJob {
  const existing = running.get(target);
  if (existing) return jobs.get(existing)!;

  const recipe = RECIPES[target];
  if (!canInstallCli(target)) throw new Error(`${recipe.label} 在这个系统上没有一键安装，请复制安装命令到终端运行。`);
  const command = recipe.npmPackage ? `npm install -g ${recipe.npmPackage}` : `irm ${recipe.windowsScript} | iex`;
  const job: CliInstallJob = {
    id: randomUUID(),
    target,
    label: recipe.label,
    command,
    status: "running",
    log: `$ ${command}\n`,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  jobs.set(job.id, job);
  // 只留最近 20 个已结束任务的记录（Map 按插入顺序，前面的最旧）。
  for (const [id, old] of jobs) {
    if (jobs.size <= 20) break;
    if (old.status !== "running") jobs.delete(id);
  }

  if (recipe.npmPackage) {
    // 刚装好 Node.js 时 Xgent 的 PATH 里还没有它，先补一下再找 npm。
    if (!resolveCliBinary("npm", { preferCmdShim: true })) refreshPathFromSystem();
    if (!resolveCliBinary("npm", { preferCmdShim: true })) {
      appendLog(job, `${nodeMissingMessage()}\n`);
      finish(job, false, nodeMissingMessage());
      return job;
    }
  }

  running.set(target, job.id);
  let child: ChildProcess;
  try {
    child = startProcess(job, recipe);
  } catch (error) {
    finish(job, false, `启动安装失败：${(error as Error).message}`);
    return job;
  }
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => appendLog(job, chunk));
  child.stderr?.on("data", (chunk: string) => appendLog(job, chunk));
  const timer = setTimeout(() => {
    appendLog(job, "\n安装超过 10 分钟还没结束，已停止。可以检查网络后重试。\n");
    if (process.platform === "win32" && child.pid) spawn("taskkill.exe", ["/F", "/T", "/PID", String(child.pid)], { windowsHide: true });
    else child.kill();
    finish(job, false, "安装超时");
  }, TIMEOUT_MS);
  child.on("error", (error) => {
    clearTimeout(timer);
    appendLog(job, `\n启动安装失败：${error.message}\n`);
    finish(job, false, `启动安装失败：${error.message}`);
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    if (code === 0) {
      appendLog(job, `\n${recipe.label} 安装完成。\n`);
      finish(job, true, null);
    } else {
      appendLog(job, `\n安装失败（退出码 ${code}）。\n`);
      finish(job, false, failureHint(job.log, code));
    }
  });
  return job;
}

/** 常见失败原因给一句人话。 */
function failureHint(log: string, code: number | null): string {
  // 先认「Node.js 太旧」：npm 的输出里别处可能夹着 EPERM 之类的字样，不能先按权限问题说。
  const nodeWanted = log.match(/requires Node\s*([^\s.,;]*(?:\.[^\s,;]*)?)/i)?.[1] ?? log.match(/Unsupported engine[\s\S]*?"node":\s*"([^"]+)"/i)?.[1];
  if (nodeWanted || /EBADENGINE|Unsupported engine/i.test(log)) {
    const current = log.match(/detected Node v?([\d.]+)/i)?.[1];
    const detail = [current && `现在是 ${current}`, nodeWanted && `需要 ${nodeWanted}`].filter(Boolean).join("，");
    return `这台电脑的 Node.js 版本太旧${detail ? `（${detail}）` : ""}。请到 https://nodejs.org 下载最新的 LTS 版覆盖安装，装好后再点「一键安装」。`;
  }
  if (/\bEACCES\b|\bEPERM\b|operation not permitted/i.test(log)) return "没有权限写入 npm 的全局目录。可以用管理员身份运行 Xgent 后再试，或复制安装命令在终端里运行。";
  if (/ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|network|getaddrinfo/i.test(log)) return "网络连不上 npm 仓库。检查网络或代理后重试（国内网络可以先设置 npm 镜像）。";
  if (/irm|Invoke-RestMethod|无法连接|Unable to connect/i.test(log)) return "下载安装脚本失败，检查网络后重试。";
  return `安装失败（退出码 ${code}），详细输出见下面的日志。`;
}

export function getCliInstallJob(id: string): CliInstallJob | null {
  return jobs.get(id) ?? null;
}
