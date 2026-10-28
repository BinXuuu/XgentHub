import {
  codexHomeForAgent,
  createCodexAccount,
  deleteCodexAccount,
  getCodexAccount,
  loginCodexWithApiKey,
  logoutCodex,
  openCodexLoginWindow,
  renameCodexAccount,
} from "./codexAccountService.ts";
import {
  claudeHomeForAgent,
  clearClaudeApiKey,
  createClaudeAccount,
  deleteClaudeAccount,
  getClaudeAccount,
  logoutClaude,
  openClaudeLoginWindow,
  renameClaudeAccount,
  setClaudeApiKey,
} from "./claudeAccountService.ts";
import { openAntigravityWindow } from "./antigravityAccountService.ts";
import {
  createCliAccount,
  deleteCliAccount,
  getCliAccount,
  isCliAccountKind,
  openCliLoginWindow,
  renameCliAccount,
  type CliAccountKind,
} from "./cliAccountService.ts";

// 账号相关操作按 Agent 类型分给各自的服务：Codex、Claude Code 能加多个账号；Antigravity 只有一个账号，只能打开 agy 去登录。

export type AccountKind = "codex" | "claude-code" | CliAccountKind;

type AccountTarget =
  | { kind: "codex"; home: string }
  | { kind: "claude-code" }
  | { kind: "antigravity" }
  | { kind: "cli"; cliKind: CliAccountKind; home: string | null };

function targetOf(agentId: string): AccountTarget {
  const codexHome = codexHomeForAgent(agentId);
  if (codexHome) return { kind: "codex", home: codexHome };
  if (claudeHomeForAgent(agentId)) return { kind: "claude-code" };
  if (agentId === "antigravity") return { kind: "antigravity" };
  if (isCliAccountKind(agentId)) return { kind: "cli", cliKind: agentId, home: null };
  const cliAccount = getCliAccount(agentId);
  if (cliAccount) return { kind: "cli", cliKind: cliAccount.kind, home: cliAccount.home };
  throw new Error("这个 Agent 没有账号可以管理");
}

export function createAgentAccount(input: { kind?: string; name?: string; copyConfig?: boolean }): { id: string } {
  if (isCliAccountKind(input.kind)) return createCliAccount({ kind: input.kind, name: input.name });
  if (input.kind === "claude-code") return createClaudeAccount(input);
  if (input.kind === "codex" || input.kind === undefined) return createCodexAccount(input);
  throw new Error(`${input.kind} 不支持添加多个账号`);
}

export function renameAgentAccount(agentId: string, name: string): void {
  if (getCodexAccount(agentId)) renameCodexAccount(agentId, name);
  else if (getClaudeAccount(agentId)) renameClaudeAccount(agentId, name);
  else if (getCliAccount(agentId)) renameCliAccount(agentId, name);
  else throw new Error("默认账号不能改名");
}

/** 是另外添加的账号就删掉并返回它的目录；不是返回 null。 */
export function deleteAgentAccount(agentId: string): string | null {
  if (getCodexAccount(agentId)) return deleteCodexAccount(agentId);
  if (getClaudeAccount(agentId)) return deleteClaudeAccount(agentId);
  if (getCliAccount(agentId)) return deleteCliAccount(agentId);
  return null;
}

export async function loginAgentAccount(
  agentId: string,
  label: string,
  input: { method?: "browser" | "apikey"; apiKey?: string; baseUrl?: string }
): Promise<{ message: string; opened: boolean }> {
  const target = targetOf(agentId);
  if (target.kind === "antigravity") {
    const result = await openAntigravityWindow();
    return result.opened ? { opened: true, message: "已在这台电脑上打开 Antigravity，按窗口里的提示登录。" } : result;
  }
  if (target.kind === "cli") {
    if (input.method === "apikey") throw new Error("这个 Agent 只能用账号登录");
    return openCliLoginWindow(target.cliKind, target.home, label);
  }
  if (input.method === "apikey") {
    if (target.kind === "codex") {
      await loginCodexWithApiKey(target.home, input.apiKey ?? "");
      return { opened: false, message: "已用 API Key 登录" };
    }
    setClaudeApiKey(agentId, input.apiKey ?? "", input.baseUrl ?? "");
    return { opened: false, message: input.baseUrl?.trim() ? "已改用中转站" : "已改用 API Key" };
  }
  if (target.kind === "codex") return openCodexLoginWindow(target.home, label);
  // 订阅登录和 API Key 只用一种：改回订阅登录时去掉存的 Key，不然 Key 会一直优先。
  clearClaudeApiKey(agentId);
  return openClaudeLoginWindow(agentId, label);
}

export async function logoutAgentAccount(agentId: string): Promise<void> {
  const target = targetOf(agentId);
  if (target.kind === "codex") await logoutCodex(target.home);
  else if (target.kind === "claude-code") await logoutClaude(agentId);
  else if (target.kind === "cli") throw new Error("这个 Agent 没有单独的退出登录，要换账号点「换个账号登录」");
  else throw new Error("Antigravity 请在 agy 里退出登录");
}

/** 只去掉 API Key / 中转站，回到订阅登录（Claude Code）。 */
export function clearAgentApiKey(agentId: string): void {
  if (targetOf(agentId).kind !== "claude-code") throw new Error("只有 Claude Code 账号能单独清除 API Key");
  clearClaudeApiKey(agentId);
}
