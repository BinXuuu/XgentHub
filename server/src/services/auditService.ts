import { nanoid } from "nanoid";
import { db } from "../db/index.ts";
import type { AuditEntry } from "../types.ts";

export function recordAudit(input: { actor: string; agentId: string | null; taskId: string | null; action: string; detail: unknown }): void {
  const id = nanoid();
  const createdAt = new Date().toISOString();
  db.prepare(
    "INSERT INTO audit_log (id, actor, agent_id, task_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, input.actor, input.agentId, input.taskId, input.action, JSON.stringify(input.detail ?? {}), createdAt);
}

function rowToEntry(row: any): AuditEntry {
  return {
    id: row.id,
    actor: row.actor,
    agentId: row.agent_id,
    taskId: row.task_id,
    action: row.action,
    detail: JSON.parse(row.detail),
    createdAt: row.created_at,
  };
}

export function listAudit(limit = 200): AuditEntry[] {
  const rows = db.prepare("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?").all(limit) as any[];
  return rows.map(rowToEntry);
}
