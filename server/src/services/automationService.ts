import { nanoid } from "nanoid";
import { db } from "../db/index.ts";
import { bus } from "../eventBus.ts";
import { getAdapter } from "../adapters/registry.ts";
import { recordAudit } from "./auditService.ts";
import { getWorkspace } from "./workspaceService.ts";
import { taskManager } from "./taskManager.ts";
import { describeRrule, nextRunAfter, parseRrule } from "./automationSchedule.ts";
import type {
  Automation,
  AutomationKind,
  AutomationRun,
  AutomationRunStatus,
  AutomationStatus,
  PermissionMode,
  TaskStatus,
} from "../types.ts";

// 定时任务：照 Codex 的自动化做。到点由 startAutomationScheduler 的定时检查触发，也可以手动「立即运行」。
// - cron：按设定的 Agent / 角色、工作区、模型、权限新建一个任务；上一次建的任务还在跑就跳过这次（免得同一个工作区里两份一起改）。
// - heartbeat：往指定的已有任务里发这段提示词；那个任务正忙就排进它的消息队列，空闲了自动接着发。
// 没开机错过的几次不会挨个补跑：到点执行一次，再从「现在」算下一次。

export interface AutomationInput {
  name: string;
  prompt: string;
  kind: AutomationKind;
  rrule: string;
  agentId?: string | null;
  workspaceId?: string | null;
  model?: string | null;
  permissionMode?: PermissionMode;
  targetTaskId?: string | null;
}

const TICK_MS = 30_000;
const BUSY_STATUSES: TaskStatus[] = ["running", "needs_approval"];
/** 这些状态说明这一轮已经有结果（或卡在等你批准），值得提醒你去看。 */
const ATTENTION_STATUSES: TaskStatus[] = ["review", "done", "failed", "stopped", "needs_approval"];
const PERMISSION_MODES: PermissionMode[] = ["supervised", "auto", "full"];

const now = () => new Date().toISOString();

function publishChanged(automationId: string) {
  bus.emit("dashboard", { kind: "automation_changed", automationId });
}

function rowToRun(row: any): AutomationRun {
  const task = row.task_id ? taskManager.getTask(row.task_id) : null;
  const taskStatus = task?.status ?? null;
  const settled = row.status === "skipped" || row.status === "failed" || (taskStatus !== null && ATTENTION_STATUSES.includes(taskStatus));
  return {
    id: row.id,
    automationId: row.automation_id,
    taskId: row.task_id ?? null,
    trigger: row.trigger,
    status: row.status,
    message: row.message ?? "",
    readAt: row.read_at ?? null,
    createdAt: row.created_at,
    taskStatus,
    taskTitle: task?.title ?? null,
    unread: !row.read_at && settled,
  };
}

function rowToAutomation(row: any): Automation {
  const runs = (db.prepare("SELECT * FROM automation_runs WHERE automation_id = ? AND read_at IS NULL").all(row.id) as any[]).map(rowToRun);
  const last = db.prepare("SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(row.id);
  let scheduleText = row.rrule;
  try {
    scheduleText = describeRrule(row.rrule);
  } catch {
    // 规则写坏了就原样显示
  }
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    kind: row.kind,
    status: row.status,
    rrule: row.rrule,
    scheduleText,
    agentId: row.agent_id ?? null,
    workspaceId: row.workspace_id ?? null,
    model: row.model ?? null,
    permissionMode: row.permission_mode,
    targetTaskId: row.target_task_id ?? null,
    nextRunAt: row.next_run_at ?? null,
    lastRunAt: row.last_run_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    unreadCount: runs.filter((run) => run.unread).length,
    lastRun: last ? rowToRun(last) : null,
  };
}

export function listAutomations(): Automation[] {
  return (db.prepare("SELECT * FROM automations ORDER BY created_at DESC").all() as any[]).map(rowToAutomation);
}

export function getAutomation(id: string): Automation | null {
  const row = db.prepare("SELECT * FROM automations WHERE id = ?").get(id);
  return row ? rowToAutomation(row) : null;
}

/** 检查并整理输入：每种类型需要的字段齐不齐、指向的 Agent / 工作区 / 任务在不在。 */
function normalize(input: AutomationInput) {
  const name = input.name?.trim();
  if (!name) throw new Error("请填写名字");
  const prompt = input.prompt?.trim();
  if (!prompt) throw new Error("请填写每次要做的事（提示词）");
  if (input.kind !== "cron" && input.kind !== "heartbeat") throw new Error("类型只能是「每次新建任务」或「在已有任务里继续」");
  const rrule = input.rrule?.trim();
  if (!rrule) throw new Error("请设置运行时间");
  parseRrule(rrule); // 写错了直接报出来
  const permissionMode = input.permissionMode ?? "supervised";
  if (!PERMISSION_MODES.includes(permissionMode)) throw new Error(`未知权限等级：${permissionMode}`);

  if (input.kind === "heartbeat") {
    const targetTaskId = input.targetTaskId?.trim();
    if (!targetTaskId || !taskManager.getTask(targetTaskId)) throw new Error("请选择要继续的任务");
    return { name: name.slice(0, 80), prompt, kind: input.kind, rrule, agentId: null, workspaceId: null, model: null, permissionMode, targetTaskId };
  }
  const agentId = input.agentId?.trim();
  if (!agentId || !getAdapter(agentId)) throw new Error("请选择 Agent 或角色");
  const workspaceId = input.workspaceId?.trim();
  if (!workspaceId || !getWorkspace(workspaceId)) throw new Error("请选择工作区");
  return {
    name: name.slice(0, 80),
    prompt,
    kind: input.kind,
    rrule,
    agentId,
    workspaceId,
    model: input.model?.trim() || null,
    permissionMode,
    targetTaskId: null,
  };
}

