import { nanoid } from "nanoid";
import { db } from "../db/index.ts";
import type { AgentKind } from "../types.ts";

// "角色"：挂在一个真实底座 Agent 上的人设（提示词 + 自带的知识组/MCP/工具/Skill）。它以 role:<id> 的身份
// 注册进 Agent 列表（见 adapters/role.ts），所以新建任务、聊天、转交、AI 智能拆分都能直接选到。

export const ROLE_AGENT_PREFIX = "role:";

export interface AgentRole {
  id: string;
  name: string;
  icon: string;
  description: string;
  baseAgentId: string;
  baseAgentKind: AgentKind;
  model: string | null;
  prompt: string;
  knowledgeGroupIds: string[];
  mcpServerIds: string[];
  toolIds: string[];
  skillIds: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRoleInput {
  name: string;
  icon?: string;
  description?: string;
  baseAgentId: string;
  baseAgentKind: AgentKind;
  model?: string | null;
  prompt?: string;
  knowledgeGroupIds?: string[];
  mcpServerIds?: string[];
  toolIds?: string[];
  skillIds?: string[];
}

function parseIds(value: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function rowToRole(row: any): AgentRole {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon ?? "",
    description: row.description ?? "",
    baseAgentId: row.base_agent_id,
    baseAgentKind: row.base_agent_kind,
    model: row.model ?? null,
    prompt: row.prompt ?? "",
    knowledgeGroupIds: parseIds(row.knowledge_group_ids),
    mcpServerIds: parseIds(row.mcp_server_ids),
    toolIds: parseIds(row.tool_ids),
    skillIds: parseIds(row.skill_ids),
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalize(input: AgentRoleInput) {
  const name = input.name?.trim();
  if (!name) throw new Error("角色名称为必填项");
  if (!input.baseAgentId?.trim()) throw new Error("请选择底座 Agent");
  return {
    name: name.slice(0, 40),
    icon: (input.icon ?? "").trim().slice(0, 8),
    description: (input.description ?? "").trim().slice(0, 300),
    baseAgentId: input.baseAgentId.trim(),
    baseAgentKind: input.baseAgentKind,
    model: input.model?.trim() || null,
    prompt: (input.prompt ?? "").trim().slice(0, 12000),
    knowledgeGroupIds: [...new Set(input.knowledgeGroupIds ?? [])],
    mcpServerIds: [...new Set(input.mcpServerIds ?? [])],
    toolIds: [...new Set(input.toolIds ?? [])],
    skillIds: [...new Set(input.skillIds ?? [])],
  };
}

export function roleAgentId(roleId: string): string {
  return `${ROLE_AGENT_PREFIX}${roleId}`;
}

export function roleIdFromAgentId(agentId: string): string | null {
  return agentId.startsWith(ROLE_AGENT_PREFIX) ? agentId.slice(ROLE_AGENT_PREFIX.length) : null;
}

export function listRoles(): AgentRole[] {
  return (db.prepare("SELECT * FROM agent_roles ORDER BY created_at ASC, rowid ASC").all() as any[]).map(rowToRole);
}

export function getRole(id: string): AgentRole | null {
  const row = db.prepare("SELECT * FROM agent_roles WHERE id = ?").get(id);
  return row ? rowToRole(row) : null;
}

export function createRole(input: AgentRoleInput): AgentRole {
  const role = normalize(input);
  const id = nanoid(10);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_roles (id, name, icon, description, base_agent_id, base_agent_kind, model, prompt, knowledge_group_ids, mcp_server_ids, tool_ids, skill_ids, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  ).run(
    id,
    role.name,
    role.icon,
    role.description,
    role.baseAgentId,
    role.baseAgentKind,
    role.model,
    role.prompt,
    JSON.stringify(role.knowledgeGroupIds),
    JSON.stringify(role.mcpServerIds),
    JSON.stringify(role.toolIds),
    JSON.stringify(role.skillIds),
    now,
    now
  );
  return getRole(id)!;
}

export function updateRole(id: string, input: AgentRoleInput): AgentRole {
  if (!getRole(id)) throw new Error("找不到这个角色");
  const role = normalize(input);
  db.prepare(
    `UPDATE agent_roles SET name = ?, icon = ?, description = ?, base_agent_id = ?, base_agent_kind = ?, model = ?, prompt = ?,
       knowledge_group_ids = ?, mcp_server_ids = ?, tool_ids = ?, skill_ids = ?, updated_at = ? WHERE id = ?`
  ).run(
    role.name,
    role.icon,
    role.description,
    role.baseAgentId,
    role.baseAgentKind,
    role.model,
    role.prompt,
    JSON.stringify(role.knowledgeGroupIds),
    JSON.stringify(role.mcpServerIds),
    JSON.stringify(role.toolIds),
    JSON.stringify(role.skillIds),
    new Date().toISOString(),
    id
  );
  return getRole(id)!;
}

export function setRoleEnabled(id: string, enabled: boolean): AgentRole {
  if (!getRole(id)) throw new Error("找不到这个角色");
  db.prepare("UPDATE agent_roles SET enabled = ?, updated_at = ? WHERE id = ?").run(enabled ? 1 : 0, new Date().toISOString(), id);
  return getRole(id)!;
}

/** 有任务或聊天在用的角色不能删（删了这些任务就找不到 Agent 了），只能停用。 */
export function deleteRole(id: string): void {
  const role = getRole(id);
  if (!role) throw new Error("找不到这个角色");
  const agentId = roleAgentId(id);
  const taskCount = (db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE agent_id = ?").get(agentId) as { c: number }).c;
  const chatCount = (db.prepare("SELECT COUNT(*) AS c FROM chats WHERE agent_id = ?").get(agentId) as { c: number }).c;
  if (taskCount + chatCount > 0) {
    throw new Error(`「${role.name}」还被 ${taskCount} 个任务、${chatCount} 个聊天使用，不能删除，可以先停用`);
  }
  db.prepare("DELETE FROM agent_roles WHERE id = ?").run(id);
  db.prepare("DELETE FROM role_memories WHERE role_id = ?").run(id);
}

// ---- 角色记忆 ----
// active：已确认，每一轮都带给角色；pending：角色自己提出、等用户确认的。

export type RoleMemoryStatus = "active" | "pending";
export type RoleMemorySource = "manual" | "agent" | "message";

export interface RoleMemory {
  id: string;
  roleId: string;
  content: string;
  status: RoleMemoryStatus;
  source: RoleMemorySource;
  taskId: string | null;
  createdAt: string;
}

const MEMORY_INJECT_LIMIT = 30;
const MEMORY_INJECT_CHARS = 4000;
const MEMORY_MAX_CHARS = 500;
const REMEMBER_LINE = /^[ \t]*【记住】[ \t]*(.+?)[ \t]*$/gm;

function rowToMemory(row: any): RoleMemory {
  return {
    id: row.id,
    roleId: row.role_id,
    content: row.content,
    status: row.status,
    source: row.source,
    taskId: row.task_id ?? null,
    createdAt: row.created_at,
  };
}

export function listRoleMemories(roleId: string): RoleMemory[] {
  return (db.prepare("SELECT * FROM role_memories WHERE role_id = ? ORDER BY created_at DESC, rowid DESC").all(roleId) as any[]).map(rowToMemory);
}

export function getRoleMemory(id: string): RoleMemory | null {
  const row = db.prepare("SELECT * FROM role_memories WHERE id = ?").get(id);
  return row ? rowToMemory(row) : null;
}

/** 同一角色里内容相同（不论是否已确认）的记忆不重复存，返回已有的那条。 */
export function addRoleMemory(input: {
  roleId: string;
  content: string;
  status: RoleMemoryStatus;
  source: RoleMemorySource;
  taskId?: string | null;
}): RoleMemory {
  if (!getRole(input.roleId)) throw new Error("找不到这个角色");
  const content = input.content.trim().slice(0, MEMORY_MAX_CHARS);
  if (!content) throw new Error("记忆内容不能为空");
  const existing = db.prepare("SELECT * FROM role_memories WHERE role_id = ? AND content = ?").get(input.roleId, content);
  if (existing) return rowToMemory(existing);
  const id = nanoid(10);
  db.prepare("INSERT INTO role_memories (id, role_id, content, status, source, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    id,
    input.roleId,
    content,
    input.status,
    input.source,
    input.taskId ?? null,
    new Date().toISOString()
  );
  return getRoleMemory(id)!;
}

export function approveRoleMemory(id: string): RoleMemory {
  if (!getRoleMemory(id)) throw new Error("找不到这条记忆");
  db.prepare("UPDATE role_memories SET status = 'active' WHERE id = ?").run(id);
  return getRoleMemory(id)!;
}

export function deleteRoleMemory(id: string): void {
  db.prepare("DELETE FROM role_memories WHERE id = ?").run(id);
}

/** 从角色回复里拿出"【记住】xxx"行：返回去掉这些行后的正文，以及提出的记忆内容。 */
export function extractRememberLines(text: string): { clean: string; proposals: string[] } {
  const proposals = [...text.matchAll(REMEMBER_LINE)].map((match) => match[1].trim()).filter(Boolean);
  if (proposals.length === 0) return { clean: text, proposals };
  const clean = text.replace(REMEMBER_LINE, "").replace(/\n{3,}/g, "\n\n").trim();
  return { clean, proposals };
}

function activeMemoriesForPrompt(roleId: string): string[] {
  const picked: string[] = [];
  let used = 0;
  for (const memory of listRoleMemories(roleId).filter((item) => item.status === "active").slice(0, MEMORY_INJECT_LIMIT)) {
    if (used + memory.content.length > MEMORY_INJECT_CHARS) break;
    picked.push(memory.content);
    used += memory.content.length;
  }
  return picked;
}

/** 角色每一轮带给底座的身份说明：身份 + 提示词 + 已确认的记忆 + 怎么提出新记忆。 */
export function buildRoleContext(role: AgentRole): string {
  const memories = activeMemoriesForPrompt(role.id);
  return [
    `【你的角色】你是「${role.name}」。${role.description}`.trim(),
    role.prompt,
    memories.length ? `【你之前记住的事】\n${memories.map((item) => `- ${item}`).join("\n")}` : null,
    "如果这次对话里出现了以后还用得上、值得长期记住的信息（比如用户的偏好、固定规范），在回复最后单独一行写：【记住】要记的内容。一条一行，只记真正需要长期保留的，不要记一次性的任务细节。用户确认后才会生效。",
  ]
    .filter(Boolean)
    .join("\n");
}
