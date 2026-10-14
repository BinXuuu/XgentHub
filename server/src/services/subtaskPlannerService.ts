import { nanoid } from "nanoid";
import { db } from "../db/index.ts";
import { ensurePrimarySubtask } from "./coreModelService.ts";
import type { MultiAgentPlan, PlannedSubtask, Subtask, SubtaskPlan, Task } from "../types.ts";

const MAX_SUBTASKS = 6;

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

function clip(text: string, length: number): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > length ? `${trimmed.slice(0, length - 1)}...` : trimmed;
}

function requestedSubtaskLimit(prompt: string): number | null {
  const digitMatch = prompt.match(/(?:只拆|只生成|拆成|生成)\s*(\d{1,2})\s*个?(?:子任务|阶段|步骤)/);
  if (digitMatch) {
    const value = Number(digitMatch[1]);
    return Number.isFinite(value) && value >= 1 ? Math.min(value, MAX_SUBTASKS) : null;
  }

  const cnDigits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
  const cnMatch = prompt.match(/(?:只拆|只生成|拆成|生成)\s*([一二两三四五六])\s*个?(?:子任务|阶段|步骤)/);
  return cnMatch ? cnDigits[cnMatch[1]] ?? null : null;
}

function uniqueTitles(titles: string[], limit = MAX_SUBTASKS): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of titles) {
    const title = clip(raw.replace(/^[-*•\d.、)\s]+/, ""), 80);
    if (!title || title.length < 3 || seen.has(title)) continue;
    seen.add(title);
    result.push(title);
    if (result.length >= limit) break;
  }
  return result;
}

function explicitSteps(prompt: string, limit = MAX_SUBTASKS): string[] {
  const lines = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const numberedLines = lines.filter((line) => /^(\d+[.)、]|[一二三四五六七八九十]+[、.．])\s*/.test(line));
  if (numberedLines.length >= 2) return uniqueTitles(numberedLines, limit);

  const bulletLines = lines.filter((line) => /^[-*•]\s+/.test(line) && !/^(要求|规则|注意|不要|只生成|只拆|每次|完成后|如果)/.test(line.replace(/^[-*•]\s+/, "")));
  if (bulletLines.length >= 2) return uniqueTitles(bulletLines, limit);

  const phaseMatches = [...prompt.matchAll(/(?:Phase|阶段)\s*[\d一二三四五六七八九十]+[：:]\s*([^。；;\n]+)/gi)].map((match) => match[1]);
  if (phaseMatches.length >= 2) return uniqueTitles(phaseMatches, limit);
  return [];
}

function hasAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}

function heuristicSteps(prompt: string, limit = MAX_SUBTASKS): { titles: string[]; reasons: string[]; confidence: number } {
  const text = prompt.toLowerCase();
  const reasons: string[] = [];
  const titles: string[] = [];

  if (hasAny(text, ["阶段", "分阶段", "拆分", "步骤", "step", "milestone", "plan"])) {
    reasons.push("任务文本要求分阶段或拆分执行");
  }
  if (prompt.length >= 120) {
    reasons.push("任务文本较长，适合先形成子任务计划");
  }
  if (hasAny(text, ["前端", "ui", "页面", "组件", "react", "css"])) {
    titles.push("前端界面与交互调整");
  }
  if (hasAny(text, ["后端", "api", "接口", "server", "数据库", "sqlite", "schema"])) {
    titles.push("后端数据模型与 API 接入");
  }
  if (hasAny(text, ["agent", "orchestrator", "调度", "runtime", "子任务", "run"])) {
    titles.push("编排与运行时链路接入");
  }
  if (hasAny(text, ["测试", "test", "验证", "regression", "doctor", "build"])) {
    titles.push("测试与回归验证");
  }
  if (hasAny(text, ["文档", "docs", "readme", "进度", "备份", "backup"])) {
    titles.push("文档、进度记录与阶段备份");
  }

  if (titles.length < 2 && (reasons.length > 0 || prompt.length >= 90)) {
    titles.unshift("梳理需求与影响范围");
    titles.push("实现核心改动", "验证结果并记录");
  }

  const deduped = uniqueTitles(titles, limit);
  const confidence = deduped.length >= 3 ? 0.78 : deduped.length >= 2 ? 0.64 : 0.25;
  return { titles: deduped, reasons, confidence };
}

