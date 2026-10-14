import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.ts";
import { chatService } from "../services/chatService.ts";

interface CreateChatBody {
  agentId: string;
  title: string;
  model?: string | null;
  mcpServerIds?: string[];
}

interface RenameChatBody {
  title: string;
}

interface UpdateChatModelBody {
  model?: string | null;
}

interface UpdateChatAgentBody {
  agentId: string;
}

interface UpdateChatMcpServersBody {
  mcpServerIds: string[];
}

interface SendChatMessageBody {
  message: string;
  images?: string[];
}

export function registerChatRoutes(app: FastifyInstance) {
  app.get("/api/chats", { preHandler: requireAuth }, async () => chatService.listChats());

  app.post<{ Body: CreateChatBody }>("/api/chats", { preHandler: requireAuth }, async (req, reply) => {
    const agentId = req.body?.agentId?.trim();
    const title = req.body?.title?.trim();
    if (!agentId || !title) {
      reply.code(400);
      return { error: "agentId / title 均为必填项" };
    }
    try {
      const chat = chatService.createChat({ agentId, title, model: req.body?.model ?? null, mcpServerIds: req.body?.mcpServerIds ?? [] });
      reply.code(201);
      return chat;
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.get<{ Params: { id: string } }>("/api/chats/:id", { preHandler: requireAuth }, async (req, reply) => {
    const chat = chatService.getChat(req.params.id);
    if (!chat) {
      reply.code(404);
      return { error: "not found" };
    }
    return chat;
  });

  app.put<{ Params: { id: string }; Body: RenameChatBody }>("/api/chats/:id", { preHandler: requireAuth }, async (req, reply) => {
    const title = req.body?.title?.trim();
    if (!title) {
      reply.code(400);
      return { error: "title 为必填项" };
    }
    try {
      return chatService.renameChat(req.params.id, title);
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.put<{ Params: { id: string }; Body: UpdateChatModelBody }>("/api/chats/:id/model", { preHandler: requireAuth }, async (req, reply) => {
    try {
      return chatService.updateChatModel(req.params.id, req.body?.model ?? null);
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.put<{ Params: { id: string }; Body: UpdateChatMcpServersBody }>(
    "/api/chats/:id/mcp-servers",
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        return chatService.setChatMcpServers(req.params.id, req.body?.mcpServerIds ?? []);
      } catch (err) {
        reply.code(400);
        return { error: (err as Error).message };
      }
    }
  );

  app.put<{ Params: { id: string }; Body: { toolIds?: string[] } }>("/api/chats/:id/tools", { preHandler: requireAuth }, async (req, reply) => {
    try {
      return chatService.setChatTools(req.params.id, req.body?.toolIds ?? []);
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.put<{ Params: { id: string }; Body: { skillIds?: string[] } }>("/api/chats/:id/skills", { preHandler: requireAuth }, async (req, reply) => {
    try {
      return chatService.setChatSkills(req.params.id, req.body?.skillIds ?? []);
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.put<{ Params: { id: string }; Body: { knowledgeIds?: string[] } }>(
    "/api/chats/:id/knowledge",
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        return chatService.setChatKnowledge(req.params.id, req.body?.knowledgeIds ?? []);
      } catch (err) {
        reply.code(400);
        return { error: (err as Error).message };
      }
    }
  );

  app.put<{ Params: { id: string }; Body: UpdateChatAgentBody }>("/api/chats/:id/agent", { preHandler: requireAuth }, async (req, reply) => {
    const agentId = req.body?.agentId?.trim();
    if (!agentId) {
      reply.code(400);
      return { error: "agentId 为必填项" };
    }
    try {
      return chatService.updateChatAgent(req.params.id, agentId);
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.delete<{ Params: { id: string } }>("/api/chats/:id", { preHandler: requireAuth }, async (req, reply) => {
    try {
      chatService.deleteChat(req.params.id);
      return { ok: true };
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.get<{ Params: { id: string } }>("/api/chats/:id/messages", { preHandler: requireAuth }, async (req) =>
    chatService.listMessages(req.params.id)
  );

  app.post<{ Params: { id: string }; Body: SendChatMessageBody }>(
    "/api/chats/:id/messages",
    { preHandler: requireAuth },
    async (req, reply) => {
      const message = req.body?.message?.trim();
      const images = req.body?.images ?? [];
      if (!message && images.length === 0) {
        reply.code(400);
        return { error: "message 或图片不能为空" };
      }
      try {
        return await chatService.sendMessage(req.params.id, message ?? "", images);
      } catch (err) {
        reply.code(400);
        return { error: (err as Error).message };
      }
    }
  );
}
