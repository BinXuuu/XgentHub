import os from "node:os";
import path from "node:path";
import type { AgentAccountInfo, AgentKind } from "../types.ts";
import { codeBuddyAuthDir } from "./cliAccountService.ts";
import { geminiDir } from "./antigravityAccountService.ts";

/**
 * 账号区「登录来自哪里」：告诉用户这个账号的登录是 Xgent 自己的，还是和这台电脑上别的软件共用的，以及具体从哪个文件读出来的。
 *
 * 为什么要写清楚：应用版装好后，WorkBuddy、Ark、DeepSeek、Antigravity 会直接显示「已登录」——它们的登录跟着整个用户目录
 * （或者系统凭据）走，Xgent 没法单独隔开，读到的就是这台电脑上原来那份。不说清楚的话，用户会以为 Xgent 自己替他登录了。
 * 只读路径，不读里面的内容。
 */
export interface LoginSource {
  /** 和这台电脑上的其它软件共用同一个登录。 */
  shared: boolean;
  /** 共用的是哪些软件（shared 为 false 时为 null）。 */
  sharedWith: string | null;
  /** 登录从哪里读的（文件 / 文件夹 / 系统凭据）。 */
  location: string;
}

const SHARED_WITH: Partial<Record<AgentKind, string>> = {
  codex: "Codex 桌面版、VS Code 里的 Codex 插件和终端里的 codex 命令",
  "claude-code": "终端里的 claude 命令（Claude Code 命令行）",
  codebuddy: "WorkBuddy 桌面版和终端里的 codebuddy 命令",
  "ark-cli": "终端里的 arkcli 命令",
  "deepseek-harness": "DeepSeek Harness 桌面版",
  antigravity: "Antigravity 和终端里的 agy 命令",
};

function samePath(a: string, b: string): boolean {
  const norm = (value: string) => path.resolve(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

function location(kind: AgentKind, home: string): string | null {
  switch (kind) {
    case "codex":
      return path.join(home, "auth.json");
    case "claude-code":
      // macOS 上 Claude Code 把登录放在钥匙串里，其它系统是这个文件。
      return process.platform === "darwin" ? `macOS 钥匙串（配置目录 ${home}）` : path.join(home, ".credentials.json");
    case "codebuddy":
      return codeBuddyAuthDir(home);
    case "ark-cli":
      return path.join(home, ".arkcli", "identities");
    case "deepseek-harness":
      return path.join(home, ".credentials.yaml");
    case "antigravity":
      return process.platform === "win32"
        ? `Windows 凭据管理器（账号邮箱读取自 ${path.join(geminiDir(), "google_accounts.json")}）`
        : `系统钥匙串（账号邮箱读取自 ${path.join(geminiDir(), "google_accounts.json")}）`;
    default:
      return null;
  }
}

/** 默认账号用的是不是这台电脑上原来那份登录（Codex / Claude Code 在应用版里换成了 Xgent 自己的文件夹）。 */
function defaultIsShared(kind: AgentKind, home: string): boolean {
  if (kind === "codex") return samePath(home, path.join(os.homedir(), ".codex"));
  if (kind === "claude-code") return samePath(home, path.join(os.homedir(), ".claude"));
  return true; // 其它几个的默认账号没法隔开
}

export function loginSourceFor(kind: AgentKind, account: AgentAccountInfo): LoginSource | null {
  const where = location(kind, account.home);
  if (!where) return null;
  // 在 Xgent 里另外添加的账号都有自己的目录，不和任何软件共用。
  const shared = account.isDefault && defaultIsShared(kind, account.home);
  return { shared, sharedWith: shared ? (SHARED_WITH[kind] ?? null) : null, location: where };
}
