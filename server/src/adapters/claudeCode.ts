import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { config } from "../config.ts";
import { scanRisk, shouldGate } from "./riskPolicy.ts";
import { cliAvailable, killProcessTree, spawnCli } from "./winSpawn.ts";
import { buildWorkspacePrompt } from "./workspacePrompt.ts";
import { cleanupTempMcpConfigFile, writeTempMcpConfigFile } from "./mcpConfigFile.ts";
import { ASK_TIMEOUT_MS } from "./askErrors.ts";
import type { AgentAdapter, McpServerSpec, TaskRuntimeContext, TurnInput } from "./types.ts";
import { runtimeKeyOf } from "./types.ts";
import type { ModelOption, RiskLevel } from "../types.ts";

// `claude --help` 里 --model 的说明："Provide an alias for the latest model (e.g. 'fable',
// 'opus', or 'sonnet') or a model's full name"——这几个别名本来就会自动指向当前最新版本，
// 跟 Claude 官方客户端模型选择器里那几档（Opus/Sonnet/Fable/Haiku + 版本号）是同一回事，
// 不用像 Codex 那样去读一份内部缓存文件，用这几个公开别名已经足够稳定。
const CLAUDE_CODE_MODEL_OPTIONS: ModelOption[] = [
  { id: "opus", label: "Opus（最新版）" },
  { id: "sonnet", label: "Sonnet（最新版）" },
  { id: "haiku", label: "Haiku（最新版）" },
  { id: "fable", label: "Fable（最新版，按量计费）" },
];

const runningClaudeCodeProcesses = new Map<string, { child: ChildProcess; kill: (reason: string) => void }>();

// Claude Code adapter：通过本机 `claude` CLI 的 headless 模式（-p/--print，
// --output-format stream-json）驱动任务，逐行解析 JSONL 事件流。
// 参数（-p/--output-format/--model/-r/--allow-dangerously-skip-permissions）已经对照
// 桌面版自带的 claude.exe --help 核实过存在；实测调用时该 exe 作为独立子进程拿不到
// 桌面应用的登录态（"OAuth session expired and could not be refreshed"），要用的话
// 需要单独给这个 claude.exe 做一次登录（或配置 ANTHROPIC_API_KEY）。
// 逐工具审批：「请求批准」「帮我批准」两档用 --input-format stream-json + --permission-prompt-tool stdio，
// Claude Code 每次要做需要授权的操作（写文件、跑会改东西的命令……）都会在 stdout 发一条
// control_request(can_use_tool) 并停下来等；这里把它转成 AgentHub 的审批（审批页、needs_approval 状态、通知），
// 用户点了之后再用 control_response 把允许/拒绝送回去。只读操作 Claude Code 自己会放行，不会来问。

const MONTH_TO_NUM: Record<string, string> = {
  jan: "1",
  feb: "2",
  mar: "3",
  apr: "4",
  may: "5",
  jun: "6",
  jul: "7",
  aug: "8",
  sep: "9",
  oct: "10",
  nov: "11",
  dec: "12",
};

const CLAUDE_USAGE_CACHE_DIR = path.join(config.dataDir, "usage-cache");
const CLAUDE_USAGE_CACHE_FILE = path.join(CLAUDE_USAGE_CACHE_DIR, "claude-code.json");
let pendingUsageRefresh: Promise<void> | null = null;

interface ClaudeUsageSnapshot {
  timestamp: string;
  rawText: string;
  summary: string;
}

// "Sep 15, 9:30pm (Asia/Shanghai)" -> "9月15日 21:30（Asia/Shanghai）"
function translateResetTime(raw: string): string {
  const m = raw.match(/^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)$/i);
  if (!m) return raw;
  const [, mon, day, hourStr, minStr, ampm, tz] = m;
  const monthNum = MONTH_TO_NUM[mon.toLowerCase()];
  if (!monthNum) return raw;
  let hour = parseInt(hourStr, 10) % 12;
  if (ampm.toLowerCase() === "pm") hour += 12;
  return `${monthNum}月${day}日 ${String(hour).padStart(2, "0")}:${minStr ?? "00"}（${tz}）`;
}

