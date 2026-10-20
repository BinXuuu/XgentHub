import { execFile, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "../config.ts";
import { scanRisk, shouldGate } from "./riskPolicy.ts";
import { cliAvailable, killProcessTree, spawnCli } from "./winSpawn.ts";
import { buildWorkspacePrompt } from "./workspacePrompt.ts";
import type { AgentAdapter, McpServerSpec, TaskRuntimeContext, TurnInput } from "./types.ts";
import { runtimeKeyOf } from "./types.ts";
import type { FileChange, ModelOption } from "../types.ts";
import { ASK_TIMEOUT_MS, ASK_TIMEOUT_SEC, cliAskError } from "./askErrors.ts";

const execFileAsync = promisify(execFile);
const runningCodexProcesses = new Map<string, { child: ChildProcess; kill: (reason: string) => void }>();

// Codex 桌面端那个模型选择器背后读的就是这份本地缓存（~/.codex/models_cache.json），CLI 自己
// 每次调用也会顺带刷新它——实测这台机器上这份缓存的 fetched_at 在我们这次会话里就被刷新过。
// 不用额外发请求去拉模型列表，直接读这份文件，跟官方客户端看到的选项保持一致。
// visibility !== "list" 的条目（比如已经退役或内部专用的）跟桌面端一样不展示。
interface CodexModelsCache {
  models?: { slug?: string; display_name?: string; visibility?: string; priority?: number }[];
}

function readCodexModelsCache(): ModelOption[] {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const cachePath = path.join(codexHome, "models_cache.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8")) as CodexModelsCache;
    return (parsed.models ?? [])
      .filter((m) => m.visibility === "list" && m.slug && m.display_name)
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
      .map((m) => ({ id: m.slug!, label: m.display_name! }));
  } catch {
    return [];
  }
}

/**
 * Codex 没有"按次传参"的 MCP 机制，必须先 `codex mcp add` 注册进 ~/.codex/config.toml 才能被
 * `codex exec` 用到——而且一旦注册，这台机器上所有 codex 调用都能看到它，不是任务级隔离，
 * 这是 Codex CLI 自己的限制。name 统一带 agenthub- 前缀，这里只增不删/不碰其它条目，
 * 保证用户自己手动 `codex mcp add` 配的（比如 cad-drafting）绝不会被动到。
 */
function runCodexCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawnCli(config.codex.bin, args, { cwd: process.cwd(), preferCmdShim: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: stderr || err.message }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function listCodexMcpServerNames(): Promise<Set<string>> {
  try {
    const { code, stdout } = await runCodexCli(["mcp", "list", "--json"]);
    if (code !== 0) return new Set();
    const parsed = JSON.parse(stdout) as { name?: string }[];
    return new Set(parsed.map((item) => item.name).filter((name): name is string => typeof name === "string"));
  } catch {
    return new Set();
  }
}

// 实测 `codex mcp list --json` 单次就要 ~6s（真的 spawn 一个子进程，不是读本地文件那么快）。
// dispatch() 每一轮对话都会调一次 ensureCodexMcpServersRegistered，如果不缓存，相当于每条
// 消息都白白多等 6 秒。这里用进程内存缓存记住"这一轮 AgentHub 进程里已经确认注册过"的名字，
// 同名 server 第二次起直接跳过 list/add。代价：如果用户在终端手动 `codex mcp remove` 了某个
// agenthub- 条目，AgentHub 要到下次重启才会发现并补注册——用这个小概率换掉每轮必等的几秒延迟。
const confirmedRegisteredCodexNames = new Set<string>();

async function ensureCodexMcpServersRegistered(servers: McpServerSpec[], log: (message: string) => void): Promise<void> {
  const uncached = servers.filter((server) => !confirmedRegisteredCodexNames.has(server.name));
  if (uncached.length === 0) return;

  const registered = await listCodexMcpServerNames();
  const missing: McpServerSpec[] = [];
  for (const server of uncached) {
    if (registered.has(server.name)) confirmedRegisteredCodexNames.add(server.name);
    else missing.push(server);
  }
  if (missing.length === 0) return;

  for (const server of missing) {
    try {
      const args = ["mcp", "add", server.name];
      if (server.transport === "http") {
        if (!server.url) continue;
        args.push("--url", server.url);
        if (server.headers && Object.keys(server.headers).length) {
          log(`[mcp] Codex 的 mcp add 不支持自定义 HTTP header，"${server.name}" 的 header 配置已忽略`);
        }
      } else {
        if (!server.command) continue;
        for (const [key, value] of Object.entries(server.env ?? {})) args.push("--env", `${key}=${value}`);
        args.push("--", server.command, ...(server.args ?? []));
      }
      const result = await runCodexCli(args);
      if (result.code !== 0) log(`[mcp] 注册 "${server.name}" 到 Codex 失败：${result.stderr.trim() || `exit ${result.code}`}`);
      else confirmedRegisteredCodexNames.add(server.name);
    } catch (err) {
      log(`[mcp] 注册 "${server.name}" 到 Codex 失败：${(err as Error).message}`);
    }
  }
}
const RATE_LIMIT_TAIL_BYTES = 4 * 1024 * 1024;
const RATE_LIMIT_SCAN_FILE_LIMIT = 120;

// Codex adapter：基于官方 `codex exec --json` 非交互模式（不是简单包一层 chat completions）。
// `codex exec` 会在一个真实的 OS 级沙箱（--sandbox read-only|workspace-write|danger-full-access）
// 里自主跑完一整个 turn（读文件、跑命令、改文件），并把过程以 JSONL 事件流打到 stdout，
// 这比其它几个 adapter 更进一步：文件系统/网络访问本身就被沙箱限制住了，
// AgentHub 这层的 riskPolicy 预检只是在此之上再加一道闸门。
//
// 已确认的事件类型（`codex exec --sandbox workspace-write --json "<prompt>"` 实测得到）：
//   thread.started            { thread_id }
//   turn.started / turn.completed
//   item.completed  type=agent_message      { text }
//   item.started/completed type=command_execution  { command, aggregated_output, exit_code, status }
//   item.started/completed type=file_change  { changes: [{ path, kind }] }  —— 不带 diff 正文
//   item.completed  type=error               { message }（例如实验特性提示，不一定是致命错误）
// file_change 事件本身不带 diff，这里在 workspace 是 git 仓库时用 `git diff` 尽力补全 diff 正文。

function isMissingBinaryError(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "ENOENT");
}

async function tryGitDiff(workspacePath: string, absoluteFilePath: string): Promise<string | undefined> {
  try {
    const rel = path.relative(workspacePath, absoluteFilePath);
    const { stdout } = await execFileAsync("git", ["diff", "--", rel], { cwd: workspacePath, maxBuffer: 10 * 1024 * 1024 });
    return stdout.trim() ? stdout : undefined;
  } catch {
    return undefined; // 不是 git 仓库，或 git 不可用：跳过，仍然记录文件改动本身
  }
}

function mapFileAction(kind: string): FileChange["action"] {
  if (kind === "add" || kind === "create") return "created";
  if (kind === "delete" || kind === "remove") return "deleted";
  return "modified";
}

function samePath(a: string, b: string): boolean {
  return a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();
}

function additionalWorkspaceDirs(ctx: TaskRuntimeContext): string[] {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const raw of ctx.workspaceAccessPaths ?? []) {
    const value = raw.trim();
    if (!value || samePath(value, ctx.workspacePath)) continue;
    const key = value.replace(/[\\/]+$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    dirs.push(value);
  }
  return dirs;
}

interface CodexRateLimitSnapshot {
  timestamp: string;
  rateLimits: {
    primary?: { used_percent?: number; window_minutes?: number; resets_at?: number };
    secondary?: { used_percent?: number; window_minutes?: number; resets_at?: number };
    credits?: { has_credits?: boolean; unlimited?: boolean; balance?: string | null } | null;
    plan_type?: string | null;
  };
}

