import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.ts";
import { getAdapter, toDescriptor } from "../adapters/registry.ts";
import { resolveCliBinary, spawnCli } from "../adapters/winSpawn.ts";
import { getCustomAgent } from "./customAgentService.ts";
import type {
  AgentDiagnosticCheck,
  AgentDiagnostics,
  AgentDiagnosticStatus,
  AgentDiagnosticSummary,
  AgentSetupAction,
  AgentSetupStep,
  ModelOption,
} from "../types.ts";

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

function addCheck(checks: AgentDiagnosticCheck[], label: string, status: AgentDiagnosticStatus, detail: string) {
  checks.push({ label, status, detail });
}

function worse(a: AgentDiagnosticStatus, b: AgentDiagnosticStatus): AgentDiagnosticStatus {
  const rank = { ok: 0, warn: 1, error: 2 };
  return rank[b] > rank[a] ? b : a;
}

function finalStatus(checks: AgentDiagnosticCheck[]): AgentDiagnosticStatus {
  return checks.reduce((status, check) => worse(status, check.status), "ok" as AgentDiagnosticStatus);
}

function statusOf(checks: AgentDiagnosticCheck[], label: string, fallback: AgentDiagnosticStatus = "warn"): AgentDiagnosticStatus {
  return checks.find((check) => check.label === label)?.status ?? fallback;
}

function command(label: string, value: string, description?: string): AgentSetupAction {
  return { kind: "copy_command", label, value, description };
}

function value(label: string, copiedValue: string, description?: string): AgentSetupAction {
  return { kind: "copy_value", label, value: copiedValue, description };
}

function field(label: string, fieldKey: string, description?: string): AgentSetupAction {
  return { kind: "config_field", label, fieldKey, description };
}

function url(label: string, target: string, description?: string): AgentSetupAction {
  return { kind: "open_url", label, url: target, description };
}

function step(title: string, status: AgentDiagnosticStatus, description: string, actions: AgentSetupAction[] = []): AgentSetupStep {
  return { title, status, description, actions };
}

function summarizeOptions(options: ModelOption[]): AgentDiagnosticSummary {
  return {
    count: options.length,
    sample: options.slice(0, 8).map((item) => item.label || item.id),
  };
}

/** CLI 都还没装时，后面"登录 / 确认用量 / 保持最新"这些步骤不能显示成已完成。 */
function buildSetupSteps(
  agentId: string,
  checks: AgentDiagnosticCheck[],
  models?: AgentDiagnosticSummary,
  subAgents?: AgentDiagnosticSummary,
  cliMissing = false
): AgentSetupStep[] {
  const steps = buildSetupStepsRaw(agentId, checks, models, subAgents);
  if (!cliMissing) return steps;
  return steps.map((item, index) => (index > 0 && item.status === "ok" ? { ...item, status: "warn" as AgentDiagnosticStatus } : item));
}

