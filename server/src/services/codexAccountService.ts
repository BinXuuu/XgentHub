import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.ts";
import { resolveCliBinary, spawnCli } from "../adapters/winSpawn.ts";
import type { AgentAccountInfo } from "../types.ts";
import { openLoginWindow, type LoginWindowResult } from "./loginWindow.ts";
import { readJsonFile, writeJsonAtomic } from "./jsonStore.ts";

// 多个 Codex 账号：Codex CLI 的登录、配置、模型缓存、会话记录全在 CODEX_HOME 目录里（默认 ~/.codex），
// 给每个账号一个独立目录，启动 codex 时带上 CODEX_HOME，就是互不影响的另一个账号（实测空目录下 login status 是"未登录"）。
// 默认账号就是 ~/.codex，跟 Codex 桌面版、终端里直接敲 codex 用的是同一个；新增的账号放在 ~/.xgent/codex-accounts/<名字> 下，
// 不放在项目里，免得更新、打包、开源导出时被带走。

export interface CodexAccountRecord {
  id: string;
  name: string;
  home: string;
  createdAt: string;
}

const storePath = path.join(config.dataDir, "codex-accounts.json");

export function defaultCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function accountsRoot(): string {
  return process.env.CODEX_ACCOUNTS_DIR || path.join(os.homedir(), ".xgent", "codex-accounts");
}

function readStore(): CodexAccountRecord[] {
  const parsed = readJsonFile<unknown[]>(storePath, [], Array.isArray);
  return (parsed as any[]).filter((item) => item && typeof item.id === "string" && typeof item.home === "string");
}

function writeStore(items: CodexAccountRecord[]) {
  writeJsonAtomic(storePath, items);
}

export function listCodexAccounts(): CodexAccountRecord[] {
  return readStore();
}

export function getCodexAccount(id: string): CodexAccountRecord | undefined {
  return readStore().find((item) => item.id === id);
}

/** 目录名只用英文数字：名字是中文时用 account-2、account-3 这种。 */
function slugify(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function createCodexAccount(input: { name?: string; copyConfig?: boolean }): CodexAccountRecord {
  const items = readStore();
  const name = input.name?.trim() || `账号 ${items.length + 2}`;
  if (items.some((item) => item.name === name)) throw new Error(`已经有叫「${name}」的 Codex 账号了`);
  const taken = new Set(items.map((item) => item.id));
  const base = slugify(name) || "account";
  let slug = base === "account" ? `account-${items.length + 2}` : base;
  for (let n = 2; taken.has(`codex:${slug}`) || fs.existsSync(path.join(accountsRoot(), slug)); n++) slug = `${base}-${n}`;

  const home = path.join(accountsRoot(), slug);
  fs.mkdirSync(home, { recursive: true });
  // 默认带上主账号的 config.toml（MCP、默认模型、中转站等设置）和全局 AGENTS.md，新账号登录后就跟主账号一样能用；登录信息不复制。
  if (input.copyConfig !== false) {
    for (const file of ["config.toml", "AGENTS.md"]) {
      const source = path.join(defaultCodexHome(), file);
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(home, file));
    }
  }
  const record: CodexAccountRecord = { id: `codex:${slug}`, name, home, createdAt: new Date().toISOString() };
  writeStore([...items, record]);
  return record;
}

export function renameCodexAccount(id: string, name: string): CodexAccountRecord {
  const items = readStore();
  const target = items.find((item) => item.id === id);
  if (!target) throw new Error("这个 Codex 账号不存在");
  const next = name.trim();
  if (!next) throw new Error("名字不能为空");
  if (items.some((item) => item.id !== id && item.name === next)) throw new Error(`已经有叫「${next}」的 Codex 账号了`);
  target.name = next;
  writeStore(items);
  return target;
}

/** 只从列表里去掉；账号目录（含登录信息）留在原处，返回目录路径，界面上告诉用户要不要自己删。 */
export function deleteCodexAccount(id: string): string {
  const items = readStore();
  const target = items.find((item) => item.id === id);
  if (!target) throw new Error("这个 Codex 账号不存在");
  writeStore(items.filter((item) => item.id !== id));
  return target.home;
}

/** agentId → 这个账号的 CODEX_HOME。内置的 codex 是默认账号；不是 Codex 账号返回 null。 */
export function codexHomeForAgent(agentId: string): string | null {
  if (agentId === "codex") return defaultCodexHome();
  return getCodexAccount(agentId)?.home ?? null;
}

