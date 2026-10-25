import type { AgentAccountInfo, AgentDescriptor } from "../api/types";

/** 括号里显示的账号：邮箱 > 中转站 / API Key 末 4 位 > 未登录。 */
export function accountLabel(account: AgentAccountInfo): string {
  if (account.email) return account.email;
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
    case "apikey":
      return account.baseUrl ? "中转站（API Key）" : "API Key";
    default:
      return account.supportsMultiple ? "未登录" : "未识别";
  }
}

/**
 * 左边栏、标题里的名字：默认账号显示成「Codex（邮箱）」；
 * 另外添加的账号名字本身就是「Codex（账号名）」，不再重复加括号。
 */
export function agentDisplayName(agent: AgentDescriptor): string {
  const account = agent.account;
  // Antigravity 读不到账号时不代表没登录（登录在系统凭据里），就不加括号了。
  if (!account?.isDefault || (!account.supportsMultiple && !account.email)) return agent.name;
  return `${agent.name}（${accountLabel(account)}）`;
}
