import { nanoid } from "nanoid";
import { db } from "../db/index.ts";
import { createTaskRunForAgent, listSubtasks, syncRunStatus } from "../services/coreModelService.ts";
import { emitTaskStatusChanged, recordDomainEvent } from "../services/eventService.ts";
import {
  canRetryRun,
  isRunTimedOut,
  isTerminalStatus,
  listRunnableSubtasks,
  shouldAdvanceQueue,
  type RetryPolicy,
} from "./scheduler.ts";
import type {
  AgentRequest,
  AgentRequestSource,
  AgentKind,
  CoreStatus,
  DomainEventName,
  RunCheckpoint,
  Subtask,
  Task,
  TaskRun,
} from "../types.ts";

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

function rowToAgentRequest(row: any): AgentRequest {
  return {
    id: row.id,
    taskId: row.task_id,
    sourceRunId: row.source_run_id,
    targetRunId: row.target_run_id,
    requestedAgentId: row.requested_agent_id,
    requestedAgentKind: row.requested_agent_kind,
    prompt: row.prompt,
    images: safeJsonParse(row.images, []) as string[],
    source: row.source,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

function rowToRun(row: any): TaskRun {
  return {
    id: row.id,
    taskId: row.task_id,
    subtaskId: row.subtask_id,
    agentId: row.agent_id,
    agentKind: row.agent_kind,
    runtimeKind: row.runtime_kind,
    model: row.model,
    status: row.status,
    attempt: row.attempt,
    sessionKey: row.session_key,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
  };
}

function rowToCheckpoint(row: any): RunCheckpoint {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    sequence: row.sequence,
    label: row.label,
    status: row.status,
    state: safeJsonParse(row.state, {}),
    createdAt: row.created_at,
  };
}

function getRun(runId: string): TaskRun | undefined {
  const row = db.prepare("SELECT * FROM task_runs WHERE id = ?").get(runId) as any;
  return row ? rowToRun(row) : undefined;
}

function latestRun(taskId: string): TaskRun | undefined {
  const row = db.prepare("SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at DESC, attempt DESC LIMIT 1").get(taskId) as any;
  return row ? rowToRun(row) : undefined;
}

function runEventNameForStatus(status: CoreStatus): DomainEventName {
  if (status === "timed_out") return "run.timed_out";
  if (status === "stopped") return "run.stopped";
  return isTerminalStatus(status) ? "run.finished" : "run.status.changed";
}

export function recordRunCheckpoint(input: {
  runId: string;
  taskId: string;
  label: string;
  status?: CoreStatus | null;
  state?: unknown;
}): RunCheckpoint {
  const sequenceRow = db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM run_checkpoints WHERE run_id = ?").get(input.runId) as {
    next: number;
  };
  const id = nanoid();
  const createdAt = now();
  db.prepare(
    "INSERT INTO run_checkpoints (id, run_id, task_id, sequence, label, status, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    id,
    input.runId,
    input.taskId,
    sequenceRow.next,
    input.label,
    input.status ?? null,
    JSON.stringify(input.state ?? {}),
    createdAt
  );
  return rowToCheckpoint(db.prepare("SELECT * FROM run_checkpoints WHERE id = ?").get(id));
}

export function createAgentRequest(input: {
  task: Task;
  prompt: string;
  images: string[];
  source: AgentRequestSource;
  sourceRunId?: string | null;
  requestedAgentId?: string;
  requestedAgentKind?: AgentKind;
  status?: CoreStatus;
}): AgentRequest {
  const id = nanoid();
  const createdAt = now();
  const requestedAgentId = input.requestedAgentId ?? input.task.agentId;
  const requestedAgentKind = input.requestedAgentKind ?? input.task.agentKind;
  db.prepare(
    `INSERT INTO agent_requests (
      id, task_id, source_run_id, target_run_id, requested_agent_id, requested_agent_kind,
      prompt, images, source, status, error, created_at, resolved_at
    ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`
  ).run(
    id,
    input.task.id,
    input.sourceRunId ?? null,
    requestedAgentId,
    requestedAgentKind,
    input.prompt,
    JSON.stringify(input.images),
    input.source,
    input.status ?? "queued",
    createdAt
  );
  return rowToAgentRequest(db.prepare("SELECT * FROM agent_requests WHERE id = ?").get(id));
}