function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

/** Codex 自己的默认模型：~/.codex/config.toml 顶层的 model = "..."（第一个 [段落] 之前）。 */
function readCodexDefaultModel(): string | null {
  try {
    const text = fs.readFileSync(path.join(codexHome(), "config.toml"), "utf8");
    const topLevel = text.split(/^\s*\[/m)[0] ?? "";
    return topLevel.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * 这一轮实际用哪个模型：指定了就用指定的；没指定时用 Codex 配置里的默认模型——
 * 但如果它已经不在可用模型列表里（OpenAI 下架了旧模型，比如 ChatGPT 账号不能再用 gpt-5.5），
 * 就改用可用列表里的第一个，免得"默认"整个用不了。返回 null 表示交给 Codex 自己的默认。
 */
export function resolveCodexModel(explicit?: string | null): { model: string | null; fallbackFrom: string | null } {
  if (explicit?.trim()) return { model: explicit.trim(), fallbackFrom: null };
  const available = readCodexModelsCache();
  if (available.length === 0) return { model: null, fallbackFrom: null };
  const configured = readCodexDefaultModel();
  if (configured && available.some((option) => option.id === configured)) return { model: null, fallbackFrom: null };
  return { model: available[0]!.id, fallbackFrom: configured };
}

function collectJsonlFiles(root: string, out: { path: string; mtimeMs: number }[], limit = 3000) {
  if (!fs.existsSync(root) || out.length >= limit) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= limit) return;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      collectJsonlFiles(full, out, limit);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    try {
      out.push({ path: full, mtimeMs: fs.statSync(full).mtimeMs });
    } catch {
      // Ignore files that disappear while Codex rotates session logs.
    }
  }
}

function readFileTail(filePath: string, maxBytes = RATE_LIMIT_TAIL_BYTES): string {
  const stat = fs.statSync(filePath);
  const size = Math.min(stat.size, maxBytes);
  const buffer = Buffer.alloc(size);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, buffer, 0, size, Math.max(0, stat.size - size));
  } finally {
    fs.closeSync(fd);
  }
  return buffer.toString("utf8");
}

function findLatestRateLimitSnapshot(): CodexRateLimitSnapshot | null {
  const files: { path: string; mtimeMs: number }[] = [];
  const home = codexHome();
  collectJsonlFiles(path.join(home, "sessions"), files);
  collectJsonlFiles(path.join(home, "archived_sessions"), files);

  // 要的是"时间最新"的那条额度记录，不是"最近改过的文件里的第一条"：老会话文件也会被 Codex 改动（续接、追加别的事件），
  // 它末尾的额度记录可能是好几天前的，以前就因此一直显示旧快照。一个文件里的记录不会比它的修改时间更新，
  // 所以扫到修改时间早于已找到记录的文件就可以停。
  let best: CodexRateLimitSnapshot | null = null;
  let bestMs = 0;
  for (const file of files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, RATE_LIMIT_SCAN_FILE_LIMIT)) {
    if (best && file.mtimeMs < bestMs) break;
    let text = "";
    try {
      text = readFileTail(file.path);
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/).filter(Boolean).reverse();
    for (const line of lines) {
      if (!line.includes("rate_limits")) continue;
      try {
        const evt = JSON.parse(line);
        const rateLimits = evt?.payload?.rate_limits;
        if (rateLimits?.primary || rateLimits?.secondary || rateLimits?.credits) {
          const timestamp = evt.timestamp ?? new Date(file.mtimeMs).toISOString();
          const ms = new Date(timestamp).getTime();
          if (!best || ms > bestMs) {
            best = { timestamp, rateLimits };
            bestMs = ms;
          }
          break; // 这个文件里最新的一条已经拿到（倒序读），看下一个文件
        }
      } catch {
        // Continue scanning older lines.
      }
    }
  }
  return best;
}

