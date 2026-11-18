#!/usr/bin/env bash
# Xgent Hub 安装（macOS / Linux），Windows 用 install.bat。
#   bash install.sh             安装依赖、生成 .env（随机登录口令）、构建
#   bash install.sh --service   另外装上开机自启并启动（macOS：launchd；Linux：systemd 用户服务）
#   bash install.sh --start     装完直接在后台启动（不装开机自启）
set -uo pipefail
cd "$(dirname "$0")" || exit 1
# shellcheck source=scripts/lib.sh
. scripts/lib.sh

WITH_SERVICE=0
START_AFTER=0
for arg in "$@"; do
  case "$arg" in
    --service) WITH_SERVICE=1 ;;
    --start) START_AFTER=1 ;;
    -h | --help)
      sed -n '2,5p' "$0"
      exit 0
      ;;
    *) die "不认识的参数：$arg" ;;
  esac
done

require_node
command -v git >/dev/null 2>&1 || say "提示：没找到 git。「撤回这一轮」要用 git 给工作区拍快照，建议装上（macOS：xcode-select --install；Debian/Ubuntu：sudo apt install git）。"

mkdir -p logs backups server/data/attachments

if [ ! -f .env ]; then
  [ -f .env.example ] || die "缺少 .env.example"
  token="$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')"
  sed "s/^ADMIN_TOKEN=change-me-please$/ADMIN_TOKEN=$token/" .env.example >.env
  chmod 600 .env
  say "已生成 .env，登录口令在 .env 的 ADMIN_TOKEN 里"
else
  say ".env 已存在，保留原来的设置"
fi

for file in custom-agents.json hidden-agents.json; do
  [ -f "server/data/$file" ] || echo "[]" >"server/data/$file"
done

say "安装依赖（npm ci）..."
# 桌面版（Electron）目前只给 Windows 打包，macOS / Linux 用浏览器访问，不下载一百多 MB 的 Electron。
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund || die "npm ci 失败"

say "构建（npm run build）..."
npm run build || die "npm run build 失败"

if [ "$WITH_SERVICE" = 1 ]; then
  bash scripts/service.sh install || exit 1
elif [ "$START_AFTER" = 1 ]; then
  bash scripts/xgent.sh start || exit 1
fi

say "安装完成。"
say "启动 / 停止：bash scripts/xgent.sh start | stop | status"
say "打开：http://127.0.0.1:$(xgent_port)  （登录口令：.env 里的 ADMIN_TOKEN）"