// claude CLI 的 /usage 只输出英文，这里把 "Current session/week: N% used · resets ..."
// 转成中文，日期/时区解析失败就原样保留那一段，不影响百分比这个最关键的数字。
function translateUsageLine(raw: string): string {
  const m = raw.match(/^Current (session|week)(?:\s*\(([^)]*)\))?:\s*(\d+)%\s*used(?:\s*·\s*resets\s*(.+))?$/i);
  if (!m) return raw;
  const [, scope, extra, percent, resetsRaw] = m;
  const label = scope.toLowerCase() === "session" ? "当前会话" : "本周额度";
  const extraCn = extra ? `（${extra.toLowerCase() === "all models" ? "全部模型" : extra}）` : "";
  const reset = resetsRaw?.trim() ? `，${translateResetTime(resetsRaw.trim())} 重置` : "";
  return `${label}${extraCn}：已用 ${percent}%${reset}`;
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

function formatUsageSummary(text: string): string {
  const keyLines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^Current (session|week)/i.test(line));
  return keyLines.length ? ["Claude Code 额度", ...keyLines.map(translateUsageLine)].join("\n") : text.slice(0, 300);
}

function readUsageSnapshot(): ClaudeUsageSnapshot | null {
  try {
    if (!fs.existsSync(CLAUDE_USAGE_CACHE_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(CLAUDE_USAGE_CACHE_FILE, "utf8")) as ClaudeUsageSnapshot;
    if (!parsed?.timestamp || !parsed?.summary) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeUsageSnapshot(rawText: string): void {
  const snapshot: ClaudeUsageSnapshot = {
    timestamp: new Date().toISOString(),
    rawText,
    summary: formatUsageSummary(rawText),
  };
  fs.mkdirSync(CLAUDE_USAGE_CACHE_DIR, { recursive: true });
  fs.writeFileSync(CLAUDE_USAGE_CACHE_FILE, JSON.stringify(snapshot, null, 2), "utf8");
}

function refreshUsageSnapshotInBackground(): void {
  if (pendingUsageRefresh) return;
  pendingUsageRefresh = runUsageCommand()
    .then((text) => {
      if (text) writeUsageSnapshot(text);
    })
    .catch(() => undefined)
    .finally(() => {
      pendingUsageRefresh = null;
    });
}

function isMissingBinaryError(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "ENOENT");
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

// `assistant` 事件里已经带了完整的文本块，最后的 `result` 事件对纯文本回复来说
// 只是把同样的内容再吐一遍——两个都转发会导致 Chat 里同一句话出现两次，
// 所以每次 dispatch 都开一个新的 handler，记住这一轮有没有已经转发过文本。
function createLineHandler(ctx: TaskRuntimeContext) {
  let sawAssistantText = false;
  return function forwardStreamJsonLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const evt = JSON.parse(trimmed);
      if (typeof evt?.session_id === "string" && evt.session_id) ctx.setSessionKey(evt.session_id);
      const type = evt?.type;
      // 启动事件里带着这次实际用的模型（没选模型时就是 Claude Code 自己的默认模型）。
      if (type === "system" && evt.subtype === "init" && typeof evt.model === "string" && evt.model) ctx.reportModel?.(evt.model);
      if (type === "assistant" || type === "message") {
        const content = evt.message?.content ?? evt.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === "text" && block.text) {
              ctx.agentMessage(block.text);
              sawAssistantText = true;
            } else if (block?.type === "tool_use") {
              ctx.terminal(`$ [tool_use] ${block.name} ${JSON.stringify(block.input ?? {})}\n`);
            }
          }
        } else if (typeof content === "string") {
          ctx.agentMessage(content);
          sawAssistantText = true;
        }
      } else if (type === "result") {
        // 只有前面没拿到过任何文本块时才用 result 兜底，避免重复
        if (!sawAssistantText && typeof evt.result === "string") ctx.agentMessage(evt.result);
      } else if (type === "tool_result" || type === "tool_use_result") {
        ctx.terminal(`${typeof evt.output === "string" ? evt.output : JSON.stringify(evt.output ?? evt)}\n`);
      } else {
        ctx.log(`[claude] ${trimmed.slice(0, 500)}`);
      }
    } catch {
      ctx.terminal(line + "\n");
    }
  };
}

