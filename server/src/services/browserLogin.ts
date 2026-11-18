import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { killProcessTree, spawnCli } from "../adapters/winSpawn.ts";

/**
 * 「网址 + 浏览器」式登录（codex login、claude auth login、arkcli auth login），由 Xgent 自己跑登录命令，不弹黑窗口：
 * - 命令打印出登录网址后，Xgent 用这台电脑的默认浏览器打开它（CLI 自己不一定打得开：实测 Codex 在 Windows 上没打开）；
 *   页面上也显示这个网址，浏览器没开时可以点。
 * - Claude Code 在浏览器里确认后，网页会给一串验证码，要粘回命令里（「Paste code here」）。以前在黑窗口里很容易漏掉这步，
 *   结果浏览器里显示登录好了、Xgent 里还是未登录。现在页面上直接给输入框，粘进来点确定就行。
 * - 命令正常结束就是登录成功，页面自动刷新账号状态。
 * 2026-11-10 在测试电脑上实测过三个命令在没有控制台（输出接管道）时的输出，格式见下面的匹配规则。
 * 账号密码只在浏览器里输入，Xgent 只转交验证码，不保存。
 */

export type BrowserLoginStatus = "starting" | "waiting" | "needs_code" | "verifying" | "succeeded" | "failed" | "cancelled";

export interface BrowserLoginSession {
  id: string;
  agentId: string;
  label: string;
  status: BrowserLoginStatus;
  /** 登录网址（浏览器没自动打开时页面上可以点）。 */
  url: string | null;
  /** Xgent 有没有替它打开浏览器。 */
  openedBrowser: boolean;
  /** 命令是否在等验证码（Claude Code）。 */
  acceptsCode: boolean;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

interface Running {
  session: BrowserLoginSession;
  child: ChildProcess;
  output: string;
  timer: NodeJS.Timeout;
  openBrowser: boolean;
}

const TIMEOUT_MS = 10 * 60 * 1000;
const sessions = new Map<string, BrowserLoginSession>();
const running = new Map<string, Running>();

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
/** 登录网址：跳过 codex 先打印的本机回调服务地址（http://localhost:1455）。 */
const URL_RE = /https?:\/\/[^\s"'<>]+/g;
/** Claude Code：「Paste code here if prompted >」。 */
const CODE_PROMPT_RE = /paste (the )?code|code here|authori[sz]ation code|输入验证码|粘贴验证码/i;

function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return true;
  }
}

/** 用这台电脑的默认浏览器打开网址。不经过 cmd（网址里的 & 会被 cmd 拆开）。 */
export function openInDefaultBrowser(url: string): boolean {
  if (process.env.XGENT_NO_OPEN_BROWSER === "1") return true; // 测试里不真的开浏览器
  try {
    const child =
      process.platform === "win32"
        ? spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore", windowsHide: true })
        : process.platform === "darwin"
          ? spawn("open", [url], { detached: true, stdio: "ignore" })
          : spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function finish(run: Running, status: BrowserLoginStatus, error: string | null) {
  const { session } = run;
  if (["succeeded", "failed", "cancelled"].includes(session.status)) return;
  clearTimeout(run.timer);
  session.status = status;
  session.error = error;
  session.finishedAt = new Date().toISOString();
  running.delete(session.id);
  console.log(`[login] ${session.agentId}: ${status}${error ? `（${error.split("\n")[0]}）` : ""}`);
}

function onOutput(run: Running, chunk: string) {
  run.output = (run.output + chunk.replace(ANSI_RE, "")).slice(-16_000);
  const { session } = run;
  if (!session.url) {
    const url = (run.output.match(URL_RE) ?? []).map((item) => item.replace(/[.,;)]+$/, "")).find((item) => !isLocalUrl(item));
    if (url) {
      session.url = url;
      if (session.status === "starting") session.status = "waiting";
      if (run.openBrowser) session.openedBrowser = openInDefaultBrowser(url);
    }
  }
  if (!session.acceptsCode && CODE_PROMPT_RE.test(run.output)) {
    session.acceptsCode = true;
    if (session.status === "starting" || session.status === "waiting") session.status = "needs_code";
  }
}

/** 失败时给一句人话，后面带上命令最后几行输出。 */
function failureMessage(output: string, code: number | null): string {
  // 只去掉打印登录网址的那几行（太长、没用），报错里带网址的行要留着。
  const tail = output
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^.*\bPaste code here[^>]*>\s*/i, ""))
    .filter((line) => line && !/(visit|open|browser|navigate)[^:]*:\s*https?:\/\/\S+$/i.test(line) && !/^https?:\/\/\S+$/.test(line))
    .filter((line) => !/^(Opening browser|Starting local login server|If your browser did not open)/i.test(line))
    .slice(-4)
    .join("\n");
  if (/\b403\b|request not allowed|forbidden|unsupported_country|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up/i.test(tail)) {
    return `连不上登录服务器（浏览器里能登录，但命令行连不上，常见原因是这台电脑要开代理才能访问）。` +
      `请确认代理软件开着、并且设成了「系统代理」，然后重新点「登录」；也可以在系统环境变量里设置 HTTPS_PROXY。\n${tail}`;
  }
  if (/invalid|expired|incorrect|wasn't accepted|not accepted|无效|过期/i.test(tail)) return `验证码不对或者过期了，请重新点「登录」再来一次。\n${tail}`;
  return `登录没有完成（退出码 ${code}）。${tail ? `\n${tail}` : ""}`;
}

