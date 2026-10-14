import { nanoid } from "nanoid";
import { db } from "../db/index.ts";
import { bus } from "../eventBus.ts";
import type { CoreStatus, DomainEvent, DomainEventName, EventType, TaskEvent } from "../types.ts";

function now(): string {
  return new Date().toISOString();
}

function safeJsonParse(value: string, fallback: unknown): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function rowToDomainEvent(row: any): DomainEvent {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    taskId: row.task_id,
    runId: row.run_id,
    legacyType: row.legacy_type,
    payload: safeJsonParse(row.payload, {}),
    createdAt: row.created_at,
  };
}

function taskExists(taskId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(taskId));
}

function normalizeDomainEventRefs(taskId?: string | null, runId?: string | null): { taskId: string | null; runId: string | null } {
  const run = runId ? (db.prepare("SELECT id, task_id FROM task_runs WHERE id = ?").get(runId) as any) : null;
  const validTaskId = taskId && taskExists(taskId) ? taskId : run?.task_id && taskExists(run.task_id) ? run.task_id : null;
  const validRunId = run && (!validTaskId || run.task_id === validTaskId) ? run.id : null;
  return { taskId: validTaskId, runId: validRunId };
}

export function domainNameForLegacyEvent(type: EventType): DomainEventName {
  switch (type) {
    case "log":
      return "task.log.created";
    case "status":
      return "task.status.changed";
    case "terminal":
      return "task.terminal.chunk";
    case "file":
      return "task.file.changed";
    case "diff":
      return "task.diff.created";
    case "message":
      return "task.message.created";
    case "approval_requested":
      return "approval.requested";
    case "approval_resolved":
      return "approval.resolved";
    case "queue_updated":
      return "queue.updated";
  }
}

export function recordDomainEvent(input: {
  name: DomainEventName;
  taskId?: string | null;
  runId?: string | null;
  legacyType?: EventType | null;
  payload?: unknown;
  createdAt?: string;
  version?: number;
}): DomainEvent {
  const id = nanoid();
  const createdAt = input.createdAt ?? now();
  const refs = normalizeDomainEventRefs(input.taskId ?? null, input.runId ?? null);
  db.prepare(
    "INSERT INTO domain_events (id, name, version, task_id, run_id, legacy_type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    id,
    input.name,
    input.version ?? 1,
    refs.taskId,
    refs.runId,
    input.legacyType ?? null,
    JSON.stringify(input.payload ?? {}),
    createdAt
  );
  return rowToDomainEvent(db.prepare("SELECT * FROM domain_events WHERE id = ?").get(id));
}

export function emitTaskEvent(input: {
  taskId: string;
  type: EventType;
  payload: unknown;
  runId?: string | null;
  domainName?: DomainEventName;
  createdAt?: string;
  touchTask?: boolean;
}): TaskEvent {
  const id = nanoid();
  const createdAt = input.createdAt ?? now();
  db.prepare("INSERT INTO task_events (id, task_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)").run(
    id,
    input.taskId,
    input.type,
    JSON.stringify(input.payload),
    createdAt
  );

  const event: TaskEvent = { id, taskId: input.taskId, type: input.type, payload: input.payload, createdAt };
  recordDomainEvent({
    name: input.domainName ?? domainNameForLegacyEvent(input.type),
    taskId: input.taskId,
    runId: input.runId ?? null,
    legacyType: input.type,
    payload: input.payload,
    createdAt,
  });

  bus.publishTaskEvent(input.taskId, event);
  if (input.touchTask ?? true) db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(createdAt, input.taskId);
  return event;
}

export function emitTaskStatusChanged(input: {
  taskId: string;
  status: CoreStatus;
  runId?: string | null;
  payload?: unknown;
  createdAt?: string;
}): DomainEvent {
  const createdAt = input.createdAt ?? now();
  const event = recordDomainEvent({
    name: "task.status.changed",
    taskId: input.taskId,
    runId: input.runId ?? null,
    legacyType: "status",
    payload: input.payload ?? { status: input.status },
    createdAt,
  });
  bus.publishTaskStatus(input.taskId, input.status);
  return event;
}

export function listDomainEvents(taskId?: string): DomainEvent[] {
  const rows = taskId
    ? (db.prepare("SELECT * FROM domain_events WHERE task_id = ? ORDER BY created_at ASC, rowid ASC").all(taskId) as any[])
    : (db.prepare("SELECT * FROM domain_events ORDER BY created_at DESC, rowid DESC").all() as any[]);
  return rows.map(rowToDomainEvent);
}

export function listDomainEventsForRun(runId: string): DomainEvent[] {
  const rows = db.prepare("SELECT * FROM domain_events WHERE run_id = ? ORDER BY created_at ASC, rowid ASC").all(runId) as any[];
  return rows.map(rowToDomainEvent);
}
