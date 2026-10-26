import { nanoid } from "nanoid";
import { db } from "../db/index.ts";
import { deleteWorkspaceSnapshots } from "./workspaceSnapshotService.ts";
import type { AgentKind, Workspace, WorkspacePrompt } from "../types.ts";

function parseJsonArray(value: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(value || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  } catch {
    return [];
  }
}

function normalizeAccessPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of paths) {
    const value = raw.trim();
    if (!value) continue;
    const key = value.replace(/[\\/]+$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(value);
  }
  return normalized;
}

function rowToWorkspace(row: any): Workspace {
  return {
    id: row.id,
    hostId: row.host_id,
    name: row.name,
    path: row.path,
    accessPaths: normalizeAccessPaths([row.path, ...parseJsonArray(row.access_paths)]),
    allowedAgentKinds: parseJsonArray(row.allowed_agent_kinds) as AgentKind[],
    knowledgeGroupIds: parseJsonArray(row.knowledge_group_ids),
    mcpServerIds: parseJsonArray(row.mcp_server_ids),
    toolIds: parseJsonArray(row.tool_ids),
    skillIds: parseJsonArray(row.skill_ids),
    createdAt: row.created_at,
  };
}

export interface WorkspaceResourcesInput {
  knowledgeGroupIds?: string[];
  mcpServerIds?: string[];
  toolIds?: string[];
  skillIds?: string[];
}

/** 只改传了的那几类；没传的保持原样。改完对这个工作区所有任务的下一轮生效。 */
export function updateWorkspaceResources(workspaceId: string, input: WorkspaceResourcesInput): Workspace {
  const workspace = getWorkspace(workspaceId);
  if (!workspace) throw new Error(`未知 workspace: ${workspaceId}`);
  const pick = (next: string[] | undefined, current: string[]) => JSON.stringify([...new Set(next ?? current)]);
  db.prepare("UPDATE workspaces SET knowledge_group_ids = ?, mcp_server_ids = ?, tool_ids = ?, skill_ids = ? WHERE id = ?").run(
    pick(input.knowledgeGroupIds, workspace.knowledgeGroupIds),
    pick(input.mcpServerIds, workspace.mcpServerIds),
    pick(input.toolIds, workspace.toolIds),
    pick(input.skillIds, workspace.skillIds),
    workspaceId
  );
  return getWorkspace(workspaceId)!;
}

function rowToWorkspacePrompt(row: any): WorkspacePrompt {
  return {
    workspaceId: row.workspace_id,
    content: row.content,
    updatedAt: row.updated_at,
  };
}

export function listWorkspaces(): Workspace[] {
  const rows = db.prepare("SELECT * FROM workspaces ORDER BY created_at ASC, rowid ASC").all() as any[];
  return rows.map(rowToWorkspace);
}

export function getWorkspace(id: string): Workspace | undefined {
  const row = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as any;
  return row ? rowToWorkspace(row) : undefined;
}

export function createWorkspace(input: { name: string; path: string; allowedAgentKinds: AgentKind[]; accessPaths?: string[]; hostId?: string }): Workspace {
  const id = nanoid();
  const createdAt = new Date().toISOString();
  const accessPaths = normalizeAccessPaths(input.accessPaths ?? []);
  db.prepare(
    "INSERT INTO workspaces (id, host_id, name, path, access_paths, allowed_agent_kinds, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, input.hostId ?? "local", input.name, input.path, JSON.stringify(accessPaths), JSON.stringify(input.allowedAgentKinds ?? []), createdAt);
  return getWorkspace(id)!;
}

export function updateWorkspaceAccessPaths(workspaceId: string, paths: string[]): Workspace {
  const workspace = getWorkspace(workspaceId);
  if (!workspace) throw new Error(`未知 workspace: ${workspaceId}`);
  const normalized = normalizeAccessPaths(paths);
  db.prepare("UPDATE workspaces SET access_paths = ? WHERE id = ?").run(JSON.stringify(normalized), workspaceId);
  resetWorkspaceTaskSessions(workspaceId);
  return getWorkspace(workspaceId)!;
}

function resetWorkspaceTaskSessions(workspaceId: string): void {
  db.prepare(
    `UPDATE tasks
     SET session_key = NULL, updated_at = ?
     WHERE workspace_id = ?
       AND status NOT IN ('running', 'needs_approval')`
  ).run(new Date().toISOString(), workspaceId);
}

export function getWorkspacePrompt(workspaceId: string): WorkspacePrompt {
  const workspace = getWorkspace(workspaceId);
  if (!workspace) throw new Error(`未知 workspace: ${workspaceId}`);
  const row = db.prepare("SELECT * FROM workspace_prompts WHERE workspace_id = ?").get(workspaceId) as any;
  if (row) return rowToWorkspacePrompt(row);
  return { workspaceId, content: "", updatedAt: workspace.createdAt };
}

export function updateWorkspacePrompt(workspaceId: string, content: string): WorkspacePrompt {
  if (!getWorkspace(workspaceId)) throw new Error(`未知 workspace: ${workspaceId}`);
  const trimmed = content.trim();
  const updatedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO workspace_prompts (workspace_id, content, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET
       content = excluded.content,
       updated_at = excluded.updated_at`
  ).run(workspaceId, trimmed, updatedAt);
  return rowToWorkspacePrompt(db.prepare("SELECT * FROM workspace_prompts WHERE workspace_id = ?").get(workspaceId));
}

/** 删除 workspace 时级联清理其下的任务及任务相关数据，避免外键约束报错。 */
export function deleteWorkspace(id: string): void {
  const taskIds = (db.prepare("SELECT id FROM tasks WHERE workspace_id = ?").all(id) as { id: string }[]).map((r) => r.id);
  for (const taskId of taskIds) {
    db.prepare("DELETE FROM task_messages WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM task_events WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM file_changes WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM approvals WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM notifications WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM task_recovery_actions WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM task_review_decisions WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM audit_log WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM message_queue WHERE task_id = ?").run(taskId);
  }
  deleteWorkspaceSnapshots(id);
  db.prepare("DELETE FROM tasks WHERE workspace_id = ?").run(id);
  db.prepare("DELETE FROM always_allow_rules WHERE workspace_id = ?").run(id);
  db.prepare("DELETE FROM memory_entries WHERE workspace_id = ?").run(id);
  db.prepare("DELETE FROM butler_intents WHERE workspace_id = ?").run(id);
  db.prepare("DELETE FROM workspace_prompts WHERE workspace_id = ?").run(id);
  db.prepare("DELETE FROM workspace_knowledge_entries WHERE workspace_id = ?").run(id);
  db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
}

export function listHosts() {
  return db.prepare("SELECT * FROM hosts ORDER BY created_at ASC, rowid ASC").all() as { id: string; name: string; kind: string; created_at: string }[];
}
