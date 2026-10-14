import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.ts";
import { listAudit } from "../services/auditService.ts";

export function registerAuditRoutes(app: FastifyInstance) {
  app.get("/api/audit", { preHandler: requireAuth }, async () => listAudit());
}
