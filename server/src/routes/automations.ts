import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.ts";
import {
  automationUnreadCount,
  createAutomation,
  deleteAutomation,
  getAutomation,
  listAutomationRuns,
  listAutomations,
  markAutomationRunsRead,
  runAutomation,
  setAutomationStatus,
  updateAutomation,
  type AutomationInput,
} from "../services/automationService.ts";
import type { AutomationStatus } from "../types.ts";

export function registerAutomationRoutes(app: FastifyInstance) {
  app.get("/api/automations", { preHandler: requireAuth }, async () => listAutomations());

  app.get("/api/automations/unread-count", { preHandler: requireAuth }, async () => ({ count: automationUnreadCount() }));

  app.post<{ Body: AutomationInput }>("/api/automations", { preHandler: requireAuth }, async (req, reply) => {
    try {
      reply.code(201);
      return createAutomation(req.body ?? ({} as AutomationInput));
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.put<{ Params: { id: string }; Body: AutomationInput }>("/api/automations/:id", { preHandler: requireAuth }, async (req, reply) => {
    try {
      return updateAutomation(req.params.id, req.body ?? ({} as AutomationInput));
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.post<{ Params: { id: string }; Body: { status?: AutomationStatus } }>("/api/automations/:id/status", { preHandler: requireAuth }, async (req, reply) => {
    try {
      return setAutomationStatus(req.params.id, req.body?.status ?? "ACTIVE");
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.post<{ Params: { id: string } }>("/api/automations/:id/run", { preHandler: requireAuth }, async (req, reply) => {
    if (!getAutomation(req.params.id)) {
      reply.code(404);
      return { error: "找不到这个定时任务" };
    }
    return runAutomation(req.params.id, "manual");
  });

  app.get<{ Params: { id: string } }>("/api/automations/:id/runs", { preHandler: requireAuth }, async (req) => listAutomationRuns(req.params.id));

  app.post<{ Params: { id: string }; Body: { runId?: string } }>("/api/automations/:id/read", { preHandler: requireAuth }, async (req) => {
    markAutomationRunsRead(req.params.id, req.body?.runId);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/automations/:id", { preHandler: requireAuth }, async (req, reply) => {
    try {
      deleteAutomation(req.params.id);
      return { ok: true };
    } catch (err) {
      reply.code(404);
      return { error: (err as Error).message };
    }
  });
}
