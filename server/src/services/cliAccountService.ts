import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.ts";
import { resolveCliBinary } from "../adapters/winSpawn.ts";
import type { AgentAccountInfo, AgentAuthMode } from "../types.ts";
import { openLoginWindow, type LoginWindowResult } from "./loginWindow.ts";
import { readJsonFile, writeJsonAtomic } from "./jsonStore.ts";

// WorkBuddy（CodeBuddy）、DeepSeek Harness、Ark CLI 的多账号。2026-10-27 在这台电脑上实测过每一种怎么隔离：
// - CodeBuddy：登录存在 <用户目录>/AppData/Local/CodeBuddyExtension/Data/Public/auth（用户目录取自 os.homedir()，
//   也就是 USERPROFILE），只换 CODEBUDDY_CONFIG_DIR 不够——换成空的 USERPROFILE 才会提示要登录；
// - DeepSeek Harness：登录存在 $DSH_HOME/.credentials.yaml（默认 ~/.dsh），换空的 DSH_HOME 就是没登录；
// - Ark CLI：登录在 <用户目录>/.arkcli，没有改目录的环境变量，换空的 USERPROFILE 时 auth status 是 logged_in=false。
// 所以每个账号一个目录，启动时带上对应的环境变量。默认账号就是本机原来那份，不改任何环境变量。

export type CliAccountKind = "codebuddy" | "deepseek-harness" | "ark-cli";
export const CLI_ACCOUNT_KINDS: CliAccountKind[] = ["codebuddy", "deepseek-harness", "ark-cli"];

export interface CliAccountRecord {
  id: string;
  kind: CliAccountKind;
  name: string;
  home: string;
  createdAt: string;
}

const KIND_LABEL: Record<CliAccountKind, string> = {
  codebuddy: "WorkBuddy",
  "deepseek-harness": "DeepSeek",
  "ark-cli": "Ark CLI",
};

const AUTH_MODE: Record<CliAccountKind, AgentAuthMode> = {
  codebuddy: "workbuddy",
  "deepseek-harness": "deepseek",
  "ark-cli": "volcengine",
};

const storePath = path.join(config.dataDir, "cli-accounts.json");

function accountsRoot(kind: CliAccountKind): string {
  return path.join(process.env.XGENT_ACCOUNTS_DIR || path.join(os.homedir(), ".xgent"), `${kind}-accounts`);
}

function readStore(): CliAccountRecord[] {
  const parsed = readJsonFile<unknown[]>(storePath, [], Array.isArray);
  return (parsed as any[]).filter(
    (item) => item && typeof item.id === "string" && typeof item.home === "string" && CLI_ACCOUNT_KINDS.includes(item.kind)
  );
}

function writeStore(items: CliAccountRecord[]) {
  writeJsonAtomic(storePath, items);
}

export function isCliAccountKind(kind: unknown): kind is CliAccountKind {
  return CLI_ACCOUNT_KINDS.includes(kind as CliAccountKind);
}

export function listCliAccounts(kind?: CliAccountKind): CliAccountRecord[] {
  return readStore().filter((item) => !kind || item.kind === kind);
}

export function getCliAccount(id: string): CliAccountRecord | undefined {
  return readStore().find((item) => item.id === id);
}

