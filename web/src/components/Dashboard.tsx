import type { AgentDescriptor, Task, TaskStatus, Workspace } from "../api/types";
import { StatusBadge } from "./StatusBadge";
import type { Filter } from "./TaskList";

interface Props {
  tasks: Task[];
  workspaces: Workspace[];
  agents: AgentDescriptor[];
  onSelectTask: (id: string) => void;
  onSelectAgent: (id: string) => void;
  onSelectWorkspace: (id: string) => void;
  onOpenTasks: (filter?: Filter) => void;
  onNewTask: () => void;
  onOpenSettings: () => void;
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  running: "运行中",
  needs_approval: "待审批",
  review: "待复核",
  done: "已完成",
  failed: "失败",
  stopped: "已停止",
};

const AGENT_KIND_COLORS: Record<string, string> = {
  mock: "#6b7280",
  openclaw: "#f59e0b",
  codex: "#4f8cff",
  "claude-code": "#a78bfa",
  antigravity: "#f43f5e",
  "ark-cli": "#0ea5e9",
  hermes: "#22c55e",
  ollama: "#14b8a6",
  tokenezgo: "#f97316",
  doubao: "#ef4444",
  "custom-api": "#38bdf8",
  "custom-cli": "#eab308",
};

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return `${s}s 前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m 前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h 前`;
  return `${Math.floor(h / 24)}d 前`;
}

function workspaceName(workspaces: Workspace[], id: string): string {
  return workspaces.find((w) => w.id === id)?.name ?? "未知工作区";
}

function TaskTriageCard({
  task,
  workspaces,
  onSelect,
}: {
  task: Task;
  workspaces: Workspace[];
  onSelect: () => void;
}) {
  const isApproval = task.status === "needs_approval";
  const isReview = task.status === "review";
  return (
    <button
      className={`triage-card ${isApproval ? "needs-approval" : isReview ? "review" : ""}`}
      onClick={onSelect}
      type="button"
    >
      <span
        className={`triage-status-dot ${task.status === "needs_approval" ? "needs-approval" : task.status === "review" ? "review" : task.status}`}
      />
      <div className="triage-info">
        <div className="triage-title">{task.title}</div>
        <div className="triage-meta">
          {task.agentKind} · {workspaceName(workspaces, task.workspaceId)} · {timeAgo(task.updatedAt)}
        </div>
      </div>
      <div className="triage-action">
        <StatusBadge status={task.status} />
      </div>
    </button>
  );
}

