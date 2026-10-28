import { useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import { copyText } from "../utils/clipboard";
import type { Task, TaskStatus, Workspace } from "../api/types";
import { StatusBadge } from "./StatusBadge";
import { useRowMenu } from "./useRowMenu";
import { confirmDialog } from "../utils/dialog";

type Filter = "all" | "running" | "needs_approval" | "review" | "done" | "failed";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "running", label: "运行中" },
  { key: "needs_approval", label: "待审批" },
  { key: "review", label: "待复核" },
  { key: "done", label: "已完成" },
  { key: "failed", label: "失败" },
];

function matchesFilter(status: TaskStatus, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "failed") return status === "failed" || status === "stopped";
  return status === filter;
}

type DateSection = "today" | "yesterday" | "earlier";

const DATE_SECTION_LABELS: Record<DateSection, string> = {
  today: "今天",
  yesterday: "昨天",
  earlier: "更早",
};

const AGENT_LABELS: Partial<Record<Task["agentKind"], string>> = {
  "claude-code": "Claude Code",
  codebuddy: "WorkBuddy",
  codex: "Codex",
  antigravity: "Antigravity",
  openclaw: "OpenClaw",
  "ark-cli": "Ark CLI",
  hermes: "Hermes",
  ollama: "Ollama",
  tokenezgo: "Tokenezgo",
  doubao: "Doubao",
  mock: "Mock",
  "custom-api": "Custom API",
  "custom-cli": "Custom CLI",
};

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatClock(date: Date): string {
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${hour}:${minute}`;
}

function getDateSection(iso: string): DateSection {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  if (Number.isNaN(date.getTime())) return "earlier";
  if (isSameDay(date, today)) return "today";
  if (isSameDay(date, yesterday)) return "yesterday";
  return "earlier";
}

function formatTaskTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";

  const section = getDateSection(iso);
  if (section === "today") return formatClock(date);
  if (section === "yesterday") return `昨天 ${formatClock(date)}`;
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function formatAgent(kind: Task["agentKind"]): string {
  return AGENT_LABELS[kind] ?? kind;
}

interface Props {
  tasks: Task[];
  workspaces: Workspace[];
  filter: Filter;
  onFilterChange: (f: Filter) => void;
  selectedTaskId: string | null;
  onSelect: (id: string) => void;
  onNewTask: () => void;
  onTaskChanged: () => void;
  onDeleted: (id: string) => void;
}

export function TaskList({ tasks, workspaces, filter, onFilterChange, selectedTaskId, onSelect, onNewTask, onTaskChanged, onDeleted }: Props) {
  const [keyword, setKeyword] = useState("");
  const [workspaceFilter, setWorkspaceFilter] = useState("all");
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const { openMenuId, menuStyle, toggleMenu, closeMenu } = useRowMenu();
  const [rowMessage, setRowMessage] = useState<{ id: string; text: string } | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const skipBlurSaveRef = useRef(false);
  const busyTaskRef = useRef<string | null>(null);
  const workspaceName = (id: string) => workspaces.find((w) => w.id === id)?.name ?? "未知工作区";
  const normalizedKeyword = keyword.trim().toLocaleLowerCase();
  const baseFiltered = useMemo(() => {
    return tasks.filter((task) => {
      const workspace = workspaceName(task.workspaceId);
      const matchesWorkspace = workspaceFilter === "all" || task.workspaceId === workspaceFilter;
      const searchText = [task.title, task.prompt, task.agentKind, task.agentId, workspace]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase();
      return matchesWorkspace && (!normalizedKeyword || searchText.includes(normalizedKeyword));
    });
  }, [normalizedKeyword, tasks, workspaceFilter, workspaces]);
  const counts: Record<Filter, number> = {
    all: baseFiltered.length,
    running: 0,
    needs_approval: 0,
    review: 0,
    done: 0,
    failed: 0,
  };
  for (const t of baseFiltered) {
    if (t.status === "failed" || t.status === "stopped") counts.failed++;
    else if (t.status in counts) (counts as any)[t.status]++;
  }

  const filtered = baseFiltered.filter((t) => matchesFilter(t.status, filter));
  const sections = (Object.keys(DATE_SECTION_LABELS) as DateSection[])
    .map((section) => ({
      section,
      label: DATE_SECTION_LABELS[section],
      tasks: filtered.filter((task) => getDateSection(task.updatedAt) === section),
    }))
    .filter((section) => section.tasks.length > 0);

  function beginRename(task: Task) {
    setEditingTaskId(task.id);
    setTitleDraft(task.title);
    closeMenu();
    setRowMessage(null);
    window.setTimeout(() => {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }, 0);
  }

  function cancelRename() {
    skipBlurSaveRef.current = true;
    setEditingTaskId(null);
    setTitleDraft("");
    setRowMessage(null);
  }

  async function saveRowTitle(task: Task) {
    if (busyTaskRef.current) return;
    const nextTitle = titleDraft.trim();
    if (!nextTitle) {
      setRowMessage({ id: task.id, text: "任务名称不能为空" });
      window.setTimeout(() => titleInputRef.current?.focus(), 0);
      return;
    }
    if (nextTitle === task.title) {
      setEditingTaskId(null);
      setRowMessage(null);
      return;
    }
    busyTaskRef.current = task.id;
    setBusyTaskId(task.id);
    setRowMessage(null);
    try {
      await api.renameTask(task.id, nextTitle);
      setEditingTaskId(null);
      setTitleDraft("");
      onTaskChanged();
    } catch (err) {
      setRowMessage({ id: task.id, text: err instanceof ApiError ? err.message : "改名失败" });
      window.setTimeout(() => titleInputRef.current?.focus(), 0);
    } finally {
      busyTaskRef.current = null;
      setBusyTaskId(null);
    }
  }

  async function copyTaskId(task: Task) {
    closeMenu();
    try {
      if (!(await copyText(task.id))) throw new Error("copy failed");
      setRowMessage({ id: task.id, text: "已复制 ID" });
      window.setTimeout(() => setRowMessage((current) => (current?.id === task.id ? null : current)), 1600);
    } catch {
      setRowMessage({ id: task.id, text: "复制失败" });
    }
  }

  async function removeTask(task: Task) {
    closeMenu();
    if (task.status === "running" || task.status === "needs_approval") {
      setRowMessage({ id: task.id, text: "运行中任务请先停止再删除" });
      return;
    }
    if (!(await confirmDialog("只删除 AgentHub 里的记录，不会撤销工作区文件改动。", { title: `删除任务「${task.title}」？`, danger: true }))) return;
    busyTaskRef.current = task.id;
    setBusyTaskId(task.id);
    setRowMessage(null);
    try {
      await api.deleteTask(task.id);
      onDeleted(task.id);
    } catch (err) {
      setRowMessage({ id: task.id, text: err instanceof ApiError ? err.message : "删除失败" });
    } finally {
      busyTaskRef.current = null;
      setBusyTaskId(null);
    }
  }

  return (
    <div className="task-list-pane">
      <div className="task-list-head">
        <div>
          <strong>任务</strong>
          <span>{tasks.length} 个</span>
        </div>
        <button className="btn btn-primary btn-sm" type="button" onClick={onNewTask}>
          + 新建任务
        </button>
      </div>
      <div className="list-tools">
        <label className="list-select-wrap">
          <span className="sr-only">按工作区筛选任务</span>
          <select className="list-select" value={workspaceFilter} onChange={(event) => setWorkspaceFilter(event.target.value)}>
            <option value="all">全部工作区</option>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        </label>
        <label className="list-search">
          <span className="sr-only">查找任务</span>
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="查找任务关键词"
          />
        </label>
      </div>
      <div className="filter-tabs">
        {FILTERS.map((f) => (
          <button key={f.key} className={`filter-tab ${filter === f.key ? "active" : ""}`} onClick={() => onFilterChange(f.key)}>
            {f.label}
            <span className="count">{counts[f.key]}</span>
          </button>
        ))}
      </div>
      <div className="task-list">
        {filtered.length === 0 && (
          <div className="empty-state">
            {tasks.length === 0 ? '这里还没有任务，点击上方"新建任务"开始' : "没有匹配的任务"}
          </div>
        )}
        {sections.map((group) => (
          <div className="task-date-section" key={group.section}>
            <div className="task-date-label">
              {group.label} ({group.tasks.length})
            </div>
            {group.tasks.map((t) => (
              <div
                key={t.id}
                className={`task-row ${t.id === selectedTaskId ? "selected" : ""}`}
                onClick={() => {
                  closeMenu();
                  onSelect(t.id);
                }}
              >
                <div className="task-row-main">
                  {editingTaskId === t.id ? (
                    <input
                      ref={titleInputRef}
                      className="task-row-title-input"
                      value={titleDraft}
                      disabled={busyTaskId === t.id}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => setTitleDraft(event.target.value)}
                      onBlur={() => {
                        if (skipBlurSaveRef.current) {
                          skipBlurSaveRef.current = false;
                          return;
                        }
                        void saveRowTitle(t);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void saveRowTitle(t);
                        }
                        if (event.key === "Escape") {
                          event.preventDefault();
                          cancelRename();
                        }
                      }}
                      aria-label="任务名称"
                    />
                  ) : (
                    <span
                      className="title"
                      title={`${t.title}（双击重命名）`}
                      onDoubleClick={(event) => {
                        event.stopPropagation();
                        beginRename(t);
                      }}
                    >
                      {t.title}
                    </span>
                  )}
                  {rowMessage?.id === t.id && <span className="task-row-inline-message">{rowMessage.text}</span>}
                  <span className="sub">
                    <span>{formatAgent(t.agentKind)}</span>
                    <span aria-hidden="true">·</span>
                    <span className="workspace-tag" title={t.workspaceId}>
                      {workspaceName(t.workspaceId)}
                    </span>
                  </span>
                </div>
                <div className="task-row-aside">
                  <span className="task-row-time">{formatTaskTime(t.updatedAt)}</span>
                  <StatusBadge status={t.status} />
                </div>
                <div className="task-row-actions" onClick={(event) => event.stopPropagation()}>
                  <button
                    className="task-row-more-button"
                    type="button"
                    aria-label="任务操作"
                    onClick={(event) => toggleMenu(t.id, event)}
                  >
                    ...
                  </button>
                  {openMenuId === t.id && (
                    <div className="task-row-menu" style={menuStyle}>
                      <button type="button" onClick={() => beginRename(t)}>
                        重命名
                      </button>
                      <button type="button" onClick={() => void copyTaskId(t)}>
                        复制 ID
                      </button>
                      <button
                        type="button"
                        className="danger"
                        disabled={t.status === "running" || t.status === "needs_approval" || busyTaskId === t.id}
                        onClick={() => void removeTask(t)}
                      >
                        删除
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export type { Filter };
