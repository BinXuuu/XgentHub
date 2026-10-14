import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.ts";
import { createCustomAdapter } from "../adapters/custom.ts";
import { toDescriptor } from "../adapters/registry.ts";
import { taskManager } from "../services/taskManager.ts";
import { getAgentConfig, updateAgentConfig } from "../services/agentConfigService.ts";
import { getAdapter, isProtectedAgent } from "../adapters/registry.ts";
import { createCustomAgent, deleteCustomAgent, getCustomAgent, type CreateCustomAgentInput } from "../services/customAgentService.ts";
import { hideAgent } from "../services/agentVisibilityService.ts";
import { diagnoseAgent } from "../services/agentDiagnosticsService.ts";

export function registerAgentRoutes(app: FastifyInstance) {
  app.get("/api/agents", { preHandler: requireAuth }, async () => {
    return taskManager.listAgents();
  });

  app.post<{ Body: CreateCustomAgentInput }>("/api/agents/custom", { preHandler: requireAuth }, async (req) => {
    const created = createCustomAgent(req.body ?? { template: "api" });
    return toDescriptor(createCustomAdapter(created));
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
