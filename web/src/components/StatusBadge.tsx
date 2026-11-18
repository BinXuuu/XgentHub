import type { TaskStatus } from "../api/types";

const LABELS: Record<TaskStatus, string> = {
  running: "运行中",
  needs_approval: "待审批",
  review: "待复核",
  done: "已完成",
  failed: "失败",
  stopped: "已停止",
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span className={`status-badge status-${status}`}>
      <span className="status-dot" />
      {LABELS[status]}
    </span>
  );
}

export function RiskBadge({ level }: { level: "low" | "medium" | "high" }) {
  const label = level === "high" ? "高风险" : level === "medium" ? "中风险" : "低风险";
  return <span className={`risk-badge risk-${level}`}>{label}</span>;
}
