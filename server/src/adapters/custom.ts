import { scanRisk, shouldGate } from "./riskPolicy.ts";
import { killProcessTree, spawnCli } from "./winSpawn.ts";
import { buildWorkspacePrompt } from "./workspacePrompt.ts";
import { cleanupTempMcpConfigFile, writeTempMcpConfigFile } from "./mcpConfigFile.ts";
import type { ChildProcess } from "node:child_process";
import type { AgentAdapter, McpServerSpec, TaskRuntimeContext, TurnInput } from "./types.ts";
import { runtimeKeyOf } from "./types.ts";
import type { CustomAgentDefinition } from "../services/customAgentService.ts";
import type { ModelOption } from "../types.ts";
import { ASK_TIMEOUT_SEC, cliAskError, httpAskError, networkAskError } from "./askErrors.ts";

const runningCustomCliProcesses = new Map<string, { kill: (reason: string) => void }>();

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const apiConversations = new Map<string, ChatMessage[]>();
const runningCustomApiRequests = new Map<string, AbortController>();

function baseUrl(agent: CustomAgentDefinition): string {
  return agent.api?.baseUrl.replace(/\/$/, "") ?? "";
}

function authHeaders(agent: CustomAgentDefinition): Record<string, string> {
  return agent.api?.apiKey ? { authorization: `Bearer ${agent.api.apiKey}` } : {};
}

function splitArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    // 同 splitTemplateArgs：引号里只有 \" 是转义，Windows 路径里的反斜杠原样保留。
    if (quote && ch === "\\" && input[i + 1] === quote) {
      current += quote;
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) args.push(current);
  return args;
}

export function splitTemplateArgs(template: string, values: Record<string, string | string[]>): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < template.length; i++) {
    const rest = template.slice(i);
    const placeholder = rest.match(/^\{(prompt|rawPrompt|workspace|accessPaths|addDirArgs|model|session|mcpConfig)\}/);
    if (placeholder) {
      const value = values[placeholder[1]] ?? "";
      if (Array.isArray(value)) {
        if (current) {
          current += value.join(" ");
        } else {
          args.push(...value);
        }
      } else {
        current += value;
      }
      i += placeholder[0].length - 1;
      continue;
    }

    const ch = template[i];
    // 引号里只有 \" （或 \'）表示引号本身；其它反斜杠原样保留，Windows 路径 "C:\Users\..." 才不会被吃掉。
    if (quote && ch === "\\" && template[i + 1] === quote) {
      current += quote;
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) args.push(current);
  return args;
}

function renderTemplate(template: string, values: Record<string, string | string[]>): string {
  return template.replace(/\{(prompt|rawPrompt|workspace|accessPaths|model|session|mcpConfig)\}/g, (_match, key: string) => {
    const value = values[key] ?? "";
    return Array.isArray(value) ? value.join(" ") : value;
  });
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

function extractJsonText(parsed: any): string {
  if (typeof parsed === "string") return parsed;
  if (typeof parsed?.response === "string") return parsed.response;
  if (typeof parsed?.result === "string") return parsed.result;
  if (typeof parsed?.message === "string") return parsed.message;
  if (typeof parsed?.text === "string") return parsed.text;
  const payloads = parsed?.result?.payloads;
  if (Array.isArray(payloads)) {
    const text = payloads.map((p) => p?.text).filter((t) => typeof t === "string" && t.trim()).join("\n\n");
    if (text) return text;
  }
  const choiceText = parsed?.choices?.[0]?.message?.content ?? parsed?.choices?.[0]?.text;
  if (typeof choiceText === "string") return choiceText;
  return JSON.stringify(parsed, null, 2);
}

function parseCliOutput(stdout: string, stderr: string, outputMode: string): string {
  const text = stdout.trim() || stderr.trim();
  if (!text) return "(无输出)";
  if (outputMode === "json") {
    try {
      return extractJsonText(JSON.parse(text));
    } catch {
      return text;
    }
  }
  if (outputMode === "jsonl") {
    const chunks: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        const piece = extractJsonText(parsed);
        if (piece && piece !== JSON.stringify(parsed, null, 2)) chunks.push(piece);
      } catch {
        chunks.push(trimmed);
      }
    }
    return chunks.join("\n").trim() || text;
  }
  return text;
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutSec: number,
  stdinText = "",
  /** 只有真正绑定到一个 Task 的长时间调用（dispatch）才需要传——让调用方能注册可中止的 kill 回调。 */
  onSpawn?: (child: ChildProcess, kill: (reason: string) => void) => void
): Promise<{ code: number | null; stdout: string; stderr: string; stoppedReason: string | null }> {
  return new Promise((resolve, reject) => {
    const child = spawnCli(command, args, { cwd });
    child.stdin?.end(stdinText || undefined);
    let stdout = "";
    let stderr = "";
    let stoppedReason: string | null = null;
    child.stdout?.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr?.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    const timeout = setTimeout(() => {
      killProcessTree(child);
      resolve({ code: null, stdout, stderr: `${stderr}\n命令超时（${timeoutSec}s）`.trim(), stoppedReason: null });
    }, timeoutSec * 1000);
    onSpawn?.(child, (reason) => {
      stoppedReason = reason;
      killProcessTree(child);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr, stoppedReason });
    });
  });
}