function buildSetupStepsRaw(agentId: string, checks: AgentDiagnosticCheck[], models?: AgentDiagnosticSummary, subAgents?: AgentDiagnosticSummary): AgentSetupStep[] {
  const readyAction = command("创建任务前刷新探测", "npm run service:status", "确认 Xgent Hub 和本地服务在线。");
  const modelCount = models?.count ?? 0;
  const subAgentCount = subAgents?.count ?? 0;

  switch (agentId) {
    case "codex":
      return [
        step(
          "安装 Codex CLI",
          statusOf(checks, "Codex CLI"),
          "Xgent Hub 通过本机 codex exec 驱动 Codex。换电脑时需要先安装 CLI。",
          [
            command("复制安装命令", "npm install -g @openai/codex"),
            url("打开 Codex 说明", "https://github.com/openai/codex"),
            field("定位 CLI 路径", "CODEX_BIN"),
          ]
        ),
        step("登录 Codex", statusOf(checks, "登录状态"), "Codex CLI 需要本机登录态。", [
          command("复制登录命令", "codex login"),
          command("复制状态命令", "codex login status"),
        ]),
        step("设置权限边界", statusOf(checks, "沙箱"), "建议日常保持 workspace-write；完全访问只给可信任务。", [
          field("定位沙箱模式", "CODEX_SANDBOX_MODE"),
          field("定位超时设置", "CODEX_TIMEOUT"),
        ]),
        step(
          "保持 Codex CLI 最新",
          statusOf(checks, "版本", "ok"),
          "电脑上有两个 Codex：桌面版（有窗口，会自动更新）和命令行版（npm 装的，不会自动更新）。Xgent Hub 在后台用的是命令行版。" +
            "命令行版旧了，OpenAI 只给它提供旧模型，这里能选的模型就会比桌面版少。用下面的命令把命令行版更新到最新，再点「重新探测」。",
          [command("复制升级命令", "npm install -g @openai/codex@latest", "把 npm 装的命令行版 Codex 更新到最新版本。"), command("复制查看版本命令", "codex --version")]
        ),
      ];
    case "openclaw":
      return [
        step("安装 OpenClaw CLI", statusOf(checks, "OpenClaw CLI"), "Xgent Hub 通过 openclaw CLI 连接本机 Gateway。", [
          command("复制安装命令", "npm install -g openclaw"),
          url("打开 OpenClaw 文档", "https://docs.openclaw.ai"),
          field("定位 CLI 路径", "OPENCLAW_BIN"),
        ]),
        step("启动 Gateway", statusOf(checks, "Gateway"), "OpenClaw 需要 Gateway 常驻，模型和 Agent 都从 Gateway 侧读取。", [
          command("复制启动命令", "openclaw gateway run"),
          command("复制状态命令", "openclaw gateway status"),
        ]),
        step("选择模型和子 Agent", modelCount > 0 ? "ok" : "warn", `当前检测到 ${modelCount} 个模型、${subAgentCount} 个子 Agent。`, [
          field("定位默认 Agent ID", "OPENCLAW_AGENT_ID"),
          field("定位超时设置", "OPENCLAW_TIMEOUT"),
        ]),
      ];
    case "claude-code":
      return [
        step(
          "安装 Claude Code CLI",
          statusOf(checks, "Claude Code CLI"),
          "需要本机的 claude 命令。装了 Claude 桌面版的话会自动找到它自带的那一份，不用另装；没装的话用下面的命令安装（在 PowerShell 里运行），装完运行一次 claude 登录。",
          [
            command("复制安装命令", "irm https://claude.ai/install.ps1 | iex", "Claude Code 官方安装脚本（PowerShell）。也可以用 npm install -g @anthropic-ai/claude-code。"),
            url("打开安装说明", "https://code.claude.com/docs/en/setup"),
            command("复制登录命令", "claude auth login"),
            field("定位 CLI 路径", "CLAUDE_CODE_BIN"),
          ]
        ),
        step("确认 headless 参数", statusOf(checks, "Headless 参数"), "stream-json 输出依赖 --print --output-format stream-json --verbose。", [
          value("复制推荐参数", "--print --output-format stream-json --verbose"),
          field("定位 CLI 参数", "CLAUDE_CODE_ARGS"),
        ]),
        step("确认用量/登录", statusOf(checks, "用量/登录", "ok"), "如果用量查不到，通常是 CLI 登录态或订阅状态问题。", [
          command("复制用量命令", "claude -p /usage --output-format json"),
        ]),
      ];
    case "antigravity":
      return [
        step(
          "安装 Antigravity CLI",
          statusOf(checks, "Antigravity CLI"),
          "Xgent Hub 通过 agy 命令（Antigravity CLI）调用 Antigravity。用下面的命令安装（在 PowerShell 里运行），装完运行一次 agy 登录。",
          [
            command("复制安装命令", "irm https://antigravity.google/cli/install.ps1 | iex", "Antigravity CLI 官方安装脚本（PowerShell）。"),
            url("打开下载页", "https://antigravity.google/download"),
            field("定位 agy 路径", "ANTIGRAVITY_BIN"),
            command("复制模型命令", "agy models"),
          ]
        ),
        step("登录并选择模型", modelCount > 0 ? "ok" : "warn", `当前检测到 ${modelCount} 个模型。Antigravity 没有子 Agent，只需要模型选择。`, [
          command("复制登录/打开命令", "agy"),
          field("定位默认模型", "ANTIGRAVITY_MODEL"),
          field("定位推理强度", "ANTIGRAVITY_EFFORT"),
        ]),
        step("确认额度", statusOf(checks, "用量/登录", "ok"), "额度信息来自 agy 的 /usage 和 /credits。", [
          command("复制额度命令", "agy -p /usage"),
        ]),
      ];
    case "ark-cli":
      return [
        step("安装 Ark CLI", statusOf(checks, "Ark CLI"), "Xgent Hub 通过 arkcli +chat 调用火山方舟。", [
          command("复制安装命令", "npm install -g @volcengine/ark-cli@latest"),
          field("定位 CLI 路径", "ARK_CLI_BIN"),
        ]),
        step("登录或配置 API Key", statusOf(checks, "登录状态"), "可以用 arkcli auth login，也可以在 Xgent Hub 中填 API Key。", [
          command("复制登录命令", "arkcli auth login"),
          field("定位 API Key", "ARK_CLI_API_KEY"),
          field("定位 Profile", "ARK_CLI_PROFILE"),
        ]),
        step("配置模型 / Endpoint", modelCount > 0 || config.arkCli.defaultModel ? "ok" : "warn", "Platform profile 通常需要 ep-* 推理接入点；没有 Endpoint 时先保留手动文本框。", [
          field("定位模型/Endpoint", "ARK_CLI_MODEL"),
          command("复制资源列表命令", "arkcli resources list --modality text --format json"),
        ]),
      ];
    case "ollama":
      return [
        step("安装并启动 Ollama", statusOf(checks, "Ollama API"), "Ollama 用来在本机跑开源模型，Xgent Hub 直连它的本地接口。没装的话先下载安装，装好后一般会自动在后台运行。", [
          url("下载 Ollama", "https://ollama.com/download"),
          command("复制启动命令", "ollama serve"),
          field("定位 Base URL", "OLLAMA_BASE_URL"),
        ]),
        step("拉取并选择模型", modelCount > 0 ? "ok" : "warn", `当前检测到 ${modelCount} 个本地模型。`, [
          command("复制示例拉取命令", "ollama pull qwen3:8b"),
          command("复制模型列表命令", "ollama list"),
          field("定位默认模型", "OLLAMA_MODEL"),
        ]),
      ];
    case "tokenezgo":
      return [
        step("获取 API Key", statusOf(checks, "API Key"), "TokenEZGO 是 Xgent Hub 预置的推荐 OpenAI 兼容 API 中转站，先充值再获取 API Key。", [
          url("打开充值页面", "https://tokenezgo.com", "打开 TokenEZGO 获取余额和 API Key。"),
          field("定位 Base URL", "TOKENEZGO_BASE_URL"),
          field("定位 API Key", "TOKENEZGO_API_KEY"),
          field("定位默认模型", "TOKENEZGO_MODEL"),
        ]),
        step("刷新模型", modelCount > 0 ? "ok" : "warn", `当前检测到 ${modelCount} 个模型；如果网关不暴露 /models，可以手动填默认模型。`, [
          value("复制默认 Base URL", "https://tokenezgo.com/v1"),
        ]),
      ];
    case "doubao":
      return [
        step("填写火山方舟 API", statusOf(checks, "API Key"), "到火山方舟控制台创建 API Key 后填到这里。API 模式只负责模型对话，不会改本地文件。", [
          url("打开火山方舟控制台", "https://console.volcengine.com/ark"),
          field("定位 Base URL", "DOUBAO_BASE_URL"),
          field("定位 API Key", "DOUBAO_API_KEY"),
          field("定位模型/Endpoint", "DOUBAO_MODEL"),
        ]),
        step("选择模型 / Endpoint", modelCount > 0 || config.doubao.defaultModel ? "ok" : "warn", `当前检测到 ${modelCount} 个模型；也可以手动填写火山方舟模型或接入点 ID。`, [
          value("复制默认 Base URL", "https://ark.cn-beijing.volces.com/api/v3"),
        ]),
      ];
    case "hermes":
      return [
        step(
          "接入本机 OpenAI 兼容服务",
          statusOf(checks, "Hermes API"),
          "Hermes 这一项用来接本机任意 OpenAI 兼容的模型服务（比如用 vLLM、LM Studio、llama.cpp 跑起来的 Hermes 等模型），默认地址 http://127.0.0.1:8000。没有这类服务可以不用管它。",
          [
          field("定位 Base URL", "HERMES_BASE_URL"),
          field("定位 API Key", "HERMES_API_KEY"),
          field("定位默认模型", "HERMES_MODEL"),
          ]
        ),
      ];
    case "mock":
      return [
        step("直接测试 UI", "ok", "Mock Agent 不依赖外部服务，可用于验证任务、审批、文件和 Diff 流程。", [readyAction]),
      ];
    default: {
      const custom = getCustomAgent(agentId);
      if (custom?.mode === "api") {
        return [
          step("填写 API 参数", statusOf(checks, "API Key"), "自定义 API 使用 OpenAI 兼容 /chat/completions。", [
            field("定位 Base URL", "CUSTOM_API_BASE_URL"),
            field("定位 API Key", "CUSTOM_API_KEY"),
            field("定位默认模型", "CUSTOM_API_MODEL"),
          ]),
          step("验证模型列表", modelCount > 0 ? "ok" : "warn", `当前检测到 ${modelCount} 个模型；如果网关不支持 /models，可以手动填默认模型。`, []),
        ];
      }
      return [
        step("填写 CLI 参数", statusOf(checks, "CLI 命令"), "自定义 CLI 通过命令和参数模板把任务交给本机工具。", [
          field("定位 CLI 命令", "CUSTOM_CLI_COMMAND"),
          field("定位参数模板", "CUSTOM_CLI_ARGS_TEMPLATE"),
          field("定位模型参数", "CUSTOM_CLI_MODEL_ARG_TEMPLATE"),
        ]),
      ];
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** "codex-cli 0.162.0-alpha.17.2" → "0.162.0-alpha.17.2" */
function parseCodexVersion(text: string): string | null {
  return text.match(/(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/)?.[1] ?? null;
}

/** 只比主版本号部分（0.162.0-alpha 和 0.162.0 算同一档），a 比 b 旧返回负数。 */
function compareVersionCore(a: string, b: string): number {
  const pa = a.split(/[-+]/)[0].split(".").map(Number);
  const pb = b.split(/[-+]/)[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

let npmLatestCache: { version: string | null; at: number } | null = null;

/** npm 上 @openai/codex 的最新版本，12 小时问一次；没网就算了。 */
async function latestCodexOnNpm(): Promise<string | null> {
  if (npmLatestCache && Date.now() - npmLatestCache.at < 12 * 60 * 60 * 1000) return npmLatestCache.version;
  let version: string | null = null;
  try {
    const res = await fetch("https://registry.npmjs.org/@openai/codex/latest", { signal: AbortSignal.timeout(6_000) });
    if (res.ok) version = ((await res.json()) as { version?: string }).version ?? null;
  } catch {
    version = null;
  }
  npmLatestCache = { version, at: Date.now() };
  return version;
}

/** Codex 桌面版自带的命令行（%LOCALAPPDATA%\OpenAI\Codex\bin\<哈希>\codex.exe），取最新那个的版本。 */
async function desktopCodexVersion(): Promise<string | null> {
  if (process.platform !== "win32") return null;
  const binRoot = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "OpenAI", "Codex", "bin");
  let newest: string | null = null;
  try {
    for (const dir of fs.readdirSync(binRoot)) {
      const exe = path.join(binRoot, dir, "codex.exe");
      if (!fs.existsSync(exe)) continue;
      const result = await runCli(exe, ["--version"], 10_000);
      const version = parseCodexVersion(`${result.stdout}\n${result.stderr}`);
      if (version && (!newest || compareVersionCore(version, newest) > 0)) newest = version;
    }
  } catch {
    return null;
  }
  return newest;
}

function runCli(bin: string, args: string[], timeoutMs = 15_000, opts: { preferCmdShim?: boolean } = {}): Promise<CliResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: CliResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      child = spawnCli(bin, args, { cwd: process.cwd(), preferCmdShim: opts.preferCmdShim });
    } catch (err) {
      finish({ code: null, stdout: "", stderr: "", error: err as Error });
      return;
    }
    child.stdin?.end();

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr?.on("data", (d) => (stderr += d.toString("utf8")));

    const timer = setTimeout(() => {
      child.kill();
      finish({ code: null, stdout, stderr: `${stderr}\n命令超时。`.trim() });
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ code: null, stdout, stderr, error });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ code, stdout, stderr });
    });
  });
}

