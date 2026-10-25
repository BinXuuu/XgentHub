import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.ts";
import { resolveCliBinary } from "../adapters/winSpawn.ts";
import type { AgentAccountInfo } from "../types.ts";
import { openLoginWindow, type LoginWindowResult } from "./loginWindow.ts";

// Antigravity（agy）只能显示当前账号，做不了多账号：它的登录令牌存在 Windows 凭据管理器里（目标 gemini:antigravity），
// 跟用户目录无关——实测把 ANTIGRAVITY_GEMINI_DIR、甚至 USERPROFILE 指到空目录，agy models 照样是登录状态。
// 当前账号的邮箱：~/.gemini/google_accounts.json 的 active；没有的话从最近的 CLI 日志里找
// "OAuth: authenticated successfully as <邮箱>"（agy 1.4.3 实测的日志格式）。

function geminiDir(): string {
  return process.env.ANTIGRAVITY_GEMINI_DIR || path.join(os.homedir(), ".gemini");
}

function emailFromAccountsFile(): string | null {
  try {
    const active = JSON.parse(fs.readFileSync(path.join(geminiDir(), "google_accounts.json"), "utf8"))?.active;
    return typeof active === "string" && active.includes("@") ? active : null;
  } catch {
    return null;
  }
}

function emailFromLatestLog(): string | null {
  const logDir = path.join(geminiDir(), "antigravity-cli", "log");
  try {
    const latest = fs
      .readdirSync(logDir)
      .filter((name) => name.endsWith(".log"))
      .map((name) => ({ name, mtime: fs.statSync(path.join(logDir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 5);
    for (const file of latest) {
      const text = fs.readFileSync(path.join(logDir, file.name), "utf8");
      const matches = [...text.matchAll(/authenticated successfully as (\S+@\S+)/g)];
      if (matches.length) return matches.at(-1)![1]!.replace(/[,.;]+$/, "");
    }
  } catch {
    // 没有日志目录
  }
  return null;
}

export function readAntigravityAccountInfo(): AgentAccountInfo {
  const email = emailFromAccountsFile() ?? emailFromLatestLog();
  return {
    id: "antigravity",
    name: "默认账号",
    home: geminiDir(),
    isDefault: true,
    supportsMultiple: false,
    loggedIn: Boolean(email),
    authMode: email ? "google" : null,
    email,
    plan: null,
    apiKeyHint: null,
    baseUrl: null,
  };
}

/** 弹一个窗口打开交互式的 agy：没登录时它会自己走登录；要换账号在里面退出再登录。 */
export function openAntigravityWindow(): Promise<LoginWindowResult> {
  const bin = resolveCliBinary(config.antigravity.bin);
  if (!bin) throw new Error(`找不到 Antigravity CLI（${config.antigravity.bin}）`);
  return openLoginWindow({
    title: "Antigravity",
    exe: bin,
    args: [],
    intro: ["正在打开 Antigravity（agy）。没登录时会提示登录；要换账号，在 agy 里退出当前账号后重新登录。", "Antigravity 一台电脑只能登录一个账号。"],
  });
}