async function ensureRiskAllowed(ctx: TaskRuntimeContext, input: TurnInput, label: string): Promise<boolean> {
  const risk = scanRisk(input.text);
  if (!risk || !shouldGate(risk.riskLevel, ctx.permissionMode)) return true;
  ctx.log(`检测到潜在高风险内容（${risk.reason}），先进入审批队列再派发给 ${label}`);
  const decision = await ctx.requestApproval({
    command: input.text,
    cwd: ctx.workspacePath,
    riskLevel: risk.riskLevel,
    reason: risk.reason,
  });
  if (decision.decision === "deny") {
    ctx.agentMessage(`已取消派发给 ${label}（原因：${decision.note ?? "用户拒绝"}）。`);
    ctx.setStatus("review");
    return false;
  }
  return true;
}

export class CustomApiAdapter implements AgentAdapter {
  readonly id: string;
  readonly kind = "custom-api" as const;
  readonly name: string;
  readonly description: string;
  private readonly agent: CustomAgentDefinition;

  constructor(agent: CustomAgentDefinition) {
    this.agent = agent;
    this.id = agent.id;
    this.name = agent.name;
    this.description = agent.description || "自定义 OpenAI 兼容 API Agent";
  }

  isConfigured() {
    return Boolean(this.agent.api?.baseUrl && this.agent.api?.apiKey);
  }

  configHint() {
    return `${this.agent.api?.baseUrl || "未设置 Base URL"}${this.agent.api?.defaultModel ? `，默认模型=${this.agent.api.defaultModel}` : ""}`;
  }

  async discoverWorkspaces() {
    return [];
  }

  defaultModel(): string | null {
    return this.agent.api?.defaultModel || null;
  }

  async listModels(): Promise<ModelOption[]> {
    try {
      const res = await fetch(`${baseUrl(this.agent)}/models`, { headers: authHeaders(this.agent) });
      if (!res.ok) return [];
      const data = (await res.json()) as { data?: { id: string; owned_by?: string }[] };
      return (data.data ?? []).map((m) => ({ id: m.id, label: m.owned_by ? `${m.id} (${m.owned_by})` : m.id }));
    } catch {
      return [];
    }
  }

