import type { AgentAccountInfo, AgentDescriptor } from "../api/types";

/** 括号里显示的账号：邮箱 > 中转站 / API Key 末 4 位 > 未登录。 */
export function accountLabel(account: AgentAccountInfo): string {
  if (account.email) return account.email;
  if (account.loggedIn && account.authMode !== "apikey") return authModeLabel(account);
  if (account.authMode === "apikey") return account.baseUrl ? `中转站 ···${account.apiKeyHint ?? ""}` : `API Key ···${account.apiKeyHint ?? ""}`;
  return account.supportsMultiple ? "未登录" : "未识别";
}

export function authModeLabel(account: AgentAccountInfo): string {
  switch (account.authMode) {
    case "chatgpt":
      return "ChatGPT 账号";
    case "claudeai":
      return "Claude 订阅账号";
    case "google":
      return "Google 账号";
    case "workbuddy":
      return "WorkBuddy 账号";
    case "deepseek":
      return "DeepSeek 账号";
    case "volcengine":
      return "火山引擎账号";
    case "apikey":
      return account.baseUrl ? "中转站（API Key）" : "API Key";
    default:
      return account.supportsMultiple ? "未登录" : "未识别";
  }
}

/** 多账号靠「每个账号一个独立目录」实现、只能用账号登录（没有 API Key 选项）的几种。 */
export const CLI_ACCOUNT_KINDS: AgentDescriptor["kind"][] = ["codebuddy", "deepseek-harness", "ark-cli"];

/**
 * 左边栏、标题里的名字：写了备注就是「Codex（备注）」；
 * 没写的话默认账号显示成「Codex（邮箱）」，另外添加的账号名字本身就是「Codex（账号名）」，不再重复加括号。
 */
export function agentDisplayName(agent: AgentDescriptor): string {
  const account = agent.account;
  if (account?.note) return `${account.isDefault ? agent.name : agent.name.replace(/（[^（）]*）$/, "")}（${account.note}）`;
  // Antigravity 读不到账号时不代表没登录（登录在系统凭据里），就不加括号了。
  // WorkBuddy / DeepSeek / 火山方舟的登录信息里读不到邮箱，默认账号也不加括号。
  if (!account?.isDefault || (!account.supportsMultiple && !account.email)) return agent.name;
  if (!account.email && account.authMode !== "apikey" && (CLI_ACCOUNT_KINDS as string[]).includes(agent.kind)) return agent.name;
  return `${agent.name}（${accountLabel(account)}）`;
}
