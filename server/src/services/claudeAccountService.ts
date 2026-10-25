import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.ts";
import { spawnCli } from "../adapters/winSpawn.ts";
import type { AgentAccountInfo } from "../types.ts";
import { openLoginWindow, type LoginWindowResult } from "./loginWindow.ts";
import { readJsonFile, writeJsonAtomic } from "./jsonStore.ts";

// 多个 Claude Code 账号：跟 Codex 一样按目录分开。Claude Code 的登录（.credentials.json）、全局状态（.claude.json）、
// 设置、会话记录都在 CLAUDE_CONFIG_DIR 里（默认 ~/.claude，此时全局状态在 ~/.claude.json）。
// 实测（claude 2.1.308）：CLAUDE_CONFIG_DIR 指向空目录时 `claude auth status` 是未登录；再带上 ANTHROPIC_API_KEY 就是 api_key 登录。
// 新增的账号放在 ~/.xgent/claude-accounts/<名字> 下。
//
// 除了订阅账号登录，每个账号（包括默认账号）还可以改用 API Key / 中转站：Key 存在 Xgent 自己的数据目录里，
// 启动 claude 时作为环境变量带上（官方 API 用 ANTHROPIC_API_KEY；填了中转站地址就用 ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN）。

export const DEFAULT_CLAUDE_AGENT_ID = "claude-code";

export interface ClaudeAccountRecord {
  id: string;
  name: string;
  home: string;
  createdAt: string;
}

interface ClaudeApiKeySetting {
  apiKey: string;
  baseUrl: string;
}

interface ClaudeAccountStore {
  accounts: ClaudeAccountRecord[];
  /** agentId → 这个账号改用的 API Key / 中转站。 */
  apiKeys: Record<string, ClaudeApiKeySetting>;
}

const storePath = path.join(config.dataDir, "claude-accounts.json");

export function defaultClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function accountsRoot(): string {
  return process.env.CLAUDE_ACCOUNTS_DIR || path.join(os.homedir(), ".xgent", "claude-accounts");
}

function readStore(): ClaudeAccountStore {
  const parsed = readJsonFile<any>(storePath, {}, (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value));
  return {
    accounts: Array.isArray(parsed?.accounts) ? parsed.accounts.filter((item: any) => item && typeof item.id === "string" && typeof item.home === "string") : [],
    apiKeys: parsed?.apiKeys && typeof parsed.apiKeys === "object" ? parsed.apiKeys : {},
  };
}

function writeStore(store: ClaudeAccountStore) {
  writeJsonAtomic(storePath, store);
}

export function listClaudeAccounts(): ClaudeAccountRecord[] {
  return readStore().accounts;
}

export function getClaudeAccount(id: string): ClaudeAccountRecord | undefined {
  return readStore().accounts.find((item) => item.id === id);
}

function slugify(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function createClaudeAccount(input: { name?: string; copyConfig?: boolean }): ClaudeAccountRecord {
  const store = readStore();
  const items = store.accounts;
  const name = input.name?.trim() || `账号 ${items.length + 2}`;
  if (items.some((item) => item.name === name)) throw new Error(`已经有叫「${name}」的 Claude Code 账号了`);
  const taken = new Set(items.map((item) => item.id));
  const base = slugify(name) || "account";
  let slug = base === "account" ? `account-${items.length + 2}` : base;
  for (let n = 2; taken.has(`claude-code:${slug}`) || fs.existsSync(path.join(accountsRoot(), slug)); n++) slug = `${base}-${n}`;

  const home = path.join(accountsRoot(), slug);
  fs.mkdirSync(home, { recursive: true });
  // 默认带上主账号的设置（settings.json：权限、hooks、环境变量等）和全局 CLAUDE.md；登录不复制。
  if (input.copyConfig !== false) {
    for (const file of ["settings.json", "CLAUDE.md"]) {
      const source = path.join(defaultClaudeConfigDir(), file);
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(home, file));
    }
  }
  const record: ClaudeAccountRecord = { id: `claude-code:${slug}`, name, home, createdAt: new Date().toISOString() };
  store.accounts.push(record);
  writeStore(store);
  return record;
}

export function renameClaudeAccount(id: string, name: string): ClaudeAccountRecord {
  const store = readStore();
  const target = store.accounts.find((item) => item.id === id);
  if (!target) throw new Error("这个 Claude Code 账号不存在");
  const next = name.trim();
  if (!next) throw new Error("名字不能为空");
  if (store.accounts.some((item) => item.id !== id && item.name === next)) throw new Error(`已经有叫「${next}」的 Claude Code 账号了`);
  target.name = next;
  writeStore(store);
  return target;
}

/** 只从列表里去掉（连同存的 API Key）；账号目录留在原处，返回目录路径。 */
export function deleteClaudeAccount(id: string): string {
  const store = readStore();
  const target = store.accounts.find((item) => item.id === id);
  if (!target) throw new Error("这个 Claude Code 账号不存在");
  store.accounts = store.accounts.filter((item) => item.id !== id);
  delete store.apiKeys[id];
  writeStore(store);
  return target.home;
}

/** agentId → 这个账号的 CLAUDE_CONFIG_DIR。内置的 claude-code 是默认账号；不是 Claude Code 账号返回 null。 */
export function claudeHomeForAgent(agentId: string): string | null {
  if (agentId === DEFAULT_CLAUDE_AGENT_ID) return defaultClaudeConfigDir();
  return getClaudeAccount(agentId)?.home ?? null;
}

export function getClaudeApiKey(agentId: string): ClaudeApiKeySetting | null {
  const setting = readStore().apiKeys[agentId];
  return setting?.apiKey ? setting : null;
}

