import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.ts";
import { listNotifications, markAllNotificationsRead, markNotificationRead } from "../services/notificationService.ts";

export function registerNotificationRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { unreadOnly?: string; limit?: string } }>("/api/notifications", { preHandler: requireAuth }, async (req) =>
    listNotifications({
      unreadOnly: req.query.unreadOnly === "1" || req.query.unreadOnly === "true",
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    })
  );

  app.post<{ Params: { id: string } }>("/api/notifications/:id/read", { preHandler: requireAuth }, async (req, reply) => {
    const notification = markNotificationRead(req.params.id);
    if (!notification) {
      reply.code(404);
      return { error: "not found" };
    }
    return notification;
  });

  app.post("/api/notifications/read-all", { preHandler: requireAuth }, async () => ({ count: markAllNotificationsRead() }));
}
