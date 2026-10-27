import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.ts";
import { scanRisk, shouldGate } from "./riskPolicy.ts";
import { cliAvailable, killProcessTree, resolveCliBinary, spawnCli } from "./winSpawn.ts";
import { buildWorkspacePrompt } from "./workspacePrompt.ts";
import type { AgentAdapter, McpServerSpec, TaskRuntimeContext, TurnInput } from "./types.ts";
import { runtimeKeyOf } from "./types.ts";
import type { AgentAccountInfo, ModelOption } from "../types.ts";
import { readAntigravityAccountInfo } from "../services/antigravityAccountService.ts";
import { ASK_TIMEOUT_MS, ASK_TIMEOUT_SEC, cliAskError } from "./askErrors.ts";

const runningAntigravityProcesses = new Map<string, { child: ChildProcess; kill: (reason: string) => void }>();

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

function isMissingBinaryOutput(text: string): boolean {
  return /not recognized as an internal or external command|not recognized as a name of a cmdlet|command not found|not found|ENOENT|不是内部或外部命令|无法将.+识别为/i.test(
    text
  );
}

function looksUnauthenticated(text: string): boolean {
  return /authentication required|sign in|login|not authenticated|unauthorized|expired/i.test(text);
}

function quoteForLog(arg: string): string {
  return /[\s"]/u.test(arg) ? JSON.stringify(arg) : arg;
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

function executableExists(bin: string): boolean {
  if (!bin.trim()) return false;
  if (path.isAbsolute(bin) || bin.includes("\\") || bin.includes("/")) return fs.existsSync(bin);

  const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  for (const dir of pathDirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, bin.endsWith(ext.toLowerCase()) || bin.endsWith(ext.toUpperCase()) ? bin : `${bin}${ext}`);
      if (fs.existsSync(candidate)) return true;
    }
  }
  return false;
}

