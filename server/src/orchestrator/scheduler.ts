import type { CoreStatus, Subtask, TaskRun } from "../types.ts";

const TERMINAL_STATUSES = new Set<CoreStatus>(["review", "done", "failed", "stopped", "cancelled", "timed_out"]);
const SUCCESS_STATUSES = new Set<CoreStatus>(["review", "done"]);
const RETRYABLE_STATUSES = new Set<CoreStatus>(["failed", "timed_out"]);
const RUNNABLE_STATUSES = new Set<CoreStatus>(["queued", "waiting"]);

export interface RetryPolicy {
  maxAttempts: number;
  retryStatuses?: CoreStatus[];
}

export function isTerminalStatus(status: CoreStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function isSuccessfulStatus(status: CoreStatus): boolean {
  return SUCCESS_STATUSES.has(status);
}

export function shouldAdvanceQueue(status: CoreStatus): boolean {
  return isSuccessfulStatus(status);
}

export function canRetryRun(run: TaskRun, policy: RetryPolicy): boolean {
  const retryStatuses = new Set(policy.retryStatuses ?? RETRYABLE_STATUSES);
  return retryStatuses.has(run.status) && run.attempt < policy.maxAttempts;
}

export function isRunTimedOut(run: TaskRun, timeoutMs: number, referenceDate = new Date()): boolean {
  if (timeoutMs <= 0) return false;
  if (isTerminalStatus(run.status)) return false;
  return referenceDate.getTime() - new Date(run.startedAt).getTime() >= timeoutMs;
}

export function dependenciesSatisfied(subtask: Subtask, allSubtasks: Subtask[]): boolean {
  if (subtask.dependencyIds.length === 0) return true;
  const byId = new Map(allSubtasks.map((item) => [item.id, item]));
  return subtask.dependencyIds.every((id) => {
    const dependency = byId.get(id);
    return dependency ? isSuccessfulStatus(dependency.status) : false;
  });
}

export function listRunnableSubtasks(subtasks: Subtask[]): Subtask[] {
  return subtasks.filter((subtask) => RUNNABLE_STATUSES.has(subtask.status) && dependenciesSatisfied(subtask, subtasks));
}
