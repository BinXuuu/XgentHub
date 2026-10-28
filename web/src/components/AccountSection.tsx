import { useEffect, useRef, useState } from "react";
import type { AgentDescriptor } from "../api/types";
import { api } from "../api/client";
import { copyText } from "../utils/clipboard";
import { accountLabel, authModeLabel, CLI_ACCOUNT_KINDS } from "../utils/agentAccount";
import { alertDialog, confirmDialog, errorDialog, promptDialog } from "../utils/dialog";

interface Props {
  agent: AgentDescriptor;
  onAgentsChanged: () => unknown;
  onAgentCreated: (agent: AgentDescriptor) => void;
  onLoginChanged: () => void;
}

const LOGIN_WAIT_MS = 3 * 60 * 1000;

const KIND_LABEL: Partial<Record<AgentDescriptor["kind"], string>> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  antigravity: "Antigravity",
  codebuddy: "WorkBuddy",
  "deepseek-harness": "DeepSeek",
  "ark-cli": "火山方舟",
};

/** 默认账号跟谁共用一份登录。 */
const SHARED_NOTE: Partial<Record<AgentDescriptor["kind"], string>> = {
  codex: "和 Codex 桌面版、终端里的 codex 共用一份登录",
  "claude-code": "和终端里的 claude 共用一份登录",
  codebuddy: "和终端里的 codebuddy 共用一份登录",
  "deepseek-harness": "和 DeepSeek Harness 桌面版共用一份登录",
  "ark-cli": "和终端里的 arkcli 共用一份登录",
};

function signature(agent: AgentDescriptor): string {
  const account = agent.account;
  return account ? `${account.loggedIn}|${account.authMode}|${account.email}|${account.apiKeyHint}|${account.baseUrl}` : "";
}

/**
 * 账号：显示这个 Agent 登录的是哪个账号，登录 / 退出 / 改名，以及再添加一个账号。
 * Codex、Claude Code 每个账号是一个独立的配置目录，登录、模型、额度、会话记录都分开；
 * Antigravity 的登录在系统凭据里，一台电脑只能有一个账号，这里只显示并提供打开 agy 去登录。
 */