export function startBrowserLogin(input: {
  agentId: string;
  label: string;
  exe: string;
  args: string[];
  env?: Record<string, string>;
  openBrowser: boolean;
}): BrowserLoginSession {
  // 同一个账号只保留一个正在进行的登录：再点一次就重新开始。
  for (const run of running.values()) {
    if (run.session.agentId === input.agentId) cancelBrowserLogin(run.session.id);
  }
  const session: BrowserLoginSession = {
    id: randomUUID(),
    agentId: input.agentId,
    label: input.label,
    status: "starting",
    url: null,
    openedBrowser: false,
    acceptsCode: false,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  sessions.set(session.id, session);
  for (const [id, old] of sessions) {
    if (sessions.size <= 30) break;
    if (!running.has(id) && old !== session) sessions.delete(id);
  }

  let child: ChildProcess;
  try {
    child = spawnCli(input.exe, input.args, { cwd: os.homedir(), preferCmdShim: true, env: { ...process.env, ...input.env } });
  } catch (err) {
    session.status = "failed";
    session.error = `启动登录命令失败：${(err as Error).message}`;
    session.finishedAt = new Date().toISOString();
    return session;
  }
  const run: Running = {
    session,
    child,
    output: "",
    openBrowser: input.openBrowser,
    timer: setTimeout(() => {
      killProcessTree(child);
      finish(run, "failed", "10 分钟内没有完成登录，已停止。需要的话重新点「登录」。");
    }, TIMEOUT_MS),
  };
  running.set(session.id, run);
  console.log(`[login] ${input.agentId}: 开始（${input.label}）`);
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => onOutput(run, chunk));
  child.stderr?.on("data", (chunk: string) => onOutput(run, chunk));
  child.stdin?.on("error", () => undefined);
  child.on("error", (err) => finish(run, "failed", `启动登录命令失败：${err.message}`));
  child.on("close", (code) => {
    if (code === 0) finish(run, "succeeded", null);
    else finish(run, "failed", failureMessage(run.output, code));
  });
  return session;
}

export function getBrowserLogin(id: string): BrowserLoginSession | null {
  return sessions.get(id) ?? null;
}

/** 把浏览器页面上的验证码交给登录命令。 */
export function submitBrowserLoginCode(id: string, code: string): BrowserLoginSession {
  const run = running.get(id);
  if (!run) throw new Error("这次登录已经结束了，请重新点「登录」");
  const value = code.trim();
  if (!value) throw new Error("验证码是空的");
  if (/[\r\n]/.test(value) || value.length > 4096) throw new Error("验证码格式不对");
  run.child.stdin?.write(`${value}\n`);
  run.session.status = "verifying";
  return run.session;
}

export function cancelBrowserLogin(id: string): BrowserLoginSession | null {
  const run = running.get(id);
  if (!run) return sessions.get(id) ?? null;
  killProcessTree(run.child);
  finish(run, "cancelled", null);
  return run.session;
}