export function setClaudeApiKey(agentId: string, apiKey: string, baseUrl: string): void {
  if (!claudeHomeForAgent(agentId)) throw new Error("这不是 Claude Code 账号");
  const key = apiKey.trim();
  if (!key) throw new Error("API Key 不能为空");
  const url = baseUrl.trim().replace(/\/+$/, "");
  if (url && !/^https?:\/\//i.test(url)) throw new Error("中转站地址要以 http:// 或 https:// 开头");
  const store = readStore();
  store.apiKeys[agentId] = { apiKey: key, baseUrl: url };
  writeStore(store);
}

export function clearClaudeApiKey(agentId: string): void {
  const store = readStore();
  if (!(agentId in store.apiKeys)) return;
  delete store.apiKeys[agentId];
  writeStore(store);
}

/**
 * 启动这个账号的 claude 要加的环境变量：另外添加的账号带上自己的 CLAUDE_CONFIG_DIR；
 * 改用 API Key 的带上 Key（中转站用 ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN，官方 API 用 ANTHROPIC_API_KEY）。
 * 什么都不用加时返回 undefined，沿用当前环境。
 */
export function claudeEnvForAgent(agentId: string): NodeJS.ProcessEnv | undefined {
  const extra: Record<string, string> = {};
  const account = getClaudeAccount(agentId);
  if (account) extra.CLAUDE_CONFIG_DIR = account.home;
  const key = getClaudeApiKey(agentId);
  if (key?.baseUrl) {
    extra.ANTHROPIC_BASE_URL = key.baseUrl;
    extra.ANTHROPIC_AUTH_TOKEN = key.apiKey;
  } else if (key) {
    extra.ANTHROPIC_API_KEY = key.apiKey;
  }
  if (Object.keys(extra).length === 0) return undefined;
  const env = { ...process.env, ...extra };
  // 在 Xgent 里明确选了 Key 的，以它为准：中转站用 AUTH_TOKEN，别让环境里原有的 ANTHROPIC_API_KEY 抢先；
  // 选官方 API 的，去掉环境里原有的中转站地址，免得官方 Key 被发到别处。
  if (key?.baseUrl) delete env.ANTHROPIC_API_KEY;
  else if (key) {
    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  return env;
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 读这个账号的登录信息，只取能显示的部分。
 * 订阅登录：<目录>/.credentials.json 的 claudeAiOauth（套餐 subscriptionType）+ 全局状态里的 oauthAccount.emailAddress
 * （默认账号的全局状态在 ~/.claude.json，指定了 CLAUDE_CONFIG_DIR 的在 <目录>/.claude.json）。格式对照 claude 2.1.308 实测。
 */
export function readClaudeAccountInfo(input: { id: string; name: string; home: string; isDefault: boolean }): AgentAccountInfo {
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
  const key = getClaudeApiKey(input.id);
  if (key) {
    info.loggedIn = true;
    info.authMode = "apikey";
    info.apiKeyHint = key.apiKey.slice(-4);
    info.baseUrl = key.baseUrl || null;
    return info;
  }
  const oauth = readJson(path.join(input.home, ".credentials.json"))?.claudeAiOauth;
  if (oauth && (oauth.refreshToken || oauth.accessToken)) {
    info.loggedIn = true;
    info.authMode = "claudeai";
    info.plan = typeof oauth.subscriptionType === "string" ? oauth.subscriptionType : null;
    const globalPath =
      input.isDefault && !process.env.CLAUDE_CONFIG_DIR ? path.join(os.homedir(), ".claude.json") : path.join(input.home, ".claude.json");
    const email = readJson(globalPath)?.oauthAccount?.emailAddress;
    info.email = typeof email === "string" ? email : null;
  }
  return info;
}

/** 在这台电脑上弹一个窗口跑 `claude auth login`（带上这个账号的 CLAUDE_CONFIG_DIR），claude 会自己打开浏览器。 */
export function openClaudeLoginWindow(agentId: string, label: string): Promise<LoginWindowResult> {
  const home = claudeHomeForAgent(agentId);
  if (!home) throw new Error("这不是 Claude Code 账号");
  const account = getClaudeAccount(agentId);
  return openLoginWindow({
    title: "Claude Code Login",
    exe: config.claudeCode.bin,
    args: ["auth", "login"],
    env: account ? { CLAUDE_CONFIG_DIR: account.home } : undefined,
    intro: [
      `正在登录 Claude Code 账号：${label}`,
      `账号目录：${home}`,
      "浏览器登录后如果这里要你粘贴验证码，把浏览器里显示的验证码粘贴进来回车。",
    ],
  });
}

/** 退出订阅登录（claude auth logout），同时去掉这个账号存的 API Key。 */
export async function logoutClaude(agentId: string): Promise<void> {
  if (!claudeHomeForAgent(agentId)) throw new Error("这不是 Claude Code 账号");
  clearClaudeApiKey(agentId);
  const account = getClaudeAccount(agentId);
  const env = account ? { ...process.env, CLAUDE_CONFIG_DIR: account.home } : undefined;
  await new Promise<void>((resolve, reject) => {
    let child;
    try {
      child = spawnCli(config.claudeCode.bin, ["auth", "logout"], { cwd: process.cwd(), env });
    } catch (err) {
      reject(err);
      return;
    }
    let output = "";
    child.stdout?.on("data", (d: Buffer) => (output += d.toString("utf8")));
    child.stderr?.on("data", (d: Buffer) => (output += d.toString("utf8")));
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 || /not logged in|no .*credentials/i.test(output)) resolve();
      else reject(new Error(output.trim() || `claude auth logout 失败（exit ${code}）`));
    });
    child.stdin?.end();
  });
}