export function createAutomation(input: AutomationInput, actor = "admin"): Automation {
  const value = normalize(input);
  const id = nanoid(10);
  const stamp = now();
  db.prepare(
    `INSERT INTO automations (id, name, prompt, kind, status, rrule, agent_id, workspace_id, model, permission_mode, target_task_id, next_run_at, last_run_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
  ).run(
    id,
    value.name,
    value.prompt,
    value.kind,
    value.rrule,
    value.agentId,
    value.workspaceId,
    value.model,
    value.permissionMode,
    value.targetTaskId,
    nextRunAfter(value.rrule, new Date()).toISOString(),
    stamp,
    stamp
  );
  recordAudit({ actor, agentId: value.agentId, taskId: value.targetTaskId, action: "create_automation", detail: { id, ...value } });
  publishChanged(id);
  return getAutomation(id)!;
}

export function updateAutomation(id: string, input: AutomationInput, actor = "admin"): Automation {
  const current = getAutomation(id);
  if (!current) throw new Error("找不到这个定时任务");
  const value = normalize(input);
  // 时间规则改了（或者原来没算过）才重新算下一次；暂停中的保持不排期。
  const nextRunAt =
    current.status === "PAUSED" ? null : value.rrule !== current.rrule || !current.nextRunAt ? nextRunAfter(value.rrule, new Date()).toISOString() : current.nextRunAt;
  db.prepare(
    `UPDATE automations SET name = ?, prompt = ?, kind = ?, rrule = ?, agent_id = ?, workspace_id = ?, model = ?, permission_mode = ?, target_task_id = ?,
       next_run_at = ?, updated_at = ? WHERE id = ?`
  ).run(value.name, value.prompt, value.kind, value.rrule, value.agentId, value.workspaceId, value.model, value.permissionMode, value.targetTaskId, nextRunAt, now(), id);
  recordAudit({ actor, agentId: value.agentId, taskId: value.targetTaskId, action: "update_automation", detail: { id, ...value } });
  publishChanged(id);
  return getAutomation(id)!;
}

export function setAutomationStatus(id: string, status: AutomationStatus, actor = "admin"): Automation {
  const current = getAutomation(id);
  if (!current) throw new Error("找不到这个定时任务");
  if (status !== "ACTIVE" && status !== "PAUSED") throw new Error(`未知状态：${status}`);
  const nextRunAt = status === "ACTIVE" ? nextRunAfter(current.rrule, new Date()).toISOString() : null;
  db.prepare("UPDATE automations SET status = ?, next_run_at = ?, updated_at = ? WHERE id = ?").run(status, nextRunAt, now(), id);
  recordAudit({ actor, agentId: current.agentId, taskId: current.targetTaskId, action: status === "ACTIVE" ? "resume_automation" : "pause_automation", detail: { id } });
  publishChanged(id);
  return getAutomation(id)!;
}

/** 删除定时任务和它的运行记录；它建出来的任务留着。 */
export function deleteAutomation(id: string, actor = "admin"): void {
  const current = getAutomation(id);
  if (!current) throw new Error("找不到这个定时任务");
  db.prepare("DELETE FROM automation_runs WHERE automation_id = ?").run(id);
  db.prepare("DELETE FROM automations WHERE id = ?").run(id);
  recordAudit({ actor, agentId: current.agentId, taskId: current.targetTaskId, action: "delete_automation", detail: { id, name: current.name } });
  publishChanged(id);
}

export function listAutomationRuns(automationId: string, limit = 50): AutomationRun[] {
  return (
    db.prepare("SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(automationId, limit) as any[]
  ).map(rowToRun);
}

export function markAutomationRunsRead(automationId: string, runId?: string): void {
  const stamp = now();
  if (runId) db.prepare("UPDATE automation_runs SET read_at = ? WHERE id = ? AND automation_id = ? AND read_at IS NULL").run(stamp, runId, automationId);
  else db.prepare("UPDATE automation_runs SET read_at = ? WHERE automation_id = ? AND read_at IS NULL").run(stamp, automationId);
  publishChanged(automationId);
}

/** 左侧「定时」图标上的数字：所有定时任务里跑完了还没看的次数。 */
export function automationUnreadCount(): number {
  return listAutomations().reduce((sum, automation) => sum + automation.unreadCount, 0);
}

function recordRun(automationId: string, trigger: AutomationRun["trigger"], status: AutomationRunStatus, taskId: string | null, message: string): AutomationRun {
  const id = nanoid(12);
  db.prepare("INSERT INTO automation_runs (id, automation_id, task_id, trigger, status, message, read_at, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)").run(
    id,
    automationId,
    taskId,
    trigger,
    status,
    message,
    now()
  );
  return rowToRun(db.prepare("SELECT * FROM automation_runs WHERE id = ?").get(id));
}

const pad = (value: number) => String(value).padStart(2, "0");
function runTitle(name: string, at: Date): string {
  return `${name} · ${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** 执行一次（到点或手动）：建任务 / 发消息，记一条运行记录。不抛错，失败也记下来。 */
export function runAutomation(id: string, trigger: AutomationRun["trigger"], at = new Date()): AutomationRun {
  const automation = getAutomation(id);
  if (!automation) throw new Error("找不到这个定时任务");
  const actor = trigger === "manual" ? "admin" : "automation";
  let run: AutomationRun;
  try {
    if (automation.kind === "heartbeat") {
      const task = automation.targetTaskId ? taskManager.getTask(automation.targetTaskId) : null;
      if (!task) {
        // 要继续的任务被删了：以后到点也没法跑，直接暂停，免得一直记失败。
        run = recordRun(id, trigger, "failed", null, "要继续的任务已经不存在，已自动暂停这个定时任务");
        db.prepare("UPDATE automations SET status = 'PAUSED', next_run_at = NULL WHERE id = ?").run(id);
      } else if (BUSY_STATUSES.includes(task.status)) {
        taskManager.enqueueMessage(task.id, automation.prompt, [], actor);
        run = recordRun(id, trigger, "queued", task.id, "任务正在进行，已排进它的消息队列，空闲后自动发送");
      } else {
        taskManager.sendMessage(task.id, automation.prompt, [], actor);
        run = recordRun(id, trigger, "started", task.id, "");
      }
    } else {
      const previous = automation.lastRun?.taskId ? taskManager.getTask(automation.lastRun.taskId) : null;
      if (previous && BUSY_STATUSES.includes(previous.status)) {
        run = recordRun(id, trigger, "skipped", previous.id, "上一次建的任务还没结束，这次跳过");
      } else {
        const task = taskManager.createTask({
          agentId: automation.agentId!,
          workspaceId: automation.workspaceId!,
          title: runTitle(automation.name, at),
          prompt: automation.prompt,
          model: automation.model ?? undefined,
          permissionMode: automation.permissionMode,
          actor,
        });
        run = recordRun(id, trigger, "started", task.id, "");
      }
    }
  } catch (err) {
    run = recordRun(id, trigger, "failed", null, (err as Error).message);
  }
  db.prepare("UPDATE automations SET last_run_at = ? WHERE id = ?").run(at.toISOString(), id);
  recordAudit({ actor, agentId: automation.agentId, taskId: run.taskId, action: "run_automation", detail: { id, trigger, status: run.status, message: run.message } });
  publishChanged(id);
  return run;
}

/** 到点检查：把 next_run_at 已到的启用中定时任务各执行一次，再从现在算下一次。 */
export function runDueAutomations(at = new Date()): AutomationRun[] {
  const due = db
    .prepare("SELECT id, rrule FROM automations WHERE status = 'ACTIVE' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at")
    .all(at.toISOString()) as { id: string; rrule: string }[];
  const runs: AutomationRun[] = [];
  for (const item of due) {
    let next: string | null = null;
    try {
      next = nextRunAfter(item.rrule, at).toISOString();
    } catch {
      // 规则坏了：不再排期，免得每 30 秒触发一次
    }
    // 先把下一次写进去再执行，就算执行过程中出了意外也不会在下一轮检查里重复触发。
    db.prepare("UPDATE automations SET next_run_at = ? WHERE id = ?").run(next, item.id);
    runs.push(runAutomation(item.id, "schedule", at));
  }
  return runs;
}

/** 关联任务状态变了也要通知页面刷新未读数（任务跑完 → 这次运行变成「未读」）。 */
function watchRunTasks() {
  bus.on("dashboard", (event: { kind?: string; taskId?: string }) => {
    if (event?.kind !== "task_status" || !event.taskId) return;
    const row = db.prepare("SELECT automation_id FROM automation_runs WHERE task_id = ? AND read_at IS NULL LIMIT 1").get(event.taskId) as
      | { automation_id: string }
      | undefined;
    if (row) publishChanged(row.automation_id);
  });
}

export function startAutomationScheduler(log: (message: string) => void): () => void {
  watchRunTasks();
  const tick = () => {
    try {
      for (const run of runDueAutomations()) {
        const name = getAutomation(run.automationId)?.name ?? run.automationId;
        log(`「${name}」到点运行：${run.status}${run.message ? `（${run.message}）` : ""}`);
      }
    } catch (err) {
      log(`定时检查出错：${(err as Error).message}`);
    }
  };
  const first = setTimeout(tick, 5_000);
  const timer = setInterval(tick, TICK_MS);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
