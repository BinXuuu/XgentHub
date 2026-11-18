import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.ts";
import { getAdapter } from "../adapters/registry.ts";
import { recordAudit } from "../services/auditService.ts";
import {
  addRoleMemory,
  approveRoleMemory,
  deleteRoleMemory,
  getRoleMemory,
  listRoleMemories,
  createRole,
  deleteRole,
  listRoles,
  roleIdFromAgentId,
  setRoleEnabled,
  updateRole,
  type AgentRoleInput,
} from "../services/roleService.ts";

type RoleBody = Omit<AgentRoleInput, "baseAgentKind">;

/** 底座必须是真实 Agent（不能是另一个角色），而且要能接 MCP——角色的能力主要靠 MCP 工具补上。 */
function resolveBase(body: RoleBody | undefined): AgentRoleInput {
  const baseAgentId = body?.baseAgentId?.trim() ?? "";
  if (roleIdFromAgentId(baseAgentId)) throw new Error("底座不能是另一个角色");
  const base = baseAgentId ? getAdapter(baseAgentId) : undefined;
  if (!base) throw new Error("请选择一个存在的底座 Agent");
  if (!base.supportsMcp) throw new Error(`${base.name} 不支持 MCP，不能作为角色底座（可选 Claude Code / Codex / OpenClaw / Antigravity）`);
  return { ...(body as RoleBody), baseAgentId, baseAgentKind: base.kind };
}

export function registerRoleRoutes(app: FastifyInstance) {
  app.get("/api/roles", { preHandler: requireAuth }, async () => listRoles());

  app.post<{ Body: RoleBody }>("/api/roles", { preHandler: requireAuth }, async (req, reply) => {
    try {
      const role = createRole(resolveBase(req.body));
      recordAudit({ actor: "admin", agentId: null, taskId: null, action: "create_role", detail: { id: role.id, name: role.name, baseAgentId: role.baseAgentId } });
      reply.code(201);
      return role;
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.put<{ Params: { id: string }; Body: RoleBody }>("/api/roles/:id", { preHandler: requireAuth }, async (req, reply) => {
    try {
      const role = updateRole(req.params.id, resolveBase(req.body));
      recordAudit({ actor: "admin", agentId: null, taskId: null, action: "update_role", detail: { id: role.id, name: role.name, baseAgentId: role.baseAgentId } });
      return role;
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.put<{ Params: { id: string }; Body: { enabled?: boolean } }>("/api/roles/:id/enabled", { preHandler: requireAuth }, async (req, reply) => {
    try {
      return setRoleEnabled(req.params.id, Boolean(req.body?.enabled));
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.get<{ Params: { id: string } }>("/api/roles/:id/memories", { preHandler: requireAuth }, async (req) => listRoleMemories(req.params.id));

  app.post<{ Params: { id: string }; Body: { content?: string; source?: "manual" | "message"; taskId?: string | null } }>(
    "/api/roles/:id/memories",
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const memory = addRoleMemory({
          roleId: req.params.id,
          content: req.body?.content ?? "",
          status: "active",
          source: req.body?.source === "message" ? "message" : "manual",
          taskId: req.body?.taskId ?? null,
        });
        reply.code(201);
        return memory;
      } catch (err) {
        reply.code(400);
        return { error: (err as Error).message };
      }
    }
  );

  app.post<{ Params: { id: string; memoryId: string } }>(
    "/api/roles/:id/memories/:memoryId/approve",
    { preHandler: requireAuth },
    async (req, reply) => {
      const memory = getRoleMemory(req.params.memoryId);
      if (!memory || memory.roleId !== req.params.id) {
        reply.code(404);
        return { error: "找不到这条记忆" };
      }
      return approveRoleMemory(memory.id);
    }
  );

  app.delete<{ Params: { id: string; memoryId: string } }>(
    "/api/roles/:id/memories/:memoryId",
    { preHandler: requireAuth },
    async (req, reply) => {
      const memory = getRoleMemory(req.params.memoryId);
      if (!memory || memory.roleId !== req.params.id) {
        reply.code(404);
        return { error: "找不到这条记忆" };
      }
      deleteRoleMemory(memory.id);
      return { ok: true };
    }
  );

  app.delete<{ Params: { id: string } }>("/api/roles/:id", { preHandler: requireAuth }, async (req, reply) => {
    try {
      deleteRole(req.params.id);
      recordAudit({ actor: "admin", agentId: null, taskId: null, action: "delete_role", detail: { id: req.params.id } });
      return { ok: true };
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });
}
