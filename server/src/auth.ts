import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.ts";
import { db } from "./db/index.ts";

const SESSION_COOKIE = "agenthub_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天，本机单用户场景

// 会话存在 SQLite（auth_sessions）里：以前放在内存 Map，服务一重启所有人都被登出，
// 页面却还停在原处、所有请求 401，看起来像"列表全空了"。库里只存 cookie 的哈希。

function hashToken(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

function cleanup() {
  db.prepare("DELETE FROM auth_sessions WHERE expires_at < ?").run(Date.now());
}

export function createSession(): string {
  cleanup();
  const id = randomBytes(24).toString("hex");
  db.prepare("INSERT INTO auth_sessions (token_hash, expires_at, created_at) VALUES (?, ?, ?)").run(
    hashToken(id),
    Date.now() + SESSION_TTL_MS,
    new Date().toISOString()
  );
  return id;
}

export function destroySession(id: string): void {
  db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(hashToken(id));
}

export function isValidSession(id: string | undefined): boolean {
  if (!id) return false;
  const row = db.prepare("SELECT expires_at FROM auth_sessions WHERE token_hash = ?").get(hashToken(id)) as { expires_at: number } | undefined;
  if (!row) return false;
  if (row.expires_at < Date.now()) {
    destroySession(id);
    return false;
  }
  return true;
}

export { SESSION_COOKIE };

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!config.adminToken) {
    // 未设置 ADMIN_TOKEN 时视为本机开发模式，直接放行（README 会提示尽快设置）
    return;
  }
  const cookie = req.cookies?.[SESSION_COOKIE];
  if (!isValidSession(cookie)) {
    reply.code(401).send({ error: "unauthorized" });
  }
}
