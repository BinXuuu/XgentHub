# Xgent Hub 的 Docker 镜像：给飞牛（fnOS）、群晖这类 NAS 和 Linux 服务器用。
#   docker compose up -d          （见 docker-compose.yml）
# 镜像里装好了 Codex CLI 和 Claude Code CLI；它们的登录信息放在数据卷里，换镜像不用重新登录。

# ---- 构建：装全部依赖、编译前端，再去掉开发依赖 ----
FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

# ---- 运行 ----
FROM node:24-bookworm-slim
# git：「撤回这一轮」用它给工作区拍快照；Agent 改代码也常用到。curl：健康检查。tini：转发停止信号、回收子进程。
RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

# 镜像里自带的 Agent CLI；不想要可以 docker build --build-arg AGENT_CLIS= 去掉。
ARG AGENT_CLIS="@openai/codex @anthropic-ai/claude-code"
RUN if [ -n "$AGENT_CLIS" ]; then npm install -g $AGENT_CLIS --no-audit --no-fund && npm cache clean --force; fi

WORKDIR /app
COPY --from=build /app /app
COPY docker/entrypoint.sh /usr/local/bin/xgent-entrypoint
RUN chmod +x /usr/local/bin/xgent-entrypoint && mkdir -p /data /workspaces && chown node:node /data /workspaces

# 容器里要对外监听；数据库和配置放 /data，Agent 的登录信息放 /home/node（都是数据卷）。
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    ALLOW_LAN_BIND=true \
    PORT=4180 \
    DB_PATH=/data/agenthub.sqlite \
    CLAUDE_CONFIG_DIR=/home/node/.claude \
    AGENTHUB_UPDATE_MODE=docker \
    HOME=/home/node

EXPOSE 4180
VOLUME ["/data", "/home/node"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/xgent-entrypoint"]
