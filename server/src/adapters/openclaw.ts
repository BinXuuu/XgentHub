import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { config } from "../config.ts";
import { scanRisk, shouldGate } from "./riskPolicy.ts";
import { cliAvailable, killProcessTree, resolveCliBinary, spawnCli } from "./winSpawn.ts";
import { buildWorkspacePrompt } from "./workspacePrompt.ts";
import type { AgentAdapter, McpServerSpec, TaskRuntimeContext, TurnInput } from "./types.ts";
import { runtimeKeyOf } from "./types.ts";
import type { ModelOption } from "../types.ts";
import { ASK_TIMEOUT_MS, ASK_TIMEOUT_SEC, cliAskError } from "./askErrors.ts";

interface OpenClawRunOptions {
  timeoutMs?: number;
  idleTimeoutMs?: number;
  taskId?: string;
  onStderr?: (chunk: string) => void;
}

interface OpenClawRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  stopped?: boolean;
}

const runningOpenClawProcesses = new Map<string, { child: ChildProcess; kill: (reason: string) => void }>();

function resolveOpenClawNodeEntry(): string | null {
  const candidates: string[] = [];
  const configuredBin = config.openclaw.bin.trim();
  const resolvedBin = configuredBin ? resolveCliBinary(configuredBin) : null;

  const addCandidate = (candidate: string | undefined | null) => {
    if (!candidate) return;
    if (!candidates.includes(candidate)) candidates.push(candidate);
  };

  if (resolvedBin && /\.(mjs|js)$/i.test(resolvedBin)) addCandidate(resolvedBin);

  for (const binDir of [resolvedBin ? path.dirname(resolvedBin) : null, process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : null]) {
    if (!binDir) continue;
    addCandidate(path.join(binDir, "node_modules", "openclaw", "openclaw.mjs"));
    addCandidate(path.join(binDir, "node_modules", "openclaw", "dist", "index.js"));
  }

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function spawnOpenclaw(args: string[], cwd: string): ChildProcess {
  const nodeEntry = resolveOpenClawNodeEntry();
  if (nodeEntry) {
    return nodeSpawn(process.execPath, [nodeEntry, ...args], { cwd, windowsHide: true });
  }
  return spawnCli(config.openclaw.bin, args, { cwd });
}

function runOpenclaw(
  args: string[],
  cwd: string,
  options: OpenClawRunOptions = {}
): Promise<OpenClawRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawnOpenclaw(args, cwd);
    const timeoutMs = options.timeoutMs ?? config.openclaw.timeoutSec * 1000;
    const idleTimeoutMs = options.idleTimeoutMs ?? 0;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let idleTimeout: ReturnType<typeof setTimeout> | undefined;
    let stoppedReason: string | null = null;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (idleTimeout) clearTimeout(idleTimeout);
      if (options.taskId && runningOpenClawProcesses.get(options.taskId)?.child === child) {
        runningOpenClawProcesses.delete(options.taskId);
      }
      fn();
    };

    const kill = (reason: string) => {
      stoppedReason = reason;
      killProcessTree(child);
    };
    if (options.taskId) runningOpenClawProcesses.set(options.taskId, { child, kill });

    const refreshIdleTimer = () => {
      if (idleTimeout) clearTimeout(idleTimeout);
      if (idleTimeoutMs <= 0) return;
      idleTimeout = setTimeout(() => {
        killProcessTree(child);
        finish(() =>
          reject(
            new Error(
              `OpenClaw 在 ${Math.round(idleTimeoutMs / 1000)} 秒内没有任何输出，已终止进程。` +
                `如果你在加载很大的本地 Ollama 模型，可以在配置中心把 OPENCLAW_IDLE_TIMEOUT 调大；` +
                `如果只是普通对话测试，建议先改用 Ollama agent 直连或换一个更小的模型。`
            )
          )
        );
      }, idleTimeoutMs);
    };

    refreshIdleTimer();
    child.stdout!.on("data", (d: Buffer) => {
      refreshIdleTimer();
      stdout += d.toString("utf8");
    });
    child.stderr!.on("data", (d: Buffer) => {
      refreshIdleTimer();
      const text = d.toString("utf8");
      stderr += text;
      options.onStderr?.(text);
    });
    child.on("error", (err) => finish(() => reject(err)));
    child.on("close", (code) => finish(() => resolve({ code, stdout, stderr, stopped: Boolean(stoppedReason) })));

    timeout = setTimeout(() => {
      killProcessTree(child);
      finish(() => reject(new Error(`openclaw 命令超时（${Math.round(timeoutMs / 1000)}s）`)));
    }, timeoutMs);
  });
}