async function fetchJson(url: string, headers?: Record<string, string>, timeoutMs = 10_000): Promise<{ ok: boolean; status?: number; data?: any; text?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    const text = await res.text().catch(() => "");
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // plain text health response
    }
    return { ok: res.ok, status: res.status, data, text };
  } catch (err) {
    return { ok: false, text: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

function checkCli(checks: AgentDiagnosticCheck[], label: string, bin: string, opts: { preferCmdShim?: boolean } = {}): string | null {
  const resolved = resolveCliBinary(bin, opts);
  if (resolved) addCheck(checks, label, "ok", resolved);
  else addCheck(checks, label, "error", `找不到 ${bin}`);
  return resolved;
}

function authHeaders(apiKey: string): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

function parseArkAuth(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout);
    if (parsed?.logged_in) {
      const profile = parsed.active_profile?.name ? `，profile=${parsed.active_profile.name}` : "";
      const kind = parsed.active_profile?.type ? `，类型=${parsed.active_profile.type}` : "";
      const remaining = parsed.volc_sso?.remaining ? `，SSO 剩余 ${parsed.volc_sso.remaining}` : "";
      return `已登录（${parsed.auth_method ?? "arkcli"}${profile}${kind}${remaining}）`;
    }
    return "arkcli 未登录";
  } catch {
    return stripAnsi(stdout).trim().slice(0, 300) || "无法解析登录状态";
  }
}

