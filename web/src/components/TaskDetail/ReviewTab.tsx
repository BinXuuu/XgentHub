import type { TaskReviewDecision, TaskRun } from "../../api/types";

const DECISION_LABEL: Record<string, string> = {
  approved: "验收通过",
  changes_requested: "要求修改",
};

function fmtTime(iso: string | null): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}

export function ReviewTab({ decisions, runs }: { decisions: TaskReviewDecision[]; runs: TaskRun[] }) {
  if (decisions.length === 0) return <div className="empty-state">暂无验收记录</div>;
  const runsById = new Map(runs.map((run) => [run.id, run]));
  return (
    <div className="review-list">
      {decisions.map((decision) => {
        const run = decision.runId ? runsById.get(decision.runId) : undefined;
        return (
          <article className={`review-card review-${decision.decision}`} key={decision.id}>
            <div className="review-card-head">
              <span>{DECISION_LABEL[decision.decision] ?? decision.decision}</span>
              <time>{fmtTime(decision.createdAt)}</time>
            </div>
            <p>{decision.note || "无补充说明"}</p>
            <div className="review-card-meta">
              <span>{run ? `关联 run ${run.attempt}` : "未关联运行"}</span>
            </div>
          </article>
        );
      })}
    </div>
  );
}