function isTransientProviderFailure(output: string): boolean {
  return /connection refused by the provider endpoint|provider endpoint|FailoverError|timeout/i.test(output);
}

async function runOpenclawWithRetry(
  args: string[],
  cwd: string,
  ctx: TaskRuntimeContext
): Promise<OpenClawRunResult> {
  const delaysMs = [0, 8_000, 20_000];
  let last: OpenClawRunResult | null = null;

  for (let attempt = 0; attempt < delaysMs.length; attempt++) {
    const delay = delaysMs[attempt] ?? 0;
    if (delay > 0) {
      ctx.log(`OpenClaw 上游模型暂时不可用，${Math.round(delay / 1000)} 秒后重试（第 ${attempt + 1}/${delaysMs.length} 次）`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    last = await runOpenclaw(args, cwd, {
      taskId: runtimeKeyOf(ctx),
      idleTimeoutMs: Math.max(0, config.openclaw.idleTimeoutSec) * 1000,
      onStderr: (chunk) => ctx.terminal(chunk),
    });
    const output = `${last.stderr}\n${last.stdout}`;
    if (last.stopped || last.code === 0 || !isTransientProviderFailure(output)) return last;
  }

  return last!;
}

/**
 * OpenClaw 和 Codex 一样没有按次传参的 MCP 机制，`openclaw mcp set` 写进它自己的
 * ~/.openclaw/openclaw.json，全局生效。name 统一带 agenthub- 前缀，只增不删/不碰其它条目。
 * 用 runOpenclaw（会绕开 Windows 下 .ps1 shim 的参数转义问题）而不是直接拼 shell 字符串。
 */
// openclaw 单次冷启动实测在这台机器上就要 ~14s（Node 启动 + 自身初始化），`mcp set` 注册
// http 类型时它还会先尝试探测连接，实测碰到不可达的地址能拖到 30s 以上——两个都要给够余量。
const MCP_LIST_TIMEOUT_MS = 45_000;
const MCP_SET_TIMEOUT_MS = 60_000;

async function listOpenClawMcpServerNames(): Promise<Set<string>> {
  try {
    const result = await runOpenclaw(["mcp", "list", "--json"], process.cwd(), { timeoutMs: MCP_LIST_TIMEOUT_MS });
    if (result.code !== 0) return new Set();
    const parsed = JSON.parse(result.stdout) as Record<string, unknown> | { name?: string }[];
    const names = Array.isArray(parsed) ? parsed.map((item) => item.name) : Object.keys(parsed);
    return new Set(names.filter((name): name is string => typeof name === "string"));
  } catch {
    return new Set();
  }
}

// dispatch() 每一轮对话都会调一次 ensureOpenClawMcpServersRegistered，如果不缓存，相当于
// 每条消息都要重新付一次 `mcp list` 的冷启动延迟（~14s，起步）。这里用进程内存缓存记住
// "这一轮 AgentHub 进程里已经确认注册过"的名字，同名 server 第二次起直接跳过 list/set。
// 代价：如果用户在终端手动 `openclaw mcp unset` 了某个 agenthub- 条目，AgentHub 要到下次
// 重启才会发现并补注册——用这个小概率换掉每轮必等的延迟。
const confirmedRegisteredOpenClawNames = new Set<string>();

async function ensureOpenClawMcpServersRegistered(servers: McpServerSpec[], log: (message: string) => void): Promise<void> {
  const uncached = servers.filter((server) => !confirmedRegisteredOpenClawNames.has(server.name));
  if (uncached.length === 0) return;

  const registered = await listOpenClawMcpServerNames();
  const missing: McpServerSpec[] = [];
  for (const server of uncached) {
    if (registered.has(server.name)) confirmedRegisteredOpenClawNames.add(server.name);
    else missing.push(server);
  }
  if (missing.length === 0) return;

  for (const server of missing) {
    const value =
      server.transport === "http"
        ? { url: server.url, ...(server.headers && Object.keys(server.headers).length ? { headers: server.headers } : {}) }
        : { command: server.command, args: server.args ?? [], ...(server.env && Object.keys(server.env).length ? { env: server.env } : {}) };
    try {
      const result = await runOpenclaw(["mcp", "set", server.name, JSON.stringify(value)], process.cwd(), { timeoutMs: MCP_SET_TIMEOUT_MS });
      if (result.code !== 0) log(`[mcp] 注册 "${server.name}" 到 OpenClaw 失败：${result.stderr.trim() || result.stdout.trim()}`);
      else confirmedRegisteredOpenClawNames.add(server.name);
    } catch (err) {
      log(`[mcp] 注册 "${server.name}" 到 OpenClaw 失败：${(err as Error).message}`);
    }
  }
}

function extractReplyText(stdout: string): string {
  // openclaw agent --json 在成功时输出一段 JSON；做宽松解析，取不到就原样返回文本。
  const trimmed = stdout.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "string") return parsed;
    if (parsed?.reply) return String(parsed.reply);
    if (parsed?.message) return String(parsed.message);
    if (parsed?.text) return String(parsed.text);
    const payloads = parsed?.result?.payloads;
    if (Array.isArray(payloads)) {
      const text = payloads
        .map((p) => p?.text)
        .filter((t) => typeof t === "string" && t.trim())
        .join("\n\n");
      if (text) return text;
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return trimmed || "(无输出)";
  }
}

function listLocalOpenClawAgents(): ModelOption[] {
  const agentsDir = path.join(os.homedir(), ".openclaw", "agents");
  if (!fs.existsSync(agentsDir)) return [];
  return fs
    .readdirSync(agentsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(agentsDir, name, "agent")))
    .sort((a, b) => (a === "main" ? -1 : b === "main" ? 1 : a.localeCompare(b)))
    .map((id) => ({ id, label: id === "main" ? "main（默认）" : id }));
}

