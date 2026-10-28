import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { scanRisk, shouldGate } from "./riskPolicy.ts";
import { cliAvailable, killProcessTree, spawnCli } from "./winSpawn.ts";
import { buildWorkspacePrompt } from "./workspacePrompt.ts";
import type { AgentAdapter, TaskRuntimeContext, TurnInput } from "./types.ts";
import { runtimeKeyOf } from "./types.ts";
import type { ModelOption, PermissionMode } from "../types.ts";
import { ASK_TIMEOUT_MS } from "./askErrors.ts";

// DeepSeek Harness（dsh，DeepSeek 官方开源 agent，npm 包 @deepseek-ai/dsh，桌面版 "DeepSeek Harness"）。
// 走它的 headless 模式：`dsh --profile headless --json -`，任务从 stdin 进，stdout 一行一个事件
// （session / status / thinking / text / tool_call / tool_result / final），`--session-id` 接着上一轮。
// 2026-10-27 对着桌面版自带的 dsh（0.2.x）实测：
// - 桌面版的 dsh.cmd 只是 ELECTRON_RUN_AS_NODE=1 "DeepSeek Harness.exe" --expose-internals <app.asar>/…/cli.js，
//   这里直接这样启动，不经过 .cmd（cmd 会把带空格的参数拆坏）；
// - headless 默认用 API Key（deepseek-official）。要用桌面版登录的 DeepSeek 账号，得在补丁里把 credentials /
//   authorization / deepseek-account 三个插件打开，再把 provider 设成 deepseek-account；
// - 权限靠 DSH_PERMISSION_MODE：read-only / workspace-write（默认，工作区和临时目录外的写入会被拒）/ danger-full-access。
//   headless 没有审批通道，沙箱要越权时直接失败，不会停下来问——所以 AgentHub 这边只能派发前做风险预检；
// - Windows 上工作区所在目录缺「修改权限」这一项时，workspace-write 沙箱起不来，所有命令都报
//   SetNamedSecurityInfoW failed (Win32 5)，读写文件不受影响。遇到时提示用户选完全访问或修目录权限。

const LABEL = "DeepSeek Harness";
const MODELS: ModelOption[] = [
  { id: "deepseek-flash", label: "DeepSeek Flash" },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
];
const LOGIN_HINT = "DeepSeek Harness 还没登录 DeepSeek 账号：请打开 DeepSeek Harness 桌面版登录一次，再回来重试。";
const API_KEY_HINT = "DeepSeek Harness 现在用 API Key 模式，但没找到 DEEPSEEK_API_KEY：在 .env 里配上，或把「账号方式」改回 account（用桌面版登录的账号）。";
const ACL_HINT =
  "DeepSeek Harness 的沙箱在这个工作区跑不了命令（Windows 文件权限不够：工作区目录缺少「修改权限」这一项，报错 SetNamedSecurityInfoW failed）。" +
  "读写文件不受影响。要跑命令可以：1）这个任务改用「完全访问权限」；2）在 DeepSeek Harness 桌面版里打开这个文件夹，按它的提示修复权限。";

const running = new Map<string, { child: ChildProcess; kill: (reason: string) => void }>();

interface Launch {
  command: string;
  baseArgs: string[];
  env: NodeJS.ProcessEnv;
  /** DSH_BIN 指向 npm 装的 dsh 时走 spawnCli（会挑 .cmd / .ps1）。 */
  viaShim: boolean;
}

