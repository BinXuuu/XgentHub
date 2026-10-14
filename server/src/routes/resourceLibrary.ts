import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.ts";
import { recordAudit } from "../services/auditService.ts";
import {
  createResourceLibraryItem,
  deleteResourceLibraryItem,
  listResourceLibraryItems,
  updateResourceLibraryItem,
} from "../services/resourceLibraryService.ts";
import type { ResourceLibraryKind } from "../types.ts";

interface ResourceLibraryBody {
  title?: string;
  content?: string;
  tags?: string[];
  command?: string | null;
}

function parseKind(kind: string): ResourceLibraryKind {
  if (kind === "skill" || kind === "tool" || kind === "mcp") return kind;
  throw new Error(`未知资源类型: ${kind}`);
}

export function registerResourceLibraryRoutes(app: FastifyInstance) {
  app.get<{ Params: { kind: string }; Querystring: { query?: string } }>(
    "/api/resource-library/:kind",
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        return listResourceLibraryItems(parseKind(req.params.kind), req.query.query);
      } catch (err) {
        reply.code(400);
        return { error: (err as Error).message };
      }
    }
  );

  app.post<{ Params: { kind: string }; Body: ResourceLibraryBody }>(
    "/api/resource-library/:kind",
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const item = createResourceLibraryItem(req.params.kind, {
          title: req.body?.title ?? "",
          content: req.body?.content ?? "",
          tags: req.body?.tags ?? [],
          command: req.body?.command ?? null,
        });
        recordAudit({
          actor: "admin",
          agentId: null,
          taskId: null,
          action: `create_${item.kind}`,
          detail: { id: item.id, title: item.title, tagCount: item.tags.length },
        });
        reply.code(201);
        return item;
      } catch (err) {
        reply.code(400);
        return { error: (err as Error).message };
      }
    }
  );

  app.delete<{ Params: { kind: string; id: string } }>(
    "/api/resource-library/:kind/:id",
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const item = deleteResourceLibraryItem(req.params.kind, req.params.id);
        if (!item) {
          reply.code(404);
          return { error: `未知资源: ${req.params.id}` };
        }
        recordAudit({
          actor: "admin",
          agentId: null,
          taskId: null,
          action: `delete_${item.kind}`,
          detail: { id: item.id, title: item.title },
        });
        return { ok: true };
      } catch (err) {
        reply.code(400);
        return { error: (err as Error).message };
      }
    }
  );

  app.put<{ Params: { kind: string; id: string }; Body: ResourceLibraryBody }>(
    "/api/resource-library/:kind/:id",
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const item = updateResourceLibraryItem(req.params.kind, req.params.id, {
          title: req.body?.title ?? "",
          content: req.body?.content ?? "",
          tags: req.body?.tags ?? [],
          command: req.body?.command ?? null,
        });
        recordAudit({
          actor: "admin",
          agentId: null,
          taskId: null,
          action: `update_${item.kind}`,
          detail: { id: item.id, title: item.title, tagCount: item.tags.length },
        });
        return item;
      } catch (err) {
        const message = (err as Error).message;
        reply.code(message.startsWith("未知资源") ? 404 : 400);
        return { error: message };
      }
    }
  );
}
