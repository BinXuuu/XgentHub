import type { Artifact, CoreStatus, DomainEvent, RunCheckpoint, TaskFlowSnapshot, TaskRecoveryAction, TaskRun } from "../../api/types";

// 这些字典/小展示组件原来都在 FlowTab.tsx 里，现在图谱节点（FlowNodes.tsx）和详情面板
// （FlowTab.tsx）都要用，抽到这个不依赖任何一边的公共模块，避免两个文件互相 import。

export const STATUS_LABEL: Record<CoreStatus, string> = {
  queued: "排队",
  waiting: "等待",
  running: "运行中",
  needs_approval: "待审批",
  review: "待复核",
  done: "已完成",
  failed: "失败",
  stopped: "已停止",
  cancelled: "已取消",
  timed_out: "超时",
};

export const SOURCE_LABEL: Record<string, string> = {
  create_task: "创建任务",
  user_message: "用户追加",
  queue: "队列",
  retry: "重试",
  agent_handoff: "转交",
  subtask_dispatch: "子任务派发",
};

export const EVENT_LABEL: Record<string, string> = {
  "task.created": "任务创建",
  "task.status.changed": "任务状态",
  "task.message.created": "消息",
  "task.log.created": "日志",
  "task.terminal.chunk": "终端",
  "task.file.changed": "文件",
  "task.diff.created": "Diff",
  "approval.requested": "审批请求",
  "approval.resolved": "审批处理",
  "queue.updated": "队列更新",
  "run.started": "运行开始",
  "run.status.changed": "运行状态",
  "run.finished": "运行结束",
  "run.stopped": "运行停止",
  "run.timed_out": "运行超时",
  "agent.handoff.dispatched": "Agent 转交",
  "subtask.ready": "子任务就绪",
  "subtask.dispatched": "子任务派发",
  "recovery.action.created": "恢复动作",
  "review.decision.created": "验收决策",
  "subtask.plan.created": "子任务计划",
};

export const ARTIFACT_LABEL: Record<string, string> = {
  file: "文件",
  diff: "Diff",
  log: "日志",
  report: "报告",
  image: "图片",
  other: "其他",
};

export const RECOVERY_KIND_LABEL: Record<string, string> = {
  retry: "重试",
  human_handoff: "转人工",
};

export const REVIEW_DECISION_LABEL: Record<string, string> = {
  approved: "验收通过",
  changes_requested: "要求修改",
};

export function fmtTime(iso: string | null): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleTimeString("zh-CN", { hour12: false });
}

export function clip(text: string | null | undefined, length = 120): string {
  if (!text) return "";
  return text.length > length ? `${text.slice(0, length - 1)}...` : text;
}

/** 12345 → 12.3k，1234567 → 1.23M。 */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

/** 几次运行加起来用了多少 token；一次都没报用量就是 null（显示「—」而不是 0，免得误以为没花）。 */
export function sumRunTokens(runs: TaskRun[]): number | null {
  const reported = runs.filter((run) => run.usage);
  return reported.length ? reported.reduce((sum, run) => sum + (run.usage?.totalTokens ?? 0), 0) : null;
}

export function shortId(id: string): string {
  return id.includes(":") ? id.split(":").pop()!.slice(0, 8) : id.slice(0, 8);
}

export function duration(run: TaskRun): string {
  if (!run.finishedAt) return "进行中";
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function StatusPill({ status }: { status: CoreStatus }) {
  return <span className={`flow-status flow-status-${status}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export function CheckpointList({ checkpoints }: { checkpoints: RunCheckpoint[] }) {
  if (checkpoints.length === 0) return <span className="flow-muted">无 checkpoint</span>;
  return (
    <div className="flow-checkpoints">
      {checkpoints.slice(-4).map((checkpoint) => (
        <span key={checkpoint.id} className="flow-checkpoint">
          {checkpoint.sequence}. {checkpoint.label}
        </span>
      ))}
    </div>
  );
}

export function ArtifactRow({ artifact, run }: { artifact: Artifact; run?: TaskRun }) {
  return (
    <div className="flow-artifact">
      <span className="flow-artifact-kind">{ARTIFACT_LABEL[artifact.kind] ?? artifact.kind}</span>
      <span className="flow-artifact-name" title={artifact.path ?? artifact.name}>
        {artifact.path ?? artifact.name}
      </span>
      <span className="flow-muted">{run ? `run ${run.attempt}` : "task"}</span>
    </div>
  );
}

export function DomainEventRow({ event }: { event: DomainEvent }) {
  return (
    <div className="flow-event-row">
      <span className="flow-event-time">{fmtTime(event.createdAt)}</span>
      <span className="flow-event-name">{EVENT_LABEL[event.name] ?? event.name}</span>
      <span className="flow-muted">{event.runId ? shortId(event.runId) : "task"}</span>
    </div>
  );
}

export function RecoveryRow({ action, run }: { action: TaskRecoveryAction; run?: TaskRun }) {
  return (
    <div className="flow-recovery-row">
      <span className={`flow-recovery-kind flow-recovery-${action.kind}`}>{RECOVERY_KIND_LABEL[action.kind] ?? action.kind}</span>
      <span className="flow-event-name" title={action.note ?? ""}>
        {action.note || "无补充说明"}
      </span>
      <span className="flow-muted">{run ? `run ${run.attempt}` : "task"}</span>
    </div>
  );
}

export function ReviewDecisionRow({ decision, run }: { decision: TaskFlowSnapshot["reviewDecisions"][number]; run?: TaskRun }) {
  return (
    <div className="flow-recovery-row">
      <span className={`flow-review-kind flow-review-${decision.decision}`}>
        {REVIEW_DECISION_LABEL[decision.decision] ?? decision.decision}
      </span>
      <span className="flow-event-name" title={decision.note ?? ""}>
        {decision.note || "无补充说明"}
      </span>
      <span className="flow-muted">{run ? `run ${run.attempt}` : "task"}</span>
    </div>
  );
}