function formatCodexResetTime(value?: number): string {
  if (!value || !Number.isFinite(value)) return "重置时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value * 1000));
}

function formatRateWindow(label: string, window?: { used_percent?: number; window_minutes?: number; resets_at?: number }): string | null {
  if (!window || typeof window.used_percent !== "number") return null;
  return `${label}：已用 ${window.used_percent}%，${formatCodexResetTime(window.resets_at)} 重置`;
}

function formatCodexRateLimitSnapshot(snapshot: CodexRateLimitSnapshot): string {
  const { rateLimits } = snapshot;
  const lines = [
    "Codex 额度",
    formatRateWindow("5 小时额度", rateLimits.primary),
    formatRateWindow("7 天额度", rateLimits.secondary),
  ].filter(Boolean) as string[];

  if (rateLimits.credits) {
    const balance =
      rateLimits.credits.unlimited ? "无限" : rateLimits.credits.has_credits ? rateLimits.credits.balance ?? "未知" : rateLimits.credits.balance ?? "0";
    lines.push(`点数余额：${balance}`);
  }
  if (rateLimits.plan_type) lines.push(`套餐类型：${rateLimits.plan_type}`);
  lines.push(`快照时间：${formatCodexResetTime(Math.floor(new Date(snapshot.timestamp).getTime() / 1000))}`);
  return lines.join("\n");
}

async function handleLine(ctx: TaskRuntimeContext, line: string): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("{")) return;
  let evt: any;
  try {
    evt = JSON.parse(trimmed);
  } catch {
    return;
  }

  switch (evt.type) {
    case "thread.started":
      if (evt.thread_id) ctx.setSessionKey(evt.thread_id);
      break;
    case "item.completed": {
      const item = evt.item ?? {};
      if (item.type === "agent_message" && item.text) {
        ctx.agentMessage(item.text);
      } else if (item.type === "command_execution") {
        ctx.terminal(`$ ${item.command}\n${item.aggregated_output ?? ""}${item.exit_code != null ? `\n(exit ${item.exit_code})\n` : ""}`);
      } else if (item.type === "file_change" && Array.isArray(item.changes)) {
        for (const change of item.changes) {
          const diff = await tryGitDiff(ctx.workspacePath, change.path);
          const rel = path.relative(ctx.workspacePath, change.path);
          ctx.fileChange(rel || change.path, mapFileAction(change.kind), diff);
        }
      } else if (item.type === "error") {
        ctx.log(`[codex] ${item.message ?? "unknown error"}`);
      }
      break;
    }
    case "turn.completed":
      ctx.setStatus("review");
      break;
    case "turn.failed":
      ctx.log(`[codex] turn failed: ${evt.error?.message ?? JSON.stringify(evt.error ?? evt)}`);
      ctx.setStatus("failed");
      break;
    case "error":
      ctx.log(`[codex] ${evt.message ?? JSON.stringify(evt)}`);
      break;
    default:
      break; // turn.started 等无需展示的事件
  }
}

