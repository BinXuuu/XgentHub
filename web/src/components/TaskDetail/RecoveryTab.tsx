import type { TaskRecoveryAction, TaskRun } from "../../api/types";

const KIND_LABEL: Record<string, string> = {
  retry: "重试",
  human_handoff: "转人工",
};

const STATUS_LABEL: Record<string, string> = {
  open: "待处理",
  dispatched: "已派发",
  resolved: "已解决",
};

function fmtTime(iso: string | null): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}

export function RecoveryTab({ actions, runs }: { actions: TaskRecoveryAction[]; runs: TaskRun[] }) {
  if (actions.length === 0) return <div className="empty-state">暂无恢复动作</div>;
  const runsById = new Map(runs.map((run) => [run.id, run]));
  return (
    <div className="recovery-list">
      {actions.map((action) => {
        const run = action.runId ? runsById.get(action.runId) : undefined;
        return (
          <article className={`recovery-card recovery-${action.kind}`} key={action.id}>
            <div className="recovery-card-head">
              <span>{KIND_LABEL[action.kind] ?? action.kind}</span>
              <strong>{STATUS_LABEL[action.status] ?? action.status}</strong>
              <time>{fmtTime(action.createdAt)}</time>
            </div>
            <p>{action.note || "无补充说明"}</p>
            <div className="recovery-card-meta">
              <span>{run ? `关联 run ${run.attempt}` : "未关联运行"}</span>
              {action.resolvedAt && <span>解决于 {fmtTime(action.resolvedAt)}</span>}
            </div>
          </article>
        );
      })}
    </div>
  );
}