interface OpenClawModelProviderConfig {
  models?: { id?: string; name?: string }[];
}

interface OpenClawModelConfigFile {
  providers?: Record<string, OpenClawModelProviderConfig>;
  models?: {
    providers?: Record<string, OpenClawModelProviderConfig>;
  };
}

function listOpenClawModelsFromProviders(providers: Record<string, OpenClawModelProviderConfig> | undefined): ModelOption[] {
  const models: ModelOption[] = [];
  for (const [providerId, provider] of Object.entries(providers ?? {})) {
    for (const model of provider.models ?? []) {
      if (!model.id) continue;
      const id = `${providerId}/${model.id}`;
      models.push({ id, label: model.name ?? id });
    }
  }
  return models;
}

function readConfiguredOpenClawModels(filePath: string): ModelOption[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as OpenClawModelConfigFile;
    return listOpenClawModelsFromProviders(parsed.models?.providers ?? parsed.providers);
  } catch {
    return [];
  }
}

function listConfiguredOpenClawModels(): ModelOption[] {
  const openclawConfigPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
  const mainAgentModelsPath = path.join(os.homedir(), ".openclaw", "agents", "main", "agent", "models.json");
  return dedupeOptions([
    ...readConfiguredOpenClawModels(openclawConfigPath),
    ...readConfiguredOpenClawModels(mainAgentModelsPath),
  ]);
}

function listAllowedOpenClawModelPatterns(): string[] {
  const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
  if (!fs.existsSync(configPath)) return [];

  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      agents?: { defaults?: { models?: Record<string, unknown> } };
    };
    return Object.keys(parsed.agents?.defaults?.models ?? {}).filter(Boolean);
  } catch {
    return [];
  }
}

function matchesModelPattern(modelId: string, pattern: string): boolean {
  if (pattern === modelId) return true;
  if (!pattern.includes("*")) return false;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(modelId);
}

function filterAllowedOpenClawModels(options: ModelOption[]): ModelOption[] {
  const patterns = listAllowedOpenClawModelPatterns();
  if (patterns.length === 0) return options;
  return options.filter((option) => patterns.some((pattern) => matchesModelPattern(option.id, pattern)));
}

async function listOllamaModelsForOpenClaw(): Promise<ModelOption[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`${config.ollama.baseUrl.replace(/\/$/, "")}/api/tags`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: { name?: string }[] };
    return (data.models ?? [])
      .map((model) => model.name)
      .filter((name): name is string => Boolean(name))
      .map((name) => ({ id: `ollama/${name}`, label: `${name} (Ollama)` }));
  } catch {
    return [];
  }
}