export function Dashboard({
  tasks,
  workspaces,
  agents,
  onSelectTask,
  onSelectAgent,
  onSelectWorkspace,
  onOpenTasks,
  onNewTask,
  onOpenSettings,
}: Props) {
  const running = tasks.filter((t) => t.status === "running");
  const needsApproval = tasks.filter((t) => t.status === "needs_approval");
  const review = tasks.filter((t) => t.status === "review");
  const failed = tasks.filter((t) => t.status === "failed" || t.status === "stopped");
  const done = tasks.filter((t) => t.status === "done");

  // 待处理 = 待审批 + 待复核
  const actionRequired = [...needsApproval, ...review];

  // 最近任务：按 updatedAt 倒序，取前 15 条
  const recent = [...tasks].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, 15);

  const hasAnyTasks = tasks.length > 0;

  return (
    <div className="dashboard">
      <section className="dashboard-hero">
        <div>
          <span className="dashboard-kicker">本机 Agent 控制台</span>
          <h1>今天的任务状态</h1>
          <p>集中查看正在运行、等待处理和最近完成的任务。</p>
        </div>
        <div className="dashboard-hero-actions">
          <button className="btn btn-primary" onClick={onNewTask}>
            + 新建任务
          </button>
          <button className="btn" onClick={onOpenSettings}>
            配置中心
          </button>
        </div>
      </section>

      {/* 统计卡片行 */}
      <section>
        <div className="stat-cards">
          <button className="stat-card running" onClick={() => onOpenTasks("running")} type="button">
            <span className="stat-card-label">运行中</span>
            <span className="stat-card-value">{running.length}</span>
          </button>
          <button className="stat-card approval" onClick={() => onOpenTasks("needs_approval")} type="button">
            <span className="stat-card-label">待审批</span>
            <span className="stat-card-value">{needsApproval.length}</span>
          </button>
          <button className="stat-card review" onClick={() => onOpenTasks("review")} type="button">
            <span className="stat-card-label">待复核</span>
            <span className="stat-card-value">{review.length}</span>
          </button>
          <button className="stat-card failed" onClick={() => onOpenTasks("failed")} type="button">
            <span className="stat-card-label">失败/停止</span>
            <span className="stat-card-value">{failed.length}</span>
          </button>
          <button className="stat-card" onClick={() => onOpenTasks("done")} type="button">
            <span className="stat-card-label">已完成</span>
            <span className="stat-card-value">{done.length}</span>
          </button>
        </div>
      </section>

      {/* 需要你操作的任务 */}
      {actionRequired.length > 0 && (
        <section>
          <div className="section-title">
            <span className="section-dot section-dot-warn" />
            需要你操作
            <span className="section-count">{actionRequired.length}</span>
          </div>
          <div className="triage-list">
            {actionRequired.map((task) => (
              <TaskTriageCard
                key={task.id}
                task={task}
                workspaces={workspaces}
                onSelect={() => onSelectTask(task.id)}
              />
            ))}
          </div>
        </section>
      )}

      {/* 运行中 */}
      {running.length > 0 && (
        <section>
          <div className="section-title">
            <span className="section-dot section-dot-running" />
            运行中
            <span className="section-count">{running.length}</span>
          </div>
          <div className="triage-list">
            {running.map((task) => (
              <TaskTriageCard
                key={task.id}
                task={task}
                workspaces={workspaces}
                onSelect={() => onSelectTask(task.id)}
              />
            ))}
          </div>
        </section>
      )}

      {/* 失败/需要重试 */}
      {failed.length > 0 && (
        <section>
          <div className="section-title">
            <span className="section-dot section-dot-failed" />
            失败 / 已停止
            <span className="section-count">{failed.length}</span>
          </div>
          <div className="triage-list">
            {failed.slice(0, 5).map((task) => (
              <TaskTriageCard
                key={task.id}
                task={task}
                workspaces={workspaces}
                onSelect={() => onSelectTask(task.id)}
              />
            ))}
          </div>
        </section>
      )}

      {/* 最近任务 */}
      <section className="dashboard-main-grid">
        <div>
        <div className="section-title">
          最近任务
          <span className="section-count">{tasks.length}</span>
        </div>
        {!hasAnyTasks ? (
          <div className="dashboard-empty">
            <div className="dashboard-empty-icon">◈</div>
            <strong>还没有任何任务</strong>
            <span>点击右上角「+ 新建任务」开始第一个任务</span>
            <div className="dashboard-empty-actions">
              <button className="btn btn-primary" onClick={onNewTask}>
                + 新建任务
              </button>
              <button className="btn" onClick={onOpenSettings}>
                配置中心
              </button>
            </div>
          </div>
        ) : (
          <div className="recent-tasks">
            {recent.map((task) => (
              <button
                key={task.id}
                className="recent-task-row"
                onClick={() => onSelectTask(task.id)}
                type="button"
              >
                <span
                  className="task-agent-dot"
                  style={{ background: AGENT_KIND_COLORS[task.agentKind] ?? "#6b7280" }}
                />
                <div className="recent-task-info">
                  <span className="recent-task-title">{task.title}</span>
                  <span className="recent-task-meta">
                    {task.agentKind} · {workspaceName(workspaces, task.workspaceId)}
                  </span>
                </div>
                <StatusBadge status={task.status} />
                <span className="recent-task-time">{timeAgo(task.updatedAt)}</span>
              </button>
            ))}
          </div>
        )}
        </div>

        <aside className="dashboard-side-panel">
          <div className="section-title">快速入口</div>
          <div className="quick-grid">
            <button className="quick-card" onClick={() => onOpenTasks("all")} type="button">
              <strong>任务列表</strong>
              <span>{tasks.length} 个任务</span>
            </button>
            <button className="quick-card" onClick={onOpenSettings} type="button">
              <strong>配置中心</strong>
              <span>检查运行环境</span>
            </button>
          </div>

          <div className="section-title compact">Agent</div>
          <div className="quick-list">
            {agents.slice(0, 8).map((agent) => (
              <button key={agent.id} className="quick-row" onClick={() => onSelectAgent(agent.id)} type="button">
                <span className="task-agent-dot" style={{ background: AGENT_KIND_COLORS[agent.kind] ?? "#6b7280" }} />
                <span>{agent.name}</span>
                <small>{agent.configured ? "可用" : "未配置"}</small>
              </button>
            ))}
          </div>

          <div className="section-title compact">工作区</div>
          <div className="quick-list">
            {workspaces.slice(0, 6).map((workspace) => (
              <button key={workspace.id} className="quick-row" onClick={() => onSelectWorkspace(workspace.id)} type="button">
                <span className="task-agent-dot" />
                <span>{workspace.name}</span>
                <small>{workspace.allowedAgentKinds.length ? `${workspace.allowedAgentKinds.length} 类` : "全部"}</small>
              </button>
            ))}
          </div>
        </aside>
      </section>
    </div>
  );
}
