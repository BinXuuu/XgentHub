import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { config } from "../config.ts";
import { db } from "../db/index.ts";
import type { ResourceLibraryItem, ResourceLibraryKind } from "../types.ts";
import { tokenizeForMatch as tokenize } from "./textMatch.ts";

const storePath = path.join(config.dataDir, "resource-library.json");

export interface ResourceLibraryInput {
  title: string;
  content: string;
  tags?: string[];
  command?: string | null;
}

function now(): string {
  return new Date().toISOString();
}

function readStore(): ResourceLibraryItem[] {
  if (!fs.existsSync(storePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStore(items: ResourceLibraryItem[]) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(items, null, 2) + "\n", "utf8");
}

function normalizeTags(tags: string[] | undefined): string[] {
  return [...new Set((tags ?? []).map((tag) => tag.trim()).filter(Boolean))].slice(0, 20);
}

function ensureKind(kind: string): ResourceLibraryKind {
  if (kind === "skill" || kind === "tool" || kind === "mcp") return kind;
  throw new Error(`未知资源类型: ${kind}`);
}

export function listResourceLibraryItems(kind: ResourceLibraryKind, query?: string): ResourceLibraryItem[] {
  const q = query?.trim().toLowerCase();
  const items = readStore()
    .filter((item) => item.kind === kind)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (!q) return items;
  return items.filter((item) => {
    const haystack = [item.title, item.content, item.command ?? "", ...item.tags].join("\n").toLowerCase();
    return haystack.includes(q);
  });
}

export function createResourceLibraryItem(kindInput: string, input: ResourceLibraryInput): ResourceLibraryItem {
  const kind = ensureKind(kindInput);
  const title = input.title.trim();
  const content = input.content.trim();
  if (!title || !content) throw new Error("标题和内容为必填项");
  const stamp = now();
  const item: ResourceLibraryItem = {
    id: `${kind}:${nanoid(10)}`,
    kind,
    title,
    content,
    tags: normalizeTags(input.tags),
    command: input.command?.trim() || null,
    createdAt: stamp,
    updatedAt: stamp,
  };
  writeStore([item, ...readStore()]);
  return item;
}

export function updateResourceLibraryItem(kindInput: string, id: string, input: ResourceLibraryInput): ResourceLibraryItem {
  const kind = ensureKind(kindInput);
  const title = input.title.trim();
  const content = input.content.trim();
  if (!title || !content) throw new Error("标题和内容为必填项");

  const items = readStore();
  const idx = items.findIndex((entry) => entry.kind === kind && entry.id === id);
  if (idx < 0) throw new Error(`未知资源: ${id}`);

  const current = items[idx]!;
  const updated: ResourceLibraryItem = {
    ...current,
    title,
    content,
    tags: normalizeTags(input.tags),
    command: input.command?.trim() || null,
    updatedAt: now(),
  };
  items[idx] = updated;
  writeStore(items);
  return updated;
}

export function getResourceLibraryItemsByIds(kind: ResourceLibraryKind, ids: string[]): ResourceLibraryItem[] {
  if (ids.length === 0) return [];
  const byId = new Map(readStore().filter((item) => item.kind === kind).map((item) => [item.id, item]));
  return ids.map((id) => byId.get(id)).filter((item): item is ResourceLibraryItem => Boolean(item));
}

interface LibraryContextOptions {
  query?: string;
  maxMatchedTools?: number;
  maxToolContentChars?: number;
  maxSkillChars?: number;
}

function clipText(value: string, maxLength: number): string {
  const text = value.trim().replace(/\s+/g, " ");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function scoreTool(item: ResourceLibraryItem, query: string): number {
  const { latin, cjk } = tokenize(query);
  const title = item.title.toLowerCase();
  const command = (item.command ?? "").toLowerCase();
  const content = item.content.toLowerCase();
  const tags = item.tags.map((tag) => tag.toLowerCase());
  let score = 0;
  for (const token of latin) {
    if (title.includes(token)) score += 12;
    if (tags.some((tag) => tag === token)) score += 8;
    if (command.includes(token)) score += 6;
    if (content.includes(token)) score += 2;
  }
  for (const bigram of cjk) {
    if (title.includes(bigram)) score += 4;
    if (tags.some((tag) => tag.includes(bigram))) score += 3;
    if (content.includes(bigram)) score += 1;
  }
  if (title && query.toLowerCase().includes(title)) score += 18;
  return score;
}

function summarizeTool(item: ResourceLibraryItem): string {
  const tags = item.tags.length ? ` 标签：${item.tags.join(", ")}` : "";
  const command = item.command ? ` 命令：${clipText(item.command, 80)}` : "";
  return `${item.title}${tags}${command}`;
}

/**
 * Skill 是"每一轮都要遵守的规则"，勾了就全文带上（超过总字数上限的只列标题）；
 * 工具是"需要时才用的说明书"，默认只给目录（名称 + 命令），和本轮消息相关的再展开详细说明。
 */
export function formatLibraryContext(kind: "tool" | "skill", items: ResourceLibraryItem[], options: LibraryContextOptions = {}): string | null {
  if (items.length === 0) return null;
  if (kind === "skill") {
    const budget = options.maxSkillChars ?? 6000;
    let used = 0;
    const full: string[] = [];
    const overflow: string[] = [];
    for (const item of items) {
      const block = `${full.length + 1}. ${item.title}\n${item.content.trim()}`;
      if (used + block.length > budget && full.length > 0) {
        overflow.push(item.title);
        continue;
      }
      full.push(block);
      used += block.length;
    }
    return [
      "用户在 AgentHub Skill 库里为这次对话勾选了以下 Skill，处理相关问题时按它们的要求做：",
      ...full,
      overflow.length ? `（以下 Skill 超出单轮字数上限，这里只列标题：${overflow.join("、")}）` : null,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  const maxMatched = options.maxMatchedTools ?? 5;
  const maxContentChars = options.maxToolContentChars ?? 1200;
  const query = options.query?.trim() ?? "";
  const matched = query
    ? items
        .map((item) => ({ item, score: scoreTool(item, query) }))
        .filter((entry) => entry.score >= 4)
        .sort((a, b) => b.score - a.score || b.item.updatedAt.localeCompare(a.item.updatedAt))
        .slice(0, maxMatched)
        .map((entry) => entry.item)
    : [];
  const matchedIds = new Set(matched.map((item) => item.id));
  const indexLines = items.map((item, index) => `${index + 1}. ${summarizeTool(item)}${matchedIds.has(item.id) ? "（本轮已展开）" : ""}`);
  const detailLines = matched.map((item, index) =>
    [`${index + 1}. ${item.title}`, item.command ? `命令：${item.command}` : null, clipText(item.content, maxContentChars)].filter(Boolean).join("\n")
  );
  return [
    "用户在 AgentHub 工具库里为这次对话开放了以下工具（目录：名称和命令）：",
    ...indexLines,
    "",
    detailLines.length
      ? ["和本轮消息相关的工具详细说明：", ...detailLines].join("\n\n")
      : "本轮没有明显相关的工具，需要时按上面的名称和命令判断；没展开的工具不要臆测它的详细用法。",
  ].join("\n");
}

/** 任务/聊天勾选的 Skill 和工具，按 Skill 在前、工具在后拼成一段上下文；都没勾时返回 null。 */
export function buildLibraryContext(selection: { skillIds: string[]; toolIds: string[] }, query?: string): string | null {
  const blocks = [
    formatLibraryContext("skill", getResourceLibraryItemsByIds("skill", selection.skillIds)),
    formatLibraryContext("tool", getResourceLibraryItemsByIds("tool", selection.toolIds), { query }),
  ].filter(Boolean);
  return blocks.length ? blocks.join("\n\n") : null;
}

export function deleteResourceLibraryItem(kindInput: string, id: string): ResourceLibraryItem | undefined {
  const kind = ensureKind(kindInput);
  const items = readStore();
  const item = items.find((entry) => entry.kind === kind && entry.id === id);
  if (!item) return undefined;
  writeStore(items.filter((entry) => entry.id !== id));
  // 同时从所有工作区、聊天、角色的勾选里去掉，不留指向不存在条目的 id。
  const column = kind === "tool" ? "tool_ids" : kind === "skill" ? "skill_ids" : null;
  if (column) {
    for (const table of ["workspaces", "chats", "agent_roles"]) {
      const rows = db.prepare(`SELECT id, ${column} AS ids FROM ${table} WHERE ${column} LIKE ?`).all(`%${JSON.stringify(id)}%`) as { id: string; ids: string }[];
      for (const row of rows) {
        let ids: unknown = [];
        try {
          ids = JSON.parse(row.ids || "[]");
        } catch {
          // 坏数据当成空列表
        }
        const kept = Array.isArray(ids) ? ids.filter((entry) => entry !== id) : [];
        db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(JSON.stringify(kept), row.id);
      }
    }
  }
  return item;
}

export { storePath as resourceLibraryStorePath };
