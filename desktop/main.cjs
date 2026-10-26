const { app, BrowserWindow, Menu, Tray, nativeImage, shell, dialog } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

const root = path.resolve(process.env.XGENT_HUB_ROOT || path.join(__dirname, ".."));
const logsDir = path.join(root, "logs");
const logPath = path.join(logsDir, "desktop-shell.log");
const healthTimeoutMs = 90_000;
const desktopAssetsDir = path.join(root, "desktop", "assets");
const appIconPath = path.join(desktopAssetsDir, "xgent-hub.ico");
const trayIconPath = path.join(desktopAssetsDir, "xgent-hub-tray.png");
const fallbackTrayIconDataUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAIwSURBVDhPZVJtS5NhGN0PKudbClvl2AdnCySiwazAWFRkftBWKL4UYlb0gvZCWVYTLUaZlaVFPW45anOSqwWjHr8kRCiUWeCywOLkueK+2bM+nO2+Xs557uvcl800TeTCMCJoaj6KKu82lJa5BTwzx1p+vxbIZDI4dLgNa+1OrClwCEKRuEDFrLGHvRYBJvzbA7pRgeTXy38QaGy15NmrRESAqqpYWFKBMmeljj1bdmDi0wKq/QHL7cgRAc7FAkmh8TheLa0g9eM3zg2NYuf+IHpHI5j8mpVcYiGLi/eeoHidSzjk2mgOFdvP96HnziPYizdis68W99MmHqRncKC1C+5NPiQXl+UjfY+f48iF68Ih10aHGZy5OYzGzrOobz+J2Nwi9jV36OsSI29nZIyW7is4PXhXcuTa+EwM/HsahGh8mIO76p/o4EQSl0aeyZmG7j7YtlqfR83eBsmRqwVcnq2Yzq7I7IwJktXXQsZLiemJqouAGqHjcr+MEY6ncHUsinKnRzcSY+9nUVldY8nJCMrE4dQ7hBNvUFTqwokbYUQ/fkawqxsl5W5xfOr7L3liWa7V1yJHTFTPmFu49jSGupZj4nj8yxJuvZhG8ttP9D40ZLHYp58xf5GI4PEe9EcTcnZUeDE+O49TA0Mi6nB5Ja8XiT/5q2wv2oCB2BRuT6ZltFzjiP9WWYlQlVdjU0HhetTWN8G3q07n+M8eRbYIKHAumkOH+UwEz8yxZu038RdxlYAZS62xuwAAAABJRU5ErkJggg==";

let mainWindow = null;
let tray = null;
let isQuitting = false;
let serviceStarting = null;
const isSmokeMode = process.argv.includes("--smoke");
const isHoldSmokeMode = process.argv.includes("--hold-smoke");

// 自检模式用独立的临时 profile，不碰桌面版自己的 Cookie / localStorage（Cookie 不区分端口，测试实例会顶掉正式登录）。
if (isSmokeMode || isHoldSmokeMode) {
  app.setPath("userData", path.join(require("os").tmpdir(), `xgent-hub-smoke-${process.pid}`));
}

function appendLog(message) {
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, "utf8");
  } catch {
    // Logging must never break the desktop shell.
  }
}

function readDotEnv() {
  const envPath = path.join(root, ".env");
  const values = {};
  if (!fs.existsSync(envPath)) return values;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    values[key] = value;
  }
  return values;
}

function getPort() {
  const env = readDotEnv();
  const value = Number.parseInt(env.PORT || process.env.PORT || "4180", 10);
  return Number.isFinite(value) && value > 0 ? value : 4180;
}

function getBaseUrl() {
  return `http://127.0.0.1:${getPort()}`;
}

function readNativeImage(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const image = nativeImage.createFromPath(filePath);
  return image.isEmpty() ? null : image;
}

function getWindowIconPath() {
  return fs.existsSync(appIconPath) ? appIconPath : undefined;
}

function createTrayIcon() {
  const image = readNativeImage(trayIconPath) || readNativeImage(appIconPath) || nativeImage.createFromDataURL(fallbackTrayIconDataUrl);
  return image.resize({ width: 16, height: 16 });
}

