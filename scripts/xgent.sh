#!/usr/bin/env bash
# Xgent Hub 服务管理（macOS / Linux）：bash scripts/xgent.sh start|stop|restart|status|logs
# 装了开机自启（scripts/service.sh install）时，启动、停止交给 launchd / systemd；没装就直接在后台跑 node。
set -uo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

running_pid() {
  local pid
  [ -f "$PID_FILE" ] || return 1
  pid="$(cat "$PID_FILE")"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && echo "$pid"
}

# 端口上正在监听的进程号（lsof 或 ss，哪个有用哪个）。
listen_pid() {
  local port
  port="$(xgent_port)"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -n 1
  elif command -v ss >/dev/null 2>&1; then
    ss -ltnpH "sport = :$port" 2>/dev/null | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -n 1
  fi
}

# 进程的工作目录（确认它是从这个安装目录的 server/ 启动的，才去停它）。
process_cwd() {
  if [ -d "/proc/$1" ]; then
    readlink "/proc/$1/cwd"
  elif command -v lsof >/dev/null 2>&1; then
    lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1
  fi
}

stop_pid() {
  local pid="$1" i
  kill "$pid" 2>/dev/null || return 0
  for i in $(seq 1 15); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 1
  done
  kill -9 "$pid" 2>/dev/null || true
}

start() {
  local old
  old="$(started_at)"
  if [ -n "$old" ]; then
    say "已经在运行：http://127.0.0.1:$(xgent_port)"
    return 0
  fi
  mkdir -p "$LOG_DIR"
  case "$(service_kind)" in
    launchd)
      launchctl bootstrap "$(launchd_domain)" "$LAUNCHD_PLIST" 2>/dev/null || launchctl kickstart -k "$(launchd_domain)/$SERVICE_LABEL"
      ;;
    systemd)
      systemctl --user start "$SYSTEMD_UNIT" || die "systemctl --user start 失败"
      ;;
    none)
      require_node
      # 不能写成 `cd ... && nohup node ... &`：那样后台跑的是一个子 shell，$! 是它的进程号，不是 node 的。
      (
        cd "$XGENT_ROOT/server" || exit 1
        nohup node $NODE_FLAGS src/index.ts >>"$LOG_FILE" 2>&1 </dev/null &
        echo $! >"$PID_FILE"
      )
      ;;
  esac
  if wait_healthy 60; then
    say "已启动：http://127.0.0.1:$(xgent_port)"
  else
    die "60 秒内没有启动成功，看日志：$LOG_FILE"
  fi
}

stop() {
  local pid i
  case "$(service_kind)" in
    launchd) launchctl bootout "$(launchd_domain)/$SERVICE_LABEL" 2>/dev/null || true ;;
    systemd) systemctl --user stop "$SYSTEMD_UNIT" 2>/dev/null || true ;;
  esac
  pid="$(running_pid || true)"
  [ -n "$pid" ] && stop_pid "$pid"
  rm -f "$PID_FILE"
  # PID 文件丢了或不对（比如是用 npm start 手动起的）：按端口找，确认是这个目录的 server/ 起的再停。
  pid="$(listen_pid || true)"
  if [ -n "$pid" ] && [ "$(process_cwd "$pid")" = "$XGENT_ROOT/server" ]; then stop_pid "$pid"; fi
  for i in $(seq 1 10); do
    health_json >/dev/null || break
    sleep 1
  done
  if health_json >/dev/null; then
    die "端口 $(xgent_port) 上还有程序在响应，可能不是从这个目录启动的 Xgent。"
  fi
  say "已停止"
}

status() {
  local json
  json="$(health_json || true)"
  say "目录     : $XGENT_ROOT"
  say "地址     : http://127.0.0.1:$(xgent_port)"
  say "开机自启 : $(service_kind)"
  say "进程     : $(running_pid || echo '-')"
  say "日志     : $LOG_FILE"
  if [ -n "$json" ]; then say "状态     : 运行中 $json"; else say "状态     : 没有响应"; fi
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart)
    stop
    start
    ;;
  status) status ;;
  logs) tail -n 100 -f "$LOG_FILE" ;;
  *)
    echo "用法：bash scripts/xgent.sh start|stop|restart|status|logs"
    exit 2
    ;;
esac