export function startRun(input: {
  task: Task;
  prompt: string;
  images: string[];
  source: AgentRequestSource;
  sourceRunId?: string | null;
  agentId?: string;
  agentKind?: AgentKind;
  model?: string | null;
  subtaskId?: string | null;
}): { run: TaskRun; request: AgentRequest } {
  const agentId = input.agentId ?? input.task.agentId;
  const agentKind = input.agentKind ?? input.task.agentKind;
  const request = createAgentRequest({
    task: input.task,
    prompt: input.prompt,
    images: input.images,
    source: input.source,
    sourceRunId: input.sourceRunId ?? null,
    requestedAgentId: agentId,
    requestedAgentKind: agentKind,
  });
  const run = createTaskRunForAgent({
    task: input.task,
    agentId,
    agentKind,
    model: input.model,
    subtaskId: input.subtaskId,
  });
  db.prepare("UPDATE agent_requests SET target_run_id = ?, status = 'running' WHERE id = ?").run(run.id, request.id);
  recordRunCheckpoint({
    runId: run.id,
    taskId: input.task.id,
    label: "run.started",
    status: "running",
    state: {
      requestId: request.id,
      source: input.source,
      imageCount: input.images.length,
      promptPreview: input.prompt.slice(0, 160),
      agentId,
      agentKind,
      subtaskId: input.subtaskId ?? run.subtaskId,
    },
  });
  recordDomainEvent({
    name: "run.started",
    taskId: input.task.id,
    runId: run.id,
    payload: {
      requestId: request.id,
      source: input.source,
      agentId,
      agentKind,
      attempt: run.attempt,
      imageCount: input.images.length,
      subtaskId: input.subtaskId ?? run.subtaskId,
    },
  });

  return {
    run,
    request: rowToAgentRequest(db.prepare("SELECT * FROM agent_requests WHERE id = ?").get(request.id)),
  };
}

export function updateRunStatus(input: { taskId: string; runId?: string; status: CoreStatus; error?: string | null }): void {
  const run = input.runId ? getRun(input.runId) : latestRun(input.taskId);
  syncRunStatus({ taskId: input.taskId, runId: run?.id, status: input.status, error: input.error });
  if (!run) return;

  const terminal = isTerminalStatus(input.status);
  const stamp = now();
  db.prepare(
    `UPDATE agent_requests
     SET status = ?,
         error = COALESCE(?, error),
         resolved_at = CASE WHEN ? THEN COALESCE(resolved_at, ?) ELSE resolved_at END
     WHERE target_run_id = ?`
  ).run(input.status, input.error ?? null, terminal ? 1 : 0, stamp, run.id);

  recordRunCheckpoint({
    runId: run.id,
    taskId: input.taskId,
    label: input.status === "timed_out" ? "run.timed_out" : input.status === "stopped" ? "run.stopped" : terminal ? "run.finished" : "run.status",
    status: input.status,
    state: input.error ? { error: input.error } : {},
  });
  recordDomainEvent({
    name: runEventNameForStatus(input.status),
    taskId: input.taskId,
    runId: run.id,
    payload: input.error ? { status: input.status, error: input.error } : { status: input.status },
  });
}

export function stopRun(input: { taskId: string; runId?: string; reason?: string }): void {
  updateRunStatus({ taskId: input.taskId, runId: input.runId, status: "stopped", error: input.reason ?? null });
}

export function listAgentRequests(taskId?: string): AgentRequest[] {
  const rows = taskId
    ? (db.prepare("SELECT * FROM agent_requests WHERE task_id = ? ORDER BY created_at ASC, rowid ASC").all(taskId) as any[])
    : (db.prepare("SELECT * FROM agent_requests ORDER BY created_at DESC, rowid DESC").all() as any[]);
  return rows.map(rowToAgentRequest);
}

export function listRunCheckpoints(runId: string): RunCheckpoint[] {
  const rows = db.prepare("SELECT * FROM run_checkpoints WHERE run_id = ? ORDER BY sequence ASC").all(runId) as any[];
  return rows.map(rowToCheckpoint);
}

export function listRunnableSubtasksForTask(taskId: string): Subtask[] {
  return listRunnableSubtasks(listSubtasks(taskId));
}

export function planRetry(taskId: string, policy: RetryPolicy): { shouldRetry: boolean; sourceRunId: string | null; nextAttempt: number } {
  const run = latestRun(taskId);
  if (!run || !canRetryRun(run, policy)) return { shouldRetry: false, sourceRunId: run?.id ?? null, nextAttempt: (run?.attempt ?? 0) + 1 };
  return { shouldRetry: true, sourceRunId: run.id, nextAttempt: run.attempt + 1 };
}

export function markTimedOutRuns(timeoutMs: number, referenceDate = new Date()): TaskRun[] {
  const rows = db.prepare("SELECT * FROM task_runs WHERE status IN ('queued', 'waiting', 'running', 'needs_approval')").all() as any[];
  const timedOut: TaskRun[] = [];

  for (const row of rows) {
    const run = rowToRun(row);
    if (!isRunTimedOut(run, timeoutMs, referenceDate)) continue;

    updateRunStatus({ taskId: run.taskId, runId: run.id, status: "timed_out", error: `Run exceeded ${timeoutMs}ms timeout.` });
    db.prepare("UPDATE tasks SET status = 'failed', updated_at = ? WHERE id = ? AND status IN ('running', 'needs_approval')").run(now(), run.taskId);
    emitTaskStatusChanged({
      taskId: run.taskId,
      status: "failed",
      runId: run.id,
      payload: { status: "failed", reason: "run_timed_out", timeoutMs },
    });
    const updated = getRun(run.id);
    if (updated) timedOut.push(updated);
  }

  return timedOut;
}

export const orchestrator = {
  shouldAdvanceQueue,
  startRun,
  updateRunStatus,
  stopRun,
  listAgentRequests,
  listRunCheckpoints,
  listRunnableSubtasksForTask,
  planRetry,
  markTimedOutRuns,
};
