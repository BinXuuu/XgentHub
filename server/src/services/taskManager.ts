import { nanoid } from "nanoid";
import { db } from "../db/index.ts";
import { bus } from "../eventBus.ts";
import { getAdapter, isProtectedAgent, listAdapters, toDescriptor } from "../adapters/registry.ts";
import { recordAudit } from "./auditService.ts";
import {
  ensurePrimarySubtask,
  listArtifacts,
  listSubtasks,
  listTaskRuns,
  recordArtifact,
  syncAgentDescriptor,
  syncRunSessionKey,
} from "./coreModelService.ts";
import { orchestrator } from "../orchestrator/orchestratorService.ts";
import { getWorkspace, getWorkspacePrompt, listWorkspaces as listWorkspaceRecords } from "./workspaceService.ts";
import * as queueDb from "./queueService.ts";
import { deleteAttachmentFile } from "./attachmentService.ts";
import { isAgentHidden } from "./agentVisibilityService.ts";
import { emitTaskEvent, emitTaskStatusChanged, recordDomainEvent } from "./eventService.ts";
import {
  deleteAlwaysAllowRule,
  ensureAlwaysAllowRule,
  findMatchingAlwaysAllowRule,
  listAlwaysAllowRules,
} from "./approvalRuleService.ts";
import { createTaskSummaryMemory } from "./memoryService.ts";
import { selectTurnKnowledge } from "./knowledgeService.ts";
import { describeTaskResources, resolveEffectiveResources, type TaskResourcesView } from "./taskResourceService.ts";
import { createNotification, markNotificationReadBySourceKey } from "./notificationService.ts";
import { createRecoveryAction, listRecoveryActions as listTaskRecoveryActions } from "./recoveryService.ts";
import { createReviewDecision, listReviewDecisions as listTaskReviewDecisions } from "./reviewService.ts";
import { createPlannedSubtasks, createPlannedSubtasksFromPlan, isPlanSummarySubtask, planSubtasks } from "./subtaskPlannerService.ts";
import { resolveMcpServers } from "./mcpServerService.ts";
import { buildLibraryContext } from "./resourceLibraryService.ts";
import type { WorkspaceSnapshot as TurnSnapshot } from "./workspaceSnapshotService.ts";
import {
  createSnapshot,
  deleteTaskSnapshots,
  diffSinceSnapshot,
  getSnapshot,
  linkSnapshotMessage,
  listTaskSnapshots,
  previewRestore,
  restoreSnapshot,
  SnapshotSkippedError,
  type RestorePreview,
  type WorkspaceSnapshot,
} from "./workspaceSnapshotService.ts";
import type { AgentAdapter, TaskRuntimeContext } from "../adapters/types.ts";
import type {
  AgentDescriptor,
  AgentRequestSource,
  Approval,
  ApprovalDecision,
  AlwaysAllowRule,
  EventType,
  FileChange,
  ModelOption,
  PermissionMode,
  QueuedMessage,
  Task,
  TaskEvent,
  TaskFlowSnapshot,
  TaskMessage,
  TaskRecoveryAction,
  TaskReviewDecision,
  Subtask,
  SubtaskDispatchResult,
  TaskStatus,
  Workspace,
  DomainEvent,
  MultiAgentPlan,
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
    budgetLimitCny: typeof row.budget_limit_cny === "number" ? row.budget_limit_cny : row.budget_limit_cny == null ? null : Number(row.budget_limit_cny),
    autoAdvancePlan: Boolean(row.auto_advance_plan),
    // plan_mode 存的是开启时刻的毫秒时间戳，0 表示关闭。
    planMode: Number(row.plan_mode) > 0,
    planModeSince: Number(row.plan_mode) > 0 ? new Date(Number(row.plan_mode)).toISOString() : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToEvent(row: any): TaskEvent {
  return { id: row.id, taskId: row.task_id, type: row.type, payload: JSON.parse(row.payload), createdAt: row.created_at };
}

function rowToMessage(row: any): TaskMessage {
  return {
    id: row.id,
    taskId: row.task_id,
    role: row.role,
    content: row.content,
    images: safeJsonParse(row.images ?? "[]", []) as string[],
    createdAt: row.created_at,
  };
}

function rowToFileChange(row: any): FileChange {
  return { id: row.id, taskId: row.task_id, path: row.path, action: row.action, diff: row.diff, createdAt: row.created_at };
}

function rowToApproval(row: any): Approval {
  return {
    id: row.id,
    taskId: row.task_id,
    command: row.command,
    cwd: row.cwd,
    riskLevel: row.risk_level,
    reason: row.reason,
    status: row.status,
    note: row.note,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

const PLAN_MODE_INSTRUCTION = [
  "【计划模式】这一轮只做调研和规划：",
  "- 可以读文件、搜索代码、运行只读命令来了解现状；",
  "- 不要创建、修改、删除任何文件，不要安装依赖，不要执行任何有副作用的命令；",
  "- 最后输出一份分步骤的执行计划（要改哪些文件、怎么改、怎么验证），然后停下，等用户批准后再动手。",
].join("\n");

export const PLAN_APPROVED_MESSAGE = "计划已批准，请按上面的计划开始执行。";

/**
 * AI 智能拆分建任务时，总管家（任务本身的 Agent）第一轮收到的指令：只做统筹，不自己把活干了——
 * 真正的活由后面按计划派发的各个子任务去做，不然同一件事会被做两遍。
 */
function buildPlanCoordinatorBrief(userPrompt: string, plan: MultiAgentPlan, allSubtasks: Subtask[]): string {
  const subtasks = allSubtasks.filter((subtask) => !isPlanSummarySubtask(subtask));
  const lines = subtasks.map((subtask, index) => {
    const agentName = subtask.assignedAgentId ? getAdapter(subtask.assignedAgentId)?.name ?? subtask.assignedAgentId : "未指定";
    return `${index + 1}. ${subtask.title}（${agentName}）`;
  });
  return [
    `这个任务已经拆成下面 ${subtasks.length} 个子任务，依赖满足的会同时派给各自的 Agent 并行去做，全部完成后再交回给你汇总：`,
    ...lines,
    "",
    "你是这个任务的总管家。这一轮不要自己动手做这些子任务，也不要修改文件。",
    "只用几句话说明：你理解的整体目标，以及各子任务之间需要对齐的地方（比如风格、接口、命名、交付格式），给后面的子任务参考。",
    plan.reasoning ? `\n拆分思路：${plan.reasoning}` : null,
    "",
    "用户原始需求：",
    userPrompt,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/** 一个任务里最多同时跑几个子任务；0 / 不设 = 不限制。 */
const MAX_PARALLEL_SUBTASKS = Math.max(0, Math.floor(Number(process.env.AGENTHUB_MAX_PARALLEL_SUBTASKS) || 0));
const IN_PROGRESS_RUN_STATUSES = new Set(["queued", "waiting", "running", "needs_approval"]);

interface ActiveRun {
  adapter: AgentAdapter;
  ctx: TaskRuntimeContext;
}

function clipText(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length)}\n…（后面省略）` : text;
}

function clipTitle(text: string, length = 72): string {
  const clean = text.trim().replace(/\s+/g, " ");
  return clean.length > length ? `${clean.slice(0, length - 3)}...` : clean;
}

interface PendingApproval {
  taskId: string;
  resolve: (v: { decision: ApprovalDecision; note: string | null }) => void;
}

interface CachedOptions {
  value: ModelOption[];
  expiresAt: number;
  promise?: Promise<ModelOption[]>;
}

const OPTION_CACHE_TTL_MS = 5 * 60 * 1000;
const EMPTY_OPTION_CACHE_TTL_MS = 15 * 1000;
const OPTION_LOAD_TIMEOUT_MS = 45_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label} 加载超时（${Math.round(timeoutMs / 1000)}s）`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (err) => {
        clearTimeout(timeout);
        reject(err);
      }
    );
  });
}

class TaskManager {
  private pendingApprovals = new Map<string, PendingApproval>();
  /** 每个任务当前正在跑的每一轮（并行子任务会有好几轮）：停止时逐个停，算任务状态时看还有没有别的在跑。 */
  private activeRuns = new Map<string, Map<string, ActiveRun>>();
  /** 每一轮（runId）里 Agent 自己上报了几次文件改动；为 0 的话一轮结束后用快照补。 */
  private reportedFileChanges = new Map<string, number>();
  private stoppers = new Map<string, () => void>();
  private modelCache = new Map<string, CachedOptions>();
  private subAgentCache = new Map<string, CachedOptions>();

  // ---- listAgents / listWorkspaces：与 adapter registry / workspace store 对接 ----
  listAgents(): AgentDescriptor[] {
    const descriptors = listAdapters().filter((adapter) => {
      const agentId = adapter.id ?? adapter.kind;
      return isProtectedAgent(agentId) || !isAgentHidden(agentId);
    }).map(toDescriptor);
    for (const descriptor of descriptors) syncAgentDescriptor(descriptor);
    return descriptors;
  }

  private async cachedOptions(
    cache: Map<string, CachedOptions>,
    key: string,
    refresh: boolean,
    load: () => Promise<ModelOption[]>
  ): Promise<ModelOption[]> {
    const nowMs = Date.now();
    const cached = cache.get(key);
    if (!refresh && cached && cached.expiresAt > nowMs) return cached.value;
    if (!refresh && cached?.promise) return cached.promise;

    const promise = withTimeout(load(), OPTION_LOAD_TIMEOUT_MS, key)
      .then((value) => {
        cache.set(key, { value, expiresAt: Date.now() + (value.length > 0 ? OPTION_CACHE_TTL_MS : EMPTY_OPTION_CACHE_TTL_MS) });
        return value;
      })
      .catch((err) => {
        cache.set(key, { value: cached?.value ?? [], expiresAt: Date.now() + EMPTY_OPTION_CACHE_TTL_MS });
        throw err;
      });

    cache.set(key, { value: cached?.value ?? [], expiresAt: 0, promise });
    return promise;
  }

  async listModels(agentId: string, refresh = false): Promise<ModelOption[]> {
    const adapter = getAdapter(agentId);
    if (!adapter?.listModels) return [];
    return this.cachedOptions(this.modelCache, agentId, refresh, () => adapter.listModels!()).catch(() => []);
  }