// claude CLI 的内置 /usage 命令能在 headless 模式下拿到真实的订阅额度信息
// （"Current session: 19% used · resets ..." / "Current week: 12% used · resets ..."），
// 这一步本身不计费（total_cost_usd 是 0）。拿不到就安静返回 null，不影响任务执行。
function runUsageCommand(): Promise<string | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnCli(config.claudeCode.bin, ["-p", "/usage", "--output-format", "json"], {});
    } catch {
      resolve(null);
      return;
    }
    child.stdin?.end();
    let stdout = "";
    child.stdout?.on("data", (d) => (stdout += d.toString("utf8")));
    child.on("error", () => resolve(null));
    const timeout = setTimeout(() => {
      child.kill();
      resolve(null);
    }, 20000);
    child.on("close", () => {
      clearTimeout(timeout);
      try {
        const parsed = JSON.parse(stdout);
        resolve(typeof parsed.result === "string" ? parsed.result : null);
      } catch {
        resolve(null);
      }
    });
  });
}

// 一次性问答用：同样走 claude -p "<prompt>" --output-format json，不计入真实对话 session，不绑定 Task。
// 失败（启动不了、超时、退出码非 0、返回报错）直接抛出带原因的错误，聊天据此显示"失败"而不是"没有返回内容"。
function runAskCommand(prompt: string, model?: string | null, mcpServers?: McpServerSpec[]): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let child;
    // ask() 没有 Task 那套审批队列，MCP 工具调用要能真的跑起来就只能跳过权限确认——
    // 跟 Task 的 permissionMode=full 是同一个风险等级，这里只在真的带了 MCP 时才加，
    // 没有 MCP 的普通一次性问答维持原来的行为不变。
    let mcpConfigPath: string | null = null;
    try {
      const args = ["-p", prompt, "--output-format", "json"];
      if (model) args.push("--model", model);
      if (mcpServers?.length) {
        mcpConfigPath = writeTempMcpConfigFile(`ask-${Date.now()}`, mcpServers);
        args.push("--mcp-config", mcpConfigPath, "--dangerously-skip-permissions");
      }
      child = spawnCli(config.claudeCode.bin, args, {});
    } catch (err) {
      cleanupTempMcpConfigFile(mcpConfigPath);
      reject(new Error(`启动 Claude Code 失败：${(err as Error).message}`));
      return;
    }
    child.stdin?.end();
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cleanupTempMcpConfigFile(mcpConfigPath);
      fn();
    };
    child.stdout?.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr?.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("error", (err) => finish(() => reject(new Error(`启动 Claude Code 失败：${err.message}`))));
    // 带 MCP 工具调用的一次性问答比纯文本慢得多（工具本身的启动/调用耗时），给够余量。
    const timeoutMs = ASK_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`Claude Code ${timeoutMs / 1000} 秒内没有回复，已超时`)));
    }, timeoutMs);
    child.on("close", (code) => {
      finish(() => {
        let parsed: any = null;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          // 不是 JSON：多半是启动阶段就报错了，下面用 stderr/stdout 拼原因
        }
        if (parsed && parsed.is_error) {
          reject(new Error(typeof parsed.result === "string" && parsed.result.trim() ? parsed.result.trim() : "Claude Code 返回了错误"));
          return;
        }
        if (parsed && typeof parsed.result === "string") {
          resolve(parsed.result.trim() ? parsed.result : null);
          return;
        }
        const detail = (stderr || stdout).trim().slice(-500);
        reject(new Error(detail ? `Claude Code 调用失败（退出码 ${code}）：${detail}` : `Claude Code 调用失败（退出码 ${code}），没有输出`));
      });
    });
  });
}

const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

interface CanUseToolRequest {
  tool_name?: string;
  display_name?: string;
  input?: Record<string, unknown>;
  description?: string;
  blocked_path?: string;
}

