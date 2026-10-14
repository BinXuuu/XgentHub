import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.ts";
import { listMemoryEntries } from "../services/memoryService.ts";

export function registerMemoryRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { workspaceId?: string; taskId?: string; agentId?: string; limit?: string } }>(
    "/api/memory",
    { preHandler: requireAuth },
    async (req) =>
      listMemoryEntries({
        workspaceId: req.query.workspaceId,
        taskId: req.query.taskId,
        agentId: req.query.agentId,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      })
  );
}
