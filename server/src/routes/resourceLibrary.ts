import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.ts";
import { recordAudit } from "../services/auditService.ts";
import {
  createResourceLibraryItem,
  deleteResourceLibraryItem,
  listResourceLibraryItems,
  updateResourceLibraryItem,
  listSkillGroups,
  saveSkillGroup,
  deleteSkillGroup,
  moveSkillsToGroup,
} from "../services/resourceLibraryService.ts";
import { importInstalledPluginSkills } from "../services/installedSkillService.ts";
import { installGithubSkills, previewGithubSkills, removeGithubSkillFiles } from "../services/githubSkillService.ts";
import type { ResourceLibraryKind } from "../types.ts";

interface ResourceLibraryBody {
  title?: string;
  content?: string;
  tags?: string[];
  command?: string | null;
  groupId?: string | null;
}

function parseKind(kind: string): ResourceLibraryKind {
  if (kind === "skill" || kind === "tool" || kind === "mcp") return kind;
  throw new Error(`未知资源类型: ${kind}`);
}

export function registerResourceLibraryRoutes(app: FastifyInstance) {
  app.get("/api/skill-groups", { preHandler: requireAuth }, async () => listSkillGroups());
  for (const method of ["POST", "PUT"] as const) {
    app.route<{ Params: { id?: string }; Body: { name?: string; description?: string } }>({
      method, url: method === "POST" ? "/api/skill-groups" : "/api/skill-groups/:id", preHandler: requireAuth,
      handler: async (req, reply) => {
        try {
          const group = saveSkillGroup({ name: req.body?.name ?? "", description: req.body?.description }, req.params.id);
          recordAudit({ actor: "admin", agentId: null, taskId: null, action: method === "POST" ? "create_skill_group" : "update_skill_group", detail: { id: group.id, name: group.name } });
          return reply.code(method === "POST" ? 201 : 200).send(group);
        } catch (err) {
          return reply.code(400).send({ error: (err as Error).message });
        }
      },
    });
  }
  app.delete<{ Params: { id: string } }>("/api/skill-groups/:id", { preHandler: requireAuth }, async (req, reply) => {
    if (!deleteSkillGroup(req.params.id)) return reply.code(404).send({ error: "未知技能组" });
    recordAudit({ actor: "admin", agentId: null, taskId: null, action: "delete_skill_group", detail: { id: req.params.id } });
    return { ok: true };
  });
  app.put<{ Body: { ids: string[]; groupId: string | null } }>("/api/skill-group-members", { preHandler: requireAuth }, async (req, reply) => {
    try {
      moveSkillsToGroup(req.body?.ids, req.body?.groupId);
      recordAudit({ actor: "admin", agentId: null, taskId: null, action: "move_skills_to_group", detail: { groupId: req.body.groupId, count: req.body.ids.length } });
      return { ok: true };
    } catch (err) { return reply.code(400).send({ error: (err as Error).message }); }
  });
  app.post("/api/skills/import-installed", { preHandler: requireAuth }, async (_req, reply) => {
    try {
      const result = importInstalledPluginSkills();
      recordAudit({ actor: "admin", agentId: null, taskId: null, action: "import_installed_skills", detail: result });
      return result;
    } catch (err) { return reply.code(400).send({ error: (err as Error).message }); }
  });
  app.post<{ Body: { url?: string } }>("/api/skills/github/preview", { preHandler: requireAuth }, async (req, reply) => {
    try {
      return await previewGithubSkills(req.body?.url ?? "");
    } catch (err) { return reply.code(400).send({ error: (err as Error).message }); }
  });
  app.post<{ Body: { url?: string; paths?: string[]; groupId?: string | null } }>("/api/skills/github/install", { preHandler: requireAuth }, async (req, reply) => {
    try {
      const result = await installGithubSkills({ url: req.body?.url ?? "", paths: req.body?.paths ?? [], groupId: req.body?.groupId ?? null });
      recordAudit({ actor: "admin", agentId: null, taskId: null, action: "install_github_skills", detail: { url: req.body?.url, ...result } });
      return result;
    } catch (err) { return reply.code(400).send({ error: (err as Error).message }); }
  });
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
          groupId: req.body?.groupId,
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
        if (item.kind === "skill") removeGithubSkillFiles(item.sourcePath);
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
          groupId: req.body?.groupId,
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
