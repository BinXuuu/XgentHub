import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.ts";
import { recordAudit } from "../services/auditService.ts";
import {
  createMcpServer,
  deleteMcpServer,
  listMcpServersWithUsage,
  testMcpServerConnection,
  updateMcpServer,
  type McpServerInput,
} from "../services/mcpServerService.ts";

export function registerMcpServerRoutes(app: FastifyInstance) {
  app.get("/api/mcp-servers", { preHandler: requireAuth }, async () => listMcpServersWithUsage());

  app.post<{ Body: Partial<McpServerInput> }>("/api/mcp-servers/test", { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body ?? {};
    try {
      return await testMcpServerConnection({
        name: body.name ?? "",
        transport: body.transport ?? "stdio",
        command: body.command,
        args: body.args,
        env: body.env,
        url: body.url,
        headers: body.headers,
      });
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.post<{ Body: Partial<McpServerInput> }>("/api/mcp-servers", { preHandler: requireAuth }, async (req, reply) => {
    try {
      const body = req.body ?? {};
      const item = createMcpServer({
        name: body.name ?? "",
        transport: body.transport ?? "stdio",
        command: body.command,
        args: body.args,
        env: body.env,
        url: body.url,
        headers: body.headers,
        enabled: body.enabled,
      });
      recordAudit({ actor: "admin", agentId: null, taskId: null, action: "create_mcp_server", detail: { id: item.id, name: item.name } });
      reply.code(201);
      return item;
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.put<{ Params: { id: string }; Body: Partial<McpServerInput> }>(
    "/api/mcp-servers/:id",
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const item = updateMcpServer(req.params.id, req.body ?? {});
        recordAudit({ actor: "admin", agentId: null, taskId: null, action: "update_mcp_server", detail: { id: item.id, name: item.name } });
        return item;
      } catch (err) {
        reply.code(400);
        return { error: (err as Error).message };
      }
    }
  );

  app.delete<{ Params: { id: string } }>("/api/mcp-servers/:id", { preHandler: requireAuth }, async (req, reply) => {
    const item = deleteMcpServer(req.params.id);
    if (!item) {
      reply.code(404);
      return { error: `未知 MCP server: ${req.params.id}` };
    }
    recordAudit({ actor: "admin", agentId: null, taskId: null, action: "delete_mcp_server", detail: { id: item.id, name: item.name } });
    return { ok: true };
  });
}
