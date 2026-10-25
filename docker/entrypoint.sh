#!/bin/sh
# Docker 启动入口：先用 root 把数据卷交给 node 用户（宿主机上新建的目录通常是 root 的，node 用户写不进去），
# 没设登录口令就生成一个存进 /data，最后以 node 用户身份启动服务。
# 不用 root 跑：Claude Code 在 root 下不允许 --dangerously-skip-permissions（「完全访问」权限会用到）。
set -e

if [ "$(id -u)" = "0" ]; then
  for dir in /data /home/node; do
    mkdir -p "$dir"
    # 有任何不属于 node 的文件就整体改一次：比如用户用 docker exec（默认 root）跑过 codex login，登录文件就成了 root 的。
    if [ -n "$(find "$dir" ! -user node -print -quit 2>/dev/null)" ]; then chown -R node:node "$dir"; fi
  done
  exec setpriv --reuid=node --regid=node --init-groups "$0" "$@"
fi

if [ -z "${ADMIN_TOKEN:-}" ]; then
  TOKEN_FILE=/data/admin-token
  if [ ! -s "$TOKEN_FILE" ]; then
    node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))' >"$TOKEN_FILE"
    chmod 600 "$TOKEN_FILE"
    echo "[Xgent Hub] 没有设置 ADMIN_TOKEN，已生成登录口令：$(cat "$TOKEN_FILE")"
    echo "[Xgent Hub] 口令存在数据卷的 admin-token 文件里；想自己定口令，在 docker-compose.yml 里设 ADMIN_TOKEN。"
  fi
  ADMIN_TOKEN="$(cat "$TOKEN_FILE")"
  export ADMIN_TOKEN
fi

cd /app/server
exec node --experimental-strip-types --no-warnings=ExperimentalWarning src/index.ts
