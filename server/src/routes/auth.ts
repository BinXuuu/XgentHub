import type { FastifyInstance } from "fastify";
import { config } from "../config.ts";
import { createSession, destroySession, isValidSession, SESSION_COOKIE } from "../auth.ts";

export function registerAuthRoutes(app: FastifyInstance) {
  app.get("/api/session", async (req) => {
    const cookie = req.cookies?.[SESSION_COOKIE];
    const requiresToken = Boolean(config.adminToken);
    const authenticated = !requiresToken || isValidSession(cookie);
    return { authenticated, requiresToken };
  });

  app.post<{ Body: { token?: string } }>("/api/login", async (req, reply) => {
    if (!config.adminToken) {
      return { ok: true };
    }
    const token = req.body?.token ?? "";
    if (token !== config.adminToken) {
      reply.code(401);
      return { ok: false, error: "令牌不正确" };
    }
    const sessionId = createSession();
    reply.setCookie(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
    });
    return { ok: true };
  });

  app.post("/api/logout", async (req, reply) => {
    const cookie = req.cookies?.[SESSION_COOKIE];
    if (cookie) destroySession(cookie);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });
}
