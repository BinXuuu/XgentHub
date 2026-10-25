#!/usr/bin/env bash
# 开机自启（macOS / Linux）：bash scripts/service.sh install|uninstall
#   macOS：~/Library/LaunchAgents 里放一个 launchd 任务，登录后自动启动，崩溃自动拉起。
#   Linux：systemd 用户服务（~/.config/systemd/user），不用 root。
# 装好以后用 scripts/xgent.sh start/stop/restart/status 管理，它会交给 launchd / systemd。
set -uo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

# 服务进程拿不到登录 shell 的 PATH：把 node 所在目录和常见的 CLI 安装位置写进去，Codex / Claude Code 才找得到。
service_path() {
  local node_dir npm_bin
  node_dir="$(dirname "$(command -v node)")"
  npm_bin="$(npm prefix -g 2>/dev/null)/bin"
  printf '%s' "$node_dir:$npm_bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
}

xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

install_launchd() {
  local node_bin
  node_bin="$(command -v node)"
  mkdir -p "$(dirname "$LAUNCHD_PLIST")" "$LOG_DIR"
  # AbandonProcessGroup：停止服务时不连带杀掉它起的子进程——在线更新脚本就是服务起的，它要负责把服务停了再拉起来。
  cat >"$LAUNCHD_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$SERVICE_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$node_bin")</string>
    <string>--experimental-strip-types</string>
    <string>--no-warnings=ExperimentalWarning</string>
    <string>src/index.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml_escape "$XGENT_ROOT/server")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml_escape "$(service_path)")</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>$(xml_escape "$LOG_FILE")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$LOG_FILE")</string>
</dict>
</plist>
EOF
  launchctl bootout "$(launchd_domain)/$SERVICE_LABEL" 2>/dev/null || true
  launchctl bootstrap "$(launchd_domain)" "$LAUNCHD_PLIST" || die "launchctl bootstrap 失败（需要在这台 Mac 上已登录桌面）"
  say "已安装开机自启：$LAUNCHD_PLIST"
}

install_systemd() {
  command -v systemctl >/dev/null 2>&1 || die "这台机器没有 systemd。可以改用 Docker 版（见 README），或者自己用 crontab @reboot 运行 scripts/xgent.sh start。"
  mkdir -p "$(dirname "$SYSTEMD_UNIT_FILE")" "$LOG_DIR"
  # KillMode=process：停止服务时只停主进程，不连带杀掉在线更新脚本（它是服务起的，要负责把服务停了再拉起来）。
  cat >"$SYSTEMD_UNIT_FILE" <<EOF
[Unit]
Description=Xgent Hub
After=network-online.target

[Service]
WorkingDirectory=$XGENT_ROOT/server
ExecStart=$(command -v node) --experimental-strip-types --no-warnings=ExperimentalWarning src/index.ts
Environment=PATH=$(service_path)
Restart=on-failure
RestartSec=5
KillMode=process
StandardOutput=append:$LOG_FILE
StandardError=append:$LOG_FILE

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now "$SYSTEMD_UNIT" || die "systemctl --user enable 失败"
  say "已安装开机自启：$SYSTEMD_UNIT_FILE"
  say "提示：想在没登录时也自动运行（比如服务器、NAS），再执行一次：sudo loginctl enable-linger $(id -un)"
}

install_service() {
  require_node
  # 先确认这台机器能装，再去停正在跑的服务：不然没有 systemd 的机器上服务会被停掉、自启又没装上。
  case "$(uname -s)" in
    Darwin) command -v launchctl >/dev/null 2>&1 || die "找不到 launchctl" ;;
    Linux) command -v systemctl >/dev/null 2>&1 || die "这台机器没有 systemd。可以改用 Docker 版（见 README），或者自己用 crontab @reboot 运行 scripts/xgent.sh start。" ;;
    *) die "不支持的系统：$(uname -s)" ;;
  esac
  # 停掉手动启动的那份，交给 launchd / systemd 接管。
  if [ "$(service_kind)" = none ] && health_json >/dev/null; then bash "$XGENT_ROOT/scripts/xgent.sh" stop; fi
  case "$(uname -s)" in
    Darwin) install_launchd ;;
    Linux) install_systemd ;;
    *) die "不支持的系统：$(uname -s)" ;;
  esac
  if wait_healthy 60; then say "已启动：http://127.0.0.1:$(xgent_port)"; else die "60 秒内没有启动成功，看日志：$LOG_FILE"; fi
}

uninstall_service() {
  case "$(service_kind)" in
    launchd)
      launchctl bootout "$(launchd_domain)/$SERVICE_LABEL" 2>/dev/null || true
      rm -f "$LAUNCHD_PLIST"
      ;;
    systemd)
      systemctl --user disable --now "$SYSTEMD_UNIT" 2>/dev/null || true
      rm -f "$SYSTEMD_UNIT_FILE"
      systemctl --user daemon-reload
      ;;
    none) say "没有安装开机自启" ;;
  esac
  say "已取消开机自启（服务已停止；要手动运行用 bash scripts/xgent.sh start）"
}

case "${1:-}" in
  install) install_service ;;
  uninstall) uninstall_service ;;
  *)
    echo "用法：bash scripts/service.sh install|uninstall"
    exit 2
    ;;
esac
