import { nanoid } from "nanoid";
import { db } from "../db/index.ts";
import type { AlwaysAllowRule } from "../types.ts";

function now(): string {
  return new Date().toISOString();
}

function rowToAlwaysAllowRule(row: any): AlwaysAllowRule {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    pattern: row.pattern,
    createdAt: row.created_at,
  };
}

export function normalizeApprovalPattern(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

export function matchesRulePattern(command: string, pattern: string): boolean {
  return normalizeApprovalPattern(command) === normalizeApprovalPattern(pattern);
}

export function listAlwaysAllowRules(): AlwaysAllowRule[] {
  const rows = db.prepare("SELECT * FROM always_allow_rules ORDER BY created_at DESC, id DESC").all() as any[];
  return rows.map(rowToAlwaysAllowRule);
}

export function findMatchingAlwaysAllowRule(input: {
  workspaceId: string;
  agentId: string;
  command: string;
}): AlwaysAllowRule | undefined {
  const pattern = normalizeApprovalPattern(input.command);
  if (!pattern) return undefined;
  const rows = db
    .prepare("SELECT * FROM always_allow_rules WHERE workspace_id = ? AND agent_id = ? ORDER BY created_at ASC, rowid ASC")
    .all(input.workspaceId, input.agentId) as any[];
  const match = rows.map(rowToAlwaysAllowRule).find((rule) => matchesRulePattern(pattern, rule.pattern));
  return match;
}

export function ensureAlwaysAllowRule(input: {
  workspaceId: string;
  agentId: string;
  command: string;
}): AlwaysAllowRule {
  const pattern = normalizeApprovalPattern(input.command);
  if (!pattern) throw new Error("审批命令不能为空");
  const existing = findMatchingAlwaysAllowRule({ ...input, command: pattern });
  if (existing) return existing;

  const id = nanoid();
  const createdAt = now();
  db.prepare("INSERT INTO always_allow_rules (id, workspace_id, agent_id, pattern, created_at) VALUES (?, ?, ?, ?, ?)").run(
    id,
    input.workspaceId,
    input.agentId,
    pattern,
    createdAt
  );
  return rowToAlwaysAllowRule(db.prepare("SELECT * FROM always_allow_rules WHERE id = ?").get(id));
}

export function deleteAlwaysAllowRule(id: string): AlwaysAllowRule | undefined {
  const row = db.prepare("SELECT * FROM always_allow_rules WHERE id = ?").get(id) as any;
  if (!row) return undefined;
  db.prepare("DELETE FROM always_allow_rules WHERE id = ?").run(id);
  return rowToAlwaysAllowRule(row);
}