  private async dispatch(ctx: TaskRuntimeContext, input: TurnInput): Promise<void> {
    if (!(await ensureRiskAllowed(ctx, input, this.name))) return;
    const model = ctx.model || this.agent.api?.defaultModel;
    if (!model) {
      ctx.agentMessage("没有指定模型：请在新建任务时选择模型，或在 Agent 配置里设置默认模型。");
      ctx.setStatus("failed");
      return;
    }
    if (input.images.length) ctx.log(`自定义 API Agent 暂不支持图片附件，已忽略 ${input.images.length} 张图片`);

    const key = `${this.id}:${runtimeKeyOf(ctx)}`;
    const history = apiConversations.get(key) ?? [
      {
        role: "system",
        content: `${this.agent.api?.systemPrompt || "你是通过 Xgent Hub 调用的自定义 API Agent。"}\n当前工作区：${ctx.workspacePath}`,
      },
    ];
    history.push({ role: "user", content: input.text });

    const url = `${baseUrl(this.agent)}/chat/completions`;
    ctx.terminal(`$ POST ${url} (model=${model}, stream=true)\n`);
    const controller = new AbortController();
    runningCustomApiRequests.set(key, controller);
    ctx.setStatus("running");
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(this.agent) },
        body: JSON.stringify({ model, messages: history, stream: true }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => "");
        throw new Error(`API 返回 ${res.status}: ${body.slice(0, 500)}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let full = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const json = JSON.parse(data);
            // 不主动加 stream_options（有的接口不认会报错），接口自己带了 usage 就记下。
            if (json?.usage) ctx.reportUsage?.(json.usage);
            const delta = json?.choices?.[0]?.delta?.content ?? json?.choices?.[0]?.message?.content;
            if (delta) {
              full += delta;
              ctx.terminal(delta);
            }
          } catch {
            // ignore broken chunks
          }
        }
      }
      history.push({ role: "assistant", content: full });
      apiConversations.set(key, history);
      ctx.agentMessage(full || "(空响应)");
      ctx.setStatus("review");
    } catch (err) {
      if (controller.signal.aborted) return;
      ctx.agentMessage(`自定义 API Agent 调用失败：${(err as Error).message}`);
      ctx.setStatus("failed");
    } finally {
      if (runningCustomApiRequests.get(key) === controller) runningCustomApiRequests.delete(key);
    }
  }

  async run(ctx: TaskRuntimeContext, input: TurnInput): Promise<void> {
    ctx.setSessionKey(`${this.id}:${runtimeKeyOf(ctx)}`);
    await this.dispatch(ctx, input);
  }

  async continueTask(ctx: TaskRuntimeContext, input: TurnInput): Promise<void> {
    await this.dispatch(ctx, input);
  }

  /** 一次性问答用：不写 ctx.terminal，直接拿完整回复文本。失败时抛出带原因的错误。 */
  async ask(prompt: string, options?: { model?: string | null }): Promise<string | null> {
    const model = options?.model || this.agent.api?.defaultModel;
    if (!model) throw new Error(`${this.agent.name} 没有指定模型：请在这个自定义 Agent 的配置里填默认模型`);
    let res: Response;
    try {
      res = await fetch(`${baseUrl(this.agent)}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(this.agent) },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], stream: false }),
      });
    } catch (err) {
      throw networkAskError(this.agent.name, err);
    }
    if (!res.ok) throw await httpAskError(this.agent.name, res);
    const json = (await res.json()) as any;
    const text = json?.choices?.[0]?.message?.content;
    return typeof text === "string" && text.trim() ? text : null;
  }

  async stop(ctx: TaskRuntimeContext): Promise<void> {
    const key = `${this.id}:${runtimeKeyOf(ctx)}`;
    const controller = runningCustomApiRequests.get(key);
    if (controller) {
      ctx.log("正在终止自定义 API Agent 请求...");
      controller.abort();
    }
    ctx.setStatus("stopped");
  }
}

export class CustomCliAdapter implements AgentAdapter {
  readonly id: string;
  readonly kind = "custom-cli" as const;
  readonly name: string;
  readonly description: string;
  private readonly agent: CustomAgentDefinition;

  constructor(agent: CustomAgentDefinition) {
    this.agent = agent;
    this.id = agent.id;
    this.name = agent.name;
    this.description = agent.description || "自定义本机 CLI Agent";
  }

  isConfigured() {
    return Boolean(this.agent.cli?.command && this.agent.cli?.argsTemplate);
  }

  configHint() {
    return `${this.agent.cli?.command || "未设置 CLI 命令"} ${this.agent.cli?.argsTemplate || ""}`.trim();
  }

  /**
   * 只有用户自己在这个自定义 CLI 的"MCP 参数模板"里填了东西，才算支持 MCP——跟内置的
   * Codex/Claude Code/OpenClaw 不一样，AgentHub 没法替任意一个自定义命令行工具判断它认不认
   * MCP，只能让用户自己声明"我这个工具接受这样的参数"，不配就不在界面上露出 MCP 选择器。
   */
  get supportsMcp(): boolean {
    return Boolean(this.agent.cli?.mcpArgTemplate?.trim());
  }

  async discoverWorkspaces() {
    return [];
  }

  defaultModel(): string | null {
    return this.agent.cli?.defaultModel || null;
  }