async function dispatch(ctx: TaskRuntimeContext, input: TurnInput, resumeSessionId: string | null): Promise<void> {
  const text = input.text;
  const prompt = buildWorkspacePrompt(ctx.workspacePath, text, ctx.workspacePrompt, ctx.workspaceKnowledge, input.images, ctx.workspaceAccessPaths);
  const risk = scanRisk(text);
  if (risk && shouldGate(risk.riskLevel, ctx.permissionMode)) {
    ctx.log(`检测到潜在高风险内容（${risk.reason}），先进入审批队列再派发给 Codex`);
    const decision = await ctx.requestApproval({
      command: text,
      cwd: ctx.workspacePath,
      riskLevel: risk.riskLevel,
      reason: risk.reason,
    });
    if (decision.decision === "deny") {
      ctx.agentMessage(`已取消派发给 Codex（原因：${decision.note ?? "用户拒绝"}）。`);
      ctx.setStatus("review");
      return;
    }
  }

  if (ctx.mcpServers.length) {
    await ensureCodexMcpServersRegistered(ctx.mcpServers, ctx.log);
    ctx.log(`已确保 MCP 在 Codex 注册: ${ctx.mcpServers.map((s) => s.name).join(", ")}`);
  }

  const imageArgs = input.images.flatMap((img) => ["--image", img]);
  if (input.images.length) ctx.log(`附带 ${input.images.length} 张图片：${input.images.join(", ")}`);
  const resolvedModel = resolveCodexModel(ctx.model);
  if (resolvedModel.model && !ctx.model) {
    ctx.log(
      resolvedModel.fallbackFrom
        ? `Codex 配置里的默认模型 ${resolvedModel.fallbackFrom} 已不可用，这一轮改用当前可用的第一个模型 ${resolvedModel.model}`
        : `Codex 配置里没有默认模型，这一轮用当前可用的第一个模型 ${resolvedModel.model}`
    );
  }
  const modelArgs = resolvedModel.model ? ["-m", resolvedModel.model] : [];
  if (!ctx.model) {
    const used = resolvedModel.model ?? readCodexDefaultModel();
    if (used) ctx.reportModel?.(used);
  }
  const extraDirs = additionalWorkspaceDirs(ctx);
  const addDirArgs = extraDirs.flatMap((dir) => ["--add-dir", dir]);

  // 权限等级映射到 Codex 真实的 --sandbox / --approve-for-me / --dangerously-bypass-approvals-and-sandbox。
  // 计划模式压过权限等级：一律 read-only 沙箱、不带任何跳过审批的参数。
  const sandboxMode = ctx.planMode ? "read-only" : ctx.permissionMode === "full" ? "danger-full-access" : config.codex.sandboxMode;
  const permissionArgs = ctx.planMode
    ? []
    : ctx.permissionMode === "auto"
      ? ["--approve-for-me"]
      : ctx.permissionMode === "full"
        ? ["--dangerously-bypass-approvals-and-sandbox"]
        : [];
  if (ctx.planMode) ctx.log("计划模式：Codex 以 read-only 沙箱运行，这一轮不会改文件");
  if (ctx.permissionMode !== "supervised" && !ctx.planMode) {
    ctx.log(`权限等级: ${ctx.permissionMode}${ctx.permissionMode === "full" ? "（完全访问，无沙箱限制）" : ""}`);
  }
  if (extraDirs.length && !resumeSessionId) {
    ctx.log(`额外允许目录: ${extraDirs.join(", ")}`);
  }

  // --skip-git-repo-check 在 `resume` 子命令自己的 --help 里没列出来，但实测不加会直接报
  // "Not inside a trusted directory and --skip-git-repo-check was not specified" 并以 exit code 1
  // 退出、不产生任何事件——之前漏加了，续接对话时百分之百会炸。
  // 把多行 prompt 从 stdin 送进去，而不是当命令行参数传给 codex。
  // Windows 上 npm 安装的 codex 通常是 shim：.ps1 会被 -C/--cd 触发参数绑定问题；
  // .cmd 又容易把带空格的 -C 路径拆坏。这里不传 -C，直接用 spawn cwd 进入工作区。
  // `codex exec ... -` / `codex exec resume ... -` 是官方支持的 stdin prompt 形式。
  // 实测 `exec resume` 不沿用原会话的沙箱，而是取 Codex 自己的默认配置，所以计划模式下续接要显式压成 read-only。
  const resumePermissionArgs = ctx.planMode
    ? ["-c", 'sandbox_mode="read-only"']
    : ctx.permissionMode === "full"
      ? ["--dangerously-bypass-approvals-and-sandbox"]
      : [];
  // --approve-for-me 自带 workspace-write 沙箱，codex 0.154 起不允许再同时传 --sandbox（会直接 exit 2、不产生任何事件）。
  const approveForMe = permissionArgs.includes("--approve-for-me");
  const args = resumeSessionId
    ? ["exec", "resume", "--json", "--skip-git-repo-check", ...imageArgs, ...modelArgs, ...resumePermissionArgs, resumeSessionId, "-"]
    : [
        "exec",
        ...(approveForMe ? [] : ["--sandbox", sandboxMode]),
        "--skip-git-repo-check",
        "--json",
        ...addDirArgs,
        ...imageArgs,
        ...modelArgs,
        ...permissionArgs,
        "-",
      ];

  ctx.log(`沙箱模式: ${approveForMe ? "workspace-write（--approve-for-me 自带）" : sandboxMode}`);
  ctx.terminal(`$ codex ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")} < prompt\n`);
  ctx.setStatus("running");

  await new Promise<void>((resolve) => {
    const child = spawnCli(config.codex.bin, args, { cwd: ctx.workspacePath, preferCmdShim: true });
    child.stdin!.end(prompt);

    let buffer = "";
    let sawItem = false;
    let stoppedReason: string | null = null;
    const pendingLines: Promise<void>[] = [];
    const cleanupRunningProcess = () => {
      if (runningCodexProcesses.get(runtimeKeyOf(ctx))?.child === child) runningCodexProcesses.delete(runtimeKeyOf(ctx));
    };
    runningCodexProcesses.set(runtimeKeyOf(ctx), {
      child,
      kill: (reason: string) => {
        stoppedReason = reason;
        killProcessTree(child);
      },
    });

    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim()) sawItem = true;
        pendingLines.push(handleLine(ctx, line));
      }
    });
    let stderrBuf = "";
    child.stderr!.on("data", (d: Buffer) => {
      const text = d.toString("utf8").trim();
      if (text) {
        stderrBuf += text + "\n";
        ctx.log(`[codex:stderr] ${text.slice(0, 500)}`);
      }
    });

    const timeout = setTimeout(() => {
      killProcessTree(child);
      ctx.log(`codex 命令超时（${config.codex.timeoutSec}s），已终止进程`);
    }, config.codex.timeoutSec * 1000);

    child.on("error", (err) => {
      clearTimeout(timeout);
      cleanupRunningProcess();
      if (isMissingBinaryError(err)) {
        ctx.agentMessage(
          `Codex adapter 尚未接通：未在本机 PATH 中找到 "${config.codex.bin}"。\n` +
            `安装：npm install -g @openai/codex ，然后 codex login 完成登录。`
        );
      } else {
        ctx.agentMessage(`调用 Codex 失败：${err.message}`);
      }
      ctx.setStatus("failed");
      resolve();
    });

    child.on("close", async (code) => {
      clearTimeout(timeout);
      cleanupRunningProcess();
      if (buffer.trim()) pendingLines.push(handleLine(ctx, buffer));
      await Promise.all(pendingLines);
      if (stoppedReason) {
        ctx.log(`codex 进程已停止：${stoppedReason}`);
        resolve();
        return;
      }
      if (code !== 0 && !sawItem) {
        // stderr 里通常就是真实原因（信任目录检查、登录过期、参数错误……），直接原文带给用户，
        // 不要武断猜是"没登录"——之前这里写死猜登录问题，掩盖了真实报错，排查全靠事后翻日志。
        const detail = stderrBuf.trim() || "（没有 stderr 输出）";
        ctx.agentMessage(`Codex 调用失败（exit code ${code}），且未收到任何事件。\n\n真实报错：\n${detail}`);
        ctx.setStatus("failed");
      } else if (code !== 0) {
        ctx.log(`codex 进程退出码 ${code}`);
      }
      resolve();
    });
  });
}