function requestOk(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

function httpJson(method, url, { body, cookie } = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = {};
    if (payload !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    if (cookie) headers.Cookie = cookie;
    const req = http.request(url, { method, headers, timeout: timeoutMs }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => {
        let data = null;
        try {
          data = JSON.parse(text);
        } catch {
          data = null;
        }
        resolve({ status: res.statusCode || 0, data, setCookie: res.headers["set-cookie"] || [] });
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const SESSION_COOKIE = "agenthub_session";

// 桌面壳和服务在同一台电脑上，直接用 .env 里的 ADMIN_TOKEN 登录，用户不用再去找令牌。
// 会话 Cookie 写进窗口自己的 session，网页里拿不到令牌本身。
async function ensureDesktopLogin(win) {
  const token = readDotEnv().ADMIN_TOKEN;
  if (!token || !win || win.isDestroyed()) return;
  const baseUrl = getBaseUrl();
  const ses = win.webContents.session;
  try {
    const existing = await ses.cookies.get({ url: baseUrl, name: SESSION_COOKIE });
    const cookie = existing[0] ? `${SESSION_COOKIE}=${existing[0].value}` : undefined;
    const current = await httpJson("GET", `${baseUrl}/api/session`, { cookie });
    if (current.data && current.data.authenticated) return;
    const login = await httpJson("POST", `${baseUrl}/api/login`, { body: { token } });
    const match = login.setCookie.map((line) => line.match(new RegExp(`^${SESSION_COOKIE}=([^;]+)`))).find(Boolean);
    if (login.status !== 200 || !match) {
      appendLog(`Desktop auto-login failed: HTTP ${login.status}`);
      return;
    }
    await ses.cookies.set({
      url: baseUrl,
      name: SESSION_COOKIE,
      value: match[1],
      httpOnly: true,
      sameSite: "lax",
      expirationDate: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    });
  } catch (error) {
    appendLog(`Desktop auto-login skipped: ${error.message}`);
  }
}

async function waitForHealth(timeoutMs = healthTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const healthUrl = `${getBaseUrl()}/api/health`;
  while (Date.now() < deadline) {
    if (await requestOk(healthUrl)) return true;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return false;
}

function runPowerShell(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts", "agenthub.ps1"), ...args],
      {
        cwd: root,
        windowsHide: true,
      },
    );

    child.stdout.on("data", (data) => appendLog(data.toString().trimEnd()));
    child.stderr.on("data", (data) => appendLog(data.toString().trimEnd()));
    child.on("error", reject);
    child.on("close", (code) => resolve(code || 0));
  });
}

async function ensureService() {
  if (await requestOk(`${getBaseUrl()}/api/health`)) return;
  if (!serviceStarting) {
    serviceStarting = (async () => {
      appendLog("Starting Xgent Hub service from desktop shell.");
      const code = await runPowerShell(["start", "-Mode", "prod", "-StartOllama"]);
      if (code !== 0) appendLog(`Service start command exited with code ${code}. Waiting for health anyway.`);
      const ok = await waitForHealth();
      if (!ok) throw new Error(`Xgent Hub service did not become healthy at ${getBaseUrl()}/api/health`);
    })().finally(() => {
      serviceStarting = null;
    });
  }
  return serviceStarting;
}

function loadingHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <title>Xgent Hub</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #080b10;
      color: #dbe7ff;
      font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(420px, calc(100vw - 48px));
      border: 1px solid #253043;
      background: #111721;
      border-radius: 8px;
      padding: 22px;
      box-shadow: 0 24px 80px rgba(0, 0, 0, .36);
    }
    h1 {
      margin: 0 0 8px;
      font-size: 20px;
      letter-spacing: 0;
    }
    p {
      margin: 0;
      color: #8da0ba;
    }
    .bar {
      height: 4px;
      overflow: hidden;
      border-radius: 99px;
      background: #202938;
      margin-top: 18px;
    }
    .bar::before {
      content: "";
      display: block;
      width: 42%;
      height: 100%;
      border-radius: inherit;
      background: #3f83ff;
      animation: move 1.2s ease-in-out infinite alternate;
    }
    @keyframes move { from { transform: translateX(-20%); } to { transform: translateX(160%); } }
  </style>
</head>
<body>
  <main>
    <h1>正在启动 Xgent Hub</h1>
    <p>桌面壳正在拉起本地服务和 Ollama，稍等一下就会进入控制台。</p>
    <div class="bar"></div>
  </main>
</body>
</html>`;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: "Xgent Hub",
    icon: getWindowIconPath(),
    backgroundColor: "#080b10",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  // 服务已经在跑时，正式页面会在启动画面画出来之前就把它打断（ERR_ABORTED），这时 ready-to-show 不会再触发，
  // 所以下面加载完正式页面后还要再确保窗口显示出来；这里的打断是正常的，不当成错误。
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHtml())}`).catch(() => {});

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(getBaseUrl())) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(getBaseUrl()) || url.startsWith("data:text/html")) return;
    event.preventDefault();
    shell.openExternal(url);
  });

  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });

  ensureService()
    .then(() => ensureDesktopLogin(mainWindow))
    .then(() => mainWindow.loadURL(getBaseUrl()))
    .then(() => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show();
    })
    .catch((error) => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show();
      appendLog(error.stack || error.message);
      dialog.showErrorBox("Xgent Hub 启动失败", `${error.message}\n\n日志：${logPath}`);
      mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHtml().replace("正在启动 Xgent Hub", "Xgent Hub 启动失败").replace("桌面壳正在拉起本地服务和 Ollama，稍等一下就会进入控制台。", `请查看日志：${logPath}`))}`);
    });
}

function showWindow() {
  if (!mainWindow) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.moveTop();
  mainWindow.focus();
  mainWindow.setAlwaysOnTop(true);
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(false);
  }, 250);
}

async function restartService() {
  appendLog("Restart requested from tray/menu.");
  await runPowerShell(["restart", "-Mode", "prod", "-StartOllama"]);
  await waitForHealth(60_000);
  if (mainWindow) {
    await ensureDesktopLogin(mainWindow);
    mainWindow.loadURL(getBaseUrl());
  }
}

async function stopService() {
  appendLog("Stop requested from tray/menu.");
  await runPowerShell(["stop", "-Mode", "prod"]);
}

function createTray() {
  try {
    tray = new Tray(createTrayIcon());
    tray.setToolTip("Xgent Hub");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "打开 Xgent Hub", click: showWindow },
        { label: "在浏览器打开", click: () => shell.openExternal(getBaseUrl()) },
        { type: "separator" },
        { label: "重启本地服务", click: () => restartService().catch((error) => appendLog(error.stack || error.message)) },
        { label: "停止本地服务", click: () => stopService().catch((error) => appendLog(error.stack || error.message)) },
        { label: "打开日志目录", click: () => shell.openPath(logsDir) },
        { type: "separator" },
        {
          label: "退出桌面壳",
          click: () => {
            isQuitting = true;
            app.quit();
          },
        },
        {
          label: "退出并停止服务",
          click: async () => {
            isQuitting = true;
            await stopService().catch((error) => appendLog(error.stack || error.message));
            app.quit();
          },
        },
      ]),
    );
    tray.on("double-click", showWindow);
  } catch (error) {
    appendLog(`Tray unavailable: ${error.message}`);
  }
}

function createMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Xgent Hub",
        submenu: [
          { label: "打开 Xgent Hub", click: showWindow },
          { label: "在浏览器打开", click: () => shell.openExternal(getBaseUrl()) },
          { label: "重启本地服务", click: () => restartService().catch((error) => appendLog(error.stack || error.message)) },
          { label: "停止本地服务", click: () => stopService().catch((error) => appendLog(error.stack || error.message)) },
          { type: "separator" },
          { label: "退出", role: "quit" },
        ],
      },
      {
        label: "查看",
        submenu: [
          { role: "reload", label: "刷新" },
          { role: "toggleDevTools", label: "开发者工具" },
          { type: "separator" },
          { role: "resetZoom", label: "重置缩放" },
          { role: "zoomIn", label: "放大" },
          { role: "zoomOut", label: "缩小" },
        ],
      },
    ]),
  );
}

async function runSmoke() {
  try {
    await ensureService();
    const ok = await requestOk(`${getBaseUrl()}/api/health`);
    let autoLogin = "skipped";
    if (ok && process.argv.includes("--check-login")) {
      const win = new BrowserWindow({ show: false });
      await ensureDesktopLogin(win);
      const cookies = await win.webContents.session.cookies.get({ url: getBaseUrl(), name: SESSION_COOKIE });
      const cookie = cookies[0] ? `${SESSION_COOKIE}=${cookies[0].value}` : undefined;
      const session = await httpJson("GET", `${getBaseUrl()}/api/session`, { cookie });
      autoLogin = session.data && session.data.authenticated ? "authenticated" : "not-authenticated";
      win.destroy();
    }
    console.log(JSON.stringify({ ok, autoLogin, url: getBaseUrl(), root }, null, 2));
    app.exit(ok ? 0 : 1);
  } catch (error) {
    console.error(error.stack || error.message);
    app.exit(1);
  }
}

async function runHoldSmoke() {
  try {
    await ensureService();
    const ok = await requestOk(`${getBaseUrl()}/api/health`);
    console.log(JSON.stringify({ ok, hold: true, url: getBaseUrl(), root }, null, 2));
    if (!ok) {
      app.exit(1);
      return;
    }
    setInterval(() => {}, 1000);
  } catch (error) {
    console.error(error.stack || error.message);
    app.exit(1);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock && !isSmokeMode && !isHoldSmokeMode) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.on("before-quit", () => {
    isQuitting = true;
  });
  app.whenReady().then(() => {
    if (isSmokeMode) {
      runSmoke();
      return;
    }
    if (isHoldSmokeMode) {
      runHoldSmoke();
      return;
    }
    appendLog(`Desktop shell ready. root=${root}, url=${getBaseUrl()}`);
    createMenu();
    createTray();
    createWindow();
  });
  app.on("activate", showWindow);
}