function slugify(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function createCliAccount(input: { kind: CliAccountKind; name?: string }): CliAccountRecord {
  const items = readStore();
  const sameKind = items.filter((item) => item.kind === input.kind);
  const name = input.name?.trim() || `账号 ${sameKind.length + 2}`;
  if (sameKind.some((item) => item.name === name)) throw new Error(`已经有叫「${name}」的 ${KIND_LABEL[input.kind]} 账号了`);
  const root = accountsRoot(input.kind);
  const base = slugify(name) || "account";
  let slug = base === "account" ? `account-${sameKind.length + 2}` : base;
  const taken = new Set(items.map((item) => item.id));
  for (let n = 2; taken.has(`${input.kind}:${slug}`) || fs.existsSync(path.join(root, slug)); n++) slug = `${base}-${n}`;
  const home = path.join(root, slug);
  fs.mkdirSync(home, { recursive: true });
  // CodeBuddy / Ark 的账号换了整个用户目录，它们跑的命令（git 等）也会看这个目录：把 git 的全局设置带过去，提交时身份不变。
  if (input.kind !== "deepseek-harness") {
    const gitconfig = path.join(os.homedir(), ".gitconfig");
    if (fs.existsSync(gitconfig)) fs.copyFileSync(gitconfig, path.join(home, ".gitconfig"));
  }
  const record: CliAccountRecord = { id: `${input.kind}:${slug}`, kind: input.kind, name, home, createdAt: new Date().toISOString() };
  writeStore([...items, record]);
  return record;
}

export function renameCliAccount(id: string, name: string): CliAccountRecord {
  const items = readStore();
  const target = items.find((item) => item.id === id);
  if (!target) throw new Error("这个账号不存在");
  const next = name.trim();
  if (!next) throw new Error("名字不能为空");
  if (items.some((item) => item.id !== id && item.kind === target.kind && item.name === next)) throw new Error(`已经有叫「${next}」的账号了`);
  target.name = next;
  writeStore(items);
  return target;
}

/** 只从列表里去掉；账号目录（含登录信息）留在原处，返回目录路径。 */
export function deleteCliAccount(id: string): string {
  const items = readStore();
  const target = items.find((item) => item.id === id);
  if (!target) throw new Error("这个账号不存在");
  writeStore(items.filter((item) => item.id !== id));
  return target.home;
}

/** 启动这个账号的 CLI 要加的环境变量；默认账号（home 为 null）不加。 */
export function cliAccountEnv(kind: CliAccountKind, home: string | null): Record<string, string> {
  if (!home) return {};
  if (kind === "deepseek-harness") return { DSH_HOME: home };
  const env: Record<string, string> = { USERPROFILE: home, HOME: home };
  if (kind === "codebuddy") env.CODEBUDDY_CONFIG_DIR = path.join(home, ".codebuddy");
  return env;
}

function codeBuddyAuthDir(userHome: string): string {
  if (process.platform === "darwin") return path.join(userHome, "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth");
  if (process.platform === "win32") return path.join(userHome, "AppData", "Local", "CodeBuddyExtension", "Data", "Public", "auth");
  return path.join(userHome, ".local", "share", "CodeBuddyExtension", "Data", "Public", "auth");
}

function hasFiles(dir: string, pattern?: RegExp): boolean {
  try {
    return fs.readdirSync(dir).some((name) => !pattern || pattern.test(name));
  } catch {
    return false;
  }
}

/** 默认账号用的目录：CodeBuddy / Ark 是用户目录，DeepSeek Harness 是 DSH_HOME。 */
export function defaultCliHome(kind: CliAccountKind): string {
  if (kind === "deepseek-harness") return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return os.homedir();
}

/** 只看登录文件在不在，不读里面的令牌。 */
export function cliAccountLoggedIn(kind: CliAccountKind, home: string): boolean {
  if (kind === "codebuddy") return hasFiles(codeBuddyAuthDir(home), /\.info$/i);
  if (kind === "ark-cli") return hasFiles(path.join(home, ".arkcli", "identities"));
  try {
    return /deepseek-account-platform\/default:/.test(fs.readFileSync(path.join(home, ".credentials.yaml"), "utf8"));
  } catch {
    return false;
  }
}

export function readCliAccountInfo(kind: CliAccountKind, input: { id: string; name: string; home: string | null }): AgentAccountInfo {
  const home = input.home ?? defaultCliHome(kind);
  const loggedIn = cliAccountLoggedIn(kind, home);
  return {
    id: input.id,
    name: input.name,
    home,
    isDefault: !input.home,
    supportsMultiple: true,
    loggedIn,
    authMode: loggedIn ? AUTH_MODE[kind] : null,
    email: null,
    plan: null,
    apiKeyHint: null,
    baseUrl: null,
  };
}

/** DeepSeek Harness 没有登录命令：开一个带这个账号 DSH_HOME 的 dsh web，浏览器里点「登录 DeepSeek 账号」。 */
async function deepseekLoginTarget(): Promise<{ exe: string; args: string[]; env: Record<string, string> }> {
  const { resolveDshLaunch } = await import("../adapters/deepseekHarness.ts");
  const launch = resolveDshLaunch();
  if (!launch) throw new Error("找不到 DeepSeek Harness，请先安装桌面版");
  return {
    exe: launch.viaShim ? resolveCliBinary(launch.command, { preferCmdShim: true }) ?? launch.command : launch.command,
    args: [...launch.baseArgs, "--profile", "web", "--port", "0"],
    env: launch.viaShim ? {} : { ELECTRON_RUN_AS_NODE: "1" },
  };
}

export async function openCliLoginWindow(kind: CliAccountKind, home: string | null, label: string): Promise<LoginWindowResult> {
  const env = cliAccountEnv(kind, home);
  const where = home ? [`账号目录：${home}`] : ["默认账号（本机原来那份登录）"];
  if (kind === "codebuddy") {
    const bin = resolveCliBinary(config.codebuddy.bin, { preferCmdShim: true });
    if (!bin) throw new Error("找不到 codebuddy，请先安装：npm i -g @tencent-ai/codebuddy-code");
    return openLoginWindow({
      title: "WorkBuddy Login",
      exe: bin,
      args: [],
      env,
      intro: [`正在登录 WorkBuddy 账号：${label}`, ...where, "进去后如果问是否信任文件夹选 1，然后输入 /login，用 WorkBuddy 账号登录；登录好后可以关掉这个窗口。"],
    });
  }
  if (kind === "ark-cli") {
    const bin = resolveCliBinary(config.arkCli.bin);
    if (!bin) throw new Error("找不到 arkcli，请先安装：npm install -g @volcengine/ark-cli");
    return openLoginWindow({
      title: "Ark CLI Login",
      exe: bin,
      args: ["auth", "login"],
      env,
      intro: [`正在登录火山方舟账号：${label}`, ...where],
    });
  }
  const target = await deepseekLoginTarget();
  return openLoginWindow({
    title: "DeepSeek Login",
    exe: target.exe,
    args: target.args,
    env: { ...target.env, ...env },
    intro: [`正在登录 DeepSeek 账号：${label}`, ...where, "浏览器会打开 DeepSeek Harness，点「登录 DeepSeek 账号」登录；登录好后关掉这个窗口即可。"],
  });
}