async function collectModels(checks: AgentDiagnosticCheck[], agentId: string): Promise<AgentDiagnosticSummary | undefined> {
  const adapter = getAdapter(agentId);
  if (!adapter?.listModels) return undefined;
  const models = await withTimeout(adapter.listModels(), 35_000, [] as ModelOption[]);
  if (models.length > 0) {
    addCheck(checks, "模型列表", "ok", `检测到 ${models.length} 个模型`);
  } else {
    addCheck(checks, "模型列表", "warn", "没有检测到可选模型；如果该 Agent 支持手动模型名，可在配置里填写默认模型。");
  }
  return summarizeOptions(models);
}

async function collectSubAgents(checks: AgentDiagnosticCheck[], agentId: string): Promise<AgentDiagnosticSummary | undefined> {
  const adapter = getAdapter(agentId);
  if (!adapter?.listSubAgents) return undefined;
  const subAgents = await withTimeout(adapter.listSubAgents(), 25_000, [] as ModelOption[]);
  if (subAgents.length > 0) addCheck(checks, "子 Agent", "ok", `检测到 ${subAgents.length} 个子 Agent`);
  else addCheck(checks, "子 Agent", "ok", "没有检测到子 Agent，默认路由仍可使用。");
  return summarizeOptions(subAgents);
}

