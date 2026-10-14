import { nanoid } from "nanoid";
import { db } from "../db/index.ts";
import { taskManager } from "./taskManager.ts";
import type {
  AgentDescriptor,
  ButlerAgentScore,
  ButlerIntentPlan,
  ButlerSignal,
  PermissionMode,
  Workspace,
} from "../types.ts";

function now(): string {
  return new Date().toISOString();
}

function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToPlan(row: any): ButlerIntentPlan {
  return {
    id: row.id,
    prompt: row.prompt,
    workspaceId: row.workspace_id,
    recommendedAgentId: row.recommended_agent_id,
    recommendedPermissionMode: row.recommended_permission_mode,
    confidence: Number(row.confidence),
    signals: safeJsonParse<ButlerSignal[]>(row.signals, []),
    reasons: safeJsonParse<string[]>(row.reasons, []),
    warnings: safeJsonParse<string[]>(row.warnings, []),
    agentScores: safeJsonParse<ButlerAgentScore[]>(row.agent_scores, []),
    createdAt: row.created_at,
  };
}

function hasAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}

function detectSignals(prompt: string, imageCount: number): ButlerSignal[] {
  const text = prompt.toLowerCase();
  const signals = new Set<ButlerSignal>();

  if (hasAny(text, ["code", "bug", "fix", "test", "build", "npm", "git", "typescript", "react", "server", "api", "代码", "修复", "实现", "前端", "后端", "测试", "构建", "接口", "数据库"])) {
    signals.add("coding");
  }
  if (hasAny(text, ["write", "edit", "modify", "delete", "create", "文件", "修改", "新增", "删除", "生成", "落地", "完成"])) {
    signals.add("workspace_write");
  }
  if (hasAny(text, ["run", "install", "deploy", "npm", "pnpm", "yarn", "git", "test", "build", "命令", "安装", "部署", "启动", "执行", "运行"])) {
    signals.add("command_execution");
  }
  if (imageCount > 0 || hasAny(text, ["image", "screenshot", "png", "jpg", "图片", "截图", "照片", "界面"])) {
    signals.add("image_input");
  }
  if (hasAny(text, ["local", "offline", "private", "本地", "离线", "隐私"])) {
    signals.add("local_model");
  }
  if (hasAny(text, ["search", "research", "browser", "rag", "查", "搜索", "调研", "资料", "网页"])) {
    signals.add("research");
  }
  if (hasAny(text, ["mock", "demo", "演示", "模拟"])) {
    signals.add("demo");
  }

  if (signals.size === 0 || hasAny(text, ["chat", "ask", "explain", "summarize", "聊天", "解释", "总结", "写作"])) {
    signals.add("chat");
  }

  return [...signals];
}

function explicitAgentBoost(agent: AgentDescriptor, text: string): number {
  const id = agent.id.toLowerCase();
  const kind = agent.kind.toLowerCase();
  const name = agent.name.toLowerCase();
  if (text.includes(id) || text.includes(kind) || text.includes(name)) return 90;
  if (agent.kind === "claude-code" && text.includes("claude")) return 90;
  if (agent.kind === "ark-cli" && (text.includes("ark") || text.includes("方舟"))) return 90;
  if (agent.kind === "tokenezgo" && (text.includes("openai") || text.includes("官方") || text.includes("推荐"))) return 70;
  return 0;
}

function defaultPermissionMode(signals: ButlerSignal[], prompt: string): PermissionMode {
  const text = prompt.toLowerCase();
  if (hasAny(text, ["full access", "完全访问", "不询问", "无需审批"])) return "auto";
  if (hasAny(text, ["auto approve", "自动批准", "帮我批准"])) return "auto";
  if (signals.includes("command_execution") || signals.includes("workspace_write") || signals.includes("coding")) return "supervised";
  return "supervised";
}

function scoreAgent(agent: AgentDescriptor, workspace: Workspace | undefined, signals: ButlerSignal[], prompt: string): ButlerAgentScore {
  const blockedReasons: string[] = [];
  const reasons: string[] = [];
  let score = 0;

  if (workspace && workspace.allowedAgentKinds.length > 0 && !workspace.allowedAgentKinds.includes(agent.kind)) {
    blockedReasons.push(`工作区未授权 ${agent.kind}`);
  }
  if (!agent.configured) {
    blockedReasons.push("Agent 未配置");
    score -= 20;
  } else {
    score += 12;
    reasons.push("已配置");
  }

  const text = prompt.toLowerCase();
  const explicit = explicitAgentBoost(agent, text);
  if (explicit > 0) {
    score += explicit;
    reasons.push("任务中明确提到该 Agent");
  }

  if (signals.includes("coding")) {
    if (agent.runtime.canReadWorkspace && agent.runtime.canWriteWorkspace) {
      score += 35;
      reasons.push("适合读写工作区代码");
    } else {
      score -= 18;
    }
    if (agent.runtime.canExecuteCommands) {
      score += 12;
      reasons.push("可执行测试或构建命令");
    }
  }

  if (signals.includes("workspace_write")) {
    if (agent.runtime.canWriteWorkspace) {
      score += 18;
      reasons.push("支持落地文件改动");
    } else {
      score -= 12;
    }
  }

  if (signals.includes("command_execution")) {
    if (agent.runtime.canExecuteCommands) {
      score += 14;
      reasons.push("支持命令执行");
    } else {
      score -= 10;
    }
  }

  if (signals.includes("image_input")) {
    if (agent.runtime.supportsImages) {
      score += 16;
      reasons.push("支持图片输入");
    } else {
      score -= 8;
    }
  }

  if (signals.includes("local_model")) {
    if (agent.kind === "ollama") {
      score += 35;
      reasons.push("本地模型优先");
    } else if (agent.runtime.kind === "local") {
      score += 20;
    }
  }

  if (signals.includes("demo") && agent.kind === "mock") {
    score += 80;
    reasons.push("适合演示完整生命周期");
  }

  if (signals.includes("chat") && !signals.includes("coding")) {
    if (!agent.runtime.canWriteWorkspace && !agent.runtime.canExecuteCommands) {
      score += 20;
      reasons.push("适合普通对话");
    }
    if (agent.id === "tokenezgo" || agent.kind === "doubao" || agent.kind === "hermes" || agent.kind === "ollama") {
      score += 12;
    }
  }

  if (signals.includes("research")) {
    if (agent.kind === "ark-cli" || agent.id === "tokenezgo") {
      score += 12;
      reasons.push("适合资料整理类对话");
    }
  }

  if (blockedReasons.length > 0) score -= 100;
  return { agentId: agent.id, agentKind: agent.kind, name: agent.name, configured: agent.configured, score, reasons, blockedReasons };
}

