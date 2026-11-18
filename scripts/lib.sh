# shellcheck shell=bash
# macOS / Linux 脚本共用的函数（Windows 对应的是 scripts/*.ps1）。只用 bash 3.2 也有的写法：macOS 自带的 bash 很老。

XGENT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$XGENT_ROOT/logs"
PID_FILE="$LOG_DIR/agenthub.pid"
LOG_FILE="$LOG_DIR/agenthub-prod.log"
SERVICE_LABEL="com.xgenthub.server"
SYSTEMD_UNIT="xgenthub.service"
LAUNCHD_PLIST="$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist"
SYSTEMD_UNIT_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$SYSTEMD_UNIT"
NODE_FLAGS="--experimental-strip-types --no-warnings=ExperimentalWarning"

say() { printf '[Xgent Hub] %s\n' "$*"; }
die() {
  printf '[Xgent Hub] 错误：%s\n' "$*" >&2
  exit 1
}

# 读 .env 里某个设置；没有就用默认值。
env_value() {
  local key="$1" def="${2:-}" val=""
  if [ -f "$XGENT_ROOT/.env" ]; then
    val="$(grep -E "^[[:space:]]*$key[[:space:]]*=" "$XGENT_ROOT/.env" | tail -n 1 | sed -E 's/^[^=]*=[[:space:]]*//; s/[[:space:]]*$//; s/^"(.*)"$/\1/')"
  fi
  printf '%s' "${val:-$def}"
}

xgent_port() { printf '%s' "${PORT:-$(env_value PORT 4180)}"; }

health_json() { curl -fsS -m 3 "http://127.0.0.1:$(xgent_port)/api/health" 2>/dev/null; }

# 这次服务进程的启动时间：用来区分"真的重启了"和"旧进程还在响应"。
started_at() { health_json | sed -n 's/.*"startedAt":"\([^"]*\)".*/\1/p'; }

# wait_healthy <秒> [旧的启动时间]：等到服务响应、且启动时间和旧的不一样。
wait_healthy() {
  local deadline=$(($(date +%s) + $1)) old="${2:-}" now
  while [ "$(date +%s)" -lt "$deadline" ]; do
    now="$(started_at)"
    if [ -n "$now" ] && [ "$now" != "$old" ]; then return 0; fi
    sleep 2
  done
  return 1
}

require_node() {
  command -v node >/dev/null 2>&1 || die "找不到 node。请先安装 Node.js 22.13 或更新版本：https://nodejs.org/"
  command -v npm >/dev/null 2>&1 || die "找不到 npm（通常和 Node.js 一起安装）"
  local v major minor
  v="$(node -p 'process.versions.node')"
  major="${v%%.*}"
  minor="$(printf '%s' "$v" | cut -d. -f2)"
  if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 13 ]; }; then
    die "Node.js 版本是 $v，需要 22.13 或更新（node:sqlite 从 22.13 起不用加开关）"
  fi
}

# 装了开机自启的话返回 launchd / systemd，否则 none。装了的时候启动、停止要交给它管，免得两边打架。
service_kind() {
  case "$(uname -s)" in
    Darwin) [ -f "$LAUNCHD_PLIST" ] && { echo launchd; return; } ;;
    Linux) [ -f "$SYSTEMD_UNIT_FILE" ] && { echo systemd; return; } ;;
  esac
  echo none
}

launchd_domain() { echo "gui/$(id -u)"; }
