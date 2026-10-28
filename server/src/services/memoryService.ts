import { nanoid } from "nanoid";
import { db } from "../db/index.ts";
import type { MemoryEntry, Task } from "../types.ts";

function now(): string {
  return new Date().toISOString();
}

function rowToMemoryEntry(row: any): MemoryEntry {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    taskId: row.task_id,
    agentId: row.agent_id,
    kind: row.kind,
    title: row.title,
    content: row.content,
    metadata: JSON.parse(row.metadata ?? "{}"),
    createdAt: row.created_at,
  };
}

function latestAgentMessage(taskId: string): string {
  const row = db
    .prepare("SELECT content FROM task_messages WHERE task_id = ? AND role = 'agent' ORDER BY created_at DESC LIMIT 1")
    .get(taskId) as { content?: string } | undefined;
  return row?.content?.trim() ?? "";
}

function changedFiles(taskId: string): string[] {
  const rows = db.prepare("SELECT DISTINCT path FROM file_changes WHERE task_id = ? ORDER BY created_at ASC").all(taskId) as { path: string }[];
  return rows.map((row) => row.path);
}

function rowToTask(row: any): Task {
  return {
    id: row.id,
    agentId: row.agent_id,
    agentKind: row.agent_kind,
    workspaceId: row.workspace_id,
    title: row.title,
    prompt: row.prompt,
    status: row.status,
    sessionKey: row.session_key,
    model: row.model ?? null,
    permissionMode: row.permission_mode ?? "supervised",
    subAgentId: row.sub_agent_id ?? null,
    budgetLimitCny: row.budget_limit_cny == null ? null : Number(row.budget_limit_cny),
    autoAdvancePlan: Boolean(row.auto_advance_plan),
    splitAgentPool: null,
    planMode: Number(row.plan_mode) > 0,
    planModeSince: Number(row.plan_mode) > 0 ? new Date(Number(row.plan_mode)).toISOString() : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listMemoryEntries(input: { workspaceId?: string; taskId?: string; agentId?: string; limit?: number } = {}): MemoryEntry[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (input.workspaceId) {
    clauses.push("workspace_id = ?");
    params.push(input.workspaceId);
  }
  if (input.taskId) {
    clauses.push("task_id = ?");
    params.push(input.taskId);
  }
  if (input.agentId) {
    clauses.push("agent_id = ?");
    params.push(input.agentId);
  }
  const limit = Math.max(1, Math.min(input.limit ?? 100, 300));
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(`SELECT * FROM memory_entries ${where} ORDER BY created_at DESC LIMIT ?`).all(...params, limit) as any[];
  return rows.map(rowToMemoryEntry);
}

export function createTaskSummaryMemory(taskId: string): MemoryEntry | undefined {
  const existing = db.prepare("SELECT * FROM memory_entries WHERE task_id = ? AND kind = 'task_summary'").get(taskId) as any;
  if (existing) return rowToMemoryEntry(existing);

  const taskRow = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
  if (!taskRow) return undefined;
  const task = rowToTask(taskRow);
  if (task.status !== "done" && task.status !== "review") return undefined;

  const files = changedFiles(taskId);
  const finalMessage = latestAgentMessage(taskId);
  const content = [
    `任务：${task.title}`,
    `状态：${task.status}`,
    `Agent：${task.agentId}`,
    `原始请求：${task.prompt}`,
    finalMessage ? `最终回复：${finalMessage}` : "",
    files.length ? `涉及文件：${files.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const id = nanoid();
  const createdAt = now();
  db.prepare(
    "INSERT INTO memory_entries (id, workspace_id, task_id, agent_id, kind, title, content, metadata, created_at) VALUES (?, ?, ?, ?, 'task_summary', ?, ?, ?, ?)"
  ).run(
    id,
    task.workspaceId,
    task.id,
    task.agentId,
    task.title,
    content,
    JSON.stringify({ status: task.status, fileCount: files.length, model: task.model, subAgentId: task.subAgentId }),
    createdAt
  );
  return rowToMemoryEntry(db.prepare("SELECT * FROM memory_entries WHERE id = ?").get(id));
}