function runAgy(args: string[], cwd: string, timeoutMs: number): Promise<CliResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnCli(config.antigravity.bin, args, { cwd });
    } catch (err) {
      resolve({ code: null, stdout: "", stderr: "", error: err as Error });
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr?.on("data", (d) => (stderr += d.toString("utf8")));

    const timeout = setTimeout(() => {
      child.kill();
      resolve({ code: null, stdout, stderr: `${stderr}\nAntigravity CLI 命令超时。`.trim() });
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ code: null, stdout, stderr, error });
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

// agy 跟 Codex 一样没有按次传 MCP 配置的参数，只能 `agy mcp add` 持久注册（全机生效，名字带 agenthub- 前缀，
// 不碰用户自己配的条目）。`agy mcp add` 本身是"新增或更新"，不用先 list；按完整配置缓存，
// 用户在 AgentHub 里改了命令/参数会重新 add 覆盖，没改的每轮直接跳过，省掉每次 spawn 的延迟。
const registeredAgyMcpSpecs = new Set<string>();

async function ensureAgyMcpServersRegistered(servers: McpServerSpec[], log: (message: string) => void): Promise<void> {
  for (const server of servers) {
    const key = JSON.stringify(server);
    if (registeredAgyMcpSpecs.has(key)) continue;
    const args = ["mcp", "add"];
    if (server.transport === "http") {
      if (!server.url) continue;
      for (const [name, value] of Object.entries(server.headers ?? {})) args.push("--header", `${name}: ${value}`);
      args.push("--type", "http", server.name, server.url);
    } else {
      if (!server.command) continue;
      for (const [name, value] of Object.entries(server.env ?? {})) args.push("--env", `${name}=${value}`);
      args.push(server.name, "--", server.command, ...(server.args ?? []));
    }
    const result = await runAgy(args, process.cwd(), 30_000);
    if (result.error || result.code !== 0) {
      log(`[mcp] 注册 "${server.name}" 到 Antigravity 失败：${(result.stderr || result.error?.message || `exit ${result.code}`).trim()}`);
    } else {
      registeredAgyMcpSpecs.add(key);
    }
  }
}

/**
 * PowerShell 单引号字符串：里面不做任何转义，只有单引号要写两遍。以前这里用 JSON.stringify（反斜杠转义），
 * PowerShell 不认，脚本一启动就解析失败，agy 根本没跑起来，额度快照因此一直停在旧时间。
 */
export function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Start-Process 会把参数数组直接用空格拼起来，带空格或引号的参数要按 Windows 命令行规则包一层引号。 */
export function windowsArg(value: string): string {
  if (value && !/[\s"]/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

export function runAgyHidden(args: string[], cwd: string, timeoutMs: number): Promise<CliResult> {
  if (process.platform !== "win32") return runAgy(args, cwd, timeoutMs);

  return new Promise((resolve) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "xgent-agy-"));
    const stdoutFile = path.join(tempDir, "stdout.txt");
    const stderrFile = path.join(tempDir, "stderr.txt");
    const resolvedBin = resolveCliBinary(config.antigravity.bin, { preferCmdShim: true }) ?? config.antigravity.bin;
    const script = `
$ErrorActionPreference = 'Stop'
$bin = ${psLiteral(resolvedBin)}
$cwd = ${psLiteral(cwd)}
$out = ${psLiteral(stdoutFile)}
$err = ${psLiteral(stderrFile)}
$argList = @(${args.map((arg) => psLiteral(windowsArg(arg))).join(", ")})
$process = Start-Process -FilePath $bin -ArgumentList $argList -WorkingDirectory $cwd -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err -Wait -PassThru
Write-Output $process.ExitCode
`;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const child = nodeSpawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { windowsHide: true }
    );

    let psStdout = "";
    let psStderr = "";
    let settled = false;
    const finish = (fallbackCode: number | null, error?: Error) => {
      if (settled) return;
      settled = true;
      let stdout = "";
      let stderr = psStderr;
      try {
        if (fs.existsSync(stdoutFile)) stdout = fs.readFileSync(stdoutFile, "utf8");
        if (fs.existsSync(stderrFile)) stderr = `${stderr}\n${fs.readFileSync(stderrFile, "utf8")}`.trim();
      } catch {
        // Ignore temp-file races while the child is exiting.
      }
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
      const parsedCode = Number.parseInt(psStdout.trim().split(/\r?\n/).pop() ?? "", 10);
      resolve({ code: Number.isFinite(parsedCode) ? parsedCode : fallbackCode, stdout, stderr, error });
    };

    child.stdout?.on("data", (chunk) => (psStdout += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk) => (psStderr += chunk.toString("utf8")));
    child.on("error", (error) => finish(null, error));
    const timeout = setTimeout(() => {
      child.kill();
      finish(null, undefined);
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timeout);
      finish(code);
    });
  });
}

function parseListOutput(stdout: string): ModelOption[] {
  const clean = stripAnsi(stdout);

  // 尝试 JSON 格式
  try {
    const parsed = JSON.parse(clean);
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => {
          if (typeof item === "string") return { id: item, label: item };
          const id = item?.id ?? item?.slug ?? item?.name ?? item?.key;
          const label = item?.label ?? item?.displayName ?? item?.display_name ?? item?.name ?? id;
          return typeof id === "string" ? { id, label: String(label) } : null;
        })
        .filter(Boolean) as ModelOption[];
    }
  } catch {
    // 非 JSON，走纯文本解析
  }

  return clean
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    // 过滤掉进度提示行、表头行、按钮行
    .filter((line) => !/^(available|model|agent|slug|name|fetching|\[button:)/i.test(line))
    .map((line) => line.replace(/^[*•-]\s*/, ""))
    .map((line) => {
      // agy models 实际输出格式："gemini-3.8-flash-high\tGemini 3.8 Flash (High)"
      const tabIdx = line.indexOf("\t");
      if (tabIdx > 0) {
        const id = line.slice(0, tabIdx).trim();
        const label = line.slice(tabIdx + 1).trim();
        if (id && /^[\w./:@-]+$/u.test(id)) return { id, label: label || id };
      }
      // 两个以上空格分隔
      const wide = line.match(/^(\S+)\s{2,}(.+)$/);
      if (wide) return { id: wide[1], label: `${wide[2].trim()} (${wide[1]})` };
      // 单 token
      const parts = line.split(/\s+/);
      const id = parts[0];
      if (!id || !/^[\w./:@-]+$/u.test(id)) return null;
      return { id, label: line === id ? id : `${line.slice(id.length).trim()} (${id})` };
    })
    .filter(Boolean) as ModelOption[];
}

