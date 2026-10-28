import { config } from "../config.ts";
import { cliAvailable, spawnCli } from "./winSpawn.ts";
import { dispatchStreamJson, runAskCommand, stopStreamJsonRun, type StreamJsonCli } from "./claudeCode.ts";
import type { AgentAdapter, McpServerSpec, TaskRuntimeContext, TurnInput } from "./types.ts";
import { runtimeKeyOf } from "./types.ts";
import type { ModelOption } from "../types.ts";

// CodeBuddy Code（腾讯，npm 包 @tencent-ai/codebuddy-code，命令 codebuddy）：跟 WorkBuddy 同一个账号，
// 用的是账号自带的订阅 / 免费额度，不另外按量付费。它照着 Claude Code 做的——-p、--output-format stream-json、
// --resume、--permission-mode、--mcp-config、control_request(can_use_tool) 都一样，所以任务派发、审批、
// 一次性问答直接复用 Claude Code 那套实现。2026-10-27 对着真 codebuddy 2.177.0 实测出的差别：
// - 没有 --permission-prompt-tool 参数，--input-format stream-json 时权限询问本来就发到 stdout；
// - 权限答复要用 { allowed, reason, updatedInput }，回 Claude Code 那种 { behavior } 会被当成拒绝；
// - --output-format json 输出的是整段消息数组，结果在最后一条 type=result 里；
// - npm 装的 codebuddy.ps1 启动脚本不转发 stdin（prompt 送不进去，进程一直挂着），要走 codebuddy.cmd；
// - 登录信息加密存在 ~/.codebuddy/local_storage，没法不花额度地提前判断有没有登录，只能看它回不回 "Authentication required"。
// WorkBuddy 桌面版里也带了一份 codebuddy，但那是精简版（交互界面被关掉，没法 /login），所以要单独装完整版登录一次。

const LABEL = "CodeBuddy";
const LOGIN_HINT =
  "CodeBuddy 还没登录。请在终端运行 codebuddy，输入 /login，用你的 WorkBuddy 账号登录一次（登录信息保存在本机 ~/.codebuddy），再回来重试。";

// `codebuddy --help` 里 --model 的说明列出了当前账号能用的模型 ID，取不到时用这几个通用档位兜底。
const FALLBACK_MODELS: ModelOption[] = [
  { id: "default-model", label: "默认模型" },
  { id: "fast-model", label: "快速" },
  { id: "balanced-model", label: "均衡" },
  { id: "primary-model", label: "主力" },
  { id: "deep-model", label: "深度思考" },
];
const TIER_LABELS: Record<string, string> = Object.fromEntries(FALLBACK_MODELS.map((m) => [m.id, m.label]));
const MODEL_CACHE_TTL_MS = 60 * 60 * 1000;
let modelCache: { at: number; models: ModelOption[] } | null = null;

export function parseHelpModels(helpText: string): ModelOption[] {
  const match = helpText.match(/--model <model>[\s\S]*?Currently supported:\s*\(([^)]*)\)/);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => ({ id, label: TIER_LABELS[id] ?? id }));
}

function runHelp(): Promise<string> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnCli(config.codebuddy.bin, ["--help"], { preferCmdShim: true });
    } catch {
      resolve("");
      return;
    }
    child.stdin?.end();
    let out = "";
    child.stdout?.on("data", (d) => (out += d.toString("utf8")));
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on("error", () => resolve(""));
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

function cli(): StreamJsonCli {
  return {
    label: LABEL,
    bin: config.codebuddy.bin,
    baseArgs: config.codebuddy.args,
    permissionPromptFlag: false,
    permissionAnswerStyle: "codebuddy",
    preferCmdShim: true,
    notLoggedInPattern: /Authentication required|use \/login command/i,
    loginHint: LOGIN_HINT,
    defaultModel: config.codebuddy.defaultModel,
    missingBinaryHint:
      `CodeBuddy 还没装：本机找不到 "${config.codebuddy.bin}"。\n` +
      "运行 npm i -g @tencent-ai/codebuddy-code 安装，再在终端运行 codebuddy 并 /login 登录 WorkBuddy 账号。",
  };
}

export class CodeBuddyAdapter implements AgentAdapter {
  readonly kind = "codebuddy" as const;
  readonly name = "WorkBuddy（CodeBuddy）";
  readonly description = "通过本机 codebuddy CLI 驱动任务，用 WorkBuddy 账号自带的额度";
  readonly enforcesPlanMode = true as const;
  readonly supportsMcp = true as const;

  isConfigured() {
    return cliAvailable(config.codebuddy.bin, { preferCmdShim: true });
  }

  configHint() {
    return `使用 CODEBUDDY_BIN="${config.codebuddy.bin}"，需要安装 CodeBuddy Code（npm i -g @tencent-ai/codebuddy-code）并用 WorkBuddy 账号 /login`;
  }

  async discoverWorkspaces() {
    return [];
  }

  defaultModel(): string | null {
    return config.codebuddy.defaultModel || null;
  }

  async listModels(): Promise<ModelOption[]> {
    if (modelCache && Date.now() - modelCache.at < MODEL_CACHE_TTL_MS) return modelCache.models;
    const parsed = parseHelpModels(await runHelp());
    const models = parsed.length ? parsed : FALLBACK_MODELS;
    if (parsed.length) modelCache = { at: Date.now(), models };
    return models;
  }

  async run(ctx: TaskRuntimeContext, input: TurnInput): Promise<void> {
    ctx.setSessionKey(`codebuddy-${runtimeKeyOf(ctx)}`);
    await dispatchStreamJson(ctx, input, null, cli());
  }

  async continueTask(ctx: TaskRuntimeContext, input: TurnInput): Promise<void> {
    await dispatchStreamJson(ctx, input, ctx.sessionKey, cli());
  }

  async ask(prompt: string, options?: { model?: string | null; mcpServers?: McpServerSpec[] }): Promise<string | null> {
    return runAskCommand(prompt, options?.model || config.codebuddy.defaultModel || null, options?.mcpServers, cli());
  }

  async stop(ctx: TaskRuntimeContext): Promise<void> {
    stopStreamJsonRun(ctx, LABEL);
  }
}
