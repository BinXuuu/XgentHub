import { nanoid } from "nanoid";
import { db } from "../db/index.ts";
import type { KnowledgeEntry, KnowledgeGroup } from "../types.ts";
import { tokenizeForMatch } from "./textMatch.ts";

// 知识库按"知识组"组织，不再挂在工作区下面：同一个组可以被多个工作区关联（工作区设置里勾选），
// 任务每一轮在它所在工作区关联的组里检索相关条目；聊天不属于工作区，直接勾选具体条目。

export interface KnowledgeEntryInput {
  title: string;
  content: string;
  tags?: string[];
  source?: string;
}

function now(): string {
  return new Date().toISOString();
}

function parseStringArray(value: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

function rowToEntry(row: any): KnowledgeEntry {
  return {
    id: row.id,
    groupId: row.group_id,
    title: row.title,
    content: row.content,
    tags: parseStringArray(row.tags),
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToGroup(row: any): KnowledgeGroup {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    entryCount: Number(row.entry_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of tags) {
    const tag = String(raw ?? "").trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    normalized.push(tag.slice(0, 40));
    if (normalized.length >= 16) break;
  }
  return normalized;
}

/** 至少这么多分才算"相关"：标题里命中一个两字词组（4 分），或者正文里命中好几个。 */
const RELEVANCE_THRESHOLD = 4;

function scoreEntry(entry: KnowledgeEntry, query: string): number {
  const { latin, cjk } = tokenizeForMatch(query);
  const title = entry.title.toLowerCase();
  const content = entry.content.toLowerCase();
  const tags = entry.tags.map((tag) => tag.toLowerCase());
  let score = 0;
  for (const token of latin) {
    if (title.includes(token)) score += 12;
    if (tags.some((tag) => tag.includes(token))) score += 8;
    if (content.includes(token)) score += 3;
  }
  for (const bigram of cjk) {
    if (title.includes(bigram)) score += 4;
    if (tags.some((tag) => tag.includes(bigram))) score += 3;
    if (content.includes(bigram)) score += 1;
  }
  if (title && query.toLowerCase().includes(title)) score += 20;
  return score;
}

function rankRelevant(entries: KnowledgeEntry[], query: string, limit: number): KnowledgeEntry[] {
  if (!query.trim()) return [];
  return entries
    .map((entry) => ({ entry, score: scoreEntry(entry, query) }))
    .filter((item) => item.score >= RELEVANCE_THRESHOLD)
    .sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt))
    .slice(0, limit)
    .map((item) => item.entry);
}

// ---- 知识组 ----

const GROUP_SELECT = `SELECT g.*, (SELECT COUNT(*) FROM knowledge_entries e WHERE e.group_id = g.id) AS entry_count FROM knowledge_groups g`;

export function listKnowledgeGroups(): KnowledgeGroup[] {
  return (db.prepare(`${GROUP_SELECT} ORDER BY g.created_at ASC`).all() as any[]).map(rowToGroup);
}

export function getKnowledgeGroup(id: string): KnowledgeGroup | null {
  const row = db.prepare(`${GROUP_SELECT} WHERE g.id = ?`).get(id);
  return row ? rowToGroup(row) : null;
}

export function createKnowledgeGroup(input: { name: string; description?: string }): KnowledgeGroup {
  const name = input.name?.trim();
  if (!name) throw new Error("知识组名称为必填项");
  const id = nanoid(10);
  const stamp = now();
  db.prepare("INSERT INTO knowledge_groups (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
    id,
    name.slice(0, 60),
    (input.description ?? "").trim().slice(0, 300),
    stamp,
    stamp
  );
  return getKnowledgeGroup(id)!;
}

export function updateKnowledgeGroup(id: string, input: { name: string; description?: string }): KnowledgeGroup {
  if (!getKnowledgeGroup(id)) throw new Error("找不到这个知识组");
  const name = input.name?.trim();
  if (!name) throw new Error("知识组名称为必填项");
  db.prepare("UPDATE knowledge_groups SET name = ?, description = ?, updated_at = ? WHERE id = ?").run(
    name.slice(0, 60),
    (input.description ?? "").trim().slice(0, 300),
    now(),
    id
  );
  return getKnowledgeGroup(id)!;
}

/** 删掉组和组里的条目，并从所有工作区、角色的关联里去掉它。 */
export function deleteKnowledgeGroup(id: string): void {
  if (!getKnowledgeGroup(id)) throw new Error("找不到这个知识组");
  db.prepare("DELETE FROM knowledge_entries WHERE group_id = ?").run(id);
  db.prepare("DELETE FROM knowledge_groups WHERE id = ?").run(id);
  for (const table of ["workspaces", "agent_roles"]) {
    for (const row of db.prepare(`SELECT id, knowledge_group_ids FROM ${table}`).all() as { id: string; knowledge_group_ids: string }[]) {
      const ids = parseStringArray(row.knowledge_group_ids);
      if (ids.includes(id)) {
        db.prepare(`UPDATE ${table} SET knowledge_group_ids = ? WHERE id = ?`).run(JSON.stringify(ids.filter((item) => item !== id)), row.id);
      }
    }
  }
}

// ---- 知识条目 ----

export function createKnowledgeEntry(groupId: string, input: KnowledgeEntryInput): KnowledgeEntry {
  if (!getKnowledgeGroup(groupId)) throw new Error("找不到这个知识组");
  const title = input.title.trim();
  const content = input.content.trim();
  if (!title) throw new Error("title 为必填项");
  if (!content) throw new Error("content 为必填项");
  const id = nanoid();
  const stamp = now();
  const source = input.source?.trim() || "manual";
  db.prepare(
    `INSERT INTO knowledge_entries (id, group_id, title, content, tags, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, groupId, title.slice(0, 160), content.slice(0, 12000), JSON.stringify(normalizeTags(input.tags)), source.slice(0, 80), stamp, stamp);
  return rowToEntry(db.prepare("SELECT * FROM knowledge_entries WHERE id = ?").get(id));
}

function loadEntries(groupIds?: string[]): KnowledgeEntry[] {
  const rows = groupIds
    ? (db
        .prepare(`SELECT * FROM knowledge_entries WHERE group_id IN (${groupIds.map(() => "?").join(", ")}) ORDER BY updated_at DESC LIMIT 500`)
        .all(...groupIds) as any[])
    : (db.prepare("SELECT * FROM knowledge_entries ORDER BY updated_at DESC LIMIT 500").all() as any[]);
  return rows.map(rowToEntry);
}

/** 知识库页面的搜索：按标题/内容/标签做子串匹配。不传 groupIds 查全部组；传了空数组就是"一个组都没关联"，直接返回空。 */
export function listKnowledgeEntries(input: { groupIds?: string[]; query?: string; limit?: number } = {}): KnowledgeEntry[] {
  if (input.groupIds && input.groupIds.length === 0) return [];
  const limit = Math.max(1, Math.min(input.limit ?? 50, 300));
  const entries = loadEntries(input.groupIds);
  const query = input.query?.trim().toLowerCase() ?? "";
  if (!query) return entries.slice(0, limit);
  return entries
    .filter((entry) => [entry.title, entry.content, ...entry.tags].join("\n").toLowerCase().includes(query))
    .slice(0, limit);
}

/** 在这些知识组里挑和 query 最相关的几条（中文按两字词组比对，要达到相关度门槛）。 */
export function getRelevantKnowledge(groupIds: string[], query: string, limit = 5): KnowledgeEntry[] {
  if (groupIds.length === 0) return [];
  return rankRelevant(loadEntries(groupIds), query, limit);
}

/** 一个组的条目总字数不超过这个值，就算"小组"：每轮整组带上，不看关键词。 */
export const SMALL_GROUP_MAX_CHARS = 3000;
/** 每轮"整组带上"的总字数上限，超出的小组退回按相关度挑，避免关联一堆小组把上下文撑爆。 */
export const ALWAYS_INCLUDED_MAX_CHARS = 8000;

function entryChars(entry: KnowledgeEntry): number {
  return entry.title.length + entry.content.length;
}

/**
 * 任务每一轮用：小知识组（比如"美工规范"这种必须遵守、但用户消息里未必会提到关键词的）整组带上；
 * 大知识组在剩下的条目里按本轮消息挑最相关的 relevantLimit 条。
 */
export function selectTurnKnowledge(groupIds: string[], query: string, relevantLimit = 5): KnowledgeEntry[] {
  if (groupIds.length === 0) return [];
  const always: KnowledgeEntry[] = [];
  const pool: KnowledgeEntry[] = [];
  let alwaysChars = 0;
  for (const groupId of groupIds) {
    const entries = (db.prepare("SELECT * FROM knowledge_entries WHERE group_id = ? ORDER BY created_at ASC, rowid ASC").all(groupId) as any[]).map(rowToEntry);
    const chars = entries.reduce((sum, entry) => sum + entryChars(entry), 0);
    if (entries.length > 0 && chars <= SMALL_GROUP_MAX_CHARS && alwaysChars + chars <= ALWAYS_INCLUDED_MAX_CHARS) {
      always.push(...entries);
      alwaysChars += chars;
    } else {
      pool.push(...entries);
    }
  }
  return [...always, ...rankRelevant(pool, query, relevantLimit)];
}

export function getKnowledgeEntriesByIds(ids: string[]): KnowledgeEntry[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db.prepare(`SELECT * FROM knowledge_entries WHERE id IN (${placeholders})`).all(...ids) as any[];
  const byId = new Map(rows.map((row) => [row.id, rowToEntry(row)]));
  return ids.map((id) => byId.get(id)).filter((entry): entry is KnowledgeEntry => Boolean(entry));
}

/** 修改一条知识：标题 / 内容 / 标签，也可以换到别的知识组。 */
export function updateKnowledgeEntry(id: string, input: KnowledgeEntryInput & { groupId?: string }): KnowledgeEntry {
  const row = db.prepare("SELECT * FROM knowledge_entries WHERE id = ?").get(id) as any;
  if (!row) throw new Error("找不到这条知识");
  const groupId = input.groupId?.trim() || row.group_id;
  if (!getKnowledgeGroup(groupId)) throw new Error("找不到这个知识组");
  const title = input.title.trim();
  const content = input.content.trim();
  if (!title) throw new Error("title 为必填项");
  if (!content) throw new Error("content 为必填项");
  db.prepare("UPDATE knowledge_entries SET group_id = ?, title = ?, content = ?, tags = ?, updated_at = ? WHERE id = ?").run(
    groupId,
    title.slice(0, 160),
    content.slice(0, 12000),
    JSON.stringify(normalizeTags(input.tags)),
    now(),
    id
  );
  return rowToEntry(db.prepare("SELECT * FROM knowledge_entries WHERE id = ?").get(id));
}

export function deleteKnowledgeEntry(id: string): KnowledgeEntry | undefined {
  const row = db.prepare("SELECT * FROM knowledge_entries WHERE id = ?").get(id) as any;
  if (!row) return undefined;
  db.prepare("DELETE FROM knowledge_entries WHERE id = ?").run(id);
  return rowToEntry(row);
}
