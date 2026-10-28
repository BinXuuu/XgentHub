import { nanoid } from "nanoid";
import { db } from "../db/index.ts";
import { getRuntimeProfile, runtimeKindFromAgentKind } from "../adapters/runtimeMetadata.ts";
import type {
  TokenUsage,
  AgentDescriptor,
  AgentKind,
  AgentRecord,
  Artifact,
  ArtifactKind,
  CoreStatus,
  RuntimeKind,
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

function rowCapabilities(row: any): AgentRecord["capabilities"] {
  const runtime = getRuntimeProfile(row.kind);
  const parsed = safeJsonParse(row.capabilities, {});
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return runtime;
  return { ...runtime, ...(parsed as Record<string, unknown>) };
}

function rowToAgent(row: any): AgentRecord {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    description: row.description,
    runtimeKind: row.runtime_kind,
    capabilities: rowCapabilities(row),
    custom: Boolean(row.custom),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToSubtask(row: any): Subtask {
  return {
    id: row.id,
    taskId: row.task_id,
    parentSubtaskId: row.parent_subtask_id,
    title: row.title,
    status: row.status,
    assignedAgentId: row.assigned_agent_id,
    dependencyIds: safeJsonParse(row.dependency_ids, []) as string[],
    plannedPrompt: row.planned_prompt ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
    usage: rowToUsage(row),
  };
}

export function rowToUsage(row: any): TokenUsage | null {
  if (row.input_tokens == null && row.output_tokens == null && row.cached_tokens == null) return null;
  const inputTokens = Number(row.input_tokens) || 0;
  const outputTokens = Number(row.output_tokens) || 0;
  const cachedTokens = Number(row.cached_tokens) || 0;
  return { inputTokens, outputTokens, cachedTokens, totalTokens: inputTokens + outputTokens + cachedTokens };
}

/** 累加到这次运行上：多步的 Agent（DeepSeek Harness 每一步报一次）会报好几次。 */
export function addRunUsage(runId: string, usage: TokenUsage): void {
  db.prepare(
    `UPDATE task_runs SET input_tokens = COALESCE(input_tokens, 0) + ?, output_tokens = COALESCE(output_tokens, 0) + ?, cached_tokens = COALESCE(cached_tokens, 0) + ? WHERE id = ?`
  ).run(usage.inputTokens, usage.outputTokens, usage.cachedTokens, runId);
}

function rowToArtifact(row: any): Artifact {
  return {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    kind: row.kind,
    name: row.name,
    path: row.path,
    metadata: safeJsonParse(row.metadata, {}),
    createdAt: row.created_at,
  };
}

export { runtimeKindFromAgentKind };

function isFinishedStatus(status: CoreStatus): boolean {
  return status === "review" || status === "done" || status === "failed" || status === "stopped" || status === "cancelled" || status === "timed_out";
}

export function syncAgentDescriptor(agent: AgentDescriptor): AgentRecord {
  const stamp = now();
  const runtime = agent.runtime ?? getRuntimeProfile(agent.kind);
  const capabilities = {
    ...runtime,
    configured: agent.configured,
    supportsModelSelection: agent.supportsModelSelection,
    supportsUsage: agent.supportsUsage,
    supportsSubAgentSelection: agent.supportsSubAgentSelection,
    official: Boolean(agent.official),
    locked: Boolean(agent.locked),
  };

  db.prepare(
    `INSERT INTO agents (id, kind, name, description, runtime_kind, capabilities, custom, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       kind = excluded.kind,
       name = excluded.name,
       description = excluded.description,
       runtime_kind = excluded.runtime_kind,
       capabilities = excluded.capabilities,
       custom = excluded.custom,
       updated_at = excluded.updated_at`
  ).run(
    agent.id,
    agent.kind,
    agent.name,
    agent.description,
    runtime.kind,
    JSON.stringify(capabilities),
    agent.custom ? 1 : 0,
    stamp,
    stamp
  );

  return getAgentRecord(agent.id)!;
}

export function listAgentRecords(): AgentRecord[] {
  return (db.prepare("SELECT * FROM agents ORDER BY created_at ASC, rowid ASC").all() as any[]).map(rowToAgent);
}

export function getAgentRecord(agentId: string): AgentRecord | undefined {
  const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as any;
  return row ? rowToAgent(row) : undefined;
}

export function ensurePrimarySubtask(task: Task): Subtask {
  const existing = db.prepare("SELECT * FROM subtasks WHERE task_id = ? AND parent_subtask_id IS NULL ORDER BY created_at ASC LIMIT 1").get(task.id) as any;
  if (existing) return rowToSubtask(existing);

  const stamp = now();
  const id = nanoid();
  db.prepare(
    `INSERT INTO subtasks (id, task_id, parent_subtask_id, title, status, assigned_agent_id, dependency_ids, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, ?, '[]', ?, ?)`
  ).run(id, task.id, task.title, task.status, task.agentId, stamp, stamp);
  return rowToSubtask(db.prepare("SELECT * FROM subtasks WHERE id = ?").get(id));
}

export function createTaskRunForAgent(input: {
  task: Task;
  agentId?: string;
  agentKind?: AgentKind;
  model?: string | null;
  subtaskId?: string | null;
  sessionKey?: string | null;
}): TaskRun {
  const task = input.task;
  const subtaskId = input.subtaskId ?? ensurePrimarySubtask(task).id;
  const agentId = input.agentId ?? task.agentId;
  const agentKind = input.agentKind ?? task.agentKind;
  const model = input.model !== undefined ? input.model : task.model;
  const sessionKey = input.sessionKey !== undefined ? input.sessionKey : task.sessionKey;
  const row = db.prepare("SELECT MAX(attempt) AS attempt FROM task_runs WHERE task_id = ?").get(task.id) as { attempt: number | null };
  const attempt = (row.attempt ?? 0) + 1;
  const id = nanoid();
  const stamp = now();

  db.prepare(
    `INSERT INTO task_runs (id, task_id, subtask_id, agent_id, agent_kind, runtime_kind, model, status, attempt, session_key, started_at, finished_at, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, NULL, NULL)`
  ).run(
    id,
    task.id,
    subtaskId,
    agentId,
    agentKind,
    getRuntimeProfile(agentKind).kind,
    model,
    attempt,
    sessionKey,
    stamp
  );

  db.prepare("UPDATE subtasks SET status = 'running', assigned_agent_id = ?, updated_at = ? WHERE id = ? AND task_id = ?").run(
    agentId,
    stamp,
    subtaskId,
    task.id
  );
  return rowToRun(db.prepare("SELECT * FROM task_runs WHERE id = ?").get(id));
}

export function createTaskRun(task: Task): TaskRun {
  return createTaskRunForAgent({ task });
}

function getRun(runId: string): TaskRun | undefined {
  const row = db.prepare("SELECT * FROM task_runs WHERE id = ?").get(runId) as any;
  return row ? rowToRun(row) : undefined;
}

function latestRun(taskId: string): TaskRun | undefined {
  const row = db.prepare("SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at DESC, attempt DESC LIMIT 1").get(taskId) as any;
  return row ? rowToRun(row) : undefined;
}

export function syncSubtaskStatus(taskId: string, status: CoreStatus): void {
  db.prepare(
    "UPDATE subtasks SET status = ?, updated_at = ? WHERE task_id = ? AND parent_subtask_id IS NULL"
  ).run(status, now(), taskId);
}

export function syncRunStatus(input: { taskId: string; status: CoreStatus; runId?: string; error?: string | null }): void {
  const run = input.runId ? getRun(input.runId) : latestRun(input.taskId);
  if (!run) {
    syncSubtaskStatus(input.taskId, input.status);
    return;
  }

  const finishedAt = isFinishedStatus(input.status) ? now() : null;
  db.prepare(
    `UPDATE task_runs
     SET status = ?,
         finished_at = ?,
         error = COALESCE(?, error)
     WHERE id = ? AND task_id = ?`
  ).run(input.status, finishedAt, input.error ?? null, run.id, input.taskId);

  if (run.subtaskId) {
    db.prepare("UPDATE subtasks SET status = ?, updated_at = ? WHERE id = ? AND task_id = ?").run(input.status, now(), run.subtaskId, input.taskId);
  } else {
    syncSubtaskStatus(input.taskId, input.status);
  }
}

export function syncRunSessionKey(taskId: string, sessionKey: string, runId?: string): void {
  const id = runId ?? latestRun(taskId)?.id;
  if (!id) return;
  db.prepare("UPDATE task_runs SET session_key = ? WHERE id = ? AND task_id = ?").run(sessionKey, id, taskId);
}

export function recordArtifact(input: {
  taskId: string;
  runId?: string | null;
  kind: ArtifactKind;
  name: string;
  path?: string | null;
  metadata?: unknown;
}): Artifact {
  const id = nanoid();
  const stamp = now();
  db.prepare(
    "INSERT INTO artifacts (id, task_id, run_id, kind, name, path, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, input.taskId, input.runId ?? null, input.kind, input.name, input.path ?? null, JSON.stringify(input.metadata ?? {}), stamp);
  return rowToArtifact(db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id));
}

export function listSubtasks(taskId: string): Subtask[] {
  return (db.prepare("SELECT * FROM subtasks WHERE task_id = ? ORDER BY created_at ASC, rowid ASC").all(taskId) as any[]).map(rowToSubtask);
}

export function listTaskRuns(taskId: string): TaskRun[] {
  return (db.prepare("SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at ASC, attempt ASC").all(taskId) as any[]).map(rowToRun);
}

export function listArtifacts(taskId: string): Artifact[] {
  return (db.prepare("SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at ASC, rowid ASC").all(taskId) as any[]).map(rowToArtifact);
}