function buildPlan(prompt: string, titles: string[], reasons: string[], confidence: number, limit = MAX_SUBTASKS): SubtaskPlan {
  const subtasks: PlannedSubtask[] = titles.slice(0, limit).map((title, index) => ({
    index: index + 1,
    title,
    description: index === 0 ? "先处理这个子任务，后续子任务会按顺序依赖前一项。" : "完成前一项后继续处理该子任务。",
    dependsOn: index === 0 ? [] : [index],
    targetAgentId: null,
    skillIds: [],
    prompt: "",
  }));
  return {
    prompt,
    shouldCreate: subtasks.length >= 2,
    confidence: Math.round(confidence * 100) / 100,
    reasons: reasons.length ? reasons : subtasks.length >= 2 ? ["根据任务复杂度生成本地子任务计划"] : ["任务较简单，暂不需要拆分"],
    subtasks,
  };
}

export function planSubtasks(prompt: string): SubtaskPlan {
  const cleanPrompt = prompt.trim();
  if (!cleanPrompt) throw new Error("prompt 不能为空");

  const limit = requestedSubtaskLimit(cleanPrompt) ?? MAX_SUBTASKS;
  const explicit = explicitSteps(cleanPrompt, limit);
  if (explicit.length >= 2) {
    return buildPlan(cleanPrompt, explicit, ["识别到显式列表或阶段描述"], 0.86, limit);
  }

  const heuristic = heuristicSteps(cleanPrompt, limit);
  return buildPlan(cleanPrompt, heuristic.titles, heuristic.reasons, heuristic.confidence, limit);
}

export function createPlannedSubtasks(task: Task, plan: SubtaskPlan): Subtask[] {
  if (!plan.shouldCreate || plan.subtasks.length < 2) return [];
  const existing = db.prepare("SELECT COUNT(*) AS count FROM subtasks WHERE task_id = ? AND parent_subtask_id IS NOT NULL").get(task.id) as {
    count: number;
  };
  if (existing.count > 0) return [];

  const primary = ensurePrimarySubtask(task);
  const created: Subtask[] = [];
  const plannedIdByIndex = new Map<number, string>();

  for (const item of plan.subtasks) {
    const id = nanoid();
    const createdAt = now();
    const dependencyIds = item.dependsOn.map((index) => plannedIdByIndex.get(index)).filter((value): value is string => Boolean(value));
    db.prepare(
      `INSERT INTO subtasks (id, task_id, parent_subtask_id, title, status, assigned_agent_id, dependency_ids, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)`
    ).run(id, task.id, primary.id, item.title, task.agentId, JSON.stringify(dependencyIds), createdAt, createdAt);
    plannedIdByIndex.set(item.index, id);
    created.push(rowToSubtask(db.prepare("SELECT * FROM subtasks WHERE id = ?").get(id)));
  }

  return created;
}

/**
 * 从已确认（可能被用户编辑过）的智能多 Agent 规划创建子任务：每一条按自己的 targetAgentId/prompt 落库，
 * 不像 createPlannedSubtasks 那样全部指派给父任务的 Agent——这是自动依次执行能按计划把每个子任务
 * 派给不同 Agent 的基础。调用方负责在创建任务前确认 plan.subtasks 至少有一条，这里不做 shouldCreate 判断。
 */
export function createPlannedSubtasksFromPlan(task: Task, plan: MultiAgentPlan): Subtask[] {
  if (plan.subtasks.length === 0) return [];
  const existing = db.prepare("SELECT COUNT(*) AS count FROM subtasks WHERE task_id = ? AND parent_subtask_id IS NOT NULL").get(task.id) as {
    count: number;
  };
  if (existing.count > 0) return [];

  const primary = ensurePrimarySubtask(task);
  const created: Subtask[] = [];
  const plannedIdByIndex = new Map<number, string>();

  for (const item of plan.subtasks) {
    const id = nanoid();
    const createdAt = now();
    const dependencyIds = item.dependsOn.map((index) => plannedIdByIndex.get(index)).filter((value): value is string => Boolean(value));
    const assignedAgentId = item.targetAgentId ?? task.agentId;
    db.prepare(
      `INSERT INTO subtasks (id, task_id, parent_subtask_id, title, status, assigned_agent_id, dependency_ids, planned_prompt, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`
    ).run(id, task.id, primary.id, item.title, assignedAgentId, JSON.stringify(dependencyIds), item.prompt || null, createdAt, createdAt);
    plannedIdByIndex.set(item.index, id);
    created.push(rowToSubtask(db.prepare("SELECT * FROM subtasks WHERE id = ?").get(id)));
  }

  return created;
}
