#!/usr/bin/env bash
# 在线更新（macOS / Linux），Windows 对应 update-agenthub.ps1，步骤一样：
# 停服务 → 备份程序文件 → 换成新版本（下载源码包，或 git 切到标签）→ npm install + build → 启动 → 失败就恢复原版本。
# 用户配置（.env）、数据（server/data）、日志、备份、依赖都不在备份和更新范围内。
#
# 服务端调用时带 --launch：把脚本拷到临时目录、脱离服务另起进程跑，然后马上返回——更新要先把服务停掉，不能是它的子进程。
set -uo pipefail
# 桌面版（Electron）只给 Windows 打包，这里不下载它的一百多 MB 本体。
export ELECTRON_SKIP_BINARY_DOWNLOAD=1

LAUNCH=0 ROOT="" TAG="" MODE="archive" ARCHIVE_URL="" FROM_VERSION="" TO_VERSION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --launch) LAUNCH=1 ;;
    --root) ROOT="$2"; shift ;;
    --tag) TAG="$2"; shift ;;
    --mode) MODE="$2"; shift ;;
    --archive-url) ARCHIVE_URL="$2"; shift ;;
    --from) FROM_VERSION="$2"; shift ;;
    --to) TO_VERSION="$2"; shift ;;
    *) echo "不认识的参数：$1" >&2; exit 2 ;;
  esac
  shift
done

[ -n "$ROOT" ] || ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$ROOT" && pwd)"
LOGS_DIR="$ROOT/logs"
mkdir -p "$LOGS_DIR"
STATUS_FILE="$LOGS_DIR/update-status.json"
LOG_FILE="$LOGS_DIR/update.log"

json_str() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n\r\t' '   '; }

write_status() {
  local state="$1" step="$2" err="${3:-}"
  printf '{\n  "state": "%s",\n  "step": "%s",\n  "fromVersion": "%s",\n  "toVersion": "%s",\n  "tag": "%s",\n  "mode": "%s",\n  "updatedAt": "%s",\n  "error": "%s",\n  "log": "%s"\n}\n' \
    "$state" "$step" "$(json_str "$FROM_VERSION")" "$(json_str "$TO_VERSION")" "$(json_str "$TAG")" "$MODE" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(json_str "$err")" "$(json_str "$LOG_FILE")" >"$STATUS_FILE"
}

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG_FILE"; }

# 跑一条命令，输出都记进 update.log，返回它的退出码。
run_logged() {
  local label="$1"
  shift
  log "> $label"
  "$@" >>"$LOG_FILE" 2>&1
}

if [ "$LAUNCH" = 1 ]; then
  copy="$(mktemp "${TMPDIR:-/tmp}/xgenthub-update.XXXXXX")"
  cp "$0" "$copy"
  write_status running queued
  args=(--root "$ROOT" --tag "$TAG" --mode "$MODE" --from "$FROM_VERSION" --to "$TO_VERSION")
  [ -n "$ARCHIVE_URL" ] && args+=(--archive-url "$ARCHIVE_URL")
  # setsid 让它脱离服务的进程组（Linux 有；macOS 没有，靠 launchd 任务里的 AbandonProcessGroup 和 nohup）。
  if command -v setsid >/dev/null 2>&1; then
    setsid nohup bash "$copy" "${args[@]}" </dev/null >/dev/null 2>&1 &
  else
    nohup bash "$copy" "${args[@]}" </dev/null >/dev/null 2>&1 &
  fi
  exit 0
fi

XGENT_SH="$ROOT/scripts/xgent.sh"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$ROOT/backups/update-before-$FROM_VERSION-$STAMP"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/xgenthub-update-work.XXXXXX")"
APPLIED=0
PREVIOUS_HEAD=""
PORT_VALUE="$(grep -E '^[[:space:]]*PORT[[:space:]]*=' "$ROOT/.env" 2>/dev/null | tail -n 1 | sed -E 's/^[^=]*=[[:space:]]*//; s/[[:space:]]*$//')"
PORT_VALUE="${PORT_VALUE:-4180}"

started_at() { curl -fsS -m 3 "http://127.0.0.1:$PORT_VALUE/api/health" 2>/dev/null | sed -n 's/.*"startedAt":"\([^"]*\)".*/\1/p'; }

