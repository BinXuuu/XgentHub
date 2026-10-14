import { nanoid } from "nanoid";
import { db } from "../db/index.ts";
import type { TaskReviewDecision, TaskReviewDecisionKind } from "../types.ts";

function now(): string {
  return new Date().toISOString();
}

function rowToReviewDecision(row: any): TaskReviewDecision {
  return {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    decision: row.decision,
    note: row.note,
    createdAt: row.created_at,
  };
}

export function createReviewDecision(input: {
  taskId: string;
  runId?: string | null;
  decision: TaskReviewDecisionKind;
  note?: string | null;
}): TaskReviewDecision {
  const id = nanoid();
  const createdAt = now();
  db.prepare(
    "INSERT INTO task_review_decisions (id, task_id, run_id, decision, note, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, input.taskId, input.runId ?? null, input.decision, input.note?.trim() || null, createdAt);
  return rowToReviewDecision(db.prepare("SELECT * FROM task_review_decisions WHERE id = ?").get(id));
}

export function listReviewDecisions(taskId?: string): TaskReviewDecision[] {
  const rows = taskId
    ? (db.prepare("SELECT * FROM task_review_decisions WHERE task_id = ? ORDER BY created_at ASC").all(taskId) as any[])
    : (db.prepare("SELECT * FROM task_review_decisions ORDER BY created_at DESC").all() as any[]);
  return rows.map(rowToReviewDecision);
}