function confidenceFromScores(scores: ButlerAgentScore[]): number {
  const available = scores.filter((score) => score.blockedReasons.length === 0);
  if (available.length === 0) return 0;
  const [top, second] = available;
  const topScore = top?.score ?? 0;
  const margin = topScore - (second?.score ?? 0);
  const raw = 0.35 + Math.max(0, Math.min(topScore, 100)) / 180 + Math.max(0, Math.min(margin, 40)) / 160;
  return Math.round(Math.min(0.95, raw) * 100) / 100;
}

/**
 * 对一段任意文本（整句任务 prompt，或某条子任务的标题+描述）打分排序，选出最合适的 Agent。
 * planButlerIntent（整句任务推荐）和 multiAgentPlannerService 的本地启发式兜底共用这一份逻辑，
 * 不写两套关键词规则。
 */
export function scoreAgentsForText(text: string, agents: AgentDescriptor[], workspace: Workspace | undefined, imageCount = 0): ButlerAgentScore[] {
  const signals = detectSignals(text, imageCount);
  return agents.map((agent) => scoreAgent(agent, workspace, signals, text)).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

export function planButlerIntent(input: { prompt: string; workspaceId?: string | null; imageCount?: number }): ButlerIntentPlan {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("prompt 不能为空");

  const workspaces = taskManager.listWorkspaces();
  const workspace = (input.workspaceId ? workspaces.find((item) => item.id === input.workspaceId) : undefined) ?? workspaces[0];
  const agents = taskManager.listAgents();
  const signals = detectSignals(prompt, input.imageCount ?? 0);
  const scores = scoreAgentsForText(prompt, agents, workspace, input.imageCount ?? 0);
  const available = scores.filter((score) => score.blockedReasons.length === 0);
  const top = available[0] ?? null;
  const warnings: string[] = [];
  const reasons: string[] = [];

  if (!workspace) warnings.push("当前没有可用工作区，请先创建工作区");
  if (signals.includes("research")) warnings.push("当前 Butler 只做本地意图规划，尚未接入浏览器/RAG 检索");
  if (signals.includes("image_input") && top && !agents.find((agent) => agent.id === top.agentId)?.runtime.supportsImages) {
    warnings.push("推荐 Agent 可能不支持图片输入");
  }
  if (!top) warnings.push("没有找到已授权且可用的 Agent");

  if (signals.length > 0) reasons.push(`识别信号：${signals.join(", ")}`);
  if (top) reasons.push(`推荐 ${top.name}：${top.reasons.slice(0, 3).join("；") || "综合评分最高"}`);

  const id = nanoid();
  const createdAt = now();
  const plan: ButlerIntentPlan = {
    id,
    prompt,
    workspaceId: workspace?.id ?? null,
    recommendedAgentId: top?.agentId ?? null,
    recommendedPermissionMode: defaultPermissionMode(signals, prompt),
    confidence: confidenceFromScores(scores),
    signals,
    reasons,
    warnings,
    agentScores: scores.slice(0, 8),
    createdAt,
  };

  db.prepare(
    `INSERT INTO butler_intents (
      id, prompt, workspace_id, recommended_agent_id, recommended_permission_mode,
      confidence, signals, reasons, warnings, agent_scores, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    plan.id,
    plan.prompt,
    plan.workspaceId,
    plan.recommendedAgentId,
    plan.recommendedPermissionMode,
    plan.confidence,
    JSON.stringify(plan.signals),
    JSON.stringify(plan.reasons),
    JSON.stringify(plan.warnings),
    JSON.stringify(plan.agentScores),
    plan.createdAt
  );

  return plan;
}

export function listButlerIntents(input: { limit?: number } = {}): ButlerIntentPlan[] {
  const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
  const rows = db.prepare("SELECT * FROM butler_intents ORDER BY created_at DESC LIMIT ?").all(limit) as any[];
  return rows.map(rowToPlan);
}
