import type { FastifyInstance } from "fastify";
import path from "node:path";
import { requireAuth } from "../auth.ts";
import {
  createWorkspace,
  deleteWorkspace,
  getWorkspacePrompt,
  listHosts,
  listWorkspaces,
  updateWorkspaceAccessPaths,
  updateWorkspacePrompt,
  updateWorkspaceResources,
  type WorkspaceResourcesInput,
} from "../services/workspaceService.ts";
import { recordAudit } from "../services/auditService.ts";
import { pickFolderWindows } from "../services/folderPicker.ts";
import type { AgentKind } from "../types.ts";

function defaultNameFromPath(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  return path.win32.basename(trimmed) || path.basename(trimmed) || trimmed;
}

interface CreateWorkspaceBody {
  name: string;
  path: string;
  allowedAgentKinds?: AgentKind[];
  accessPaths?: string[];
}

interface WorkspacePromptBody {
  content?: string;
}

interface WorkspaceAccessPathsBody {
  paths?: string[];
}

export function registerWorkspaceRoutes(app: FastifyInstance) {
  app.get("/api/hosts", { preHandler: requireAuth }, async () => listHosts());

  app.get("/api/workspaces", { preHandler: requireAuth }, async () => listWorkspaces());

  app.get<{ Params: { id: string } }>("/api/workspaces/:id/prompt", { preHandler: requireAuth }, async (req, reply) => {
    try {
      return getWorkspacePrompt(req.params.id);
    } catch (err) {
      reply.code(404);
      return { error: (err as Error).message };
    }
  });

  app.put<{ Params: { id: string }; Body: WorkspaceResourcesInput }>(
    "/api/workspaces/:id/resources",
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const workspace = updateWorkspaceResources(req.params.id, req.body ?? {});
        recordAudit({
          actor: "admin",
          agentId: null,
          taskId: null,
          action: "update_workspace_resources",
          detail: {
            workspaceId: workspace.id,
            knowledgeGroupIds: workspace.knowledgeGroupIds,
            mcpServerIds: workspace.mcpServerIds,
            toolIds: workspace.toolIds,
            skillIds: workspace.skillIds,
          },
        });
        return workspace;
      } catch (err) {
        reply.code(404);
        return { error: (err as Error).message };
      }
    }
  );

  app.post<{ Body: CreateWorkspaceBody }>("/api/workspaces", { preHandler: requireAuth }, async (req, reply) => {
    const { name, path: wsPath, allowedAgentKinds, accessPaths } = req.body ?? ({} as CreateWorkspaceBody);
    if (!wsPath?.trim()) {
      reply.code(400);
      return { error: "path 为必填项" };
    }
    const finalName = name?.trim() || defaultNameFromPath(wsPath.trim());
    const ws = createWorkspace({ name: finalName, path: wsPath.trim(), allowedAgentKinds: allowedAgentKinds ?? [], accessPaths: accessPaths ?? [] });
    recordAudit({ actor: "admin", agentId: null, taskId: null, action: "create_workspace", detail: ws });
    reply.code(201);
    return ws;
  });

  app.put<{ Params: { id: string }; Body: WorkspacePromptBody }>(
    "/api/workspaces/:id/prompt",
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const prompt = updateWorkspacePrompt(req.params.id, req.body?.content ?? "");
        recordAudit({
          actor: "admin",
          agentId: null,
          taskId: null,
          action: "update_workspace_prompt",
          detail: { workspaceId: req.params.id, length: prompt.content.length },
        });
        return prompt;
      } catch (err) {
        reply.code(404);
        return { error: (err as Error).message };
      }
    }
  );

  app.put<{ Params: { id: string }; Body: WorkspaceAccessPathsBody }>(
    "/api/workspaces/:id/access-paths",
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const workspace = updateWorkspaceAccessPaths(req.params.id, req.body?.paths ?? []);
        recordAudit({
          actor: "admin",
          agentId: null,
          taskId: null,
          action: "update_workspace_access_paths",
          detail: { workspaceId: req.params.id, count: workspace.accessPaths.length },
        });
        return workspace;
      } catch (err) {
        reply.code(404);
        return { error: (err as Error).message };
      }
    }
  );

  // 本机场景下直接弹系统文件夹选择框，比手填绝对路径可靠（浏览器拿不到真实绝对路径）
  app.post("/api/workspaces/pick-folder", { preHandler: requireAuth }, async (_req, reply) => {
    try {
      const selected = await pickFolderWindows();
      return { path: selected };
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.delete<{ Params: { id: string } }>("/api/workspaces/:id", { preHandler: requireAuth }, async (req) => {
    deleteWorkspace(req.params.id);
    recordAudit({ actor: "admin", agentId: null, taskId: null, action: "delete_workspace", detail: { id: req.params.id } });
    return { ok: true };
  });
}