  async listSubAgents(agentId: string, refresh = false): Promise<ModelOption[]> {
    const adapter = getAdapter(agentId);
    if (!adapter?.listSubAgents) return [];
    return this.cachedOptions(this.subAgentCache, agentId, refresh, () => adapter.listSubAgents!()).catch(() => []);
  }

  invalidateOptions(agentId: string): void {
    this.modelCache.delete(agentId);
    this.subAgentCache.delete(agentId);
  }

  async getUsageSummary(agentId: string): Promise<string | null> {
    const adapter = getAdapter(agentId);
    if (!adapter?.getUsageSummary) return null;
    try {
      return await adapter.getUsageSummary();
    } catch {
      return null;
    }
  }

  listWorkspaces(): Workspace[] {
    return listWorkspaceRecords();
  }

  listTasks(): Task[] {
    const rows = db.prepare("SELECT * FROM tasks ORDER BY updated_at DESC").all() as any[];
    return rows.map(rowToTask);
  }

  getTask(taskId: string): Task | undefined {
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
    return row ? rowToTask(row) : undefined;
  }

  renameTask(taskId: string, title: string, actor: string): Task {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`未知任务: ${taskId}`);
    const nextTitle = title.trim().slice(0, 160);
    if (!nextTitle) throw new Error("任务名称不能为空");
    if (nextTitle === task.title) return task;

