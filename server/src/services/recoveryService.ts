import { nanoid } from "nanoid";
import { db } from "../db/index.ts";
import type { RecoveryActionKind, RecoveryActionStatus, TaskRecoveryAction } from "../types.ts";

function now(): string {
  return new Date().toISOString();
}

function rowToRecoveryAction(row: any): TaskRecoveryAction {
  return {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    kind: row.kind,
    status: row.status,
    note: row.note,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export function listRecoveryActions(taskId?: string): TaskRecoveryAction[] {
  const rows = taskId
    ? (db.prepare("SELECT * FROM task_recovery_actions WHERE task_id = ? ORDER BY created_at ASC").all(taskId) as any[])
    : (db.prepare("SELECT * FROM task_recovery_actions ORDER BY created_at DESC").all() as any[]);
  return rows.map(rowToRecoveryAction);
}

export function createRecoveryAction(input: {
  taskId: string;
  runId?: string | null;
  kind: RecoveryActionKind;
  status?: RecoveryActionStatus;
  note?: string | null;
}): TaskRecoveryAction {
  const id = nanoid();
  const createdAt = now();
  const status = input.status ?? "open";
  db.prepare(
    `INSERT INTO task_recovery_actions (id, task_id, run_id, kind, status, note, created_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`
  ).run(id, input.taskId, input.runId ?? null, input.kind, status, input.note?.trim() || null, createdAt);
  return rowToRecoveryAction(db.prepare("SELECT * FROM task_recovery_actions WHERE id = ?").get(id));
}

export function resolveRecoveryAction(id: string): TaskRecoveryAction | undefined {
  const resolvedAt = now();
  db.prepare("UPDATE task_recovery_actions SET status = 'resolved', resolved_at = ? WHERE id = ?").run(resolvedAt, id);
  const row = db.prepare("SELECT * FROM task_recovery_actions WHERE id = ?").get(id) as any;
  return row ? rowToRecoveryAction(row) : undefined;
}
