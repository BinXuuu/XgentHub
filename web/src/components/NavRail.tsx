import { useEffect, useState } from "react";
import {
  Bot,
  BookOpen,
  Home,
  ListChecks,
  MessageSquareText,
  Moon,
  Network,
  Store,
  Sparkles,
  Sun,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { api } from "../api/client";
import type { TaskStatus, UpdateInfo } from "../api/types";
import { UpdateCenter } from "./UpdateCenter";
import { applyTheme, persistTheme, readStoredTheme, type ThemeMode } from "../utils/theme";

export type NavView = "dashboard" | "chats" | "tasks" | "agents" | "knowledge" | "skills" | "tools" | "mcp" | "catalog";

interface Props {
  activeView: NavView;
  onViewChange: (view: NavView) => void;
  taskCounts: Record<TaskStatus, number>;
}

const NAV_ITEMS: { id: NavView; icon: LucideIcon; label: string }[] = [
  { id: "dashboard", icon: Home, label: "工作台" },
  { id: "chats", icon: MessageSquareText, label: "聊天" },
  { id: "tasks", icon: ListChecks, label: "任务" },
  { id: "agents", icon: Bot, label: "Agent" },
  { id: "knowledge", icon: BookOpen, label: "知识库" },
  { id: "skills", icon: Sparkles, label: "Skill" },
  { id: "tools", icon: Wrench, label: "工具" },
  { id: "mcp", icon: Network, label: "MCP" },
  { id: "catalog", icon: Store, label: "推荐" },
];

export function NavRail({ activeView, onViewChange, taskCounts }: Props) {
  const runningCount = taskCounts.running ?? 0;
  const [theme, setTheme] = useState<ThemeMode>(() => readStoredTheme("light"));

  useEffect(() => {
    applyTheme(theme);
    persistTheme(theme);
  }, [theme]);

  const approvalCount = taskCounts.needs_approval ?? 0;

  // 版本与在线更新：打开时查一次，之后每 6 小时查一次（服务端也有 6 小时缓存，不会频繁请求 GitHub）。
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [showUpdate, setShowUpdate] = useState(false);

  async function checkUpdate(force = false) {
    setCheckingUpdate(true);
    try {
      setUpdateInfo(await api.getUpdateInfo(force));
    } catch {
      // 查不到就先不显示新版本提示
    } finally {
      setCheckingUpdate(false);
    }
  }

  useEffect(() => {
    void checkUpdate();
    const timer = window.setInterval(() => void checkUpdate(), 6 * 60 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  const hasUpdate = Boolean(updateInfo?.available && updateInfo.mode !== "dev");

  function getRunningBadge(id: NavView): boolean {
    return id === "tasks" && runningCount > 0 && approvalCount === 0;
  }

  function toggleTheme() {
    setTheme((value) => (value === "dark" ? "light" : "dark"));
  }

  return (
    <nav className="nav-rail" aria-label="主导航">
      <div className="nav-rail-brand" title="Xgent Hub">
        <img src="/xgent-hub.png" alt="Xgent Hub" />
      </div>

      {NAV_ITEMS.map((item) => {
        const isRunning = getRunningBadge(item.id);
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            className={`nav-rail-item ${activeView === item.id ? "active" : ""}`}
            onClick={() => onViewChange(item.id)}
            title={item.label}
            aria-pressed={activeView === item.id}
          >
            <span className="nav-icon" aria-hidden="true">
              <Icon size={22} strokeWidth={2.1} />
            </span>
            <span className="nav-label">{item.label}</span>
            {isRunning && <span className="nav-badge nav-badge-running" />}
            {item.id === "tasks" && approvalCount > 0 && (
              <span className="nav-badge nav-badge-approval" title={`${approvalCount} 个任务在等你批准`}>
                {approvalCount}
              </span>
            )}
          </button>
        );
      })}

      <div className="nav-rail-spacer" />

      <button
        className={`nav-rail-version ${hasUpdate ? "has-update" : ""}`}
        type="button"
        onClick={() => setShowUpdate(true)}
        title={hasUpdate ? `有新版本 v${updateInfo?.latestVersion}，点开更新` : "版本与更新"}
      >
        {updateInfo ? `v${updateInfo.currentVersion}` : "版本"}
        {hasUpdate && <span className="nav-badge nav-badge-update" />}
      </button>

      <button
        className="nav-rail-theme-toggle"
        type="button"
        onClick={toggleTheme}
        title={theme === "dark" ? "切换到亮色主题" : "切换到暗色主题"}
        aria-label={theme === "dark" ? "切换到亮色主题" : "切换到暗色主题"}
      >
        <span className="nav-icon" aria-hidden="true">
          {theme === "dark" ? <Sun size={21} strokeWidth={2.1} /> : <Moon size={21} strokeWidth={2.1} />}
        </span>
        <span className="nav-label">{theme === "dark" ? "亮色" : "暗色"}</span>
      </button>

      {showUpdate && (
        <UpdateCenter info={updateInfo} checking={checkingUpdate} onCheck={() => void checkUpdate(true)} onClose={() => setShowUpdate(false)} />
      )}
    </nav>
  );
}

/** 移动端底部导航栏 */
export function BottomNav({
  activeView,
  onViewChange,
  taskCounts,
}: Props) {
  const runningCount = taskCounts.running ?? 0;
  const approvalCount = taskCounts.needs_approval ?? 0;

  return (
    <nav className="bottom-nav" aria-label="底部导航">
      {NAV_ITEMS.map((item) => {
        const isRunning = item.id === "tasks" && runningCount > 0 && approvalCount === 0;
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            className={`bottom-nav-item ${activeView === item.id ? "active" : ""}`}
            onClick={() => onViewChange(item.id)}
          >
            <span className="nav-icon" aria-hidden="true">
              <Icon size={19} strokeWidth={2.1} />
            </span>
            <span className="nav-label">{item.label}</span>
            {isRunning && <span className="nav-badge nav-badge-running" />}
            {item.id === "tasks" && approvalCount > 0 && <span className="nav-badge nav-badge-approval">{approvalCount}</span>}
          </button>
        );
      })}
    </nav>
  );
}