/** 把 Claude Code 的一次权限询问翻译成审批页里能看懂的一条：要做什么、为什么问、风险多大。 */
export function describeToolPermission(request: CanUseToolRequest): { command: string; reason: string; riskLevel: RiskLevel } {
  const tool = request.tool_name ?? "未知工具";
  const label = request.display_name || tool;
  const input = request.input ?? {};
  const str = (value: unknown) => (typeof value === "string" ? value : "");
  let command: string;
  if (SHELL_TOOLS.has(tool)) command = str(input.command) || `${label}（空命令）`;
  else if (EDIT_TOOLS.has(tool)) command = `${label} ${str(input.file_path) || str(input.notebook_path)}`.trim();
  else if (tool === "WebFetch") command = `WebFetch ${str(input.url)}`.trim();
  else command = `${label} ${JSON.stringify(input).slice(0, 300)}`;
  const risk = scanRisk(command);
  const detail = [
    request.description && request.description !== command ? request.description : null,
    request.blocked_path ? `涉及路径：${request.blocked_path}` : null,
    risk ? `风险：${risk.reason}` : null,
  ]
    .filter(Boolean)
    .join("；");
  return {
    command,
    reason: `Claude Code 请求使用 ${label}${detail ? `：${detail}` : ""}`,
    riskLevel: risk?.riskLevel ?? (SHELL_TOOLS.has(tool) || EDIT_TOOLS.has(tool) ? "medium" : "low"),
  };
}