async function collectUsage(checks: AgentDiagnosticCheck[], agentId: string): Promise<string | null | undefined> {
  const adapter = getAdapter(agentId);
  if (!adapter?.getUsageSummary) return undefined;
  const usage = await withTimeout(adapter.getUsageSummary(), 35_000, null);
  if (usage) addCheck(checks, "用量/登录", "ok", usage.split("\n")[0] ?? "已返回用量信息");
  else addCheck(checks, "用量/登录", "warn", "未返回用量信息；可能是不支持查询、未登录或服务暂不可用。");
  return usage;
}

/** 返回 true 表示这个 Agent 依赖的 CLI 在本机找不到。 */
async function diagnoseBuiltin(agentId: string, checks: AgentDiagnosticCheck[], nextSteps: string[]): Promise<boolean> {
  switch (agentId) {
    case "codex": {
      if (!checkCli(checks, "Codex CLI", config.codex.bin, { preferCmdShim: true })) {
        nextSteps.push("安装：npm install -g @openai/codex，然后运行 codex login。");
        return true;
      }
      const status = await runCli(config.codex.bin, ["login", "status"], 15_000, { preferCmdShim: true });
      const text = stripAnsi(`${status.stdout}\n${status.stderr}`).trim();
      if (status.code === 0 && /logged in/i.test(text)) addCheck(checks, "登录状态", "ok", text);
      else {
        addCheck(checks, "登录状态", "warn", text || "无法确认 Codex 登录状态");
        nextSteps.push("在终端运行 codex login，完成后再刷新诊断。");
      }
      addCheck(checks, "沙箱", config.codex.sandboxMode === "danger-full-access" ? "warn" : "ok", config.codex.sandboxMode);

      // 版本：Xgent Hub 用的是命令行版 Codex（npm 装的），它不会跟着桌面版自动更新。版本旧时 OpenAI 只给它旧模型，
      // 这里的模型列表就会比桌面版少（两者还共用 ~/.codex/models_cache.json，谁最后跑谁的列表生效）。
      const versionResult = await runCli(config.codex.bin, ["--version"], 15_000, { preferCmdShim: true });
      const cliVersion = parseCodexVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
      const [npmLatest, desktopVersion] = await Promise.all([latestCodexOnNpm(), desktopCodexVersion()]);
      const newer = [npmLatest, desktopVersion].filter((v): v is string => Boolean(v)).sort((a, b) => compareVersionCore(b, a))[0] ?? null;
      const reference = [npmLatest ? `npm 最新 ${npmLatest}` : null, desktopVersion ? `桌面版自带 ${desktopVersion}` : null].filter(Boolean).join("，");
      if (!cliVersion) {
        addCheck(checks, "版本", "warn", "读不到命令行版 Codex 的版本号");
      } else if (newer && compareVersionCore(cliVersion, newer) < 0) {
        addCheck(
          checks,
          "版本",
          "warn",
          `命令行版 Codex 是 ${cliVersion}，比较旧（${reference}）。版本旧时 OpenAI 只给它提供旧模型，所以这里的模型会比桌面版少。用下面「保持 Codex CLI 最新」里的命令升级。`
        );
        nextSteps.push("升级命令行版 Codex：npm install -g @openai/codex@latest，升级后点「重新探测」。");
      } else {
        addCheck(checks, "版本", "ok", `${cliVersion}（已是最新${reference ? `；${reference}` : ""}）`);
      }
      break;
    }
    case "openclaw": {
      if (!checkCli(checks, "OpenClaw CLI", config.openclaw.bin)) {
        nextSteps.push("安装 OpenClaw CLI：npm install -g openclaw，并确认 openclaw 在 PATH 中。");
        return true;
      }
      const gateway = await runCli(config.openclaw.bin, ["gateway", "status"], 25_000);
      const output = stripAnsi(`${gateway.stdout}\n${gateway.stderr}`).trim();
      if (gateway.code === 0 && /Connectivity probe:\s*ok|Runtime:\s*running/i.test(output)) {
        const line = output.split(/\r?\n/).find((l) => /Runtime:|Connectivity probe:|Dashboard:/i.test(l));
        addCheck(checks, "Gateway", "ok", line ?? "Gateway 正常");
      } else {
        addCheck(checks, "Gateway", "warn", output.slice(0, 500) || "无法确认 Gateway 状态");
        nextSteps.push("运行 openclaw gateway run 或确认 OpenClaw Gateway 服务已启动。");
      }
      break;
    }
    case "claude-code": {
      if (!checkCli(checks, "Claude Code CLI", config.claudeCode.bin)) {
        nextSteps.push("安装 Claude Code：在 PowerShell 运行 irm https://claude.ai/install.ps1 | iex，或在配置里填写 CLAUDE_CODE_BIN 的完整路径。");
        return true;
      }
      if (config.claudeCode.bin !== config.claudeCode.configuredBin) {
        addCheck(checks, "版本", "ok", `配置的是 ${config.claudeCode.configuredBin}，已自动改用最新版本 ${config.claudeCode.bin}`);
      }
      addCheck(checks, "Headless 参数", "ok", config.claudeCode.args.join(" "));
      break;
    }
    case "antigravity": {
      if (!checkCli(checks, "Antigravity CLI", config.antigravity.bin)) {
        nextSteps.push("安装 Antigravity CLI：在 PowerShell 运行 irm https://antigravity.google/cli/install.ps1 | iex，或在配置里填写 agy.exe 的完整路径。");
        return true;
      }
      if (config.antigravity.defaultModel) addCheck(checks, "默认模型", "ok", config.antigravity.defaultModel);
      break;
    }
    case "ark-cli": {
      if (!checkCli(checks, "Ark CLI", config.arkCli.bin)) {
        nextSteps.push("安装：npm install -g @volcengine/ark-cli@latest，然后运行 arkcli auth login。");
        return true;
      }
      const auth = await runCli(config.arkCli.bin, ["auth", "status", "--format", "json"], 20_000);
      const authText = `${auth.stdout}\n${auth.stderr}`;
      const parsedAuth = parseArkAuth(auth.stdout);
      if (/已登录/.test(parsedAuth) || config.arkCli.apiKey) addCheck(checks, "登录状态", "ok", parsedAuth);
      else {
        addCheck(checks, "登录状态", "warn", stripAnsi(authText).trim().slice(0, 500) || "arkcli 未登录");
        nextSteps.push("运行 arkcli auth login，或在配置中填写 ARK_CLI_API_KEY。");
      }
      if (config.arkCli.defaultModel) addCheck(checks, "默认模型/Endpoint", "ok", config.arkCli.defaultModel);
      else nextSteps.push("如果当前是 platform profile，需要在 ARK_CLI_MODEL 或新建任务模型框里填 ep-* Endpoint ID。");
      break;
    }
    case "ollama": {
      const url = `${config.ollama.baseUrl.replace(/\/$/, "")}/api/tags`;
      const tags = await fetchJson(url, undefined, 8_000);
      if (tags.ok) addCheck(checks, "Ollama API", "ok", url);
      else {
        addCheck(checks, "Ollama API", "error", tags.text || `HTTP ${tags.status}`);
        nextSteps.push("启动 Ollama：ollama serve，或用 start.bat 让 Xgent Hub 带起 Ollama。");
      }
      break;
    }
    case "tokenezgo": {
      if (!config.tokenezgo.apiKey) {
        addCheck(checks, "API Key", "error", "TOKENEZGO_API_KEY 未设置");
        nextSteps.push("打开 https://tokenezgo.com 充值并获取 API Key，然后在推荐 API 中转站配置页填写。");
      } else addCheck(checks, "API Key", "ok", "已设置");
      addCheck(checks, "Base URL", config.tokenezgo.baseUrl ? "ok" : "error", config.tokenezgo.baseUrl || "未设置");
      break;
    }
    case "doubao": {
      if (!config.doubao.apiKey) {
        addCheck(checks, "API Key", "error", "DOUBAO_API_KEY 未设置");
        nextSteps.push("在 Doubao 配置页填写火山方舟 API Key，或暂时保留手动模型/Endpoint 文本框。");
      } else addCheck(checks, "API Key", "ok", "已设置");
      addCheck(checks, "Base URL", config.doubao.baseUrl ? "ok" : "error", config.doubao.baseUrl || "未设置");
      break;
    }
    case "hermes": {
      const url = `${config.hermes.baseUrl.replace(/\/$/, "")}/v1/models`;
      const models = await fetchJson(url, config.hermes.apiKey ? authHeaders(config.hermes.apiKey) : undefined, 8_000);
      if (models.ok) addCheck(checks, "Hermes API", "ok", url);
      else {
        addCheck(checks, "Hermes API", "warn", models.text || `HTTP ${models.status}`);
        nextSteps.push("确认 Hermes OpenAI 兼容服务已启动，或检查 HERMES_BASE_URL。");
      }
      break;
    }
    case "mock": {
      addCheck(checks, "本地模拟", "ok", "无需外部服务，适合测试 UI/审批/Diff 流程。");
      break;
    }
  }
  return false;
}

