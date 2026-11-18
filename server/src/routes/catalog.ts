import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireAuth } from "../auth.ts";
import { recordAudit } from "../services/auditService.ts";
import {
  CatalogConflictError,
  deleteCatalogSource,
  getCatalogPage,
  installCatalogItem,
  listCatalogSources,
  saveCatalogSource,
} from "../services/catalogService.ts";
import { checkStorePurchases, disconnectStore, getStoreStatus, startStoreBrowse, startStoreCheckout, startStoreLogin, stopStoreBrowse } from "../services/storeAccountService.ts";

export function registerCatalogRoutes(app: FastifyInstance) {
  // 页面用精简目录：商店只给每组前几个和真实总数，搜索在服务端做。
  app.get<{ Querystring: { refresh?: string; q?: string } }>("/api/catalog", { preHandler: requireAuth }, async (req) => getCatalogPage(req.query.refresh === "1", String(req.query.q ?? "").slice(0, 100)));

  app.post<{ Body: { sourceId?: string; itemId?: string; inputs?: Record<string, string>; force?: boolean; groupId?: string | null } }>(
    "/api/catalog/install",
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const result = await installCatalogItem({
          sourceId: req.body?.sourceId ?? "",
          itemId: req.body?.itemId ?? "",
          inputs: req.body?.inputs,
          force: req.body?.force === true,
          groupId: req.body?.groupId,
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
    app.route<{ Params: { id?: string }; Body: { name?: string; url?: string; key?: string | null; enabled?: boolean; type?: "catalog" | "store" } }>({
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

  // 商店源：连接官网账号、去官网结算、付款后自动安装。
  type StoreRoute = { Params: { id: string }; Body: { itemIds?: string[] } };
  const store = (action: string, handler: (id: string, body: { itemIds?: string[] }) => unknown) =>
    async (req: FastifyRequest<StoreRoute>, reply: FastifyReply) => {
      try {
        const result = await handler(req.params.id, req.body ?? {});
        if (action) recordAudit({ actor: "admin", agentId: null, taskId: null, action, detail: { id: req.params.id, itemIds: req.body?.itemIds } });
        return result;
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    };
  app.get<StoreRoute>("/api/catalog/sources/:id/store", { preHandler: requireAuth }, store("", (id) => getStoreStatus(id)));
  app.post<StoreRoute>("/api/catalog/sources/:id/login", { preHandler: requireAuth }, store("", (id) => startStoreLogin(id)));
  app.delete<StoreRoute>("/api/catalog/sources/:id/login", { preHandler: requireAuth }, store("disconnect_store_account", (id) => { disconnectStore(id); return { ok: true }; }));
  app.post<StoreRoute>("/api/catalog/sources/:id/checkout", { preHandler: requireAuth }, store("open_store_checkout", (id, body) => startStoreCheckout(id, body.itemIds ?? [])));
  app.post<StoreRoute>("/api/catalog/sources/:id/purchases/check", { preHandler: requireAuth }, store("", (id) => checkStorePurchases(id)));
  // 去官网挑选：盯着官网「我的库」，新加入的自动装上。
  app.post<StoreRoute>("/api/catalog/sources/:id/browse", { preHandler: requireAuth }, store("open_store_browse", (id) => startStoreBrowse(id)));
  app.delete<StoreRoute>("/api/catalog/sources/:id/browse", { preHandler: requireAuth }, store("", (id) => stopStoreBrowse(id)));
}
