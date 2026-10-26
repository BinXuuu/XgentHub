import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.ts";
import { recordAudit } from "../services/auditService.ts";
import {
  CatalogConflictError,
  deleteCatalogSource,
  getCatalog,
  installCatalogItem,
  listCatalogSources,
  saveCatalogSource,
} from "../services/catalogService.ts";

export function registerCatalogRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { refresh?: string } }>("/api/catalog", { preHandler: requireAuth }, async (req) => getCatalog(req.query.refresh === "1"));

  app.post<{ Body: { sourceId?: string; itemId?: string; inputs?: Record<string, string>; force?: boolean } }>(
    "/api/catalog/install",
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const result = await installCatalogItem({
          sourceId: req.body?.sourceId ?? "",
          itemId: req.body?.itemId ?? "",
          inputs: req.body?.inputs,
          force: req.body?.force === true,
        });
        recordAudit({ actor: "admin", agentId: null, taskId: null, action: "install_catalog_item", detail: { sourceId: req.body?.sourceId, itemId: req.body?.itemId, ...result } });
        return result;
      } catch (err) {
        if (err instanceof CatalogConflictError) return reply.code(409).send({ error: err.message, code: err.code });
        return reply.code(400).send({ error: (err as Error).message });
      }
    }
  );

  app.get("/api/catalog/sources", { preHandler: requireAuth }, async () => listCatalogSources());
  for (const method of ["POST", "PUT"] as const) {
    app.route<{ Params: { id?: string }; Body: { name?: string; url?: string; key?: string | null; enabled?: boolean } }>({
      method,
      url: method === "POST" ? "/api/catalog/sources" : "/api/catalog/sources/:id",
      preHandler: requireAuth,
      handler: async (req, reply) => {
        try {
          const source = saveCatalogSource(req.body ?? {}, req.params.id);
          recordAudit({ actor: "admin", agentId: null, taskId: null, action: method === "POST" ? "add_catalog_source" : "update_catalog_source", detail: { id: source.id, url: source.url } });
          return reply.code(method === "POST" ? 201 : 200).send(source);
        } catch (err) {
          return reply.code(400).send({ error: (err as Error).message });
        }
      },
    });
  }
  app.delete<{ Params: { id: string } }>("/api/catalog/sources/:id", { preHandler: requireAuth }, async (req, reply) => {
    try {
      if (!deleteCatalogSource(req.params.id)) return reply.code(404).send({ error: "没有这个订阅源" });
      recordAudit({ actor: "admin", agentId: null, taskId: null, action: "delete_catalog_source", detail: { id: req.params.id } });
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
}