function dedupeOptions(options: ModelOption[]): ModelOption[] {
  const seen = new Set<string>();
  const result: ModelOption[] = [];
  for (const option of options) {
    if (seen.has(option.id)) continue;
    seen.add(option.id);
    result.push(option);
  }
  return result;
}

async function dispatch(ctx: TaskRuntimeContext, sessionKey: string, input: TurnInput): Promise<void> {
  const text = input.text;
  const prompt = buildWorkspacePrompt(ctx.workspacePath, text, ctx.workspacePrompt, ctx.workspaceKnowledge, input.images, ctx.workspaceAccessPaths);
  if (input.images.length) ctx.log(`OpenClaw adapter 暂不支持原生图片附件，已把 ${input.images.length} 张图片路径写入提示词作为兜底`);
  const risk = scanRisk(text);
  if (risk && shouldGate(risk.riskLevel, ctx.permissionMode)) {
    ctx.log(`检测到潜在高风险内容（${risk.reason}），先进入审批队列再派发给 OpenClaw`);
    const decision = await ctx.requestApproval({
      command: text,
      cwd: ctx.workspacePath,
      riskLevel: risk.riskLevel,
      reason: risk.reason,
    });
    if (decision.decision === "deny") {
      ctx.agentMessage(`已取消派发给 OpenClaw（原因：${decision.note ?? "用户拒绝"}）。`);
      ctx.setStatus("review");
      return;
    }
  }

  if (ctx.mcpServers.length) {
    await ensureOpenClawMcpServersRegistered(ctx.mcpServers, ctx.log);
    ctx.log(`已确保 MCP 在 OpenClaw 注册: ${ctx.mcpServers.map((s) => s.name).join(", ")}`);
  }

  const args = ["agent", "--session-key", sessionKey, "--message", prompt, "--json", "--timeout", String(config.openclaw.timeoutSec)];
  // 建任务时选的子 agent 优先于 .env 里配的全局默认值
  const agentId = ctx.subAgentId || config.openclaw.agentId;
  if (agentId) {
    args.push("--agent", agentId);
  }
  if (ctx.model) {
    args.push("--model", ctx.model);
  }

  const idleTimeout = Math.max(0, config.openclaw.idleTimeoutSec);
  ctx.log(`OpenClaw 进程总超时 ${config.openclaw.timeoutSec}s，无输出超时 ${idleTimeout > 0 ? `${idleTimeout}s` : "关闭"}。`);
  if (ctx.model?.startsWith("ollama/")) {
    ctx.log(
      `当前通过 OpenClaw 调用本机 Ollama 模型 ${ctx.model}。大模型首次加载可能很久；如果只是测试回复速度，建议优先用 Ollama agent 直连。`
    );
  }
  ctx.terminal(`$ ${config.openclaw.bin} ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}\n`);
  ctx.setStatus("running");

  try {
    const result = await runOpenclawWithRetry(args, ctx.workspacePath, ctx);
    if (result.stopped) return;
    const { code, stdout, stderr } = result;
    if (stderr.trim()) ctx.terminal(stderr);
    if (code !== 0) {
      ctx.log(`openclaw 进程退出码 ${code}`);
      ctx.agentMessage(`OpenClaw 调用失败（exit code ${code}）：\n${stderr.trim() || stdout.trim()}`);
      ctx.setStatus("failed");
      return;
    }
    const reply = extractReplyText(stdout);
    ctx.agentMessage(reply);
    ctx.setStatus("review");
  } catch (err) {
    ctx.log(`调用 openclaw 失败：${(err as Error).message}`);
    ctx.agentMessage(
      `无法调用 OpenClaw：${(err as Error).message}\n` +
        `请确认已安装 openclaw CLI 且本机 Gateway 正在运行（openclaw gateway status）。`
    );
    ctx.setStatus("failed");
  }
}

export class OpenClawAdapter implements AgentAdapter {
  readonly kind = "openclaw" as const;
  readonly name = "OpenClaw";
  readonly description = "通过本机 openclaw CLI 调用 OpenClaw Gateway 执行一次 agent turn";
  readonly supportsMcp = true as const;