export class CodexAdapter implements AgentAdapter {
  readonly kind = "codex" as const;
  readonly enforcesPlanMode = true as const;
  readonly name = "Codex";
  readonly description = "通过 `codex exec --json`（真实 OS 沙箱）驱动任务";
  readonly supportsMcp = true as const;

  isConfigured() {
    return cliAvailable(config.codex.bin, { preferCmdShim: true });
  }
  configHint() {
    return `使用 CODEX_BIN="${config.codex.bin}"，沙箱模式=${config.codex.sandboxMode}；需要本机已 npm i -g @openai/codex 并 codex login`;
  }
  async discoverWorkspaces() {
    return [];
  }

  defaultModel(): string | null {
    // 界面上显示的"默认模型"要和实际会用的一致：配置里的默认已下架时显示改用的那个。
    return resolveCodexModel(null).model ?? readCodexDefaultModel();
  }

  async listModels(): Promise<ModelOption[]> {
    return readCodexModelsCache();
  }

  async getUsageSummary(): Promise<string | null> {
    const snapshot = findLatestRateLimitSnapshot();
    if (!snapshot) {
      return "Codex 额度\n暂无本机额度快照：请先运行一次 Codex 任务，或在 Codex CLI 活跃会话里输入 /status 查看。";
    }
    return formatCodexRateLimitSnapshot(snapshot);
  }