/** 启动 codex 子进程用的环境变量：默认账号不改（沿用当前环境），其它账号带上自己的 CODEX_HOME。 */
export function codexEnvForHome(home: string): NodeJS.ProcessEnv | undefined {
  return samePath(home, defaultCodexHome()) ? undefined : { ...process.env, CODEX_HOME: home };
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function decodeJwtPayload(token: unknown): Record<string, any> | null {
  if (typeof token !== "string") return null;
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * 读这个目录里的登录信息（auth.json），只取能显示的部分：登录方式、邮箱、套餐、API Key 末 4 位。
 * 令牌本身不往外传。auth.json 的格式是对着 codex-cli 0.162 实测的：
 * ChatGPT 登录是 auth_mode=chatgpt + tokens.id_token（JWT，里面有 email 和 chatgpt_plan_type），
 * API Key 登录是 auth_mode=apikey + OPENAI_API_KEY。
 */
export function readCodexAccountInfo(input: { home: string; id: string; name: string; isDefault: boolean }): AgentAccountInfo {
  const info: AgentAccountInfo = {
    id: input.id,
    name: input.name,
    home: input.home,
    isDefault: input.isDefault,
    supportsMultiple: true,
    loggedIn: false,
    authMode: null,
    email: null,
    plan: null,
    apiKeyHint: null,
    baseUrl: null,
  };
  let auth: any;
  try {
    auth = JSON.parse(fs.readFileSync(path.join(input.home, "auth.json"), "utf8"));
  } catch {
    return info;
  }
  const idToken = decodeJwtPayload(auth?.tokens?.id_token);
  if (idToken) {
    info.loggedIn = true;
    info.authMode = "chatgpt";
    info.email = typeof idToken.email === "string" ? idToken.email : null;
    const plan = idToken["https://api.openai.com/auth"]?.chatgpt_plan_type;
    info.plan = typeof plan === "string" ? plan : null;
  } else if (typeof auth?.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY) {
    info.loggedIn = true;
    info.authMode = "apikey";
    info.apiKeyHint = auth.OPENAI_API_KEY.slice(-4);
  }
  return info;
}

/** 左边栏、标题里括号中显示的账号：邮箱 > API Key 末 4 位 > 未登录。 */
export function accountLabel(info: AgentAccountInfo): string {
  if (info.email) return info.email;
  if (info.authMode === "apikey") return `API Key ···${info.apiKeyHint ?? ""}`;
  return "未登录";
}

/** 在这台电脑上弹一个窗口跑 `codex login`（带上这个账号的 CODEX_HOME），codex 会自己打开浏览器。 */
export function openCodexLoginWindow(home: string, label: string): Promise<LoginWindowResult> {
  const bin = resolveCliBinary(config.codex.bin, { preferCmdShim: true });
  if (!bin) throw new Error(`找不到 Codex CLI（${config.codex.bin}），请先安装：npm install -g @openai/codex`);
  return openLoginWindow({
    title: "Codex Login",
    exe: bin,
    args: ["login"],
    // 没有屏幕时用设备码登录：命令行给一个网址和验证码，用手机等任意设备打开网址输入验证码即可。
    headlessArgs: ["login", "--device-auth"],
    env: { CODEX_HOME: home },
    intro: [`正在登录 Codex 账号：${label}`, `账号目录：${home}`],
  });
}

function runCodex(home: string, args: string[], stdin: string | null, timeoutMs = 30_000): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnCli(config.codex.bin, args, { cwd: process.cwd(), preferCmdShim: true, env: { ...process.env, CODEX_HOME: home } });
    } catch (err) {
      resolve({ code: null, output: (err as Error).message });
      return;
    }
    let output = "";
    child.stdout?.on("data", (d: Buffer) => (output += d.toString("utf8")));
    child.stderr?.on("data", (d: Buffer) => (output += d.toString("utf8")));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, output: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
    child.stdin?.end(stdin ?? "");
  });
}

/** 不是本账号目录的提示行（比如"临时目录不建 PATH 别名"的 WARNING）不展示给用户。 */
function cleanOutput(output: string): string {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("WARNING:") && !/Reading API key from stdin/i.test(line))
    .join("\n");
}

export async function loginCodexWithApiKey(home: string, apiKey: string): Promise<void> {
  const key = apiKey.trim();
  if (!key) throw new Error("API Key 不能为空");
  const result = await runCodex(home, ["login", "--with-api-key"], key + "\n");
  if (result.code !== 0) throw new Error(cleanOutput(result.output) || `codex login 失败（exit ${result.code}）`);
}

export async function logoutCodex(home: string): Promise<void> {
  const result = await runCodex(home, ["logout"], null);
  if (result.code !== 0 && !/not logged in/i.test(result.output)) {
    throw new Error(cleanOutput(result.output) || `codex logout 失败（exit ${result.code}）`);
  }
}