function desktopPaths(home: string): { exe: string; cli: string } {
  if (process.platform === "darwin") {
    return {
      exe: path.join(home, "Contents", "MacOS", "DeepSeek Harness"),
      cli: path.join(home, "Contents", "Resources", "app.asar", "dsh", "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "cli.js"),
    };
  }
  return {
    exe: path.join(home, "DeepSeek Harness.exe"),
    cli: path.join(home, "resources", "app.asar", "dsh", "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "cli.js"),
  };
}

/** 优先用配置的 dsh 命令，其次桌面版自带的那份。都没有就 null。 */
export function resolveDshLaunch(): Launch | null {
  const bin = config.deepseekHarness.bin.trim();
  if (bin) return cliAvailable(bin, { preferCmdShim: true }) ? { command: bin, baseArgs: [], env: { ...process.env }, viaShim: true } : null;
  const { exe, cli } = desktopPaths(config.deepseekHarness.desktopDir);
  // app.asar 是文件不是目录，fs 看不到里面的 cli.js，只能确认 asar 本身在。
  const asar = cli.slice(0, cli.indexOf("app.asar") + "app.asar".length);
  if (!fs.existsSync(exe) || !fs.existsSync(asar)) return null;
  return { command: exe, baseArgs: ["--expose-internals", cli], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, viaShim: false };
}

function dshPermission(mode: PermissionMode, planMode: boolean): string {
  if (planMode) return "read-only";
  return mode === "full" ? "danger-full-access" : "workspace-write";
}

/** 账号 / 模型的补丁层，每次启动前按当前配置重写。 */
export function buildPatch(model: string): string {
  const effort = config.deepseekHarness.reasoningEffort.trim();
  const modelEntry = [
    "- id: agent-default-model",
    "  config:",
    `    provider: ${config.deepseekHarness.provider === "api-key" ? "deepseek-official" : "deepseek-account"}`,
    `    model: ${JSON.stringify(model)}`,
    ...(effort ? [`    reasoningEffort: ${JSON.stringify(effort)}`] : []),
  ];
  if (config.deepseekHarness.provider === "api-key") return `${modelEntry.join("\n")}\n`;
  const platform = process.platform === "darwin" ? "darwin" : "win32";
  return [
    "- id: credentials",
    "  disabled: false",
    "- id: authorization",
    "  disabled: false",
    "- id: deepseek-account",
    "  disabled: false",
    "  config:",
    `    desktopPlatform: ${platform}`,
    ...modelEntry,
    "",
  ].join("\n");
}

function writePatchFile(model: string): string {
  const dir = path.join(config.dataDir, "dsh");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "xgent-headless-patch.yml");
  fs.writeFileSync(file, buildPatch(model), "utf8");
  return file;
}

function spawnDsh(launch: Launch, args: string[], cwd: string, permission: string): ChildProcess {
  const env = { ...launch.env, DSH_PERMISSION_MODE: permission };
  const full = [...launch.baseArgs, ...args];
  if (launch.viaShim) return spawnCli(launch.command, full, { cwd, env, preferCmdShim: true });
  return nodeSpawn(launch.command, full, { cwd, env, windowsHide: true });
}

function headlessArgs(patchFile: string, sessionId: string | null): string[] {
  return ["--profile", "headless", "--patch", patchFile, "--json", ...(sessionId ? ["--session-id", sessionId] : []), "-"];
}

function friendlyError(code: string | undefined, message: string): string {
  if (code === "ACCOUNT_SIGN_IN_REQUIRED") return LOGIN_HINT;
  if (code === "MISSING_CREDENTIAL") return API_KEY_HINT;
  return `DeepSeek Harness 出错：${message}`;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…（共 ${text.length} 字）` : text;
}

/** 把 dsh 的 JSON 事件转成任务里的消息 / 终端输出。 */
export function createDshEventHandler(ctx: Pick<TaskRuntimeContext, "agentMessage" | "terminal" | "log" | "setSessionKey">) {
  let sawText = false;
  let error: string | null = null;
  let aclBlocked = false;
  return {
    handleLine(line: string) {
      const trimmed = line.trim();
      if (!trimmed) return;
      let evt: any;
      try {
        evt = JSON.parse(trimmed);
      } catch {
        ctx.log(`[dsh] ${clip(trimmed, 300)}`);
        return;
      }
      switch (evt?.type) {
        case "session":
          if (typeof evt.sessionId === "string" && evt.sessionId) ctx.setSessionKey(evt.sessionId);
          break;
        case "text":
          if (typeof evt.text === "string" && evt.text.trim()) {
            ctx.agentMessage(evt.text);
            sawText = true;
          }
          break;
        case "final":
          if (!sawText && typeof evt.text === "string" && evt.text.trim()) ctx.agentMessage(evt.text);
          break;
        case "tool_call":
          ctx.terminal(`$ [${evt.tool ?? "tool"}] ${clip(JSON.stringify(evt.input ?? {}), 400)}\n`);
          break;
        case "tool_result": {
          const result = typeof evt.result === "string" ? evt.result : JSON.stringify(evt.result ?? "");
          if (evt.status === "error" && /SetNamedSecurityInfoW failed/i.test(result)) aclBlocked = true;
          ctx.terminal(`${evt.status === "error" ? "[失败] " : ""}${clip(result, 2000)}\n`);
          break;
        }
        case "status":
          if (evt.phase === "turn_end" && evt.reason?.kind === "error") {
            error = friendlyError(evt.reason.error?.code, String(evt.reason.error?.message ?? "未知错误"));
          }
          break;
        case "thinking":
          break;
        default:
          ctx.log(`[dsh] ${clip(trimmed, 300)}`);
      }
    },
    get error() {
      return error;
    },
    get aclBlocked() {
      return aclBlocked;
    },
    get sawText() {
      return sawText;
    },
  };
}

async function dispatch(ctx: TaskRuntimeContext, input: TurnInput, resumeSessionId: string | null): Promise<void> {
  const launch = resolveDshLaunch();
  if (!launch) {
    ctx.agentMessage(
      "找不到 DeepSeek Harness：请安装 DeepSeek Harness 桌面版并登录 DeepSeek 账号；" +
        "装在别的位置的话，在配置里填 DSH_DESKTOP_DIR，或者把 DSH_BIN 指向 npm 装的 dsh。"
    );
    ctx.setStatus("failed");
    return;
  }
  const text = input.text;
  if (input.images.length) ctx.log(`DeepSeek Harness headless 暂不支持图片附件，已把 ${input.images.length} 张图片路径写入提示词作为兜底`);
  const risk = scanRisk(text);
  if (risk && shouldGate(risk.riskLevel, ctx.permissionMode)) {
    ctx.log(`检测到潜在高风险内容（${risk.reason}），先进入审批队列再派发给 DeepSeek Harness`);
    const decision = await ctx.requestApproval({ command: text, cwd: ctx.workspacePath, riskLevel: risk.riskLevel, reason: risk.reason });
    if (decision.decision === "deny") {
      ctx.agentMessage(`已取消派发给 DeepSeek Harness（原因：${decision.note ?? "用户拒绝"}）。`);
      ctx.setStatus("review");
      return;
    }
  }

  const model = ctx.model || config.deepseekHarness.defaultModel || MODELS[0].id;
  const permission = dshPermission(ctx.permissionMode, Boolean(ctx.planMode));
  if (ctx.planMode) ctx.log("计划模式：DeepSeek Harness 以只读权限运行，这一轮不会改文件");
  else if (ctx.permissionMode !== "full") {
    ctx.log("DeepSeek Harness headless 没有逐步审批：它在工作区里可以直接读写、跑命令，工作区外的写入会被它的沙箱拒绝。");
  }
  const prompt = buildWorkspacePrompt(ctx.workspacePath, text, ctx.workspacePrompt, ctx.workspaceKnowledge, input.images, ctx.workspaceAccessPaths);
  const sessionId = resumeSessionId?.startsWith("session-") ? resumeSessionId : null;
  const args = headlessArgs(writePatchFile(model), sessionId);
  ctx.reportModel?.(model);
  ctx.terminal(`$ dsh ${args.join(" ")} < stdin（DSH_PERMISSION_MODE=${permission}）\n`);
  ctx.setStatus("running");

  await new Promise<void>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnDsh(launch, args, ctx.workspacePath, permission);
    } catch (err) {
      ctx.agentMessage(`无法启动 DeepSeek Harness：${(err as Error).message}`);
      ctx.setStatus("failed");
      resolve();
      return;
    }
    child.stdin?.end(prompt);
    const handler = createDshEventHandler(ctx);
    let buffer = "";
    let stderr = "";
    let stoppedReason: string | null = null;
    const key = runtimeKeyOf(ctx);
    running.set(key, {
      child,
      kill: (reason) => {
        stoppedReason = reason;
        killProcessTree(child);
      },
    });
    const timeout = setTimeout(() => {
      stderr += `\nDeepSeek Harness 超时（${config.deepseekHarness.timeoutSec}s），已终止。\n`;
      killProcessTree(child);
    }, config.deepseekHarness.timeoutSec * 1000);

    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        handler.handleLine(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const finish = () => {
      clearTimeout(timeout);
      if (running.get(key)?.child === child) running.delete(key);
    };
    child.on("error", (err) => {
      finish();
      ctx.agentMessage(`无法启动 DeepSeek Harness：${err.message}`);
      ctx.setStatus("failed");
      resolve();
    });
    child.on("close", (code) => {
      finish();
      if (stoppedReason) {
        ctx.log(`DeepSeek Harness 已停止：${stoppedReason}`);
        resolve();
        return;
      }
      if (buffer.trim()) handler.handleLine(buffer);
      const errText = stderr.split(/\r?\n/).filter((line) => line.trim() && !/SOCKS proxy/.test(line)).join("\n");
      if (errText) ctx.terminal(`${clip(errText, 2000)}\n`);
      if (handler.aclBlocked) ctx.agentMessage(ACL_HINT);
      if (handler.error) {
        ctx.agentMessage(handler.error);
        ctx.setStatus("failed");
      } else if (code !== 0) {
        if (!handler.sawText) ctx.agentMessage(`DeepSeek Harness 调用失败（退出码 ${code}）：${clip(errText, 500) || "没有输出"}`);
        ctx.setStatus("failed");
      } else {
        ctx.setStatus("review");
      }
      resolve();
    });
  });
}

export class DeepSeekHarnessAdapter implements AgentAdapter {
  readonly kind = "deepseek-harness" as const;
  readonly name = "DeepSeek Harness";
  readonly description = "通过 DeepSeek Harness（dsh）的 headless 模式驱动任务，默认用桌面版登录的 DeepSeek 账号";
  readonly enforcesPlanMode = true as const;

  isConfigured() {
    return Boolean(resolveDshLaunch());
  }

  configHint() {
    return config.deepseekHarness.bin
      ? `使用 DSH_BIN="${config.deepseekHarness.bin}"`
      : `使用桌面版自带的 dsh（${config.deepseekHarness.desktopDir}），需要先在 DeepSeek Harness 桌面版登录 DeepSeek 账号`;
  }

  async discoverWorkspaces() {
    return [];
  }

  defaultModel(): string | null {
    return config.deepseekHarness.defaultModel || null;
  }

  async listModels(): Promise<ModelOption[]> {
    return MODELS;
  }

  async run(ctx: TaskRuntimeContext, input: TurnInput): Promise<void> {
    await dispatch(ctx, input, null);
  }

  async continueTask(ctx: TaskRuntimeContext, input: TurnInput): Promise<void> {
    await dispatch(ctx, input, ctx.sessionKey);
  }

  async stop(ctx: TaskRuntimeContext): Promise<void> {
    const proc = running.get(runtimeKeyOf(ctx));
    if (proc) {
      ctx.log("正在终止 DeepSeek Harness 进程树...");
      proc.kill("用户停止");
    }
    ctx.setStatus("stopped");
  }

  /** 一次性问答：只读权限，不绑定任务。 */
  async ask(prompt: string, options?: { model?: string | null }): Promise<string | null> {
    const launch = resolveDshLaunch();
    if (!launch) throw new Error("找不到 DeepSeek Harness，请先安装桌面版并登录 DeepSeek 账号");
    const model = options?.model || config.deepseekHarness.defaultModel || MODELS[0].id;
    const child = spawnDsh(launch, headlessArgs(writePatchFile(model), null), process.cwd(), "read-only");
    child.stdin?.end(prompt);
    const messages: string[] = [];
    const handler = createDshEventHandler({
      agentMessage: (text) => messages.push(text),
      terminal: () => {},
      log: () => {},
      setSessionKey: () => {},
    });
    let buffer = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (buffer += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        killProcessTree(child);
        reject(new Error(`DeepSeek Harness ${ASK_TIMEOUT_MS / 1000} 秒内没有回复，已超时`));
      }, ASK_TIMEOUT_MS);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`启动 DeepSeek Harness 失败：${err.message}`));
      });
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    for (const line of buffer.split("\n")) handler.handleLine(line);
    if (handler.error) throw new Error(handler.error);
    if (messages.length) return messages.join("\n\n");
    if (code !== 0) throw new Error(`DeepSeek Harness 调用失败（退出码 ${code}）：${clip(stderr.trim(), 500) || "没有输出"}`);
    return null;
  }
}
