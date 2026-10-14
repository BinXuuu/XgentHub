import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.ts";
import "./db/index.ts";
import { registerAuthRoutes } from "./routes/auth.ts";
import { registerAgentRoutes } from "./routes/agents.ts";
import { registerWorkspaceRoutes } from "./routes/workspaces.ts";
import { registerTaskRoutes } from "./routes/tasks.ts";
import { registerChatRoutes } from "./routes/chats.ts";
import { registerAttachmentRoutes } from "./routes/attachments.ts";
import { registerAuditRoutes } from "./routes/audit.ts";
import { registerOnboardingRoutes } from "./routes/onboarding.ts";
import { registerSystemRoutes } from "./routes/system.ts";
import { registerGatewayRoutes } from "./routes/gateway.ts";
import { registerNotificationRoutes } from "./routes/notifications.ts";
import { registerMemoryRoutes } from "./routes/memory.ts";
import { registerButlerRoutes } from "./routes/butler.ts";
import { registerResourceLibraryRoutes } from "./routes/resourceLibrary.ts";
import { registerMcpServerRoutes } from "./routes/mcpServers.ts";
import { registerRoleRoutes } from "./routes/roles.ts";
import { registerKnowledgeRoutes } from "./routes/knowledge.ts";
import { startDataBackupSchedule } from "./services/dataBackupService.ts";
import { startSnapshotPruneSchedule } from "./services/workspaceSnapshotService.ts";
import { listWorkspaces, createWorkspace } from "./services/workspaceService.ts";

// 首次启动给一个空的默认工作区。不能指向 Xgent Hub 自己的安装目录：新用户第一个测试任务就会让 Agent 改程序本身。
if (listWorkspaces().length === 0) {
  const defaultWorkspacePath = path.join(os.homedir(), "XgentHub-Workspace");
  fs.mkdirSync(defaultWorkspacePath, { recursive: true });
  createWorkspace({ name: "默认工作区", path: defaultWorkspacePath, allowedAgentKinds: [] });
}

// 默认 warn：Fastify 内置的每请求 info 日志（incoming request / request completed）太吵，
// 尤其是 SSE 长连接和前端轮询，本机单人使用没必要每条都落盘。想看全量请求日志时设 LOG_LEVEL=info。
// bodyLimit 调大是为了容纳 Chat 附件上传（图片转 base64 后体积会膨胀约 1/3）
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "warn" }, bodyLimit: 25 * 1024 * 1024 });

await app.register(cookie);
await app.register(cors, {
  origin: (origin, cb) => cb(null, true),
  credentials: true,
});

registerAuthRoutes(app);
registerAgentRoutes(app);
registerWorkspaceRoutes(app);
registerTaskRoutes(app);
registerChatRoutes(app);
registerAttachmentRoutes(app);
registerAuditRoutes(app);
registerOnboardingRoutes(app);
registerSystemRoutes(app);
registerGatewayRoutes(app);
registerNotificationRoutes(app);
registerMemoryRoutes(app);
registerButlerRoutes(app);
registerResourceLibraryRoutes(app);
registerMcpServerRoutes(app);
registerRoleRoutes(app);
registerKnowledgeRoutes(app);

app.get("/api/health", async () => ({ ok: true, time: new Date().toISOString() }));

// 生产模式：如果 web/dist 已构建，直接由后端一并提供静态文件（单端口访问，便于 Tailscale 手机访问）
const webDist = path.resolve(config.serverRoot, "../web/dist");
if (fs.existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.raw.url?.startsWith("/api/")) {
      reply.code(404).send({ error: "not found" });
      return;
    }
    reply.sendFile("index.html");
  });
}

app
  .listen({ host: config.host, port: config.port })
  .then(() => {
    // 用 console.log 而不是 app.log.info，确保不管 LOG_LEVEL 设成什么，这条启动横幅都看得见
    console.log(`Xgent Hub server listening on http://${config.host}:${config.port}`);
    startDataBackupSchedule((message) => console.log(`[backup] ${message}`));
    startSnapshotPruneSchedule((message) => console.log(`[snapshots] ${message}`));
    if (!config.adminToken) {
      app.log.warn("未设置 ADMIN_TOKEN：当前处于本机开发模式，任何能访问该端口的人都可以直接使用，请尽快在 .env 中设置 ADMIN_TOKEN。");
    }
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
