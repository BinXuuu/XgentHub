import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.ts";
import { recordAudit } from "../services/auditService.ts";
import {
  createKnowledgeEntry,
  createKnowledgeGroup,
  deleteKnowledgeEntry,
  updateKnowledgeEntry,
  deleteKnowledgeGroup,
  listKnowledgeEntries,
  listKnowledgeGroups,
  updateKnowledgeGroup,
} from "../services/knowledgeService.ts";

interface GroupBody {
  name?: string;
  description?: string;
}

interface EntryBody {
  groupId?: string;
  title?: string;
  content?: string;
  tags?: string[];
  source?: string;
}

export function registerKnowledgeRoutes(app: FastifyInstance) {
  app.get("/api/knowledge-groups", { preHandler: requireAuth }, async () => listKnowledgeGroups());

  app.post<{ Body: GroupBody }>("/api/knowledge-groups", { preHandler: requireAuth }, async (req, reply) => {
    try {
      const group = createKnowledgeGroup({ name: req.body?.name ?? "", description: req.body?.description });
      recordAudit({ actor: "admin", agentId: null, taskId: null, action: "create_knowledge_group", detail: { id: group.id, name: group.name } });
      reply.code(201);
      return group;
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.put<{ Params: { id: string }; Body: GroupBody }>("/api/knowledge-groups/:id", { preHandler: requireAuth }, async (req, reply) => {
    try {
      return updateKnowledgeGroup(req.params.id, { name: req.body?.name ?? "", description: req.body?.description });
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.delete<{ Params: { id: string } }>("/api/knowledge-groups/:id", { preHandler: requireAuth }, async (req, reply) => {
    try {
      deleteKnowledgeGroup(req.params.id);
      recordAudit({ actor: "admin", agentId: null, taskId: null, action: "delete_knowledge_group", detail: { id: req.params.id } });
      return { ok: true };
    } catch (err) {
      reply.code(404);
      return { error: (err as Error).message };
    }
  });

  app.get<{ Querystring: { groupId?: string; query?: string; limit?: string } }>(
    "/api/knowledge",
    { preHandler: requireAuth },
    async (req) =>
      listKnowledgeEntries({
        groupIds: req.query.groupId ? [req.query.groupId] : undefined,
        query: req.query.query,
        limit: req.query.limit ? Number(req.query.limit) : 300,
      })
  );

  app.post<{ Body: EntryBody }>("/api/knowledge", { preHandler: requireAuth }, async (req, reply) => {
    try {
      const entry = createKnowledgeEntry(req.body?.groupId ?? "", {
        title: req.body?.title ?? "",
        content: req.body?.content ?? "",
        tags: req.body?.tags ?? [],
        source: req.body?.source ?? "manual",
      });
      recordAudit({
        actor: "admin",
        agentId: null,
        taskId: null,
        action: "create_knowledge",
        detail: { groupId: entry.groupId, entryId: entry.id, title: entry.title },
      });
      reply.code(201);
      return entry;
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.put<{ Params: { id: string }; Body: EntryBody }>("/api/knowledge/:id", { preHandler: requireAuth }, async (req, reply) => {
    try {
      const entry = updateKnowledgeEntry(req.params.id, {
        groupId: req.body?.groupId,
        title: req.body?.title ?? "",
        content: req.body?.content ?? "",
        tags: req.body?.tags ?? [],
      });
      recordAudit({
        actor: "admin",
        agentId: null,
        taskId: null,
        action: "update_knowledge",
        detail: { groupId: entry.groupId, entryId: entry.id, title: entry.title },
      });
      return entry;
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.delete<{ Params: { id: string } }>("/api/knowledge/:id", { preHandler: requireAuth }, async (req, reply) => {
    const entry = deleteKnowledgeEntry(req.params.id);
    if (!entry) {
      reply.code(404);
      return { error: `未知知识条目: ${req.params.id}` };
    }
    recordAudit({ actor: "admin", agentId: null, taskId: null, action: "delete_knowledge", detail: { entryId: entry.id, title: entry.title } });
    return { ok: true };
  });
}
