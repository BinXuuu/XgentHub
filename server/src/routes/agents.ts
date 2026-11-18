import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.ts";
import { createCustomAdapter } from "../adapters/custom.ts";
import { toDescriptor } from "../adapters/registry.ts";
import { taskManager } from "../services/taskManager.ts";
import { getAgentConfig, updateAgentConfig } from "../services/agentConfigService.ts";
import { getAdapter, isProtectedAgent } from "../adapters/registry.ts";
import { createCustomAgent, deleteCustomAgent, getCustomAgent, type CreateCustomAgentInput } from "../services/customAgentService.ts";
import { hideAgent } from "../services/agentVisibilityService.ts";
import { deleteAccountNote, setAccountNote } from "../services/accountNoteService.ts";
import { diagnoseAgent } from "../services/agentDiagnosticsService.ts";
import { getCliInstallJob, isCliInstallTarget, startCliInstall } from "../services/cliInstallService.ts";
import { cancelBrowserLogin, getBrowserLogin, submitBrowserLoginCode } from "../services/browserLogin.ts";
import {
  clearAgentApiKey,
  createAgentAccount,
  deleteAgentAccount,
  loginAgentAccount,
  logoutAgentAccount,
  renameAgentAccount,
} from "../services/agentAccountService.ts";

export function registerAgentRoutes(app: FastifyInstance) {
  app.get("/api/agents", { preHandler: requireAuth }, async () => {
    return taskManager.listAgents();
  });

  app.get("/api/agents/hidden", { preHandler: requireAuth }, async () => taskManager.listHiddenAgents());

  app.post<{ Params: { id: string } }>("/api/agents/:id/restore", { preHandler: requireAuth }, async (req, reply) => {
    try {
      return taskManager.restoreAgent(req.params.id);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post<{ Body: CreateCustomAgentInput }>("/api/agents/custom", { preHandler: requireAuth }, async (req) => {
    const created = createCustomAgent(req.body ?? { template: "api" });
    return toDescriptor(createCustomAdapter(created));
  });

  // ---- 账号：Codex、Claude Code 每个账号一个独立的配置目录；Antigravity 只有一个账号 ----
  app.post<{ Body: { kind?: string; name?: string; copyConfig?: boolean } }>("/api/agents/accounts", { preHandler: requireAuth }, async (req) => {
    const created = createAgentAccount(req.body ?? {});
    const adapter = getAdapter(created.id);
    if (!adapter) throw new Error("账号创建失败");
    return toDescriptor(adapter);
  });

  app.put<{ Params: { id: string }; Body: { note?: string } }>("/api/agents/:id/account-note", { preHandler: requireAuth }, async (req, reply) => {
    const adapter = getAdapter(req.params.id);
    if (!adapter?.account) return reply.code(400).send({ error: "这个 Agent 没有账号，不能写备注" });
    setAccountNote(req.params.id, String(req.body?.note ?? ""));
    return toDescriptor(adapter);
  });

  app.put<{ Params: { id: string }; Body: { name?: string } }>("/api/agents/:id/account", { preHandler: requireAuth }, async (req) => {
    renameAgentAccount(req.params.id, req.body?.name ?? "");
    taskManager.invalidateOptions(req.params.id);
    return toDescriptor(getAdapter(req.params.id)!);
  });

  app.post<{ Params: { id: string }; Body: { method?: "browser" | "apikey"; apiKey?: string; baseUrl?: string } }>(
    "/api/agents/:id/account-login",
    { preHandler: requireAuth },
    async (req) => {
      const result = await loginAgentAccount(req.params.id, getAdapter(req.params.id)?.name ?? req.params.id, req.body ?? {});
      taskManager.invalidateOptions(req.params.id);
      return { ok: true, ...result };
    }
  );

  app.post<{ Params: { id: string } }>("/api/agents/:id/account-logout", { preHandler: requireAuth }, async (req) => {
    await logoutAgentAccount(req.params.id);
    taskManager.invalidateOptions(req.params.id);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/agents/:id/account-api-key", { preHandler: requireAuth }, async (req) => {
    clearAgentApiKey(req.params.id);
    taskManager.invalidateOptions(req.params.id);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/agents/:id/config", { preHandler: requireAuth }, async (req) => {
    return getAgentConfig(req.params.id);
  });

  app.put<{ Params: { id: string }; Body: { values?: Record<string, string> } }>(
    "/api/agents/:id/config",
    { preHandler: requireAuth },
    async (req) => {
      const result = updateAgentConfig(req.params.id, req.body.values ?? {});
      taskManager.invalidateOptions(req.params.id);
      return result;
    }
  );

  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>(
    "/api/agents/:id/models",
    { preHandler: requireAuth },
    async (req) => taskManager.listModels(req.params.id, req.query.refresh === "1")
  );

  app.get<{ Params: { id: string } }>("/api/agents/:id/usage", { preHandler: requireAuth }, async (req) => {
    const text = await taskManager.getUsageSummary(req.params.id);
    return { text };
  });

  // 「网址 + 浏览器」式登录的进度、交验证码、取消（见 browserLogin.ts）。
  app.get<{ Params: { loginId: string } }>("/api/agent-login/:loginId", { preHandler: requireAuth }, async (req, reply) => {
    const session = getBrowserLogin(req.params.loginId);
    if (!session) return reply.code(404).send({ error: "这次登录的记录不在了（Xgent 重启过？），请重新点「登录」" });
    // 登录好了，模型列表等跟着账号走的缓存要重新取。
    if (session.status === "succeeded" && getAdapter(session.agentId)) taskManager.invalidateOptions(session.agentId);
    return session;
  });

  app.post<{ Params: { loginId: string }; Body: { code?: string } }>("/api/agent-login/:loginId/code", { preHandler: requireAuth }, async (req, reply) => {
    try {
      return submitBrowserLoginCode(req.params.loginId, String(req.body?.code ?? ""));
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.delete<{ Params: { loginId: string } }>("/api/agent-login/:loginId", { preHandler: requireAuth }, async (req) => {
    return cancelBrowserLogin(req.params.loginId) ?? { ok: true };
  });

  // 配置向导的「一键安装」：只接受 cliInstallService 里写死的几个名字。
  app.post<{ Body: { target?: unknown } }>("/api/agent-setup/install", { preHandler: requireAuth }, async (req, reply) => {
    const target = req.body?.target;
    if (!isCliInstallTarget(target)) return reply.code(400).send({ error: "不支持一键安装这个" });
    try {
      return startCliInstall(target);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get<{ Params: { jobId: string } }>("/api/agent-setup/install/:jobId", { preHandler: requireAuth }, async (req, reply) => {
    const job = getCliInstallJob(req.params.jobId);
    if (!job) return reply.code(404).send({ error: "安装记录不存在了（Xgent 重启过？），请重新点「一键安装」" });
    return job;
  });

  app.get<{ Params: { id: string } }>("/api/agents/:id/diagnostics", { preHandler: requireAuth }, async (req) => {
    return diagnoseAgent(req.params.id);
  });

  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>(
    "/api/agents/:id/sub-agents",
    { preHandler: requireAuth },
    async (req) => taskManager.listSubAgents(req.params.id, req.query.refresh === "1")
  );

  app.delete<{ Params: { id: string } }>("/api/agents/:id", { preHandler: requireAuth }, async (req, reply) => {
    if (isProtectedAgent(req.params.id)) {
      return reply.code(400).send({ error: "推荐接入不能删除或隐藏" });
    }
    const custom = getCustomAgent(req.params.id);
    const accountHome = deleteAgentAccount(req.params.id);
    if (accountHome) {
      deleteAccountNote(req.params.id);
      taskManager.invalidateOptions(req.params.id);
      return { ok: true, home: accountHome };
    }
    if (custom) {
      deleteCustomAgent(req.params.id);
    } else {
      const adapter = getAdapter(req.params.id);
      if (!adapter) throw new Error("这个 Agent 不存在");
      hideAgent(req.params.id);
    }
    taskManager.invalidateOptions(req.params.id);
    return { ok: true };
  });
}