async function dispatch(ctx: TaskRuntimeContext, input: TurnInput, resumeSessionId: string | null): Promise<void> {
  const text = input.text;
  const prompt = buildWorkspacePrompt(ctx.workspacePath, text, ctx.workspacePrompt, ctx.workspaceKnowledge, input.images, ctx.workspaceAccessPaths);
  if (input.images.length) ctx.log(`Claude Code adapter 暂不支持原生图片附件，已把 ${input.images.length} 张图片路径写入提示词作为兜底`);
  const risk = scanRisk(text);
  if (risk && shouldGate(risk.riskLevel, ctx.permissionMode)) {
    ctx.log(`检测到潜在高风险内容（${risk.reason}），先进入审批队列再派发给 Claude Code`);
    const decision = await ctx.requestApproval({
      command: text,
      cwd: ctx.workspacePath,
      riskLevel: risk.riskLevel,
      reason: risk.reason,
    });
    if (decision.decision === "deny") {
      ctx.agentMessage(`已取消派发给 Claude Code（原因：${decision.note ?? "用户拒绝"}）。`);
      ctx.setStatus("review");
      return;
    }
  }

  const args = [...config.claudeCode.args];
  const extraDirs = additionalWorkspaceDirs(ctx);
  if (extraDirs.length) {
    args.push("--add-dir", ...extraDirs);
    ctx.log(`额外允许目录: ${extraDirs.join(", ")}`);
  }
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  if (ctx.model) args.push("--model", ctx.model);
  // full 权限对应 claude CLI 真实的跳过权限模式。--allow-dangerously-skip-permissions 只是在交互 UI 里允许选择，
  // headless 模式需要直接启用 --dangerously-skip-permissions，否则仍会被 Claude Code 自己的目录/工具策略拦截。
  if (ctx.planMode) {
    // 实测 -p 下 plan 模式不会改工作区文件，只输出计划（会在 ~/.claude/plans 留一份计划文件）；这一轮不能叠加跳过权限。
    args.push("--permission-mode", "plan");
    ctx.log("计划模式：Claude Code 以 --permission-mode plan 运行，这一轮不会改文件");
  } else if (ctx.permissionMode === "full") {
    args.push("--dangerously-skip-permissions");
  } else if (ctx.permissionMode === "auto") {
    // "帮我批准"：Claude Code 自己的 auto 模式先自动放行低风险操作，拿不准的再来问（走下面的审批）。
    args.push("--permission-mode", "auto");
  }
  // 「请求批准」「帮我批准」：需要授权的操作交给 AgentHub 审批。计划模式本身不改文件、有自己的批准流程；完全访问不需要问。
  // 输出得是 stream-json 才能收到权限询问，用户在 CLAUDE_CODE_ARGS 里改掉了就退回老办法（没人回答 = 直接拒绝）。
  const interactivePermissions = !ctx.planMode && ctx.permissionMode !== "full" && args.join(" ").includes("stream-json");
  if (interactivePermissions) {
    if (!args.includes("--input-format")) args.push("--input-format", "stream-json");
    args.push("--permission-prompt-tool", "stdio");
    ctx.log("权限确认：Claude Code 需要授权的操作会进审批页等你批准");
  }
  let mcpConfigPath: string | null = null;
  if (ctx.mcpServers.length) {
    mcpConfigPath = writeTempMcpConfigFile(runtimeKeyOf(ctx), ctx.mcpServers);
    args.push("--mcp-config", mcpConfigPath);
    ctx.log(`已挂载 MCP: ${ctx.mcpServers.map((s) => s.name).join(", ")}`);
  }
  ctx.terminal(`$ ${config.claudeCode.bin} ${args.join(" ")} < stdin\n`);
  ctx.setStatus("running");

  await new Promise<void>((resolve) => {
    const child = spawnCli(config.claudeCode.bin, args, { cwd: ctx.workspacePath });
    // 交互权限模式下 stdin 要一直开着（权限答复从这里送回去），等 result 出来再关。
    if (interactivePermissions) child.stdin!.write(`${JSON.stringify({ type: "user", message: { role: "user", content: prompt } })}\n`);
    else child.stdin!.end(prompt);
    const forwardStreamJsonLine = createLineHandler(ctx);
    let processClosed = false;
    let waitingApprovals = 0;

    const sendToClaude = (message: unknown) => {
      if (processClosed || !child.stdin || child.stdin.destroyed || child.stdin.writableEnded) return;
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const answerPermission = async (requestId: string, request: CanUseToolRequest) => {
      const { command, reason, riskLevel } = describeToolPermission(request);
      ctx.log(`${reason}，等待审批：${command}`);
      waitingApprovals += 1;
      let decision: Awaited<ReturnType<TaskRuntimeContext["requestApproval"]>>;
      try {
        decision = await ctx.requestApproval({ command, cwd: ctx.workspacePath, riskLevel, reason });
      } finally {
        waitingApprovals -= 1;
      }
      if (processClosed) return;
      const allowed = decision.decision !== "deny";
      ctx.log(`审批结果：${allowed ? "允许" : "拒绝"} ${command}${decision.note ? `（${decision.note}）` : ""}`);
      sendToClaude({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: requestId,
          response: allowed
            ? { behavior: "allow", updatedInput: request.input ?? {} }
            : { behavior: "deny", message: decision.note ? `用户在 AgentHub 拒绝了这一步：${decision.note}` : "用户在 AgentHub 拒绝了这一步" },
        },
      });
      if (waitingApprovals === 0) ctx.setStatus("running");
    };

    /** 交互模式下拦截权限询问和最终结果，其余照常转发。 */
    const handleLine = (line: string) => {
      if (interactivePermissions) {
        let evt: any = null;
        try {
          evt = JSON.parse(line.trim());
        } catch {
          // 不是 JSON 就交给通用转发
        }
        if (evt?.type === "control_request") {
          const request = evt.request ?? {};
          if (request.subtype === "can_use_tool") {
            void answerPermission(String(evt.request_id), request).catch((err) => ctx.log(`处理权限询问出错：${(err as Error).message}`));
          } else {
            sendToClaude({ type: "control_response", response: { subtype: "error", request_id: evt.request_id, error: `AgentHub 不支持 ${request.subtype}` } });
          }
          return;
        }
        if (evt?.type === "control_response" || evt?.type === "control_cancel_request") return;
        if (evt?.type === "result") {
          forwardStreamJsonLine(line);
          child.stdin?.end();
          return;
        }
      }
      forwardStreamJsonLine(line);
    };

    let stderr = "";
    let sawOutput = false;
    let buffer = "";
    let stoppedReason: string | null = null;
    const cleanupRunningProcess = () => {
      if (runningClaudeCodeProcesses.get(runtimeKeyOf(ctx))?.child === child) runningClaudeCodeProcesses.delete(runtimeKeyOf(ctx));
    };
    runningClaudeCodeProcesses.set(runtimeKeyOf(ctx), {
      child,
      kill: (reason: string) => {
        stoppedReason = reason;
        killProcessTree(child);
      },
    });

    child.stdout!.on("data", (chunk: Buffer) => {
      sawOutput = true;
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        handleLine(line);
      }
    });
    child.stderr!.on("data", (d) => (stderr += d.toString("utf8")));

    child.on("error", (err) => {
      processClosed = true;
      cleanupRunningProcess();
      cleanupTempMcpConfigFile(mcpConfigPath);
      if (isMissingBinaryError(err)) {
        ctx.agentMessage(
          `Claude Code adapter 尚未接通：未在本机 PATH 中找到 "${config.claudeCode.bin}"。\n` +
            `安装 Claude Code CLI 并设置 CLAUDE_CODE_BIN 后即可使用 headless 模式驱动任务。`
        );
      } else {
        ctx.agentMessage(`调用 Claude Code 失败：${err.message}`);
      }
      ctx.setStatus("failed");
      resolve();
    });

    child.on("close", (code) => {
      processClosed = true;
      cleanupRunningProcess();
      cleanupTempMcpConfigFile(mcpConfigPath);
      // 进程没了，还在等的审批答复也送不回去了，别在审批页留着没用的按钮。
      if (waitingApprovals > 0) ctx.cancelPendingApprovals?.("Claude Code 已经结束，这条审批自动取消");
      if (stoppedReason) {
        ctx.log(`claude 进程已停止：${stoppedReason}`);
        resolve();
        return;
      }
      if (buffer.trim()) handleLine(buffer);
      if (stderr.trim()) ctx.terminal(stderr);
      if (code !== 0) {
        ctx.log(`claude 进程退出码 ${code}`);
        if (!sawOutput) ctx.agentMessage(`Claude Code 调用失败（exit code ${code}）：\n${stderr.trim()}`);
        ctx.setStatus("failed");
      } else {
        ctx.setStatus("review");
      }
      resolve();
    });
  });
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly kind = "claude-code" as const;
  readonly enforcesPlanMode = true as const;
  readonly name = "Claude Code";
  readonly description = "通过本机 claude CLI 的 headless 模式（stream-json）驱动任务";
  readonly supportsMcp = true as const;

  isConfigured() {
    return cliAvailable(config.claudeCode.bin);
  }
  configHint() {
    return `使用 CLAUDE_CODE_BIN="${config.claudeCode.bin}"，需要本机已安装并登录 Claude Code CLI`;
  }
  async discoverWorkspaces() {
    return [];
  }

  async listModels(): Promise<ModelOption[]> {
    return CLAUDE_CODE_MODEL_OPTIONS;
  }

  async getUsageSummary(): Promise<string | null> {
    const snapshot = readUsageSnapshot();
    refreshUsageSnapshotInBackground();
    if (!snapshot) {
      return "Claude Code 额度\n暂无本地额度快照：已在后台刷新，请稍后再点一次查询用量。";
    }
    return `${snapshot.summary}\n快照时间：${formatSnapshotTime(snapshot.timestamp)}\n后台刷新：已触发`;
  }

  async run(ctx: TaskRuntimeContext, input: TurnInput): Promise<void> {
    ctx.setSessionKey(`claude-code-${runtimeKeyOf(ctx)}`);
    await dispatch(ctx, input, null);
  }

  async continueTask(ctx: TaskRuntimeContext, input: TurnInput): Promise<void> {
    await dispatch(ctx, input, ctx.sessionKey);
  }

  async ask(prompt: string, options?: { model?: string | null; mcpServers?: McpServerSpec[] }): Promise<string | null> {
    return runAskCommand(prompt, options?.model, options?.mcpServers);
  }

  async stop(ctx: TaskRuntimeContext): Promise<void> {
    const running = runningClaudeCodeProcesses.get(runtimeKeyOf(ctx));
    if (running) {
      ctx.log("正在终止 Claude Code 进程树...");
      running.kill("用户停止");
    }
    ctx.setStatus("stopped");
  }
}