  isConfigured() {
    return cliAvailable(config.openclaw.bin); // Gateway 是否在线以运行时为准，这里只看 CLI 装没装
  }
  configHint() {
    return `使用 openclaw CLI（${config.openclaw.bin}），需要本机已 \`openclaw gateway run\` 或作为服务常驻`;
  }
  async discoverWorkspaces() {
    return [];
  }

  async listModels(): Promise<ModelOption[]> {
    const localModels = filterAllowedOpenClawModels(
      dedupeOptions([...listConfiguredOpenClawModels(), ...(await listOllamaModelsForOpenClaw())])
    );
    if (localModels.length > 0) return localModels;

    try {
      const { code, stdout } = await runOpenclaw(["models", "list", "--json"], process.cwd(), { timeoutMs: 20_000 });
      if (code !== 0) return [];
      const parsed = JSON.parse(stdout) as { models?: { key: string; name?: string; available?: boolean }[] };
      return filterAllowedOpenClawModels(
        (parsed.models ?? [])
          .filter((m) => m.available !== false)
          .map((m) => ({ id: m.key, label: m.name ? `${m.name} (${m.key})` : m.key }))
      );
    } catch {
      return []; // openclaw 没装/没配置模型时安静返回空列表，不影响其它 adapter
    }
  }

  async listSubAgents(): Promise<ModelOption[]> {
    const localAgents = listLocalOpenClawAgents();
    if (localAgents.length > 0) return localAgents;

    try {
      const { code, stdout } = await runOpenclaw(["agents", "list", "--json"], process.cwd(), { timeoutMs: 20_000 });
      if (code !== 0) return [];
      const parsed = JSON.parse(stdout) as { id: string; name?: string; isDefault?: boolean }[];
      return parsed.map((a) => ({ id: a.id, label: a.isDefault ? `${a.id}（默认）` : a.name ?? a.id }));
    } catch {
      return []; // openclaw 没装/没配置多 agent 时安静返回空列表
    }
  }

  async run(ctx: TaskRuntimeContext, input: TurnInput): Promise<void> {
    // openclaw --session-key 的格式是 agent:<id>:<key>；选了具体子 agent 时按这个格式绑定，
    // 没选就维持原来的自定义 key（走默认路由）。
    const agentId = ctx.subAgentId || config.openclaw.agentId;
    const sessionKey = agentId ? `agent:${agentId}:agenthub-${runtimeKeyOf(ctx)}` : `agenthub:${runtimeKeyOf(ctx)}`;
    ctx.setSessionKey(sessionKey);
    await dispatch(ctx, sessionKey, input);
  }

  async continueTask(ctx: TaskRuntimeContext, input: TurnInput): Promise<void> {
    const sessionKey = ctx.sessionKey ?? `agenthub:${runtimeKeyOf(ctx)}`;
    await dispatch(ctx, sessionKey, input);
  }

  async stop(ctx: TaskRuntimeContext): Promise<void> {
    const running = runningOpenClawProcesses.get(runtimeKeyOf(ctx));
    if (running) {
      ctx.log("正在终止 OpenClaw 进程树...");
      running.kill("用户停止");
    }
    ctx.setStatus("stopped");
  }

  /** 一次性问答用：不绑定真实任务 session，不走审批闸门，直接拿文本回复。失败时抛出带原因的错误。 */
  async ask(prompt: string, options?: { model?: string | null; mcpServers?: McpServerSpec[] }): Promise<string | null> {
    if (options?.mcpServers?.length) {
      await ensureOpenClawMcpServersRegistered(options.mcpServers, (message) => console.warn(`[openclaw ask mcp] ${message}`));
    }
    const args = ["agent", "--session-key", `agenthub-ask-${Date.now()}`, "--message", prompt, "--json", "--timeout", String(ASK_TIMEOUT_SEC)];
    if (options?.model) args.push("--model", options.model);
    let result: OpenClawRunResult;
    try {
      result = await runOpenclaw(args, process.cwd(), { timeoutMs: ASK_TIMEOUT_MS + 10_000 });
    } catch (err) {
      throw new Error(`启动 OpenClaw 失败：${(err as Error).message}`);
    }
    if (result.code !== 0) throw cliAskError("OpenClaw", result.code, result.stderr || result.stdout);
    const reply = extractReplyText(result.stdout);
    return reply && reply !== "(无输出)" ? reply : null;
  }
}
