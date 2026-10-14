import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { api } from "../api/client";
import { applyTheme, persistTheme, type ThemeMode } from "../utils/theme";

export function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>("light");

  useEffect(() => {
    applyTheme(theme);
    persistTheme(theme);
  }, [theme]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await api.login(token);
      if (res.ok) onLoggedIn();
      else setError(res.error ?? "登录失败");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function toggleTheme() {
    setTheme((value) => (value === "light" ? "dark" : "light"));
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <button
          className="login-theme-toggle"
          type="button"
          onClick={toggleTheme}
          title={theme === "light" ? "切换到暗色主题" : "切换到亮色主题"}
          aria-label={theme === "light" ? "切换到暗色主题" : "切换到亮色主题"}
        >
          {theme === "light" ? <Moon size={16} strokeWidth={2.2} /> : <Sun size={16} strokeWidth={2.2} />}
          <span>{theme === "light" ? "暗色" : "亮色"}</span>
        </button>
        <div className="login-card-head">
          <h1>Xgent Hub</h1>
          <p className="hint">输入管理员令牌以访问本机 Agent 控制台</p>
        </div>
        <form onSubmit={submit}>
          <input
            className="field"
            type="password"
            placeholder="ADMIN_TOKEN"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoFocus
          />
          {error && <div className="login-error">{error}</div>}
          <button className="btn btn-primary" type="submit" style={{ width: "100%", marginTop: 14 }} disabled={loading}>
            {loading ? "登录中..." : "登录"}
          </button>
        </form>
        <p className="login-token-hint">
          令牌在 Xgent Hub 安装目录的 <code>.env</code> 文件里，<code>ADMIN_TOKEN=</code> 后面那一串（安装版默认装在{" "}
          <code>%LOCALAPPDATA%\Programs\Xgent Hub</code>）。在这台电脑上用桌面版打开会自动登录。
        </p>
      </div>
    </div>
  );
}