  async run(ctx: TaskRuntimeContext, input: TurnInput): Promise<void> {
    await dispatch(ctx, input, null);
  }

  async continueTask(ctx: TaskRuntimeContext, input: TurnInput): Promise<void> {
    await dispatch(ctx, input, ctx.sessionKey);
  }

  async stop(ctx: TaskRuntimeContext): Promise<void> {
    const running = runningCodexProcesses.get(runtimeKeyOf(ctx));
    if (running) {
      ctx.log("正在终止 Codex 进程树...");
      running.kill("用户停止");
    }
    ctx.setStatus("stopped");
  }

  /**
   * 一次性问答用：只读沙箱、不绑定真实 Task，直接拿 agent_message 文本。
   * 不经过审批闸门——纯文本规划请求，--sandbox read-only 已经限制了它不能改文件/跑危险命令。
   * 查不到/失败返回 null。
   */
  async ask(prompt: string, options?: { model?: string | null; mcpServers?: McpServerSpec[] }): Promise<string | null> {
    if (options?.mcpServers?.length) {
      await ensureCodexMcpServersRegistered(options.mcpServers, (message) => console.warn(`[codex ask mcp] ${message}`));
    }
    const args = ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--json"];
    const askModel = resolveCodexModel(options?.model).model;
    if (askModel) args.push("-m", askModel);
    args.push("-");
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnCli(config.codex.bin, args, { cwd: process.cwd(), preferCmdShim: true });
      } catch (err) {
        reject(new Error(`启动 Codex 失败：${(err as Error).message}`));
        return;
      }
      child.stdin!.end(prompt);
      let buffer = "";
      let reply = "";
      let stderr = "";
      let failure: string | null = null;
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        fn();
      };
      child.stdout!.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line.startsWith("{")) continue;
          try {
            const evt = JSON.parse(line);
            if (evt.type === "item.completed" && evt.item?.type === "agent_message" && evt.item.text) {
              reply += evt.item.text;
            } else if (evt.type === "turn.failed") {
              failure = evt.error?.message ?? JSON.stringify(evt.error ?? evt);
            } else if (evt.type === "error" && evt.message) {
              failure = String(evt.message);
            }
          } catch {
            // 忽略解析失败的行
          }
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      const timeout = setTimeout(() => {
        child.kill();
        finish(() => (reply.trim() ? resolve(reply) : reject(new Error(`Codex ${ASK_TIMEOUT_SEC} 秒内没有回复，已超时`))));
      }, ASK_TIMEOUT_MS);
      child.on("error", (err) => finish(() => reject(new Error(`启动 Codex 失败：${err.message}`))));
      child.on("close", (code) => {
        finish(() => {
          if (reply.trim()) resolve(reply);
          else if (failure) reject(new Error(`Codex 调用失败：${failure}`));
          else if (code !== 0) reject(cliAskError("Codex", code, stderr));
          else resolve(null);
        });
      });
    });
  }
}