# 等服务起来，且是新进程（启动时间和更新前不一样）——光看能不能访问，可能还是没停掉的旧进程。
wait_new_process() {
  local deadline=$(($(date +%s) + $1)) now
  while [ "$(date +%s)" -lt "$deadline" ]; do
    now="$(started_at)"
    if [ -n "$now" ] && [ "$now" != "$OLD_STARTED_AT" ]; then return 0; fi
    sleep 2
  done
  return 1
}

# 把 $1 目录的内容拷到 $2，跳过数据、配置、依赖、日志、备份、.git。
copy_program_files() {
  mkdir -p "$2"
  (cd "$1" && tar -cf - --exclude=node_modules --exclude=.git --exclude=./logs --exclude=./backups \
    --exclude=./server/data --exclude=./XgentHub-opensource --exclude=./.env --exclude=./.env.bak .) | (cd "$2" && tar -xf -)
}

npm_install_and_build() {
  write_status running installing
  (cd "$ROOT" && run_logged "npm install" npm install --no-audit --no-fund) || return 1
  write_status running building
  (cd "$ROOT" && run_logged "npm run build" npm run build) || return 1
}

fail() {
  local message="$1"
  log "ERROR: $message"
  if [ "$APPLIED" = 1 ]; then
    write_status running restoring "$message"
    if [ "$MODE" = git ] && [ -n "$PREVIOUS_HEAD" ]; then
      run_logged "git checkout back to $PREVIOUS_HEAD" git -C "$ROOT" -c advice.detachedHead=false checkout --force "$PREVIOUS_HEAD"
    else
      run_logged "restore backup" copy_program_files "$BACKUP_DIR" "$ROOT"
    fi
    (cd "$ROOT" && run_logged "npm install (restore)" npm install --no-audit --no-fund)
    [ "$MODE" = git ] && (cd "$ROOT" && run_logged "npm run build (restore)" npm run build)
  fi
  if [ -z "$(started_at)" ]; then
    run_logged "xgent.sh start (restore)" bash "$XGENT_SH" start
  fi
  write_status failed failed "$message"
  rm -rf "$WORK_DIR"
  exit 1
}

log "Updating $FROM_VERSION -> $TO_VERSION (mode=$MODE, tag=$TAG)"
OLD_STARTED_AT="$(started_at)"

write_status running stopping
run_logged "xgent.sh stop" bash "$XGENT_SH" stop

write_status running backup
run_logged "backup to $BACKUP_DIR" copy_program_files "$ROOT" "$BACKUP_DIR" || fail "备份失败"

if [ "$MODE" = git ]; then
  write_status running downloading
  if [ -n "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ]; then fail "有改过但没提交的文件，先提交或放弃这些改动再更新"; fi
  PREVIOUS_HEAD="$(git -C "$ROOT" rev-parse HEAD)"
  run_logged "git fetch" git -C "$ROOT" fetch --tags --force origin || fail "git fetch 失败"
  write_status running applying
  APPLIED=1
  run_logged "git checkout $TAG" git -C "$ROOT" -c advice.detachedHead=false checkout --force "refs/tags/$TAG" || fail "git checkout $TAG 失败"
else
  [ -n "$ARCHIVE_URL" ] || fail "没有下载地址"
  write_status running downloading
  run_logged "download $ARCHIVE_URL" curl -fsSL -A "XgentHub-updater" -o "$WORK_DIR/update.tar.gz" "$ARCHIVE_URL" || fail "下载新版本失败"
  mkdir -p "$WORK_DIR/src"
  run_logged "extract" tar -xzf "$WORK_DIR/update.tar.gz" -C "$WORK_DIR/src" || fail "解压失败"
  INNER="$(find "$WORK_DIR/src" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  if [ -z "$INNER" ] || [ ! -f "$INNER/package.json" ] || [ ! -d "$INNER/server" ]; then fail "下载的文件看起来不是 Xgent Hub"; fi
  write_status running applying
  APPLIED=1
  run_logged "copy new version" copy_program_files "$INNER" "$ROOT" || fail "替换新版本文件失败"
fi

npm_install_and_build || fail "npm install / build 失败"

write_status running starting
run_logged "xgent.sh start" bash "$XGENT_SH" start
wait_new_process 90 || fail "更新后服务没有起来"

log "Update finished: $TO_VERSION"
write_status done done
rm -rf "$WORK_DIR"