    const updatedAt = now();
    db.prepare("UPDATE tasks SET title = ?, updated_at = ? WHERE id = ?").run(nextTitle, updatedAt, taskId);
    recordAudit({ actor, agentId: task.agentId, taskId, action: "rename_task", detail: { from: task.title, to: nextTitle } });
    bus.emit("dashboard", { kind: "task_updated", taskId, title: nextTitle, updatedAt });
    return this.getTask(taskId)!;
  }

  listMessages(taskId: string): TaskMessage[] {
    const rows = db.prepare("SELECT * FROM task_messages WHERE task_id = ? ORDER BY created_at ASC").all(taskId) as any[];
    return rows.map(rowToMessage);
  }

  listEvents(taskId: string): TaskEvent[] {
    const rows = db.prepare("SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC").all(taskId) as any[];
    return rows.map(rowToEvent);
  }

  listDomainEvents(taskId: string): DomainEvent[] {
    const rows = db.prepare("SELECT * FROM domain_events WHERE task_id = ? ORDER BY created_at ASC, rowid ASC").all(taskId) as any[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      version: row.version,
      taskId: row.task_id,
      runId: row.run_id,
      legacyType: row.legacy_type,
      payload: JSON.parse(row.payload),
      createdAt: row.created_at,
    }));
  }

  getFlowSnapshot(taskId: string): TaskFlowSnapshot | undefined {
    const task = this.getTask(taskId);
    if (!task) return undefined;
    const runs = listTaskRuns(taskId);
    return {
      task,
      subtasks: listSubtasks(taskId),
      runs,
      artifacts: listArtifacts(taskId),
      agentRequests: orchestrator.listAgentRequests(taskId),
      recoveryActions: listTaskRecoveryActions(taskId),
      reviewDecisions: listTaskReviewDecisions(taskId),
      runCheckpoints: Object.fromEntries(runs.map((run) => [run.id, orchestrator.listRunCheckpoints(run.id)])),
      domainEvents: this.listDomainEvents(taskId),
    };
  }

  listApprovals(taskId?: string): Approval[] {
    const rows = taskId
      ? (db.prepare("SELECT * FROM approvals WHERE task_id = ? ORDER BY created_at ASC").all(taskId) as any[])
      : (db.prepare("SELECT * FROM approvals ORDER BY created_at DESC").all() as any[]);
    return rows.map(rowToApproval);
  }

  listAlwaysAllowRules(): AlwaysAllowRule[] {
    return listAlwaysAllowRules();
  }

  listRecoveryActions(taskId?: string): TaskRecoveryAction[] {
    return listTaskRecoveryActions(taskId);
  }

  listReviewDecisions(taskId?: string): TaskReviewDecision[] {
    return listTaskReviewDecisions(taskId);
  }

  deleteAlwaysAllowRule(ruleId: string, actor: string): AlwaysAllowRule {
    const rule = deleteAlwaysAllowRule(ruleId);
    if (!rule) throw new Error(`未知总是允许规则: ${ruleId}`);
    recordAudit({
      actor,
      agentId: rule.agentId,
      taskId: null,
      action: "delete_always_allow_rule",
      detail: { ruleId: rule.id, workspaceId: rule.workspaceId, pattern: rule.pattern },
    });
    return rule;
  }

  // ---- getDiff / getFiles：统一从 file_changes 表读取，不关心具体 adapter ----
  getFiles(taskId: string): FileChange[] {
    const rows = db.prepare("SELECT * FROM file_changes WHERE task_id = ? ORDER BY created_at ASC").all(taskId) as any[];
    return rows.map(rowToFileChange);
  }

  getDiff(taskId: string): string {
    const files = this.getFiles(taskId);
    return files
      .filter((f) => f.diff)
      .map((f) => f.diff)
      .join("\n");
  }

  private createCtx(task: Task, runId?: string, turnText?: string, opts: { subtask?: Subtask; agentName?: string } = {}): TaskRuntimeContext {
    // 并行子任务各用各的运行标识和会话，不能共用、也不能改写主任务的会话（汇总那一轮还要接着主任务的会话聊）。
    const subtaskRun = opts.subtask ?? null;
    const taskStillExists = () => Boolean(db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(task.id));
    const workspace = getWorkspace(task.workspaceId);
    let workspacePrompt: string | null = null;
    try {
      const prompt = getWorkspacePrompt(task.workspaceId).content.trim();
      workspacePrompt = prompt || null;
    } catch {
      workspacePrompt = null;
    }
    // 知识组 / MCP / 工具 / Skill 统一取"工作区配置 ∪ 角色默认"；Skill/工具跟工作区长期上下文放在一起，
    // 所有走 buildWorkspacePrompt 的 adapter 都能自动带上。
    const turnQuery = turnText?.trim() || task.prompt;
    const resources = resolveEffectiveResources(task);
    const libraryContext = buildLibraryContext(resources, turnQuery);
    if (libraryContext) workspacePrompt = [workspacePrompt, libraryContext].filter(Boolean).join("\n\n");
    if (task.planMode) workspacePrompt = [workspacePrompt, PLAN_MODE_INSTRUCTION].filter(Boolean).join("\n\n");
    const workspaceKnowledge = selectTurnKnowledge(resources.knowledgeGroupIds, turnQuery, 5);

    const insertEvent = (type: EventType, payload: unknown) => {
      if (!taskStillExists()) return;
      try {
        emitTaskEvent({ taskId: task.id, type, payload, runId });
      } catch (err) {
        if (!taskStillExists()) return;
        throw err;
      }
    };

    const addMessage = (role: "user" | "agent" | "system", content: string, images: string[] = []) => {
      if (!taskStillExists()) return;
      const id = nanoid();
      const createdAt = now();
      try {
        db.prepare("INSERT INTO task_messages (id, task_id, role, content, images, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
          id,
          task.id,
          role,
          content,
          JSON.stringify(images),
          createdAt
        );
      } catch (err) {
        if (!taskStillExists()) return;
        throw err;
      }
      insertEvent("message", { id, role, content, images });
    };

    if (task.planMode && runId && !getAdapter(task.agentId)?.enforcesPlanMode) {
      insertEvent("log", { message: "计划模式：这个 Agent 没有原生只读机制，只能靠指令约束它这一轮不改文件，不能完全保证" });
    }

    return {
      taskId: task.id,
      runtimeKey: subtaskRun ? `${task.id}:${subtaskRun.id}` : task.id,
      agentId: task.agentId,
      workspaceId: task.workspaceId,
      workspacePath: workspace?.path ?? process.cwd(),
      workspaceAccessPaths: workspace?.accessPaths ?? (workspace?.path ? [workspace.path] : [process.cwd()]),
      workspacePrompt,
      workspaceKnowledge,
      sessionKey: subtaskRun ? null : task.sessionKey,
      model: task.model,
      permissionMode: task.permissionMode,
      planMode: task.planMode,
      subAgentId: task.subAgentId,
      budgetLimitCny: task.budgetLimitCny,
      mcpServers: resolveMcpServers(resources.mcpServerIds),

      log: (message: string) => insertEvent("log", { message }),
      terminal: (chunk: string) => insertEvent("terminal", { chunk }),
      // 并行时几个子任务的回复会交错出现在对话里，前面标上是哪个子任务、哪个 Agent。
      agentMessage: (content: string) =>
        addMessage("agent", subtaskRun ? `【${subtaskRun.title} · ${opts.agentName ?? task.agentId}】\n${content}` : content),
      fileChange: (path: string, action: FileChange["action"], diff?: string) => {
        if (!taskStillExists()) return;
        if (runId) this.reportedFileChanges.set(runId, (this.reportedFileChanges.get(runId) ?? 0) + 1);
        const id = nanoid();
        const createdAt = now();
        try {
          db.prepare("INSERT INTO file_changes (id, task_id, path, action, diff, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
            id,
            task.id,
            path,
            action,
            diff ?? null,
            createdAt
          );
        } catch (err) {
          if (!taskStillExists()) return;
          throw err;
        }
        recordArtifact({
          taskId: task.id,
          runId,
          kind: "file",
          name: path,
          path,
          metadata: { action, hasDiff: Boolean(diff) },
        });
        insertEvent("file", { path, action, diff: diff ?? null });
      },

      requestApproval: ({ command, cwd, riskLevel, reason }) => {
        if (!taskStillExists()) return Promise.resolve({ decision: "deny" as ApprovalDecision, note: "任务已删除" });
        const id = nanoid();
        const createdAt = now();
        const matchedRule = findMatchingAlwaysAllowRule({ workspaceId: task.workspaceId, agentId: task.agentId, command });
        if (matchedRule) {
          const note = `命中总是允许规则：${matchedRule.pattern}`;
          try {
            db.prepare(
              "INSERT INTO approvals (id, task_id, command, cwd, risk_level, reason, status, note, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, 'always_allowed', ?, ?, ?)"
            ).run(id, task.id, command, cwd, riskLevel, reason, note, createdAt, createdAt);
          } catch (err) {
            if (!taskStillExists()) return Promise.resolve({ decision: "deny" as ApprovalDecision, note: "任务已删除" });
            throw err;
          }
          const approval: Approval = {
            id,
            taskId: task.id,
            command,
            cwd,
            riskLevel,
            reason,
            status: "always_allowed",
            note,
            createdAt,
            resolvedAt: createdAt,
          };
          insertEvent("approval_resolved", approval);
          bus.publishApproval(task.id, approval);
          recordAudit({
            actor: "system",
            agentId: task.agentId,
            taskId: task.id,
            action: "approval_auto_allowed",
            detail: { approvalId: id, ruleId: matchedRule.id, pattern: matchedRule.pattern, command },
          });
          return Promise.resolve({ decision: "approve_always" as ApprovalDecision, note });
        }
        try {
          db.prepare(
            "INSERT INTO approvals (id, task_id, command, cwd, risk_level, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)"
          ).run(id, task.id, command, cwd, riskLevel, reason, createdAt);
        } catch (err) {
          if (!taskStillExists()) return Promise.resolve({ decision: "deny" as ApprovalDecision, note: "任务已删除" });
          throw err;
        }
        this.setStatus(task.id, "needs_approval", runId);
        const approval: Approval = {
          id,
          taskId: task.id,
          command,
          cwd,
          riskLevel,
          reason,
          status: "pending",
          note: null,
          createdAt,
          resolvedAt: null,
        };
        insertEvent("approval_requested", approval);
        bus.publishApproval(task.id, approval);
        createNotification({
          level: riskLevel === "high" ? "danger" : "warn",
          title: riskLevel === "high" ? "高风险命令待审批" : "命令待审批",
          detail: command,
          taskId: task.id,
          source: "approval",
          sourceKey: `approval:${id}`,
        });

        return new Promise((resolve) => {
          this.pendingApprovals.set(id, { taskId: task.id, resolve });
        });
      },

      cancelPendingApprovals: (note: string) => this.cancelPendingApprovals(task.id, note),
      setStatus: (status) => this.setStatus(task.id, status, runId),
      setSessionKey: (sessionKey: string) => {
        if (!subtaskRun) db.prepare("UPDATE tasks SET session_key = ? WHERE id = ?").run(sessionKey, task.id);
        syncRunSessionKey(task.id, sessionKey, runId);
      },
      reportModel: (model: string) => {
        if (!runId || !model.trim() || !taskStillExists()) return;
        db.prepare("UPDATE task_runs SET model = ? WHERE id = ? AND (model IS NULL OR model = '')").run(model.trim(), runId);
      },
    };
  }

  private setStatus(taskId: string, status: TaskStatus, runId?: string, error?: string | null) {
    orchestrator.updateRunStatus({ taskId, status, runId, error });

    // 还有别的子任务在跑：任务整体仍是"运行中"（有在等审批的就是"待审批"），不能因为其中一个跑完就进复核；
    // 但这一个跑完可能让后面的子任务依赖满足了，马上派出去。
    const others = this.otherActiveRunStatuses(taskId, runId);
    if (others.length > 0) {
      const effective: TaskStatus = status === "needs_approval" || others.includes("needs_approval") ? "needs_approval" : "running";
      db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(effective, now(), taskId);
      emitTaskStatusChanged({
        taskId,
        status: effective,
        runId,
        payload: error ? { status: effective, runStatus: status, error } : { status: effective, runStatus: status },
      });
      if (status === "review" || status === "done") this.maybeAutoAdvancePlan(taskId);
      return;
    }

    const aggregate = this.resolveAggregateStatus(taskId, status);
    db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(aggregate.status, now(), taskId);
    emitTaskStatusChanged({
      taskId,
      status: aggregate.status,
      runId,
      payload: error ? { status: aggregate.status, runStatus: status, error } : { status: aggregate.status, runStatus: status },
    });
    if (aggregate.nextRunnableSubtask) this.recordSubtaskReady(taskId, aggregate.nextRunnableSubtask, runId);
    this.recordStatusSideEffects(taskId, aggregate.status, error, aggregate.nextRunnableSubtask);
    if (aggregate.nextRunnableSubtask) this.maybeAutoAdvancePlan(taskId);
  }

  private trackRun(taskId: string, runId: string, adapter: AgentAdapter, ctx: TaskRuntimeContext): void {
    let runs = this.activeRuns.get(taskId);
    if (!runs) {
      runs = new Map();
      this.activeRuns.set(taskId, runs);
    }
    runs.set(runId, { adapter, ctx });
  }

  private untrackRun(taskId: string, runId: string): void {
    const runs = this.activeRuns.get(taskId);
    if (!runs) return;
    runs.delete(runId);
    if (runs.size === 0) this.activeRuns.delete(taskId);
  }

  /** 这个任务里除了 runId 之外、还没结束的那些轮的状态。 */
  private otherActiveRunStatuses(taskId: string, runId?: string): string[] {
    const runs = this.activeRuns.get(taskId);
    if (!runs) return [];
    const statuses: string[] = [];
    for (const id of runs.keys()) {
      if (id === runId) continue;
      const row = db.prepare("SELECT status FROM task_runs WHERE id = ?").get(id) as { status: string } | undefined;
      if (row && IN_PROGRESS_RUN_STATUSES.has(row.status)) statuses.push(row.status);
    }
    return statuses;
  }

  private activeRunCount(taskId: string): number {
    return this.otherActiveRunStatuses(taskId).length;
  }

  /** 启动一轮：登记为正在跑，结束后注销并处理排队消息。所有启动 Agent 的地方都走这里，停止才能停全。 */
  private launch(taskId: string, runId: string, adapter: AgentAdapter, ctx: TaskRuntimeContext, start: () => Promise<void>, failLabel: string): void {
    this.trackRun(taskId, runId, adapter, ctx);
    void start()
      .catch((err) => {
        ctx.log(`${failLabel}：${(err as Error).message}`);
        this.setStatus(taskId, "failed", runId, (err as Error).message);
      })
      .finally(() => {
        this.untrackRun(taskId, runId);
        this.tryAdvanceQueue(taskId);
      });
  }

  /**
   * 智能多 Agent 规划确认时如果勾选了"自动依次执行"（task.autoAdvancePlan），
   * 下一个依赖已就绪的子任务已经带着 assignedAgentId（规划阶段选好的 Agent），
   * 不需要再等人工点一次"执行下个子任务"——直接按计划派发。
   * 单条子任务内部的风险审批闸门（scanRisk/shouldGate/requestApproval）不受影响，照常生效。
   */
  private maybeAutoAdvancePlan(taskId: string): void {
    const task = this.getTask(taskId);
    if (!task || !task.autoAdvancePlan) return;
    this.dispatchRunnableSubtasks(taskId, "auto_advance_plan");
  }

  /**
   * 把依赖已满足的子任务全部派出去，同时跑（受 AGENTHUB_MAX_PARALLEL_SUBTASKS 限制）。
   * 已经在跑的子任务状态是 running，不会被重复派发。
   */
  private dispatchRunnableSubtasks(taskId: string, actor: string): number {
    let started = 0;
    for (const subtask of this.listRunnableSubtasks(taskId)) {
      if (!subtask.assignedAgentId) continue;
      if (MAX_PARALLEL_SUBTASKS > 0 && this.activeRunCount(taskId) >= MAX_PARALLEL_SUBTASKS) break;
      const task = this.getTask(taskId);
      if (!task) break;
      try {
        this.startSubtask(task, subtask, {}, actor);
        started += 1;
      } catch (err) {
        this.recordMessage(taskId, "system", `自动派发子任务「${subtask.title}」失败：${(err as Error).message}`);
      }
    }
    return started;
  }

  /**
   * 暂停/恢复自动依次执行，不影响正在跑的当次 run——只改变下一个子任务跑完后要不要自动继续派发。
   * 暂停后仍然可以用"执行下个子任务"手动继续，恢复后下一次有子任务就绪时会自动接着跑。
   */
  setAutoAdvancePlan(taskId: string, enabled: boolean, actor: string): Task {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`未知任务: ${taskId}`);
    if (task.autoAdvancePlan === enabled) return task;

    db.prepare("UPDATE tasks SET auto_advance_plan = ?, updated_at = ? WHERE id = ?").run(enabled ? 1 : 0, now(), taskId);
    this.recordSystemMessage(taskId, enabled ? "已重新开启子任务自动依次执行。" : "已暂停子任务自动依次执行，后续子任务需要手动点「执行下个子任务」。");
    recordAudit({ actor, agentId: task.agentId, taskId, action: "set_auto_advance_plan", detail: { enabled } });

    // 恢复时如果已经有一个依赖就绪的子任务在等（比如暂停期间上一个 run 刚好跑完），
    // 不能指望"下一次状态变化"才触发——那一次状态变化已经发生过了。这里主动补一次检查，
    // 不然用户点了"恢复"却发现什么都没发生，还得再手动点一次"执行下个子任务"。
    if (enabled) this.dispatchRunnableSubtasks(taskId, actor);
    return this.getTask(taskId)!;
  }

  /** 任务实际能用的知识组 / MCP / 工具 / Skill（工作区配置 + 角色默认），只读，改要去工作区。 */
  getTaskResources(taskId: string): TaskResourcesView {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`未知任务: ${taskId}`);
    return describeTaskResources(task);
  }

  setTaskPlanMode(taskId: string, enabled: boolean, actor: string): Task {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`未知任务: ${taskId}`);
    if (enabled === task.planMode) return task;
    db.prepare("UPDATE tasks SET plan_mode = ?, updated_at = ? WHERE id = ?").run(enabled ? Date.now() : 0, now(), taskId);
    recordAudit({ actor, agentId: task.agentId, taskId, action: "set_task_plan_mode", detail: { enabled } });
    return this.getTask(taskId)!;
  }

  /** 批准计划：先退出计划模式，再让 Agent 按刚才的计划执行（续接同一个会话，计划还在上下文里）。 */
  approvePlan(taskId: string, actor: string): Task {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`未知任务: ${taskId}`);
    if (!task.planMode) throw new Error("这个任务当前不在计划模式");
    if (["running", "needs_approval", "waiting", "queued"].includes(task.status)) throw new Error("Agent 还在处理中，等这一轮结束再批准");
    const since = task.planModeSince ?? "";
    if (!this.listMessages(taskId).some((message) => message.role === "agent" && message.createdAt > since)) {
      throw new Error("开启计划模式后 Agent 还没给出方案，先发一条需求让它出方案");
    }
    this.setTaskPlanMode(taskId, false, actor);
    recordAudit({ actor, agentId: task.agentId, taskId, action: "approve_plan", detail: {} });
    this.sendMessage(taskId, PLAN_APPROVED_MESSAGE, [], actor);
    return this.getTask(taskId)!;
  }

  /** 只改 task.model 这个字段，不碰当前正在跑的 run，下一次 createCtx() 重新读到新值，从下一轮对话开始生效。 */
  setTaskModel(taskId: string, model: string | null, actor: string): Task {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`未知任务: ${taskId}`);
    const normalized = model?.trim() || null;
    db.prepare("UPDATE tasks SET model = ?, updated_at = ? WHERE id = ?").run(normalized, now(), taskId);
    recordAudit({ actor, agentId: task.agentId, taskId, action: "set_task_model", detail: { model: normalized } });
    return this.getTask(taskId)!;
  }

  private assignTaskAgent(taskId: string, adapter: AgentAdapter, model: string | null) {
    db.prepare(
      "UPDATE tasks SET agent_id = ?, agent_kind = ?, model = ?, sub_agent_id = NULL, base_agent_id = ?, updated_at = ? WHERE id = ?"
    ).run(adapter.id ?? adapter.kind, adapter.kind, model, adapter.roleInfo?.baseAgentId ?? null, now(), taskId);
  }

  private taskHasWorkspaceBoundHistory(taskId: string): boolean {
    const tables = ["task_runs", "file_changes", "approvals", "artifacts"] as const;
    for (const table of tables) {
      if (db.prepare(`SELECT 1 FROM ${table} WHERE task_id = ? LIMIT 1`).get(taskId)) return true;
    }
    return Boolean(db.prepare("SELECT 1 FROM task_messages WHERE task_id = ? LIMIT 1").get(taskId));
  }

  private resolveAggregateStatus(
    taskId: string,
    status: TaskStatus
  ): { status: TaskStatus; nextRunnableSubtask: Subtask | null } {
    if (status !== "done" && status !== "review") return { status, nextRunnableSubtask: null };

    const subtasks = listSubtasks(taskId);
    const childSubtasks = subtasks.filter((subtask) => subtask.parentSubtaskId);
    if (childSubtasks.length === 0) return { status, nextRunnableSubtask: null };

    // 并行时某个子任务失败了，其他的会继续跑完；全部停下来以后，任务整体算失败，不进汇总。
    if (childSubtasks.some((subtask) => ["failed", "timed_out", "cancelled"].includes(subtask.status))) {
      return { status: "failed", nextRunnableSubtask: null };
    }
    if (childSubtasks.some((subtask) => subtask.status === "stopped")) return { status: "stopped", nextRunnableSubtask: null };

    const successful = new Set(["done", "review"]);
    const allChildrenSuccessful = childSubtasks.every((subtask) => successful.has(subtask.status));
    if (allChildrenSuccessful) return { status, nextRunnableSubtask: null };

    const runnable = orchestrator.listRunnableSubtasksForTask(taskId).find((subtask) => Boolean(subtask.parentSubtaskId)) ?? null;
    return { status: "review", nextRunnableSubtask: runnable };
  }

  private recordSubtaskReady(taskId: string, subtask: Subtask, runId?: string): void {
    emitTaskEvent({
      taskId,
      type: "log",
      runId: runId ?? null,
      domainName: "subtask.ready",
      payload: {
        message: `子任务「${subtask.title}」已满足依赖，可以派发`,
        subtaskId: subtask.id,
        title: subtask.title,
        assignedAgentId: subtask.assignedAgentId,
        dependencyIds: subtask.dependencyIds,
      },
      touchTask: false,
    });
    createNotification({
      level: "info",
      title: "下个子任务可派发",
      detail: subtask.title,
      taskId,
      source: "subtask_ready",
      sourceKey: `subtask_ready:${taskId}:${subtask.id}`,
    });
  }

  private recordStatusSideEffects(taskId: string, status: TaskStatus, error?: string | null, nextRunnableSubtask?: Subtask | null): void {
    const task = this.getTask(taskId);
    if (!task) return;
    if (status === "done" || status === "review") {
      createTaskSummaryMemory(taskId);
      createNotification({
        level: "success",
        title: nextRunnableSubtask ? "任务等待下个子任务" : status === "done" ? "任务已完成" : "任务进入复核",
        detail: nextRunnableSubtask ? `${task.title}：${nextRunnableSubtask.title}` : task.title,
        taskId,
        source: nextRunnableSubtask ? "subtask_ready_status" : "task_status",
        sourceKey: nextRunnableSubtask ? `task:${taskId}:subtask-ready:${nextRunnableSubtask.id}` : `task:${taskId}:status:${status}`,
      });
      return;
    }
    if (status === "failed") {
      createNotification({
        level: "danger",
        title: "任务失败",
        detail: error ? `${task.title}：${error}` : task.title,
        taskId,
        source: "task_status",
        sourceKey: `task:${taskId}:status:failed`,
      });
      return;
    }
    if (status === "stopped") {
      createNotification({
        level: "info",
        title: "任务已停止",
        detail: task.title,
        taskId,
        source: "task_status",
        sourceKey: `task:${taskId}:status:stopped`,
      });
    }
  }

  createTask(input: {
    agentId: string;
    workspaceId: string;
    title?: string;
    prompt?: string;
    images?: string[];
    model?: string;
    permissionMode?: PermissionMode;
    subAgentId?: string;
    budgetLimitCny?: number | null;
    autoPlanSubtasks?: boolean;
    /** 用户在"AI 智能拆分并分配 Agent"里确认（可能编辑过）的多 Agent 规划；带了这个字段就不走本地启发式拆分。 */
    multiAgentPlan?: MultiAgentPlan;
    /** 配合 multiAgentPlan：子任务跑完一个自动派发下一个，不需要逐步人工点确认。 */
    autoAdvancePlan?: boolean;
    planMode?: boolean;
    actor: string;
  }): Task {
    const adapter = getAdapter(input.agentId);
    if (!adapter) throw new Error(`未知 agent: ${input.agentId}`);
    const agentId = adapter.id ?? adapter.kind;
    const workspace = getWorkspace(input.workspaceId);
    if (!workspace) throw new Error(`未知 workspace: ${input.workspaceId}`);
    if (workspace.allowedAgentKinds.length > 0 && !workspace.allowedAgentKinds.includes(adapter.kind)) {
      throw new Error(`workspace "${workspace.name}" 未授权 agent "${adapter.kind}"`);
    }

    const images = input.images ?? [];
    const prompt = input.prompt?.trim() ?? "";
    const title = (input.title?.trim() || (prompt.length > 60 ? prompt.slice(0, 57) + "..." : prompt)).trim();
    if (!title) throw new Error("任务名称为必填项");
    // 角色：没单独指定模型就用角色的默认模型，并记下当时的底座（角色的 MCP / 工具 / Skill 在运行时叠加）。
    const role = adapter.roleInfo ?? null;
    const model = input.model?.trim() || role?.model || null;
    const permissionMode: PermissionMode = input.permissionMode ?? "supervised";
    const subAgentId = input.subAgentId?.trim() || null;
    const budgetLimitCny =
      input.budgetLimitCny == null || !Number.isFinite(Number(input.budgetLimitCny)) || Number(input.budgetLimitCny) <= 0
        ? null
        : Math.round(Number(input.budgetLimitCny) * 100) / 100;
    const id = nanoid();
    const createdAt = now();
    const shouldStart = Boolean(prompt);
    const autoAdvancePlan = Boolean(input.multiAgentPlan) && input.autoAdvancePlan !== false;
    db.prepare(
      `INSERT INTO tasks (id, agent_id, agent_kind, workspace_id, title, prompt, status, session_key, model, permission_mode, sub_agent_id, budget_limit_cny, auto_advance_plan, plan_mode, base_agent_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      agentId,
      adapter.kind,
      input.workspaceId,
      title.slice(0, 160),
      prompt,
      shouldStart ? "running" : "stopped",
      model,
      permissionMode,
      subAgentId,
      budgetLimitCny,
      autoAdvancePlan ? 1 : 0,
      input.planMode ? Date.now() : 0,
      role?.baseAgentId ?? null,
      createdAt,
      createdAt
    );

    const task = this.getTask(id)!;
    recordDomainEvent({
      name: "task.created",
      taskId: id,
      payload: {
        agentId,
        agentKind: adapter.kind,
        workspaceId: input.workspaceId,
        title,
        model,
        permissionMode,
        subAgentId,
        budgetLimitCny,
        imageCount: images.length,
        initialMessage: shouldStart,
      },
    });
    syncAgentDescriptor(toDescriptor(adapter));
    if (!shouldStart) {
      recordAudit({ actor: input.actor, agentId, taskId: id, action: "create_task", detail: { title, prompt, images, initialMessage: false } });
      return task;
    }

    const subtaskPlan = input.multiAgentPlan || input.autoPlanSubtasks === false ? null : planSubtasks(prompt);
    const { run } = orchestrator.startRun({ task, prompt, images, source: "create_task" });
    const plannedSubtasks = input.multiAgentPlan
      ? createPlannedSubtasksFromPlan(task, input.multiAgentPlan)
      : subtaskPlan
        ? createPlannedSubtasks(task, subtaskPlan)
        : [];
    const planSummary = input.multiAgentPlan
      ? { confidence: 1, reasons: [input.multiAgentPlan.reasoning].filter(Boolean) }
      : subtaskPlan
        ? { confidence: subtaskPlan.confidence, reasons: subtaskPlan.reasons }
        : null;
    if (planSummary && plannedSubtasks.length > 0) {
      emitTaskEvent({
        taskId: id,
        type: "log",
        runId: run.id,
        domainName: "subtask.plan.created",
        payload: {
          message: `已生成 ${plannedSubtasks.length} 个计划子任务${input.multiAgentPlan ? "（AI 智能分配 Agent）" : ""}`,
          confidence: planSummary.confidence,
          reasons: planSummary.reasons,
          subtasks: plannedSubtasks.map((subtask) => ({
            id: subtask.id,
            title: subtask.title,
            dependencyIds: subtask.dependencyIds,
            assignedAgentId: subtask.assignedAgentId,
          })),
        },
      });
      recordAudit({
        actor: input.actor,
        agentId,
        taskId: id,
        action: "create_subtask_plan",
        detail: {
          subtaskCount: plannedSubtasks.length,
          confidence: planSummary.confidence,
          reasons: planSummary.reasons,
          source: input.multiAgentPlan?.source ?? "heuristic",
        },
      });
    }
    recordAudit({ actor: input.actor, agentId, taskId: id, action: "create_task", detail: { title, prompt, images, initialMessage: true } });

    const ctx = this.createCtx(task, run.id, prompt);
    const messageId = this.recordUserMessage(id, prompt, images);
    // 有 AI 拆分计划时，总管家第一轮只统筹，活交给后面的子任务；对话里记的仍是用户的原话。
    const firstTurnText =
      input.multiAgentPlan && plannedSubtasks.length > 0 ? buildPlanCoordinatorBrief(prompt, input.multiAgentPlan, plannedSubtasks) : prompt;

    this.launch(id, run.id, adapter, ctx, () => this.runTurn(task, ctx, run.id, messageId, () => adapter.run(ctx, { text: firstTurnText, images })), "任务执行异常");

    return task;
  }

  /** 一轮的完整流程：拍快照 → 跑 Agent → Agent 没自己上报文件改动的话，用快照补上这一轮改了什么。 */
  private async runTurn(task: Task, ctx: TaskRuntimeContext, runId: string, messageId: string, start: () => Promise<void>): Promise<void> {
    const { stillActive, snapshot } = await this.snapshotBeforeRun(task, ctx, runId, messageId);
    if (!stillActive) return;
    try {
      await start();
    } finally {
      // 不等它：算 diff 要跑 git，不能拖住后面的排队消息派发。它排在同一工作区的快照锁里，
      // 下一轮的快照一定在它之后才拍，所以算出来的仍是这一轮的改动。
      void this.recordTurnFileChanges(task, ctx, runId, snapshot);
    }
  }

  /**
   * Claude Code、Antigravity、OpenClaw 这类 Agent 不会告诉我们改了哪些文件（Codex 会），"文件 / Diff"页就一直是空的。
   * 这里拿这一轮开始前的快照和现在的工作区比一下补上。同一工作区同时有别的任务在改的话，它们的改动也会算进来。
   */
  private async recordTurnFileChanges(task: Task, ctx: TaskRuntimeContext, runId: string, snapshot: TurnSnapshot | null): Promise<void> {
    const reported = this.reportedFileChanges.get(runId) ?? 0;
    this.reportedFileChanges.delete(runId);
    if (reported > 0 || !snapshot) return;
    // 这一步在一轮结束之后才跑，任务可能已被删除、服务可能正在关闭（数据库已关），都只能安静跳过，不能再抛错。
    try {
      if (!this.getTask(task.id)) return;
      const workspace = getWorkspace(task.workspaceId);
      if (!workspace) return;
      const changes = await diffSinceSnapshot(snapshot, workspace.path);
      for (const change of changes) ctx.fileChange(change.path, change.action, change.diff);
    } catch (err) {
      try {
        if (this.getTask(task.id)) ctx.log(`统计这一轮的文件改动失败：${(err as Error).message}`);
      } catch {
        // 数据库已关闭
      }
    }
  }

  /**
   * 派发前给工作区拍快照，供"撤回这一轮"用。拍失败不阻塞派发，只是这一轮不能撤回。
   * stillActive 表示拍完之后还要不要启动 Agent：拍快照期间用户点了停止 / 删了任务，就不能再启动。
   */
  private async snapshotBeforeRun(
    task: Task,
    ctx: TaskRuntimeContext,
    runId: string,
    messageId: string
  ): Promise<{ stillActive: boolean; snapshot: TurnSnapshot | null }> {
    const workspace = getWorkspace(task.workspaceId);
    let snapshot: TurnSnapshot | null = null;
    if (workspace) {
      try {
        snapshot = await createSnapshot({ workspaceId: workspace.id, workspacePath: workspace.path, taskId: task.id, runId, messageId, kind: "before_run" });
        // 拍快照期间任务被删了：快照记录是删除之后才写进去的，清掉免得留下孤儿数据。
        if (!this.getTask(task.id)) {
          deleteTaskSnapshots(task.id);
          snapshot = null;
        }
      } catch (err) {
        if (this.getTask(task.id)) {
          ctx.log(err instanceof SnapshotSkippedError ? err.message : `工作区快照失败，这一轮之后不能撤回：${(err as Error).message}`);
        }
      }
    }
    return { stillActive: this.getTask(task.id)?.status === "running", snapshot };
  }

  listSnapshots(taskId: string): WorkspaceSnapshot[] {
    return listTaskSnapshots(taskId);
  }

  private resolveSnapshot(taskId: string, snapshotId: string) {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`未知任务: ${taskId}`);
    const snapshot = getSnapshot(snapshotId);
    if (!snapshot || snapshot.taskId !== taskId) throw new Error("找不到这个快照");
    const workspace = getWorkspace(snapshot.workspaceId);
    if (!workspace) throw new Error("快照所在的工作区已经不存在");
    return { task, snapshot, workspace };
  }

  previewSnapshotRestore(taskId: string, snapshotId: string): Promise<RestorePreview> {
    const { snapshot, workspace } = this.resolveSnapshot(taskId, snapshotId);
    return previewRestore(snapshot, workspace.path);
  }

  async restoreSnapshot(taskId: string, snapshotId: string, actor: string): Promise<{ preview: RestorePreview }> {
    const { task, snapshot, workspace } = this.resolveSnapshot(taskId, snapshotId);
    const busyStatuses = ["running", "needs_approval", "waiting", "queued"];
    const busyInWorkspace = (db.prepare("SELECT id, title, status FROM tasks WHERE workspace_id = ?").all(workspace.id) as {
      id: string;
      title: string;
      status: string;
    }[]).filter((row) => busyStatuses.includes(row.status));
    if (busyInWorkspace.length) {
      throw new Error(`工作区里还有任务在运行（${busyInWorkspace.map((row) => row.title).join("、")}），等它们停下再撤回`);
    }

    const { preview, safety } = await restoreSnapshot(snapshot, workspace.path);
    const anchor = snapshot.messageId
      ? this.listMessages(taskId).find((message) => message.id === snapshot.messageId)?.content ?? ""
      : "";
    const what = snapshot.kind === "before_restore" ? "上一次撤回之前的状态" : `「${clipTitle(anchor, 30) || "这一轮"}」发出之前`;
    const summary = [
      preview.restore.length ? `还原 ${preview.restore.length} 个` : null,
      preview.recreate.length ? `恢复 ${preview.recreate.length} 个被删的` : null,
      preview.remove.length ? `删除 ${preview.remove.length} 个新增的` : null,
    ]
      .filter(Boolean)
      .join("、");
    // 先把"撤回前"快照挂到这条系统消息上，再发出消息：前端一收到新消息就会去拉快照列表。
    const systemMessageId = nanoid();
    linkSnapshotMessage(safety.id, systemMessageId);
    this.recordMessage(
      taskId,
      "system",
      `已把工作区文件回退到${what}：${summary || "没有文件需要改动"}。对话记录不变；撤回前的文件已自动保存，点这条消息上的"恢复撤回前的文件"可以还原。`,
      [],
      systemMessageId
    );
    recordAudit({
      actor,
      agentId: task.agentId,
      taskId,
      action: "restore_workspace_snapshot",
      detail: { snapshotId, kind: snapshot.kind, safetySnapshotId: safety.id, ...preview },
    });
    return { preview };
  }

  private recordMessage(taskId: string, role: TaskMessage["role"], content: string, images: string[] = [], messageId = nanoid()): string {
    const createdAt = now();
    db.prepare("INSERT INTO task_messages (id, task_id, role, content, images, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      messageId,
      taskId,
      role,
      content,
      JSON.stringify(images),
      createdAt
    );
    emitTaskEvent({ taskId, type: "message", payload: { id: messageId, role, content, images }, createdAt });
    return messageId;
  }

  private recordUserMessage(taskId: string, content: string, images: string[] = []): string {
    return this.recordMessage(taskId, "user", content, images);
  }

  private recordSystemMessage(taskId: string, content: string): string {
    return this.recordMessage(taskId, "system", content, []);
  }

  changeTaskWorkspace(taskId: string, workspaceId: string, confirmed: boolean, actor: string): Task {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`未知任务: ${taskId}`);
    if (task.workspaceId === workspaceId) return task;
    if (task.status === "running" || task.status === "needs_approval") {
      throw new Error("任务正在运行或等待审批，不能切换工作区");
    }

    const oldWorkspace = getWorkspace(task.workspaceId);
    const nextWorkspace = getWorkspace(workspaceId);
    if (!nextWorkspace) throw new Error(`未知 workspace: ${workspaceId}`);
    if (nextWorkspace.allowedAgentKinds.length > 0 && !nextWorkspace.allowedAgentKinds.includes(task.agentKind)) {
      throw new Error(`workspace "${nextWorkspace.name}" 未授权 agent "${task.agentKind}"`);
    }

    const hasHistory = this.taskHasWorkspaceBoundHistory(taskId);
    if (hasHistory && !confirmed) {
      throw new Error("该任务已有运行记录或消息，切换工作区需要确认");
    }

    const updatedAt = now();
    db.prepare("UPDATE tasks SET workspace_id = ?, updated_at = ? WHERE id = ?").run(workspaceId, updatedAt, taskId);
    this.recordSystemMessage(
      taskId,
      `工作区已从「${oldWorkspace?.name ?? task.workspaceId}」切换到「${nextWorkspace.name}」。后续 Agent 将在新工作区执行；历史消息、产物和文件记录仍属于切换前的上下文。`
    );
    recordDomainEvent({
      name: "task.workspace.changed",
      taskId,
      payload: {
        previousWorkspaceId: task.workspaceId,
        previousWorkspaceName: oldWorkspace?.name ?? null,
        workspaceId,
        workspaceName: nextWorkspace.name,
        confirmed,
        hadHistory: hasHistory,
      },
    });
    recordAudit({
      actor,
      agentId: task.agentId,
      taskId,
      action: "change_task_workspace",
      detail: {
        previousWorkspaceId: task.workspaceId,
        workspaceId,
        confirmed,
        hadHistory: hasHistory,
      },
    });
    return this.getTask(taskId)!;
  }

  sendMessage(taskId: string, message: string, images: string[], actor: string): void {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`未知任务: ${taskId}`);
    if (!getAdapter(task.agentId)) throw new Error(`未知 agent: ${task.agentId}`);
    this.dispatchContinue(taskId, message, images, actor);
  }

  /** 实际把一条消息交给 adapter.continueTask，sendMessage 和队列推进都走这里。 */
  private dispatchContinue(
    taskId: string,
    text: string,
    images: string[],
    actor: string,
    source?: AgentRequestSource,
    sourceRunId?: string | null
  ): void {
    const task = this.getTask(taskId);
    if (!task) return;
    const adapter = getAdapter(task.agentId);
    if (!adapter) return;
    syncAgentDescriptor(toDescriptor(adapter));
    const continuedSubtaskId = this.resolveContinueSubtaskId(taskId, sourceRunId ?? null, source);
    const { run } = orchestrator.startRun({
      task,
      prompt: text,
      images,
      source: source ?? (actor === "queue" ? "queue" : "user_message"),
      sourceRunId: sourceRunId ?? null,
      subtaskId: continuedSubtaskId,
    });

    const messageId = this.recordUserMessage(taskId, text, images);
    recordAudit({
      actor,
      agentId: task.agentId,
      taskId,
      action: source === "retry" ? "dispatch_retry" : "send_message",
      detail: {
        message: text,
        images,
        source: source ?? (actor === "queue" ? "queue" : "user_message"),
        sourceRunId: sourceRunId ?? null,
        continuedSubtaskId,
      },
    });
    this.setStatus(taskId, "running", run.id);

    const ctx = this.createCtx(task, run.id, text);
    this.launch(taskId, run.id, adapter, ctx, () => this.runTurn(task, ctx, run.id, messageId, () => adapter.continueTask(ctx, { text, images })), "任务执行异常");
  }

  private resolveContinueSubtaskId(taskId: string, sourceRunId?: string | null, source?: AgentRequestSource): string | null {
    const subtasks = listSubtasks(taskId);
    const childSubtaskIds = new Set(subtasks.filter((subtask) => subtask.parentSubtaskId).map((subtask) => subtask.id));
    if (childSubtaskIds.size === 0) return null;

    const runs = listTaskRuns(taskId);
    if (sourceRunId) {
      const sourceRun = runs.find((run) => run.id === sourceRunId);
      if (sourceRun?.subtaskId && childSubtaskIds.has(sourceRun.subtaskId)) return sourceRun.subtaskId;
    }

    const shouldResumeStoppedChild = !source || source === "user_message";
    if (!shouldResumeStoppedChild) return null;

    for (const run of [...runs].reverse()) {
      if (run.status !== "stopped") continue;
      if (!run.subtaskId || !childSubtaskIds.has(run.subtaskId)) continue;
      const subtask = subtasks.find((item) => item.id === run.subtaskId);
      if (subtask?.status === "stopped") return run.subtaskId;
    }
    return null;
  }

  private createAgentHandoffSubtask(task: Task, agentId: string, prompt: string): string {
    const primary = ensurePrimarySubtask(task);
    const id = nanoid();
    const createdAt = now();
    db.prepare(
      `INSERT INTO subtasks (id, task_id, parent_subtask_id, title, status, assigned_agent_id, dependency_ids, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', ?, '[]', ?, ?)`
    ).run(id, task.id, primary.id, `转交：${clipTitle(prompt, 58)}`, agentId, createdAt, createdAt);
    return id;
  }

  listRunnableSubtasks(taskId: string): Subtask[] {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`未知任务: ${taskId}`);
    return orchestrator.listRunnableSubtasksForTask(taskId).filter((subtask) => Boolean(subtask.parentSubtaskId));
  }

  dispatchNextSubtask(
    taskId: string,
    input: { agentId?: string | null; prompt?: string | null; model?: string | null; images?: string[] },
    actor: string
  ): SubtaskDispatchResult {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`未知任务: ${taskId}`);
    if (task.status === "running" || task.status === "needs_approval") {
      throw new Error("任务正在运行或等待审批，请先停止或处理审批后再派发子任务");
    }

    const [subtask] = this.listRunnableSubtasks(taskId);
    if (!subtask) throw new Error("当前没有依赖已满足的待执行子任务");
    return this.startSubtask(task, subtask, input, actor);
  }

  /** 派发一个子任务（不检查任务是否在跑：并行时别的子任务可能正在跑）。 */
  private startSubtask(
    task: Task,
    subtask: Subtask,
    input: { agentId?: string | null; prompt?: string | null; model?: string | null; images?: string[] },
    actor: string
  ): SubtaskDispatchResult {
    const taskId = task.id;
    const summary = isPlanSummarySubtask(subtask);
    const requestedAgentId = input.agentId?.trim() || subtask.assignedAgentId || task.agentId;
    const adapter = getAdapter(requestedAgentId);
    if (!adapter) throw new Error(`未知 agent: ${requestedAgentId}`);
    const agentId = adapter.id ?? adapter.kind;
    if (!adapter.isConfigured()) throw new Error(`agent "${agentId}" 尚未配置，不能派发子任务`);

    const workspace = getWorkspace(task.workspaceId);
    if (!workspace) throw new Error(`未知 workspace: ${task.workspaceId}`);
    if (workspace.allowedAgentKinds.length > 0 && !workspace.allowedAgentKinds.includes(adapter.kind)) {
      throw new Error(`workspace "${workspace.name}" 未授权 agent "${adapter.kind}"`);
    }

    const latestRun = listTaskRuns(taskId).at(-1);
    const note = input.prompt?.trim() || "";
    // 智能多 Agent 规划确认时已经为这条子任务拼好了带技能资料的最终 prompt（subtask.plannedPrompt）；
    // 没有显式调度说明覆盖时直接用它，不再套用通用模板——保留通用模板只是给手动/本地启发式拆分兜底。
    const basePrompt = summary
      ? this.buildPlanSummaryPrompt(task)
      : !note && subtask.plannedPrompt
        ? subtask.plannedPrompt
        : [
            `请执行计划子任务：「${subtask.title}」。`,
            note ? `调度说明：${note}` : "",
            "请结合当前任务上下文，只处理这个子任务范围；完成后说明结果、产物和需要复核的点。",
            `原始任务：${task.prompt}`,
          ].filter(Boolean).join("\n\n");
    // 依赖前面子任务的，把它们的最后回复附上：前一步的成果如果只写在回复里（没落成文件），后一步也能接着用。
    const prompt = summary ? basePrompt : this.withUpstreamResults(task, subtask, basePrompt);
    const images = input.images ?? [];
    const model = input.model?.trim() || (agentId === task.agentId ? task.model : null);

    syncAgentDescriptor(toDescriptor(adapter));
    const { run, request } = orchestrator.startRun({
      task,
      prompt,
      images,
      source: "subtask_dispatch",
      sourceRunId: latestRun?.id ?? null,
      agentId,
      agentKind: adapter.kind,
      model,
      subtaskId: subtask.id,
    });
    const dispatchedSubtask = listSubtasks(taskId).find((item) => item.id === subtask.id) ?? subtask;

    this.recordUserMessage(
      taskId,
      summary
        ? `所有子任务都完成了，交给 ${adapter.name} 汇总结果`
        : `派发子任务给 ${adapter.name}：「${subtask.title}」${note ? ` - ${note}` : ""}`,
      images
    );
    emitTaskEvent({
      taskId,
      type: "log",
      runId: run.id,
      domainName: "subtask.dispatched",
      payload: {
        message: `已派发子任务「${subtask.title}」给 ${adapter.name}`,
        requestId: request.id,
        sourceRunId: latestRun?.id ?? null,
        targetRunId: run.id,
        subtaskId: subtask.id,
        targetAgentId: agentId,
        targetAgentKind: adapter.kind,
      },
    });
    createNotification({
      level: "info",
      title: "子任务已派发",
      detail: `${subtask.title} -> ${adapter.name}`,
      taskId,
      source: "subtask_dispatch",
      sourceKey: `subtask_dispatch:${request.id}`,
    });
    recordAudit({
      actor,
      agentId,
      taskId,
      action: "dispatch_subtask",
      detail: {
        requestId: request.id,
        sourceRunId: latestRun?.id ?? null,
        targetRunId: run.id,
        subtaskId: subtask.id,
        title: subtask.title,
        targetAgentKind: adapter.kind,
        prompt: note,
        images,
      },
    });
    this.setStatus(taskId, "running", run.id);

    // 汇总这一轮接着主任务 Agent 的会话聊（它记得自己第一轮的统筹说明）；普通子任务各开各的会话。
    const continueMain = summary && agentId === task.agentId && Boolean(task.sessionKey);
    const runtimeTask: Task = summary ? task : { ...task, agentId, agentKind: adapter.kind, model, subAgentId: null };
    const ctx = this.createCtx(runtimeTask, run.id, prompt, summary ? {} : { subtask: dispatchedSubtask, agentName: adapter.name });
    this.launch(
      taskId,
      run.id,
      adapter,
      ctx,
      () => (continueMain ? adapter.continueTask(ctx, { text: prompt, images }) : adapter.run(ctx, { text: prompt, images })),
      "子任务执行异常"
    );

    return { subtask: dispatchedSubtask, run, request };
  }

  /** 汇总这一轮发给主任务 Agent 的内容：用户原始需求 + 每个子任务最后的回复。 */
  /** 一个子任务的结果段落：标题、哪个 Agent 做的、它最后的回复（去掉对话里加的【子任务 · Agent】标签）。 */
  private subtaskResultSection(task: Task, subtask: Subtask, heading: string, maxChars: number): string {
    const run = listTaskRuns(task.id).filter((item) => item.subtaskId === subtask.id).at(-1);
    const agentName = getAdapter(run?.agentId ?? subtask.assignedAgentId ?? "")?.name ?? run?.agentId ?? subtask.assignedAgentId ?? "未知 Agent";
    const reply = run ? this.lastAgentReply(run.id).replace(/^【[^】\n]*】\n/, "").trim() : "";
    return `### ${heading}（${agentName}）\n${reply ? clipText(reply, maxChars) : "（这个子任务没有留下文字结果，成果可能直接在工作区的文件里）"}`;
  }

  private withUpstreamResults(task: Task, subtask: Subtask, prompt: string): string {
    if (subtask.dependencyIds.length === 0) return prompt;
    const all = listSubtasks(task.id);
    const upstream = subtask.dependencyIds
      .map((id) => all.find((item) => item.id === id))
      .filter((item): item is Subtask => Boolean(item));
    if (upstream.length === 0) return prompt;
    return [
      prompt,
      "---",
      "这一步依赖前面的子任务，下面是它们完成后最后的回复（成果也可能已经写在工作区的文件里，需要时自己去看）：",
      ...upstream.map((item) => this.subtaskResultSection(task, item, item.title, 3000)),
    ].join("\n\n");
  }

  private buildPlanSummaryPrompt(task: Task): string {
    const subtasks = listSubtasks(task.id).filter((subtask) => subtask.parentSubtaskId && !isPlanSummarySubtask(subtask));
    const sections = subtasks.map((subtask, index) => this.subtaskResultSection(task, subtask, `${index + 1}. ${subtask.title}`, 4000));
    return [
      `用户最初的需求：${task.prompt}`,
      `这个需求拆成了 ${subtasks.length} 个子任务，由不同 Agent 在同一个工作区里并行完成。各子任务最后的回复如下：`,
      ...sections,
      [
        "现在由你作为总负责人收尾：",
        "1. 汇总每个子任务做了什么、结果怎样；",
        "2. 它们是同时改同一个文件夹的，可能互相覆盖或不一致，必要时直接看工作区里的文件确认，发现问题可以直接修；",
        "3. 用简洁的中文把最终结果交给用户，并说明还需要用户做什么。",
      ].join("\n"),
    ].join("\n\n");
  }

  private lastAgentReply(runId: string): string {
    const rows = db
      .prepare("SELECT payload FROM domain_events WHERE run_id = ? AND legacy_type = 'message' ORDER BY created_at DESC")
      .all(runId) as Array<{ payload: string }>;
    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payload) as { role?: string; content?: string };
        if (payload.role === "agent" && payload.content) return payload.content;
      } catch {
        // 跳过坏数据
      }
    }
    return "";
  }

  dispatchAgentHandoff(
    taskId: string,
    input: { agentId: string; prompt: string; subtaskId?: string | null; model?: string | null; images?: string[] },
    actor: string
  ): void {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`未知任务: ${taskId}`);
    if (task.status === "running" || task.status === "needs_approval") {
      throw new Error("任务正在运行或等待审批，请先停止或处理审批后再转交 Agent");
    }

    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("转交说明不能为空");

    const adapter = getAdapter(input.agentId);
    if (!adapter) throw new Error(`未知 agent: ${input.agentId}`);
    const agentId = adapter.id ?? adapter.kind;
    if (!adapter.isConfigured()) throw new Error(`agent "${agentId}" 尚未配置，不能转交`);

    const workspace = getWorkspace(task.workspaceId);
    if (!workspace) throw new Error(`未知 workspace: ${task.workspaceId}`);
    if (workspace.allowedAgentKinds.length > 0 && !workspace.allowedAgentKinds.includes(adapter.kind)) {
      throw new Error(`workspace "${workspace.name}" 未授权 agent "${adapter.kind}"`);
    }

    const cleanSubtaskId = input.subtaskId?.trim() || null;
    const targetSubtaskId = cleanSubtaskId ?? this.createAgentHandoffSubtask(task, agentId, prompt);
    if (cleanSubtaskId && !listSubtasks(taskId).some((subtask) => subtask.id === cleanSubtaskId)) {
      throw new Error(`未知子任务: ${cleanSubtaskId}`);
    }

    syncAgentDescriptor(toDescriptor(adapter));
    const latestRun = listTaskRuns(taskId).at(-1);
    const images = input.images ?? [];
    const model = input.model?.trim() || adapter.roleInfo?.model || null;
    const { run, request } = orchestrator.startRun({
      task,
      prompt,
      images,
      source: "agent_handoff",
      sourceRunId: latestRun?.id ?? null,
      agentId,
      agentKind: adapter.kind,
      model,
      subtaskId: targetSubtaskId,
    });

    this.recordUserMessage(taskId, `转交给 ${adapter.name}：${prompt}`, images);
    emitTaskEvent({
      taskId,
      type: "log",
      runId: run.id,
      domainName: "agent.handoff.dispatched",
      payload: {
        message: `已转交给 ${adapter.name}`,
        requestId: request.id,
        sourceRunId: latestRun?.id ?? null,
        targetRunId: run.id,
        targetAgentId: agentId,
        targetAgentKind: adapter.kind,
        subtaskId: targetSubtaskId,
      },
    });
    createNotification({
      level: "info",
      title: "Agent 转交已派发",
      detail: `${task.title} -> ${adapter.name}`,
      taskId,
      source: "agent_handoff",
      sourceKey: `agent_handoff:${request.id}`,
    });
    recordAudit({
      actor,
      agentId,
      taskId,
      action: "dispatch_agent_handoff",
      detail: {
        requestId: request.id,
        sourceRunId: latestRun?.id ?? null,
        targetRunId: run.id,
        targetAgentKind: adapter.kind,
        subtaskId: targetSubtaskId,
        prompt,
        images,
      },
    });
    this.assignTaskAgent(taskId, adapter, model);
    this.setStatus(taskId, "running", run.id);

    const runtimeTask: Task = { ...(this.getTask(taskId) ?? task), agentId, agentKind: adapter.kind, model, subAgentId: null };
    const ctx = this.createCtx(runtimeTask, run.id, prompt);
    this.launch(taskId, run.id, adapter, ctx, () => adapter.run(ctx, { text: prompt, images }), "Agent 转交执行异常");
  }

  retryTask(taskId: string, note: string | undefined, actor: string): TaskRecoveryAction {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`未知任务: ${taskId}`);
    if (task.status === "running" || task.status === "needs_approval") {
      throw new Error("任务正在运行或等待审批，请先停止或处理审批后再重试");
    }
    if (!getAdapter(task.agentId)) throw new Error(`未知 agent: ${task.agentId}`);

    const plan = orchestrator.planRetry(taskId, {
      maxAttempts: 50,
      retryStatuses: ["failed", "stopped", "review", "timed_out"],
    });
    if (!plan.shouldRetry) {
      throw new Error("当前任务没有可重试的终止运行");
    }

    const cleanNote = note?.trim() || null;
    const action = createRecoveryAction({
      taskId,
      runId: plan.sourceRunId,
      kind: "retry",
      status: "dispatched",
      note: cleanNote,
    });
    recordDomainEvent({
      name: "recovery.action.created",
      taskId,
      runId: plan.sourceRunId,
      payload: { actionId: action.id, kind: action.kind, status: action.status, note: action.note, nextAttempt: plan.nextAttempt },
    });
    emitTaskEvent({
      taskId,
      type: "log",
      payload: { message: cleanNote ? `发起重试：${cleanNote}` : "发起重试" },
      runId: plan.sourceRunId,
    });
    createNotification({
      level: "info",
      title: "任务已发起重试",
      detail: cleanNote ? `${task.title}：${cleanNote}` : task.title,
      taskId,
      source: "recovery",
      sourceKey: `recovery:${action.id}`,
    });
    recordAudit({
      actor,
      agentId: task.agentId,
      taskId,
      action: "retry_task",
      detail: { actionId: action.id, sourceRunId: plan.sourceRunId, nextAttempt: plan.nextAttempt, note: cleanNote },
    });

    const prompt = cleanNote
      ? `请重试当前任务，并优先处理这条恢复说明：${cleanNote}`
      : "请重试当前任务。请参考上一轮失败或待复核的上下文，继续完成原始目标。";
    this.dispatchContinue(taskId, prompt, [], actor, "retry", plan.sourceRunId);
    return action;
  }

  handoffToHuman(taskId: string, note: string | undefined, actor: string): TaskRecoveryAction {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`未知任务: ${taskId}`);
    if (task.status === "running" || task.status === "needs_approval") {
      throw new Error("任务正在运行或等待审批，请先停止或处理审批后再转人工");
    }

    const latestRun = listTaskRuns(taskId).at(-1);
    const cleanNote = note?.trim() || null;
    const action = createRecoveryAction({
      taskId,
      runId: latestRun?.id ?? null,
      kind: "human_handoff",
      status: "open",
      note: cleanNote,
    });
    recordDomainEvent({
      name: "recovery.action.created",
      taskId,
      runId: latestRun?.id ?? null,
      payload: { actionId: action.id, kind: action.kind, status: action.status, note: action.note },
    });
    emitTaskEvent({
      taskId,
      type: "log",
      payload: { message: cleanNote ? `转人工复核：${cleanNote}` : "转人工复核" },
      runId: latestRun?.id ?? null,
    });
    createNotification({
      level: "warn",
      title: "任务已转人工复核",
      detail: cleanNote ? `${task.title}：${cleanNote}` : task.title,
      taskId,
      source: "recovery",
      sourceKey: `recovery:${action.id}`,
    });
    recordAudit({
      actor,
      agentId: task.agentId,
      taskId,
      action: "handoff_to_human",
      detail: { actionId: action.id, runId: latestRun?.id ?? null, note: cleanNote },
    });
    this.setStatus(taskId, "review", latestRun?.id ?? undefined);
    return action;
  }

  approveTaskReview(taskId: string, note: string | undefined, actor: string): TaskReviewDecision {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`未知任务: ${taskId}`);
    if (task.status !== "review") throw new Error("只有待复核任务可以验收通过");

    const latestRun = listTaskRuns(taskId).at(-1);
    const cleanNote = note?.trim() || null;
    const decision = createReviewDecision({
      taskId,
      runId: latestRun?.id ?? null,
      decision: "approved",
      note: cleanNote,
    });
    recordDomainEvent({
      name: "review.decision.created",
      taskId,
      runId: latestRun?.id ?? null,
      payload: { decisionId: decision.id, decision: decision.decision, note: decision.note },
    });
    emitTaskEvent({
      taskId,
      type: "log",
      payload: { message: cleanNote ? `验收通过：${cleanNote}` : "验收通过" },
      runId: latestRun?.id ?? null,
    });
    recordAudit({
      actor,
      agentId: task.agentId,
      taskId,
      action: "approve_task_review",
      detail: { decisionId: decision.id, runId: latestRun?.id ?? null, note: cleanNote },
    });
    this.setStatus(taskId, "done", latestRun?.id ?? undefined);
    return decision;
  }

  requestTaskChanges(taskId: string, note: string | undefined, actor: string): TaskReviewDecision {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`未知任务: ${taskId}`);
    if (task.status !== "review") throw new Error("只有待复核任务可以要求修改");
    const cleanNote = note?.trim();
    if (!cleanNote) throw new Error("要求修改时必须填写说明");

    const latestRun = listTaskRuns(taskId).at(-1);
    const decision = createReviewDecision({
      taskId,
      runId: latestRun?.id ?? null,
      decision: "changes_requested",
      note: cleanNote,
    });
    recordDomainEvent({
      name: "review.decision.created",
      taskId,
      runId: latestRun?.id ?? null,
      payload: { decisionId: decision.id, decision: decision.decision, note: decision.note },
    });
    emitTaskEvent({
      taskId,
      type: "log",
      payload: { message: `验收要求修改：${cleanNote}` },
      runId: latestRun?.id ?? null,
    });
    recordAudit({
      actor,
      agentId: task.agentId,
      taskId,
      action: "request_task_changes",
      detail: { decisionId: decision.id, runId: latestRun?.id ?? null, note: cleanNote },
    });
    this.retryTask(taskId, `验收要求修改：${cleanNote}`, actor);
    return decision;
  }

  // ---- 任务内消息队列：排队、拖拽重排、删除；任务自然完成（review/done）时自动派发下一条 ----
  listQueue(taskId: string): QueuedMessage[] {
    return queueDb.listQueue(taskId);
  }

  enqueueMessage(taskId: string, content: string, images: string[], actor: string): QueuedMessage {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`未知任务: ${taskId}`);
    const item = queueDb.enqueue(taskId, content, images);
    recordAudit({ actor, agentId: task.agentId, taskId, action: "enqueue_message", detail: { content, images } });
    this.publishQueue(taskId);
    this.tryAdvanceQueue(taskId); // 任务当前空闲的话立刻处理，不用等下一次状态变化
    return item;
  }

  removeQueueItem(taskId: string, itemId: string, actor: string): void {
    queueDb.removeItem(taskId, itemId);
    recordAudit({ actor, agentId: null, taskId, action: "dequeue_message", detail: { itemId } });
    this.publishQueue(taskId);
  }

  reorderQueue(taskId: string, orderedIds: string[], actor: string): QueuedMessage[] {
    const items = queueDb.reorder(taskId, orderedIds);
    recordAudit({ actor, agentId: null, taskId, action: "reorder_queue", detail: { orderedIds } });
    this.publishQueue(taskId);
    return items;
  }

  private publishQueue(taskId: string): void {
    const items = queueDb.listQueue(taskId);
    emitTaskEvent({ taskId, type: "queue_updated", payload: items });
  }

  /** 任务自然完成时（review/done）才继续处理队列；needs_approval/failed/stopped 不自动往下走。 */
  private tryAdvanceQueue(taskId: string): void {
    const task = this.getTask(taskId);
    if (!task) return;
    if (!orchestrator.shouldAdvanceQueue(task.status)) return;
    const next = queueDb.dequeueNext(taskId);
    if (!next) return;
    this.publishQueue(taskId);
    this.dispatchContinue(taskId, next.content, next.images, "queue");
  }

  approveAction(taskId: string, approvalId: string, decision: ApprovalDecision, note: string | undefined, actor: string): Approval {
    const row = db.prepare("SELECT * FROM approvals WHERE id = ? AND task_id = ?").get(approvalId, taskId) as any;
    if (!row) throw new Error(`未知审批: ${approvalId}`);
    if (row.status !== "pending") throw new Error(`审批 ${approvalId} 已处理（状态: ${row.status}）`);

    const task = this.getTask(taskId);
    if (!task) throw new Error(`未知任务: ${taskId}`);
    const rule = decision === "approve_always"
      ? ensureAlwaysAllowRule({ workspaceId: task.workspaceId, agentId: task.agentId, command: row.command })
      : null;
    const status = decision === "deny" ? "denied" : decision === "approve_always" ? "always_allowed" : "approved";
    const resolvedNote = note ?? (rule ? `已加入总是允许规则：${rule.pattern}` : null);
    const resolvedAt = now();
    db.prepare("UPDATE approvals SET status = ?, note = ?, resolved_at = ? WHERE id = ?").run(
      status,
      resolvedNote,
      resolvedAt,
      approvalId
    );

    const approval = rowToApproval({ ...row, status, note: resolvedNote, resolved_at: resolvedAt });

    emitTaskEvent({ taskId, type: "approval_resolved", payload: approval, createdAt: resolvedAt });
    bus.publishApproval(taskId, approval);
    markNotificationReadBySourceKey(`approval:${approvalId}`);

    recordAudit({
      actor,
      agentId: task.agentId,
      taskId,
      action: "approve_action",
      detail: { approvalId, decision, note: resolvedNote, ruleId: rule?.id, pattern: rule?.pattern },
    });

    const pending = this.pendingApprovals.get(approvalId);
    if (pending) {
      this.pendingApprovals.delete(approvalId);
      pending.resolve({ decision, note: resolvedNote });
    }

    return approval;
  }

  async stopTask(taskId: string, actor: string): Promise<void> {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`未知任务: ${taskId}`);
    const adapter = getAdapter(task.agentId);
    recordAudit({ actor, agentId: task.agentId, taskId, action: "stop_task", detail: {} });
    // 停止要停全：并行子任务各自是不同的 Agent / 进程。同时暂停自动执行，不然一个停了又会派出下一个。
    if (task.autoAdvancePlan) {
      db.prepare("UPDATE tasks SET auto_advance_plan = 0, updated_at = ? WHERE id = ?").run(now(), taskId);
      this.recordSystemMessage(taskId, "已停止，子任务自动执行也已暂停；要继续的话重新开启自动执行。");
    }
    const active = [...(this.activeRuns.get(taskId)?.entries() ?? [])];
    if (active.length > 0) {
      for (const [runId, entry] of active) {
        if (entry.adapter.stop) await entry.adapter.stop(entry.ctx);
        else this.setStatus(taskId, "stopped", runId);
      }
    } else if (adapter?.stop) {
      const ctx = this.createCtx(task);
      await adapter.stop(ctx);
    } else {
      this.setStatus(taskId, "stopped");
    }
    this.cancelPendingApprovals(taskId, "任务已停止，这条审批自动取消");
  }

  /**
   * 把任务还在等的审批标成拒绝（附说明），并通知界面刷新。故意不去唤醒等待中的 requestApproval：
   * 那边的 Agent 已经停了，唤醒反而会让它按"被拒绝"继续往下走、把"已停止"的状态改掉。
   */
  cancelPendingApprovals(taskId: string, note: string): void {
    const rows = db.prepare("SELECT * FROM approvals WHERE task_id = ? AND status = 'pending'").all(taskId) as any[];
    for (const row of rows) {
      const resolvedAt = now();
      db.prepare("UPDATE approvals SET status = 'denied', note = ?, resolved_at = ? WHERE id = ?").run(note, resolvedAt, row.id);
      const approval = rowToApproval({ ...row, status: "denied", note, resolved_at: resolvedAt });
      emitTaskEvent({ taskId, type: "approval_resolved", payload: approval, createdAt: resolvedAt });
      bus.publishApproval(taskId, approval);
      markNotificationReadBySourceKey(`approval:${row.id}`);
      this.pendingApprovals.delete(row.id);
    }
  }

  /**
   * 删除任务：清掉 AgentHub 自己记录的对话/事件/文件改动记录/审批/队列这些"缓存"，
   * 以及还没被消费、只属于这个任务排队消息的图片附件。绝不碰 workspace 里 agent 实际改过的
   * 真实文件——file_changes 表里存的只是 diff 文本记录，删记录不等于撤销改动。
   * 运行中的任务不允许直接删，得先停止，避免适配器还在写一个已经被删掉的任务。
   */
  deleteTask(taskId: string, actor: string): void {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`未知任务: ${taskId}`);
    if (task.status === "running" || task.status === "needs_approval") {
      throw new Error("任务正在运行，请先停止再删除");
    }

    for (const item of queueDb.listQueue(taskId)) {
      for (const img of item.images) deleteAttachmentFile(img);
    }

    db.prepare("DELETE FROM task_messages WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM task_events WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM file_changes WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM approvals WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM notifications WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM task_recovery_actions WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM task_review_decisions WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM message_queue WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM audit_log WHERE task_id = ?").run(taskId);
    deleteTaskSnapshots(taskId);
    db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);

    recordAudit({ actor, agentId: task.agentId, taskId: null, action: "delete_task", detail: { taskId, title: task.title } });
    bus.publishTaskDeleted(taskId);
  }
}

export const taskManager = new TaskManager();