async function diagnoseCustom(agentId: string, checks: AgentDiagnosticCheck[], nextSteps: string[]) {
  const custom = getCustomAgent(agentId);
  if (!custom) return;

  if (custom.mode === "api") {
    const baseUrl = custom.api?.baseUrl ?? "";
    const apiKey = custom.api?.apiKey ?? "";
    addCheck(checks, "Base URL", baseUrl ? "ok" : "error", baseUrl || "未设置");
    addCheck(checks, "API Key", apiKey ? "ok" : "error", apiKey ? "已设置" : "未设置");
    if (!baseUrl || !apiKey) nextSteps.push("在配置页补齐 Base URL 和 API Key。");
    return;
  }

  const command = custom.cli?.command ?? "";
  if (!command) {
    addCheck(checks, "CLI 命令", "error", "未设置");
    nextSteps.push("在配置页填写 CLI 命令和参数模板。");
    return;
  }
  checkCli(checks, "CLI 命令", command);
  addCheck(checks, "参数模板", custom.cli?.argsTemplate ? "ok" : "error", custom.cli?.argsTemplate || "未设置");
}

function statusText(status: AgentDiagnosticStatus): string {
  if (status === "ok") return "可用";
  if (status === "warn") return "需要注意";
  return "不可用";
}

export async function diagnoseAgent(agentId: string): Promise<AgentDiagnostics> {
  const adapter = getAdapter(agentId);
  if (!adapter) throw new Error(`未知 agent: ${agentId}`);

  const descriptor = toDescriptor(adapter);
  const checks: AgentDiagnosticCheck[] = [];
  const nextSteps: string[] = [];

  // CLI 类 Agent 没装 CLI 时 configured=false，但配置本身没错，标成"需配置"，真正的错误由下面的 CLI 检查给出。
  const cliKinds = new Set(["codex", "claude-code", "antigravity", "ark-cli", "openclaw"]);
  addCheck(
    checks,
    "Agent 配置",
    descriptor.configured ? "ok" : cliKinds.has(agentId) ? "warn" : "error",
    descriptor.configHint || "无额外配置"
  );
  const cliMissing = await diagnoseBuiltin(agentId, checks, nextSteps);
  await diagnoseCustom(agentId, checks, nextSteps);

  // CLI 都找不到时，模型列表、用量这些查询要么查不到、要么返回写死的默认值，显示出来只会是假的"正常"。
  const [models, subAgents, usage] = cliMissing
    ? [undefined, undefined, undefined]
    : await Promise.all([
        collectModels(checks, agentId),
        collectSubAgents(checks, agentId),
        // 没配置好（比如中转站没填 Key）时用量查询只会返回一句固定说明，不能算"正常"。
        descriptor.configured ? collectUsage(checks, agentId) : Promise.resolve(undefined),
      ]);
  const setupSteps = buildSetupSteps(agentId, checks, models, subAgents, cliMissing);

  if (!nextSteps.length) nextSteps.push("当前没有必须处理的问题，可以直接创建任务测试。");

  const status = finalStatus(checks);
  return {
    agentId,
    status,
    summary: `${descriptor.name}：${statusText(status)}`,
    updatedAt: new Date().toISOString(),
    checks,
    nextSteps,
    setupSteps,
    models,
    subAgents,
    usage,
  };
}
