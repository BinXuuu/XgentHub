import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { config } from "../config.ts";
import { scanRisk, shouldGate } from "./riskPolicy.ts";
import { killProcessTree, spawnCli } from "./winSpawn.ts";
import { buildWorkspacePrompt } from "./workspacePrompt.ts";
import type { AgentAdapter, TaskRuntimeContext, TurnInput } from "./types.ts";
import { runtimeKeyOf } from "./types.ts";
import type { AgentAccountInfo, ModelOption } from "../types.ts";
import { cliAccountEnv, readCliAccountInfo } from "../services/cliAccountService.ts";

/** 另外添加的火山方舟账号：一个独立的用户目录（登录在里面的 .arkcli）。不传就是本机默认账号。 */
export interface ArkAccountOptions {
  id: string;
  name: string;
  home: string;
}
import { ASK_TIMEOUT_MS, cliAskError } from "./askErrors.ts";

const runningArkCliProcesses = new Map<string, { child: ChildProcess; kill: (reason: string) => void }>();

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

interface StreamState {
  responseId: string | null;
  streamed: string;
  finalText: string;
  sawJson: boolean;
}

const conversations = new Map<string, ChatMessage[]>();
const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

function quoteForLog(arg: string): string {
  return /[\s"]/u.test(arg) ? JSON.stringify(arg) : arg;
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

function globalArgs(maskSecrets = false): string[] {
  const args: string[] = [];
  if (config.arkCli.profile) args.push("--profile", config.arkCli.profile);
  if (config.arkCli.baseUrl) args.push("--base-url", config.arkCli.baseUrl);
  if (config.arkCli.apiKey) args.push("--api-key", maskSecrets ? "***" : config.arkCli.apiKey);
  args.push("--ui-lang", "zh_cn");
  return args;
}

function runArk(args: string[], cwd: string, timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnCli(config.arkCli.bin, args, { cwd, env });
    } catch (err) {
      resolve({ code: null, stdout: "", stderr: "", error: err as Error });
      return;
    }
    // 不关 stdin 的话，经 npm 的 .ps1 启动脚本跑的 CLI 会一直等输入，直到超时（实测 arkcli auth status 1.8 秒 → 卡满 20 秒）。
    child.stdin?.end();

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr?.on("data", (d) => (stderr += d.toString("utf8")));

    const timeout = setTimeout(() => {
      child.kill();
      resolve({ code: null, stdout, stderr: `${stderr}\nArk CLI 命令超时。`.trim() });
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

function looksUnauthenticated(text: string): boolean {
  return /not configured|auth login|logged_in["']?\s*:\s*false|unauthorized|forbidden|access denied|please login|登录|未登录/i.test(text);
}

function looksMissingBinary(text: string): boolean {
  return /not recognized as an internal or external command|command not found|ENOENT|无法将.+识别为|不是内部或外部命令/i.test(text);
}

function idOf(item: any, preferModelField = false): string | null {
  const raw =
    (preferModelField ? (item?.model ?? item?.Model) : undefined) ??
    item?.id ??
    item?.ID ??
    item?.model ??
    item?.Model ??
    item?.model_id ??
    item?.ModelID ??
    item?.resource_id ??
    item?.ResourceID ??
    item?.endpoint_id ??
    item?.EndpointID ??
    item?.name ??
    item?.Name;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function labelOf(item: any, id: string, preferModelField = false): string {
  if (preferModelField) {
    const name = item?.name ?? item?.Name;
    const version = item?.version ?? item?.Version;
    if (typeof name === "string" && name.trim() && typeof version === "string" && version.trim()) {
      return `${name.trim()} ${version.trim()} (${id})`;
    }
  }
  const raw = item?.display_name ?? item?.DisplayName ?? item?.label ?? item?.Label ?? item?.name ?? item?.Name;
  return typeof raw === "string" && raw.trim() && raw.trim() !== id ? `${raw.trim()} (${id})` : id;
}

function collectModelOptions(value: unknown, out: ModelOption[], preferModelField = false) {
  if (!value) return;
  if (typeof value === "string") {
    if (/^[\w./:@-]+$/u.test(value)) out.push({ id: value, label: value });
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectModelOptions(item, out, preferModelField);
    return;
  }
  if (typeof value !== "object") return;

  const item = value as any;
  const id = idOf(item, preferModelField);
  if (id) out.push({ id, label: labelOf(item, id, preferModelField) });

  for (const key of ["data", "items", "models", "Models", "resources", "Resources", "endpoints", "Endpoints", "result", "Result"]) {
    if (key in item) collectModelOptions(item[key], out, preferModelField);
  }
}

function parseModelOptions(stdout: string, preferModelField = false): ModelOption[] {
  const clean = stripAnsi(stdout).trim();
  const options: ModelOption[] = [];
  try {
    collectModelOptions(JSON.parse(clean), options, preferModelField);
  } catch {
    for (const line of clean.split(/\r?\n/)) {
      const trimmed = line.trim().replace(/^[*•-]\s*/, "");
      if (!trimmed || /^(id|model|name|resource|endpoint)\b/i.test(trimmed)) continue;
      const id = trimmed.split(/\s+/)[0];
      if (id && /^[\w./:@-]+$/u.test(id)) options.push({ id, label: trimmed === id ? id : `${trimmed.slice(id.length).trim()} (${id})` });
    }
  }

  const seen = new Set<string>();
  return options.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

async function fetchModels(env?: NodeJS.ProcessEnv): Promise<ModelOption[]> {
  if (!executableExists(config.arkCli.bin)) return [];
  const result = await runArk([...globalArgs(), "resources", "list", "--modality", "text", "--format", "json"], process.cwd(), 30_000, env);
  if (result.code !== 0 || result.error) return [];
  return parseModelOptions(result.stdout);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => part?.text ?? part?.content ?? part?.value)
    .filter((part) => typeof part === "string" && part.trim())
    .join("");
}

function outputTextFromResponse(response: any): string {
  if (typeof response?.output_text === "string") return response.output_text;
  if (!Array.isArray(response?.output)) return "";
  return response.output
    .map((item: any) => textFromContent(item?.content))
    .filter(Boolean)
    .join("");
}

function extractResponseId(evt: any): string | null {
  const id = evt?.response?.id ?? evt?.response_id ?? evt?.id;
  return typeof id === "string" && /^(resp|response|r)[_-]/i.test(id) ? id : null;
}

function extractDelta(evt: any): string {
  const type = String(evt?.type ?? evt?.event ?? "");
  if (!/delta/i.test(type)) return "";
  if (typeof evt?.delta === "string") return evt.delta;
  if (typeof evt?.delta?.text === "string") return evt.delta.text;
  if (typeof evt?.delta?.content === "string") return evt.delta.content;
  if (typeof evt?.text_delta === "string") return evt.text_delta;
  if (typeof evt?.output_text_delta === "string") return evt.output_text_delta;
  return "";
}

function extractFinalText(evt: any): string {
  const type = String(evt?.type ?? evt?.event ?? "");
  if (!/(completed|complete|result|message)/i.test(type)) return "";
  return (
    outputTextFromResponse(evt?.response) ||
    textFromContent(evt?.message?.content) ||
    textFromContent(evt?.content) ||
    (typeof evt?.result === "string" ? evt.result : "") ||
    (typeof evt?.text === "string" ? evt.text : "")
  );
}

function handleStreamLine(ctx: TaskRuntimeContext, state: StreamState, line: string) {
  const trimmed = line.trim();
  if (!trimmed) return;

  let evt: any;
  try {
    evt = JSON.parse(trimmed);
    state.sawJson = true;
  } catch {
    const text = `${line}\n`;
    state.streamed += text;
    ctx.terminal(text);
    return;
  }

  const responseId = extractResponseId(evt);
  if (responseId) {
    state.responseId = responseId;
    ctx.setSessionKey(responseId);
  }

  const delta = extractDelta(evt);
  if (delta) {
    state.streamed += delta;
    ctx.terminal(delta);
    return;
  }

  const finalText = extractFinalText(evt);
  if (finalText) state.finalText = finalText;

  const type = String(evt?.type ?? evt?.event ?? "");
  if (/error/i.test(type) || evt?.error) ctx.log(`[arkcli] ${JSON.stringify(evt).slice(0, 800)}`);
}

function buildPrompt(ctx: TaskRuntimeContext, input: TurnInput, resumeResponseId: string | null): string {
  const current = buildWorkspacePrompt(ctx.workspacePath, input.text, ctx.workspacePrompt, ctx.workspaceKnowledge, input.images, ctx.workspaceAccessPaths);
  if (resumeResponseId) return current;
  const history = conversations.get(runtimeKeyOf(ctx)) ?? [];
  const previous = history
    .slice(-6)
    .map((msg) => `${msg.role === "user" ? "用户" : "助手"}：${msg.content}`)
    .join("\n\n");
  return previous ? `以下是本任务之前的对话摘要，供你续接上下文：\n${previous}\n\n---\n\n${current}` : current;
}

async function dispatch(ctx: TaskRuntimeContext, input: TurnInput, env?: NodeJS.ProcessEnv, accountName?: string): Promise<void> {
  if (!executableExists(config.arkCli.bin)) {
    ctx.agentMessage(
      `Ark CLI 尚未接通：未在本机 PATH 中找到 "${config.arkCli.bin}"。\n` +
        "安装：npm install -g @volcengine/ark-cli@latest，然后运行 arkcli auth login。"
    );
    ctx.setStatus("failed");
    return;
  }

  const risk = scanRisk(input.text);
  if (risk && shouldGate(risk.riskLevel, ctx.permissionMode)) {
    ctx.log(`检测到潜在高风险内容（${risk.reason}），先进入审批队列再派发给 Ark CLI`);
    const decision = await ctx.requestApproval({
      command: input.text,
      cwd: ctx.workspacePath,
      riskLevel: risk.riskLevel,
      reason: risk.reason,
    });
    if (decision.decision === "deny") {
      ctx.agentMessage(`已取消派发给 Ark CLI（原因：${decision.note ?? "用户拒绝"}）。`);
      ctx.setStatus("review");
      return;
    }
  }

  const resumeResponseId = ctx.sessionKey && !ctx.sessionKey.startsWith("ark-cli-") ? ctx.sessionKey : null;
  const prompt = buildPrompt(ctx, input, resumeResponseId);
  const model = ctx.model || config.arkCli.defaultModel;
  const args = [...globalArgs(), "+chat", prompt, "--stream", "--include-events", "--store", "--no-progress"];
  if (model) args.push("--model", model);
  if (resumeResponseId) args.push("--previous-response-id", resumeResponseId);
  if (config.arkCli.reasoningEffort) args.push("--reasoning-effort", config.arkCli.reasoningEffort);
  for (const image of input.images) args.push("--input", `@${image}`);

  ctx.terminal(`$ ${config.arkCli.bin} ${[...globalArgs(true), ...args.slice(globalArgs().length)].map(quoteForLog).join(" ")}\n`);
  ctx.setStatus("running");

  await new Promise<void>((resolve) => {
    let child;
    try {
      child = spawnCli(config.arkCli.bin, args, { cwd: ctx.workspacePath, env });
    } catch (err) {
      ctx.agentMessage(`无法启动 Ark CLI：${(err as Error).message}`);
      ctx.setStatus("failed");
      resolve();
      return;
    }

    child.stdin?.end();
    const state: StreamState = { responseId: resumeResponseId, streamed: "", finalText: "", sawJson: false };
    let buffer = "";
    let stderr = "";
    let stoppedReason: string | null = null;
    const cleanupRunningProcess = () => {
      if (runningArkCliProcesses.get(runtimeKeyOf(ctx))?.child === child) runningArkCliProcesses.delete(runtimeKeyOf(ctx));
    };
    runningArkCliProcesses.set(runtimeKeyOf(ctx), {
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
        handleStreamLine(ctx, state, line);
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const timeout = setTimeout(() => {
      killProcessTree(child!);
      stderr += `\nArk CLI 命令超时（${config.arkCli.timeoutSec}s），已终止进程。\n`;
    }, config.arkCli.timeoutSec * 1000);

    child.on("error", (err) => {
      clearTimeout(timeout);
      cleanupRunningProcess();
      ctx.agentMessage(`无法启动 Ark CLI：${err.message}`);
      ctx.setStatus("failed");
      resolve();
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      cleanupRunningProcess();
      if (stoppedReason) {
        ctx.log(`arkcli 进程已停止：${stoppedReason}`);
        resolve();
        return;
      }
      if (buffer.trim()) handleStreamLine(ctx, state, buffer);
      if (stderr.trim()) ctx.terminal(stripAnsi(stderr));

      const combined = `${stderr}\n${buffer}\n${state.streamed}\n${state.finalText}`;
      if (code !== 0) {
        if (looksMissingBinary(combined)) {
          ctx.agentMessage(
            `Ark CLI 尚未接通：未在本机 PATH 中找到 "${config.arkCli.bin}"。\n` +
              "安装：npm install -g @volcengine/ark-cli@latest，然后运行 arkcli auth login。"
          );
      } else if (looksUnauthenticated(combined)) {
        ctx.agentMessage(
          accountName
            ? `「${accountName}」还没登录火山方舟账号：在左侧打开「${accountName}」，在「账号」里点「登录 火山方舟 账号」，登录完再重试。`
            : "Ark CLI 尚未登录或未配置：在左侧打开 Ark CLI，在「账号」里点「登录 火山方舟 账号」（或在终端运行 `arkcli auth login`），也可以在配置里填 `ARK_CLI_API_KEY`。"
        );
      } else if (/requires an endpoint id|endpoint id|ep-\.\.\./i.test(combined)) {
        ctx.agentMessage(
          "Ark CLI 当前 profile 是 Platform 路径，`+chat` 需要使用 `ep-*` 推理接入点 ID。\n" +
            "请在火山方舟创建/选择一个文本 Endpoint，然后在新建任务的模型框或 Ark CLI 配置里的 `ARK_CLI_MODEL` 填入该 `ep-*`。"
        );
      } else {
        ctx.agentMessage(`Ark CLI 调用失败（exit code ${code ?? "unknown"}）：\n${stripAnsi(stderr || buffer).trim() || "没有输出"}`);
      }
        ctx.setStatus("failed");
        resolve();
        return;
      }

      if (state.responseId) ctx.setSessionKey(state.responseId);
      else if (!ctx.sessionKey) ctx.setSessionKey(`ark-cli-${runtimeKeyOf(ctx)}`);
      const reply = (state.streamed || state.finalText).trim();
      const history = conversations.get(runtimeKeyOf(ctx)) ?? [];
      history.push({ role: "user", content: input.text }, { role: "assistant", content: reply });
      conversations.set(runtimeKeyOf(ctx), history.slice(-12));
      ctx.agentMessage(reply || "(空响应)");
      ctx.setStatus("review");
      resolve();
    });
  });
}

async function authStatusText(env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await runArk([...globalArgs(), "auth", "status", "--format", "json"], process.cwd(), 15_000, env);
  const text = `${result.stdout}\n${result.stderr}\n${result.error?.message ?? ""}`.trim();
  if (!text) return config.arkCli.apiKey ? "使用 AgentHub 中配置的 API Key" : "未返回登录状态";
  try {
    const parsed = JSON.parse(result.stdout);
    if (parsed?.logged_in) return `已登录：${parsed.auth_method ?? "arkcli"}`;
    return config.arkCli.apiKey ? "arkcli 未登录；当前会尝试使用 AgentHub 中配置的 API Key" : "arkcli 未登录";
  } catch {
    return stripAnsi(text).slice(0, 300);
  }
}

async function usageSummary(env?: NodeJS.ProcessEnv): Promise<string | null> {
  if (!executableExists(config.arkCli.bin)) return "找不到 Ark CLI：请先安装 @volcengine/ark-cli，或在配置里设置 ARK_CLI_BIN。";
  const auth = await authStatusText(env);
  const plan = await runArk([...globalArgs(), "usage", "plan", "--format", "json"], process.cwd(), 30_000, env);
  const output = `${plan.stdout}\n${plan.stderr}\n${plan.error?.message ?? ""}`.trim();
  if (looksUnauthenticated(output) && !config.arkCli.apiKey) return `${auth}\n请先运行 arkcli auth login。`;
  if (plan.code !== 0 || !output) return `${auth}\n暂时查不到订阅用量。`;
  return `火山方舟用量\n登录状态：${auth}\n${stripAnsi(output).slice(0, 1200)}`;
}

export class ArkCliAdapter implements AgentAdapter {
  readonly id?: string;
  readonly kind = "ark-cli" as const;
  readonly name: string;
  private readonly accountOptions: ArkAccountOptions | null;

  constructor(account?: ArkAccountOptions) {
    this.accountOptions = account ?? null;
    this.id = account?.id;
    this.name = account ? `Ark CLI（${account.name}）` : "Ark CLI";
  }

  /** 另外添加的账号换一个用户目录（登录在里面的 .arkcli），默认账号不改环境。 */
  private env(): NodeJS.ProcessEnv | undefined {
    return this.accountOptions ? { ...process.env, ...cliAccountEnv("ark-cli", this.accountOptions.home) } : undefined;
  }

  account(): AgentAccountInfo {
    return readCliAccountInfo("ark-cli", {
      id: this.accountOptions?.id ?? "ark-cli",
      name: this.accountOptions?.name ?? "默认账号",
      home: this.accountOptions?.home ?? null,
    });
  }
  readonly description = "通过本机 arkcli +chat 调用火山方舟/豆包 CLI（headless）";

  isConfigured() {
    return executableExists(config.arkCli.bin);
  }

  configHint() {
    return `使用 ARK_CLI_BIN="${config.arkCli.bin}"；需要 arkcli auth login，或配置 ARK_CLI_API_KEY`;
  }

  async discoverWorkspaces() {
    return [];
  }

  defaultModel(): string | null {
    return config.arkCli.defaultModel || null;
  }

  async listModels(): Promise<ModelOption[]> {
    return fetchModels(this.env());
  }

  async getUsageSummary(): Promise<string | null> {
    return usageSummary(this.env());
  }

  async run(ctx: TaskRuntimeContext, input: TurnInput): Promise<void> {
    ctx.setSessionKey(`ark-cli-${runtimeKeyOf(ctx)}`);
    await dispatch(ctx, input, this.env(), this.accountOptions ? this.name : undefined);
  }

  async continueTask(ctx: TaskRuntimeContext, input: TurnInput): Promise<void> {
    await dispatch(ctx, input, this.env(), this.accountOptions ? this.name : undefined);
  }

  async stop(ctx: TaskRuntimeContext): Promise<void> {
    const running = runningArkCliProcesses.get(runtimeKeyOf(ctx));
    if (running) {
      ctx.log("正在终止 Ark CLI 进程树...");
      running.kill("用户停止");
    }
    ctx.setStatus("stopped");
  }

  /** 一次性问答用：不带工作区、不写 session，直接拿回复文本。失败时抛出带原因的错误。 */
  async ask(prompt: string, options?: { model?: string | null }): Promise<string | null> {
    if (!executableExists(config.arkCli.bin)) throw new Error(`找不到 Ark CLI：${config.arkCli.bin}`);
    const args = [...globalArgs(), "+chat", prompt, "--stream", "--include-events", "--no-progress"];
    const model = options?.model || config.arkCli.defaultModel;
    if (model) args.push("--model", model);
    const result = await runArk(args, process.cwd(), ASK_TIMEOUT_MS + 5_000, this.env());
    if (result.error) throw new Error(`启动 Ark CLI 失败：${result.error.message}`);
    if (result.code !== 0) throw cliAskError("Ark CLI", result.code, result.stderr || result.stdout);
    let streamed = "";
    let finalText = "";
    for (const line of result.stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const evt = JSON.parse(trimmed);
        streamed += extractDelta(evt);
        const text = extractFinalText(evt);
        if (text) finalText = text;
      } catch {
        // 忽略非 JSON 行
      }
    }
    const reply = (streamed || finalText).trim();
    return reply || null;
  }
}