  async listModels(): Promise<ModelOption[]> {
    const spec = this.agent.cli;
    if (!spec?.modelListCommand) return [];
    const [command, ...args] = splitArgs(spec.modelListCommand);
    if (!command) return [];
    try {
      const { stdout } = await runCommand(command, args, process.cwd(), Math.min(spec.timeoutSec || 900, 60));
      try {
        const parsed = JSON.parse(stdout);
        const models = parsed?.models ?? parsed?.data ?? parsed;
        if (Array.isArray(models)) {
          return models
            .map((m) => {
              if (typeof m === "string") return { id: m, label: m };
              const id = m.key ?? m.id ?? m.name;
              return id ? { id: String(id), label: m.name && m.name !== id ? `${m.name} (${id})` : String(id) } : null;
            })
            .filter(Boolean) as ModelOption[];
        }
      } catch {
        // plain text list
      }
      return stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !/fetching|available|model/i.test(line))
        .map((line) => {
          const [id, ...rest] = line.split(/\s+/);
          return { id, label: rest.length ? `${rest.join(" ")} (${id})` : id };
        });
    } catch {
      return [];
    }
  }

  private async dispatch(ctx: TaskRuntimeContext, input: TurnInput): Promise<void> {
    if (!(await ensureRiskAllowed(ctx, input, this.name))) return;
    const spec = this.agent.cli;
    if (!spec?.command || !spec.argsTemplate) {
      ctx.agentMessage("自定义 CLI Agent 尚未配置命令或参数模板。");
      ctx.setStatus("failed");
      return;
    }
    if (input.images.length) ctx.log(`自定义 CLI Agent 暂不支持原生图片附件，已把 ${input.images.length} 张图片路径写入提示词作为兜底`);

    const prompt = spec.workspacePrompt
      ? buildWorkspacePrompt(ctx.workspacePath, input.text, ctx.workspacePrompt, ctx.workspaceKnowledge, input.images, ctx.workspaceAccessPaths)
      : input.text;
    const session = ctx.sessionKey || `${this.id}:${runtimeKeyOf(ctx)}`;
    const model = ctx.model || spec.defaultModel || "";
    const extraDirs = additionalWorkspaceDirs(ctx);
    // 只有用户自己填了 mcpArgTemplate，才说明这个自定义 CLI 真的支持按文件传 MCP 配置——
    // 格式沿用 Claude Code 的 {"mcpServers": {...}}，这是目前最通用的约定。跟 modelArgTemplate
    // 一样，调用结束（成功/失败/停止都算）就删，不留在磁盘上。
    const mcpConfigPath = ctx.mcpServers.length && spec.mcpArgTemplate?.trim() ? writeTempMcpConfigFile(runtimeKeyOf(ctx), ctx.mcpServers) : null;
    const templateValues = {
      prompt,
      rawPrompt: input.text,
      workspace: ctx.workspacePath,
      accessPaths: (ctx.workspaceAccessPaths ?? [ctx.workspacePath]).join(";"),
      addDirArgs: extraDirs.flatMap((dir) => ["--add-dir", dir]),
      model,
      session,
      mcpConfig: mcpConfigPath ?? "",
    };
    const args = splitTemplateArgs(spec.argsTemplate, templateValues);
    if (model && spec.modelArgTemplate?.trim() && !spec.argsTemplate.includes("{model}")) {
      const modelArgs = splitTemplateArgs(spec.modelArgTemplate, templateValues);
      if (spec.stdinTemplate?.trim() && args.at(-1) === "-") args.splice(args.length - 1, 0, ...modelArgs);
      else args.push(...modelArgs);
    }
    if (mcpConfigPath && spec.mcpArgTemplate?.trim() && !spec.argsTemplate.includes("{mcpConfig}")) {
      const mcpArgs = splitTemplateArgs(spec.mcpArgTemplate, templateValues);
      if (spec.stdinTemplate?.trim() && args.at(-1) === "-") args.splice(args.length - 1, 0, ...mcpArgs);
      else args.push(...mcpArgs);
    }
    if (mcpConfigPath) ctx.log(`已挂载 MCP: ${ctx.mcpServers.map((s) => s.name).join(", ")}`);
    const stdinText = spec.stdinTemplate?.trim() ? renderTemplate(spec.stdinTemplate, templateValues) : "";
    ctx.setSessionKey(session);
    ctx.terminal(`$ ${spec.command} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}${stdinText ? " < stdin" : ""}\n`);
    ctx.setStatus("running");

    try {
      const { code, stdout, stderr, stoppedReason } = await runCommand(
        spec.command,
        args,
        ctx.workspacePath,
        spec.timeoutSec || 900,
        stdinText,
        (_child, kill) => runningCustomCliProcesses.set(runtimeKeyOf(ctx), { kill })
      );
      runningCustomCliProcesses.delete(runtimeKeyOf(ctx));
      if (stoppedReason) {
        ctx.log(`自定义 CLI 进程已停止：${stoppedReason}`);
        return;
      }
      if (stderr.trim()) ctx.terminal(stderr);
      if (code !== 0 && !stdout.trim()) {
        ctx.agentMessage(`自定义 CLI Agent 调用失败（exit code ${code ?? "unknown"}）：\n${stderr.trim() || "没有输出"}`);
        ctx.setStatus("failed");
        return;
      }
      ctx.agentMessage(parseCliOutput(stdout, stderr, spec.outputMode));
      ctx.setStatus("review");
    } catch (err) {
      runningCustomCliProcesses.delete(runtimeKeyOf(ctx));
      ctx.agentMessage(`自定义 CLI Agent 无法启动：${(err as Error).message}`);
      ctx.setStatus("failed");
    } finally {
      cleanupTempMcpConfigFile(mcpConfigPath);
    }
  }

  async run(ctx: TaskRuntimeContext, input: TurnInput): Promise<void> {
    await this.dispatch(ctx, input);
  }

  async continueTask(ctx: TaskRuntimeContext, input: TurnInput): Promise<void> {
    await this.dispatch(ctx, input);
  }

  async stop(ctx: TaskRuntimeContext): Promise<void> {
    const running = runningCustomCliProcesses.get(runtimeKeyOf(ctx));
    if (running) {
      ctx.log("正在终止自定义 CLI 进程树...");
      running.kill("用户停止");
    }
    ctx.setStatus("stopped");
  }

  /** 一次性问答用：直接拿命令输出文本，不走工作区提示词注入。失败时抛出带原因的错误。 */
  async ask(prompt: string, options?: { model?: string | null; mcpServers?: McpServerSpec[] }): Promise<string | null> {
    const spec = this.agent.cli;
    if (!spec?.command || !spec.argsTemplate) throw new Error(`${this.agent.name} 还没有配置启动命令和参数模板`);
    const mcpConfigPath =
      options?.mcpServers?.length && spec.mcpArgTemplate?.trim()
        ? writeTempMcpConfigFile(`ask-${Date.now()}`, options.mcpServers)
        : null;
    try {
      const model = options?.model || spec.defaultModel || "";
      const templateValues = {
        prompt,
        rawPrompt: prompt,
        workspace: process.cwd(),
        accessPaths: "",
        addDirArgs: [],
        model,
        session: "",
        mcpConfig: mcpConfigPath ?? "",
      };
      const args = splitTemplateArgs(spec.argsTemplate, templateValues);
      if (model && spec.modelArgTemplate?.trim() && !spec.argsTemplate.includes("{model}")) {
        args.push(...splitTemplateArgs(spec.modelArgTemplate, templateValues));
      }
      if (mcpConfigPath && spec.mcpArgTemplate?.trim() && !spec.argsTemplate.includes("{mcpConfig}")) {
        args.push(...splitTemplateArgs(spec.mcpArgTemplate, templateValues));
      }
      const stdinText = spec.stdinTemplate?.trim() ? renderTemplate(spec.stdinTemplate, templateValues) : "";
      const { code, stdout, stderr } = await runCommand(spec.command, args, process.cwd(), Math.min(spec.timeoutSec || 900, ASK_TIMEOUT_SEC), stdinText);
      // 超时：runCommand 会把 code 置为 null 并在 stderr 里写明。
      if ((code === null || code !== 0) && !stdout.trim()) throw cliAskError(this.agent.name, code, stderr);
      const text = parseCliOutput(stdout, "", spec.outputMode);
      return text && text !== "(无输出)" ? text : null;
    } finally {
      cleanupTempMcpConfigFile(mcpConfigPath);
    }
  }
}

export function createCustomAdapter(agent: CustomAgentDefinition): AgentAdapter {
  return agent.mode === "api" ? new CustomApiAdapter(agent) : new CustomCliAdapter(agent);
}
