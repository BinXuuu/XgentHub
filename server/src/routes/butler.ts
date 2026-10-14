import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.ts";
import { listButlerIntents, planButlerIntent } from "../services/butlerService.ts";

interface PlanIntentBody {
  prompt?: string;
  workspaceId?: string | null;
  imageCount?: number;
}

export function registerButlerRoutes(app: FastifyInstance) {
  app.post<{ Body: PlanIntentBody }>("/api/butler/intent", { preHandler: requireAuth }, async (req, reply) => {
    const prompt = req.body?.prompt?.trim();
    if (!prompt) {
      reply.code(400);
      return { error: "prompt 不能为空" };
    }
    try {
      return planButlerIntent({
        prompt,
        workspaceId: req.body?.workspaceId ?? null,
        imageCount: req.body?.imageCount,
      });
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.get<{ Querystring: { limit?: string } }>("/api/butler/intents", { preHandler: requireAuth }, async (req) =>
    listButlerIntents({ limit: req.query.limit ? Number(req.query.limit) : undefined })
  );
}