export function summarizeUsageText(title: string, text: string): string | null {
  const lines = stripAnsi(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\[button:/i.test(line));
  const translated = lines.map(translateUsageLine);
  const clean = translated.join("\n").trim();
  if (!clean) return null;
  return `${title}\n${clean.slice(0, 1200)}`;
}

function translateUsageLine(line: string): string {
  const columns = line
    .split(/\t+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (columns.length >= 4) {
    const [rawFamily, rawMetric, value, resetAt] = columns;
    const family = translateModelFamily(rawFamily);
    // 新模型的指标名会带上模型名，比如 "Gemini 4 Argon Weekly Limit"：去掉重复的模型名再翻译。
    const ownMetric = rawMetric.toLowerCase().startsWith(rawFamily.toLowerCase()) ? rawMetric.slice(rawFamily.length).trim() : rawMetric;
    const metric = translateUsageMetric(ownMetric);
    const reset = formatResetTime(resetAt);
    return reset ? `${family}：${metric} ${value}，${reset} 重置` : `${family}：${metric} ${value}`;
  }

  if (columns.length >= 2) {
    const [rawMetric, value] = columns;
    const metric = translateUsageMetric(rawMetric);
    if (/^https?:\/\//i.test(value)) return `${metric}：${value}`;
    return `${metric}：${value}`;
  }

  return translateUsageMetric(line);
}

function translateModelFamily(raw: string): string {
  const normalized = raw.toLowerCase();
  if (normalized === "gemini models") return "Gemini 模型";
  if (normalized === "claude and gpt models") return "Claude/GPT 模型";
  return raw;
}

function translateUsageMetric(raw: string): string {
  const normalized = raw.toLowerCase();
  const translations: Record<string, string> = {
    "weekly limit remaining": "本周额度剩余",
    "five hour limit remaining": "5 小时额度剩余",
    "weekly limit": "本周额度剩余",
    "five hour limit": "5 小时额度剩余",
    "remaining credits": "剩余点数",
    upgrade: "升级链接",
  };
  return translations[normalized] ?? raw;
}

function formatResetTime(raw: string): string | null {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw || null;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

async function runSlashReport(command: "/usage" | "/credits"): Promise<CliResult> {
  // 在后台跑，不卡界面；agy 单次查询本身就要 8~10 秒，三条同时跑时更慢，JS 侧给 30 秒。
  return runAgyHidden(["-p", command, "--print-timeout", "10s"], process.cwd(), 30_000);
}

const ANTIGRAVITY_USAGE_CACHE_DIR = path.join(config.dataDir, "usage-cache");
const ANTIGRAVITY_USAGE_CACHE_FILE = path.join(ANTIGRAVITY_USAGE_CACHE_DIR, "antigravity.json");
const USAGE_BACKGROUND_REFRESH_INTERVAL_MS = 60_000;
let pendingUsageRefresh: Promise<void> | null = null;
let lastUsageRefreshStartedAt = 0;

const ANTIGRAVITY_FALLBACK_MODELS: ModelOption[] = [
  { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
  { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
  { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
  { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)" },
  { id: "gemini-3.7-flash-medium", label: "Gemini 3.7 Flash (Medium)" },
  { id: "gemini-3.7-flash-low", label: "Gemini 3.7 Flash (Low)" },
  { id: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash (High)" },
  { id: "gemini-3.6-flash-medium", label: "Gemini 3.6 Flash (Medium)" },
  { id: "gemini-3.6-flash-low", label: "Gemini 3.6 Flash (Low)" },
  { id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" },
  { id: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (Low)" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
  { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)" },
  { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
];

interface AntigravityUsageSnapshot {
  timestamp: string;
  summary: string;
  models?: ModelOption[];
}

function formatSnapshotTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function readUsageSnapshot(): AntigravityUsageSnapshot | null {
  try {
    if (!fs.existsSync(ANTIGRAVITY_USAGE_CACHE_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(ANTIGRAVITY_USAGE_CACHE_FILE, "utf8")) as AntigravityUsageSnapshot;
    if (!parsed?.timestamp || !parsed?.summary) return null;
    if (parsed.models && !Array.isArray(parsed.models)) parsed.models = [];
    return parsed;
  } catch {
    return null;
  }
}

function writeUsageSnapshot(summary: string, models?: ModelOption[]): void {
  const previous = readUsageSnapshot();
  const nextModels = models && models.length > 0 ? models : previous?.models?.length ? previous.models : ANTIGRAVITY_FALLBACK_MODELS;
  const snapshot: AntigravityUsageSnapshot = {
    timestamp: new Date().toISOString(),
    summary,
    models: nextModels,
  };
  fs.mkdirSync(ANTIGRAVITY_USAGE_CACHE_DIR, { recursive: true });
  fs.writeFileSync(ANTIGRAVITY_USAGE_CACHE_FILE, JSON.stringify(snapshot, null, 2), "utf8");
}

async function collectModelsSnapshot(): Promise<ModelOption[]> {
  const result = await runAgyHidden(["models"], process.cwd(), 30_000);
  if (result.error) return [];
  return parseListOutput(result.stdout);
}

async function collectUsageSnapshot(): Promise<AntigravityUsageSnapshot | null> {
  const [usage, credits, models] = await Promise.all([runSlashReport("/usage"), runSlashReport("/credits"), collectModelsSnapshot()]);
  const combinedOutput = `${usage.stdout}\n${usage.stderr}\n${usage.error?.message ?? ""}\n${credits.stdout}\n${credits.stderr}\n${credits.error?.message ?? ""}`;
  if (isMissingBinaryOutput(combinedOutput)) {
    return { timestamp: new Date().toISOString(), summary: "找不到 Antigravity CLI：请先安装 agy，或在配置里设置 ANTIGRAVITY_BIN。", models };
  }
  if (looksUnauthenticated(combinedOutput)) {
    return { timestamp: new Date().toISOString(), summary: "Antigravity CLI 尚未登录：请先在终端运行 agy 完成登录。", models };
  }
  if (usage.code !== 0 && credits.code !== 0 && !combinedOutput.trim()) {
    return { timestamp: new Date().toISOString(), summary: "Antigravity CLI 没有返回用量信息：请确认 agy 已安装并已登录。", models };
  }

  const usagePart = usage.stdout.trim() ? summarizeUsageText("模型额度", usage.stdout) : null;
  const creditsPart = credits.stdout.trim() ? summarizeUsageText("AI 点数", credits.stdout) : null;
  const parts = [usagePart, creditsPart].filter(Boolean);
  const summary = parts.length ? parts.join("\n\n") : null;
  if (!summary) return null;
  return { timestamp: new Date().toISOString(), summary, models };
}

function refreshUsageSnapshotInBackground(): void {
  if (pendingUsageRefresh) return;
  const now = Date.now();
  if (now - lastUsageRefreshStartedAt < USAGE_BACKGROUND_REFRESH_INTERVAL_MS) return;
  lastUsageRefreshStartedAt = now;
  pendingUsageRefresh = collectUsageSnapshot()
    .then((snapshot) => {
      if (snapshot) writeUsageSnapshot(snapshot.summary, snapshot.models);
    })
    .catch(() => undefined)
    .finally(() => {
      pendingUsageRefresh = null;
    });
}

function createStreamHandler(ctx: TaskRuntimeContext) {
  let streamedResponse = "";
  let sawResult = false;
  let finalStatus: "review" | "failed" | null = null;
  // headless 模式没法弹窗问权限：需要权限的工具调用会被自动拒绝。记下来，结果为空时据此判失败而不是当成功。
  let deniedTool: string | null = null;

  function setConversationId(value: unknown) {
    if (typeof value === "string" && value) ctx.setSessionKey(value);
  }

  function handleLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;

    let evt: any;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      ctx.terminal(`${line}\n`);
      return;
    }

    if (evt.event === "init") {
      setConversationId(evt.conversation_id);
      const init = evt.init ?? {};
      if (typeof init.model === "string" && init.model) ctx.reportModel?.(init.model);
      const model = init.model ? ` model=${init.model}` : "";
      const permission = init.permission_mode ? ` permission=${init.permission_mode}` : "";
      ctx.log(`[antigravity] started${model}${permission}`);
      return;
    }

    if (evt.event === "step_update") {
      const step = evt.step_update ?? {};
      setConversationId(step.conversation_id);
      if (typeof step.text_delta === "string" && step.text_delta) {
        streamedResponse += step.text_delta;
        ctx.terminal(step.text_delta);
      }
      if (step.step_type === "tool" || step.tool_info) {
        const tool = step.tool_info ?? {};
        const name = step.tool_name ?? tool.name ?? "tool";
        const params = tool.parameters ? ` ${JSON.stringify(tool.parameters)}` : "";
        const output = typeof tool.output === "string" && tool.output ? `\n${tool.output}` : "";
        const error = tool.error ? `\nERROR: ${typeof tool.error === "string" ? tool.error : JSON.stringify(tool.error)}` : "";
        if (/permission check failed|denied permission/i.test(error)) deniedTool = name;
        ctx.terminal(`\n$ [antigravity:${name}]${params}${output}${error}\n`);
      }
      if (step.subagent_info) ctx.terminal(`\n[antigravity:subagents] ${JSON.stringify(step.subagent_info)}\n`);
      return;
    }

    if (evt.event === "result") {
      sawResult = true;
      const result = evt.result ?? {};
      setConversationId(result.conversation_id);
      const status = String(result.status ?? "").toUpperCase();
      const response = String(result.response || streamedResponse || "").trim();
      if (status === "SUCCESS" && !response && deniedTool) {
        // 什么都没做成：不能标成"待复核"，否则并行 / 自动执行会当它完成了继续往下走。
        ctx.agentMessage(
          `Antigravity 没有完成这一步：它需要执行「${deniedTool}」这类操作，但无界面模式没法询问权限，被自动拒绝了。\n` +
            "这个任务改用「完全访问权限」再跑，或者在 Antigravity 的 settings.json 里给这类操作加允许规则（permissions.allow）。"
        );
        ctx.setStatus("failed");
        finalStatus = "failed";
      } else if (status === "SUCCESS") {
        ctx.agentMessage(response || "(空响应)");
        if (result.usage) ctx.log(`[antigravity] usage ${JSON.stringify(result.usage)}`);
        ctx.setStatus("review");
        finalStatus = "review";
      } else {
        const error = result.error ? String(result.error) : `Antigravity 返回状态 ${status || "UNKNOWN"}`;
        ctx.agentMessage(`Antigravity 调用失败：\n${error}`);
        ctx.setStatus("failed");
        finalStatus = "failed";
      }
      return;
    }

    ctx.log(`[antigravity] ${trimmed.slice(0, 500)}`);
  }

  function finish(code: number | null, stderr: string) {
    if (stderr.trim()) ctx.terminal(stripAnsi(stderr));
    if (sawResult) return finalStatus;
    if (streamedResponse.trim() && code === 0) {
      ctx.agentMessage(streamedResponse);
      ctx.setStatus("review");
      return "review";
    }
    return null;
  }

  return { handleLine, finish };
}

async function dispatch(ctx: TaskRuntimeContext, input: TurnInput, resumeConversationId: string | null): Promise<void> {
  const text = input.text;
  if (input.images.length) ctx.log(`Antigravity CLI headless 模式暂不支持原生图片附件，已把 ${input.images.length} 张图片路径写入提示词作为兜底`);

  const risk = scanRisk(text);
  if (risk && shouldGate(risk.riskLevel, ctx.permissionMode)) {
    ctx.log(`检测到潜在高风险内容（${risk.reason}），先进入审批队列再派发给 Antigravity`);
    const decision = await ctx.requestApproval({
      command: text,
      cwd: ctx.workspacePath,
      riskLevel: risk.riskLevel,
      reason: risk.reason,
    });
    if (decision.decision === "deny") {
      ctx.agentMessage(`已取消派发给 Antigravity（原因：${decision.note ?? "用户拒绝"}）。`);
      ctx.setStatus("review");
      return;
    }
  }

  const prompt = buildWorkspacePrompt(ctx.workspacePath, text, ctx.workspacePrompt, ctx.workspaceKnowledge, input.images, ctx.workspaceAccessPaths);
  const extraDirs = additionalWorkspaceDirs(ctx);
  const args = [
    "--add-dir",
    ctx.workspacePath,
    ...extraDirs.flatMap((dir) => ["--add-dir", dir]),
    "--output-format",
    "stream-json",
    "--print-timeout",
    config.antigravity.printTimeout,
    "-p",
    prompt,
  ];
  const model = ctx.model || config.antigravity.defaultModel;
  if (model) args.push("--model", model);
  if (config.antigravity.effort) args.push("--effort", config.antigravity.effort);
  if (resumeConversationId) args.push("--conversation", resumeConversationId);
  if (ctx.permissionMode === "full") args.push("--dangerously-skip-permissions");
  if (ctx.permissionMode === "auto") {
    ctx.log("Antigravity CLI headless 模式没有 Codex 那种选择性自动审批；此处沿用 CLI/settings 里的权限策略。需要完全自动执行时请选择“完全访问权限”。");
  }
  if (extraDirs.length) ctx.log(`额外允许目录: ${extraDirs.join(", ")}`);

  ctx.terminal(`$ ${config.antigravity.bin} ${args.map(quoteForLog).join(" ")}\n`);
  ctx.setStatus("running");

  if (ctx.mcpServers.length && executableExists(config.antigravity.bin)) {
    await ensureAgyMcpServersRegistered(ctx.mcpServers, ctx.log);
    ctx.log(`已确保 MCP 在 Antigravity 注册: ${ctx.mcpServers.map((s) => s.name).join(", ")}`);
  }

  if (!executableExists(config.antigravity.bin)) {
    ctx.agentMessage(
      `Antigravity adapter 尚未接通：未在本机 PATH 中找到 "${config.antigravity.bin}"。\n` +
        `安装 Antigravity CLI 后运行 agy 完成登录，或在左侧 Antigravity 配置里把 ANTIGRAVITY_BIN 改成 agy.exe 的完整路径。`
    );
    ctx.setStatus("failed");
    return;
  }

  await new Promise<void>((resolve) => {
    let child;
    try {
      child = spawnCli(config.antigravity.bin, args, { cwd: ctx.workspacePath });
    } catch (err) {
      ctx.agentMessage(`无法启动 Antigravity CLI：${(err as Error).message}`);
      ctx.setStatus("failed");
      resolve();
      return;
    }

    child.stdin?.end();
    const handler = createStreamHandler(ctx);
    let buffer = "";
    let stderr = "";
    let stoppedReason: string | null = null;
    const cleanupRunningProcess = () => {
      if (runningAntigravityProcesses.get(runtimeKeyOf(ctx))?.child === child) runningAntigravityProcesses.delete(runtimeKeyOf(ctx));
    };
    runningAntigravityProcesses.set(runtimeKeyOf(ctx), {
      child,
      kill: (reason: string) => {
        stoppedReason = reason;
        killProcessTree(child!);
      },
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        handler.handleLine(line);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const timeout = setTimeout(() => {
      killProcessTree(child!);
      stderr += `\nAntigravity CLI 命令超时（${config.antigravity.timeoutSec}s），已终止进程。\n`;
    }, config.antigravity.timeoutSec * 1000);

    child.on("error", (err) => {
      clearTimeout(timeout);
      cleanupRunningProcess();
      ctx.agentMessage(`无法启动 Antigravity CLI：${err.message}`);
      ctx.setStatus("failed");
      resolve();
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      cleanupRunningProcess();
      if (stoppedReason) {
        ctx.log(`antigravity 进程已停止：${stoppedReason}`);
        resolve();
        return;
      }
      if (buffer.trim()) handler.handleLine(buffer);
      const status = handler.finish(code, stderr);
      const combined = `${stderr}\n${buffer}`;
      if (!status) {
        if (isMissingBinaryOutput(combined)) {
          ctx.agentMessage(
            `Antigravity adapter 尚未接通：未在本机 PATH 中找到 "${config.antigravity.bin}"。\n` +
              `安装 Antigravity CLI 后运行 agy 完成登录，或在左侧 Antigravity 配置里把 ANTIGRAVITY_BIN 改成 agy.exe 的完整路径。`
          );
        } else if (looksUnauthenticated(combined)) {
          ctx.agentMessage("Antigravity CLI 需要先登录：请在终端运行 `agy`，按浏览器提示完成登录后再回来创建任务。");
        } else {
          ctx.agentMessage(`Antigravity 调用失败（exit code ${code ?? "unknown"}）：\n${stripAnsi(stderr || buffer).trim() || "没有输出"}`);
        }
        ctx.setStatus("failed");
      } else if (code !== 0 && status === "review") {
        ctx.log(`antigravity 进程退出码 ${code}`);
      }
      resolve();
    });
  });
}

export class AntigravityAdapter implements AgentAdapter {
  readonly kind = "antigravity" as const;
  readonly name = "Antigravity";
  readonly description = "通过本机 agy CLI 的 headless 模式驱动 Antigravity agent";
  readonly supportsMcp = true as const;

  account(): AgentAccountInfo {
    return readAntigravityAccountInfo();
  }

  isConfigured() {
    return cliAvailable(config.antigravity.bin);
  }

  configHint() {
    return `使用 ANTIGRAVITY_BIN="${config.antigravity.bin}"；需要本机安装 Antigravity CLI 并运行 agy 完成登录`;
  }

  async discoverWorkspaces() {
    return [];
  }

  defaultModel(): string | null {
    return config.antigravity.defaultModel || null;
  }

  async listModels(): Promise<ModelOption[]> {
    if (!executableExists(config.antigravity.bin)) return [];
    const snapshot = readUsageSnapshot();
    refreshUsageSnapshotInBackground();
    return snapshot?.models?.length ? snapshot.models : ANTIGRAVITY_FALLBACK_MODELS;
  }

  async getUsageSummary(): Promise<string | null> {
    if (!executableExists(config.antigravity.bin)) return `找不到 Antigravity CLI：请先安装 agy，或在配置里设置 ANTIGRAVITY_BIN。`;

    const snapshot = readUsageSnapshot();
    refreshUsageSnapshotInBackground();
    if (!snapshot) {
      return "Antigravity 额度\n暂无本地额度快照：已在后台刷新，请稍后再点一次查询用量。";
    }
    return `${snapshot.summary}\n\n快照时间：${formatSnapshotTime(snapshot.timestamp)}\n后台刷新：已触发`;
  }

  async run(ctx: TaskRuntimeContext, input: TurnInput): Promise<void> {
    await dispatch(ctx, input, null);
  }

  async continueTask(ctx: TaskRuntimeContext, input: TurnInput): Promise<void> {
    await dispatch(ctx, input, ctx.sessionKey);
  }

  async stop(ctx: TaskRuntimeContext): Promise<void> {
    const running = runningAntigravityProcesses.get(runtimeKeyOf(ctx));
    if (running) {
      ctx.log("正在终止 Antigravity 进程树...");
      running.kill("用户停止");
    }
    ctx.setStatus("stopped");
  }

  /** 一次性问答用：不带工作区、不写终端，直接拿 result 事件里的文本。失败时抛出带原因的错误。 */
  async ask(prompt: string, options?: { model?: string | null; mcpServers?: McpServerSpec[] }): Promise<string | null> {
    if (!executableExists(config.antigravity.bin)) throw new Error(`找不到 Antigravity CLI：${config.antigravity.bin}`);
    if (options?.mcpServers?.length) {
      await ensureAgyMcpServersRegistered(options.mcpServers, (message) => console.warn(`[antigravity ask mcp] ${message}`));
    }
    const args = ["--output-format", "stream-json", "--print-timeout", `${ASK_TIMEOUT_SEC}s`];
    const model = options?.model || config.antigravity.defaultModel;
    if (model) args.push("--model", model);
    args.push("-p", prompt);
    const result = await runAgy(args, process.cwd(), ASK_TIMEOUT_MS + 5_000);
    if (result.error) throw new Error(`启动 Antigravity 失败：${result.error.message}`);
    let reply: string | null = null;
    let failure: string | null = null;
    for (const line of result.stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const evt = JSON.parse(trimmed);
        if (evt.event !== "result") continue;
        const status = String(evt.result?.status ?? "").toUpperCase();
        if (status === "SUCCESS") reply = String(evt.result?.response ?? "") || reply;
        else failure = evt.result?.error ? String(evt.result.error) : `Antigravity 返回状态 ${status || "UNKNOWN"}`;
      } catch {
        // 忽略非 JSON 行
      }
    }
    if (reply?.trim()) return reply;
    if (failure) throw new Error(failure);
    if (result.code !== 0) throw cliAskError("Antigravity", result.code, result.stderr || result.stdout);
    return null;
  }
}
