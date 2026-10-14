import type { TaskEvent } from "../../api/types";

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("zh-CN", { hour12: false });
}

const STATUS_LABEL: Record<string, string> = {
  running: "运行中",
  needs_approval: "待审批",
  review: "待复核",
  done: "已完成",
  failed: "失败",
  stopped: "已停止",
};

const APPROVAL_STATUS_LABEL: Record<string, string> = {
  approved: "已批准",
  denied: "已拒绝",
  always_allowed: "总是允许",
};

const ROLE_LABEL: Record<string, string> = { user: "你", agent: "Agent", system: "系统" };
const FILE_ACTION_LABEL: Record<string, string> = { created: "新建", deleted: "删除", modified: "修改" };

function describe(e: TaskEvent): string {
  switch (e.type) {
    case "log":
      return e.payload?.message ?? "";
    case "status":
      return `状态变更 -> ${STATUS_LABEL[e.payload?.status] ?? e.payload?.status}`;
    case "file":
      return `文件${FILE_ACTION_LABEL[e.payload?.action] ?? e.payload?.action}: ${e.payload?.path}`;
    case "approval_requested":
      return `发起审批请求: ${e.payload?.command}`;
    case "approval_resolved":
      return `审批已处理（${APPROVAL_STATUS_LABEL[e.payload?.status] ?? e.payload?.status}）: ${e.payload?.command}`;
    case "message":
      return `[${ROLE_LABEL[e.payload?.role] ?? e.payload?.role}] ${String(e.payload?.content ?? "").slice(0, 120)}`;
    default:
      return JSON.stringify(e.payload);
  }
}

export function EventsTab({ events }: { events: TaskEvent[] }) {
  const visible = events.filter((e) => e.type !== "terminal");
  return (
    <div>
      {visible.length === 0 && <div className="empty-state">暂无事件</div>}
      {visible.map((e) => (
        <div key={e.id || `${e.type}-${e.createdAt}-${Math.random()}`} className="log-line">
          <span className="ts">{fmtTime(e.createdAt)}</span>
          {describe(e)}
        </div>
      ))}
    </div>
  );
}