export function AccountSection({ agent, onAgentsChanged, onAgentCreated, onLoginChanged }: Props) {
  const account = agent.account!;
  const kind = agent.kind;
  const kindLabel = KIND_LABEL[kind] ?? agent.name;
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const loginSignature = useRef(signature(agent));

  // 点了浏览器登录后，每 3 秒刷新一次列表，直到登录状态变了（或者等满 3 分钟）。
  useEffect(() => {
    if (waitingSince === null) return;
    const timer = window.setInterval(() => {
      if (Date.now() - waitingSince > LOGIN_WAIT_MS) {
        setWaitingSince(null);
        setMessage("还没检测到登录完成。登录好之后点「刷新」。");
        return;
      }
      void onAgentsChanged();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [waitingSince, onAgentsChanged]);

  useEffect(() => {
    const next = signature(agent);
    if (next === loginSignature.current) return;
    loginSignature.current = next;
    if (waitingSince !== null) {
      setWaitingSince(null);
      setMessage(agent.account?.loggedIn ? `登录成功：${accountLabel(agent.account)}` : "登录状态已更新");
    }
    onLoginChanged();
  }, [agent, waitingSince, onLoginChanged]);

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    setMessage(null);
    try {
      await action();
    } catch (err) {
      void errorDialog(err);
    } finally {
      setBusy(null);
    }
  }

  const sharedNote = SHARED_NOTE[kind] ?? "";
  const cliAccount = CLI_ACCOUNT_KINDS.includes(kind);

  async function loginWithBrowser() {
    if (account.loggedIn && account.authMode !== "apikey" && kind !== "antigravity") {
      const note = account.isDefault
        ? `默认账号${sharedNote}，换账号后它们也会跟着换。只想多用一个账号的话，建议用「添加另一个 ${kindLabel} 账号」。`
        : "登录新的账号会替换这个账号当前的登录。";
      if (!(await confirmDialog(note, { title: "换一个账号登录？", confirmText: "继续登录" }))) return;
    }
    await run("browser", async () => {
      const res = await api.agentAccountLogin(agent.id, { method: "browser" });
      if (res.opened === false) {
        // Linux / Docker 上没法弹窗：把要运行的命令（最后一行）复制好，弹窗里给出完整说明。
        const command = res.message.split("\n").pop() ?? "";
        const copied = command ? await copyText(command) : false;
        await alertDialog(`${res.message}${copied ? "\n\n（命令已复制到剪贴板）" : ""}`, { title: "在终端里运行登录命令" });
        setMessage("等你在终端里登录完成，这里会自动刷新。");
      } else {
        setMessage(`${res.message}完成后这里会自动刷新。`);
      }
      setWaitingSince(Date.now());
    });
  }

  async function loginWithApiKey() {
    if (kind === "codex") {
      const key = await promptDialog("Key 只保存在这个账号自己的目录里（Codex 的 auth.json），Xgent 不另外保存。", {
        title: `用 OpenAI API Key 登录「${agent.name}」`,
        confirmText: "登录",
        secret: true,
      });
      if (!key?.trim()) return;
      await run("apikey", async () => {
        await api.agentAccountLogin(agent.id, { method: "apikey", apiKey: key.trim() });
        await onAgentsChanged();
        setMessage("已用 API Key 登录");
      });
      return;
    }
    const baseUrl = await promptDialog(
      "用官方 Anthropic API 的话留空；用中转站就填它给的地址（比如 https://example.com）。下一步再填 Key。",
      { title: "中转站地址（可留空）", defaultValue: account.baseUrl ?? "", confirmText: "下一步", singleLine: true, placeholder: "https://…（用官方 API 就留空）" }
    );
    if (baseUrl === null) return;
    const key = await promptDialog(
      baseUrl.trim()
        ? "中转站给的 Key。Xgent 启动 Claude Code 时会用 ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN 带上。"
        : "Anthropic Console 里的 API Key。Xgent 启动 Claude Code 时会用 ANTHROPIC_API_KEY 带上。",
      { title: `给「${agent.name}」填 Key`, confirmText: "保存", secret: true }
    );
    if (!key?.trim()) return;
    await run("apikey", async () => {
      const res = await api.agentAccountLogin(agent.id, { method: "apikey", apiKey: key.trim(), baseUrl: baseUrl.trim() });
      await onAgentsChanged();
      setMessage(res.message);
    });
  }

  async function clearApiKey() {
    if (!(await confirmDialog("之后这个账号改回用 Claude 订阅登录。", { title: "清除 API Key / 中转站？", confirmText: "清除" }))) return;
    await run("clear", async () => {
      await api.clearAgentApiKey(agent.id);
      await onAgentsChanged();
      setMessage("已清除，改回订阅登录");
    });
  }

  async function logout() {
    const note = account.isDefault ? `默认账号${sharedNote}，退出后它们也需要重新登录。` : "退出后这个账号的任务会失败，直到重新登录。";
    if (!(await confirmDialog(note, { title: `退出「${accountLabel(account)}」？`, danger: true, confirmText: "退出登录" }))) return;
    await run("logout", async () => {
      await api.agentAccountLogout(agent.id);
      await onAgentsChanged();
      setMessage("已退出登录");
    });
  }

  async function rename() {
    const name = await promptDialog("只改在 Xgent 里显示的名字，登录不受影响。", { title: "改名", defaultValue: account.name, confirmText: "保存", singleLine: true });
    if (!name?.trim() || name.trim() === account.name) return;
    await run("rename", async () => {
      await api.renameAgentAccount(agent.id, name.trim());
      await onAgentsChanged();
    });
  }

  async function editNote() {
    const note = await promptDialog("只在 Xgent 里显示：左边栏括号里会显示它。清空就恢复显示邮箱 / 账号名。", {
      title: "备注",
      defaultValue: account.note ?? "",
      confirmText: "保存",
      singleLine: true,
    });
    if (note === null || note === undefined || note.trim() === (account.note ?? "")) return;
    await run("note", async () => {
      await api.setAgentAccountNote(agent.id, note.trim());
      await onAgentsChanged();
    });
  }

  async function addAccount() {
    if (kind !== "codex" && kind !== "claude-code" && !cliAccount) return;
    const copied = kind === "codex" ? "config.toml：MCP、默认模型等" : "settings.json：权限、hooks 等";
    const name = await promptDialog(
      cliAccount
        ? `给新账号起个名字，只用来在 Xgent 里区分，留空会自动起名。添加后再在它的详情页登录。
新账号有自己独立的登录目录，跟默认账号互不影响。`
        : `给新账号起个名字，只用来在 Xgent 里区分，留空会自动起名。添加后再在它的详情页登录。
新账号有自己独立的登录、额度和会话记录，会先复制默认账号的 ${kindLabel} 设置（${copied}），不复制登录。`,
      { title: `添加 ${kindLabel} 账号`, defaultValue: "", confirmText: "添加", singleLine: true, placeholder: "账号名，比如：工作号" }
    );
    if (name === null) return;
    await run("add", async () => {
      const created = await api.createAgentAccount({ kind: kind as "codex" | "claude-code" | "codebuddy" | "deepseek-harness" | "ark-cli", name: name.trim() || undefined, copyConfig: true });
      onAgentCreated(created);
    });
  }

  async function copyHome() {
    const ok = await copyText(account.home);
    setMessage(ok ? "已复制账号目录" : `复制失败：${account.home}`);
  }

  const description = !account.supportsMultiple
    ? "Antigravity 的登录保存在系统凭据里，一台电脑只能登录一个账号。要换账号，点下面的按钮打开 agy，在里面退出后重新登录。"
    : account.isDefault
      ? `默认账号：${sharedNote}。`
      : "这个账号有自己独立的登录、额度和会话记录，跟默认账号互不影响。";
  const statusKnown = account.supportsMultiple || account.loggedIn;

  return (
    <section className="config-section codex-account-section">
      <div className="config-section-head">
        <div>
          <h3>{kindLabel} 账号</h3>
          <p>{description}</p>
        </div>
        <div className="config-tools">
          <button className="btn btn-ghost btn-sm" onClick={() => void onAgentsChanged()} disabled={Boolean(busy)}>
            刷新
          </button>
        </div>
      </div>

      <div className="codex-account-grid">
        <span>状态</span>
        <strong>
          <span className={`config-state ${account.loggedIn ? "ok" : "warn"}`}>{account.loggedIn ? "已登录" : statusKnown ? "未登录" : "读不到"}</span>
          {waitingSince !== null && <span className="meta codex-account-waiting">等待登录…</span>}
        </strong>
        <span>账号</span>
        <strong>{account.loggedIn ? accountLabel(account) : "—"}</strong>
        <span>登录方式</span>
        <strong>{authModeLabel(account)}</strong>
        {account.baseUrl && (
          <>
            <span>中转站</span>
            <strong>{account.baseUrl}</strong>
          </>
        )}
        {account.plan && (
          <>
            <span>套餐</span>
            <strong>{account.plan}</strong>
          </>
        )}
        {account.supportsMultiple && (
          <>
            <span>名字</span>
            <strong>
              {account.name}
              {!account.isDefault && (
                <button className="btn btn-ghost btn-sm" onClick={() => void rename()} disabled={Boolean(busy)}>
                  改名
                </button>
              )}
            </strong>
          </>
        )}
        <span>备注</span>
        <strong>
          {account.note || <em className="meta">未填写，左边栏显示{account.isDefault ? "邮箱" : "名字"}</em>}
          <button className="btn btn-ghost btn-sm" onClick={() => void editNote()} disabled={Boolean(busy)}>
            {account.note ? "修改" : "添加"}
          </button>
        </strong>
        <span>账号目录</span>
        <strong className="codex-account-home">
          <span className="codex-account-path" title={account.home}>
            {account.home}
          </span>
          <button className="btn btn-ghost btn-sm" onClick={() => void copyHome()}>
            复制
          </button>
        </strong>
      </div>

      <div className="config-actions">
        {kind === "antigravity" ? (
          <button className="btn btn-primary btn-sm" onClick={() => void loginWithBrowser()} disabled={Boolean(busy)}>
            {busy === "browser" ? "正在打开…" : account.loggedIn ? "打开 agy 换账号" : "打开 agy 登录"}
          </button>
        ) : (
          <>
            <button className="btn btn-primary btn-sm" onClick={() => void loginWithBrowser()} disabled={Boolean(busy)}>
              {busy === "browser"
                ? "正在打开…"
                : account.loggedIn && account.authMode !== "apikey"
                  ? "换个账号登录"
                  : kind === "codex"
                    ? "登录 ChatGPT 账号"
                    : cliAccount
                      ? `登录 ${kindLabel} 账号`
                      : "登录 Claude 账号"}
            </button>
            {!cliAccount && (
              <button className="btn btn-sm" onClick={() => void loginWithApiKey()} disabled={Boolean(busy)}>
                {busy === "apikey" ? "保存中…" : kind === "codex" ? "用 API Key 登录" : "用 API Key / 中转站"}
              </button>
            )}
            {kind === "claude-code" && account.authMode === "apikey" && (
              <button className="btn btn-sm" onClick={() => void clearApiKey()} disabled={Boolean(busy)}>
                {busy === "clear" ? "清除中…" : "清除 API Key"}
              </button>
            )}
            {account.loggedIn && !cliAccount && (kind === "codex" || account.authMode !== "apikey") && (
              <button className="btn btn-sm" onClick={() => void logout()} disabled={Boolean(busy)}>
                {busy === "logout" ? "退出中…" : "退出登录"}
              </button>
            )}
            <button className="btn btn-sm" onClick={() => void addAccount()} disabled={Boolean(busy)}>
              {busy === "add" ? "添加中…" : `+ 添加另一个 ${kindLabel} 账号`}
            </button>
          </>
        )}
        {message && <span className="save-state">{message}</span>}
      </div>
      <p className="config-field-help">登录窗口和浏览器会在运行 Xgent 的这台电脑上打开，账号密码只在浏览器里输入。</p>
    </section>
  );
}
