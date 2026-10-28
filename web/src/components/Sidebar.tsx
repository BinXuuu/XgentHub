import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AgentDescriptor, AgentKind, AgentRole, Host, Workspace } from "../api/types";
import { api } from "../api/client";
import { confirmDialog, errorDialog } from "../utils/dialog";
import { accountLabel, agentDisplayName } from "../utils/agentAccount";
import { loadAgentUsage } from "../utils/agentUsage";

const AGENT_COLORS: Record<AgentKind, string> = {
  mock: "#6b7280",
  openclaw: "#f59e0b",
  codex: "#4f8cff",
  "claude-code": "#a78bfa",
  codebuddy: "#6366f1",
  "deepseek-harness": "#4d6bfe",
  antigravity: "#f43f5e",
  "ark-cli": "#0ea5e9",
  hermes: "#22c55e",
  ollama: "#14b8a6",
  tokenezgo: "#f97316",
  doubao: "#ef4444",
  "custom-api": "#38bdf8",
  "custom-cli": "#eab308",
};

const AGENT_ORDER_KEY = "xgent.sidebar.agentOrder";
const WORKSPACE_ORDER_KEY = "xgent.sidebar.workspaceOrder";
const DEFAULT_AGENT_ORDER = [
  "tokenezgo",
  "codex",
  "claude-code",
  "codebuddy",
  "deepseek-harness",
  "antigravity",
  "ark-cli",
  "openclaw",
  "doubao",
  "hermes",
  "ollama",
  "mock",
];

interface Props {
  hosts: Host[];
  workspaces: Workspace[];
  agents: AgentDescriptor[];
  selectedAgentId: string | null;
  selectedWorkspaceId: string | null;
  onAgentSelected: (agentId: string) => void;
  onWorkspaceSelected: (workspaceId: string) => void;
  onCreateAgentRequested: () => void;
  onWorkspacesChanged: () => void;
  roles: AgentRole[];
  selectedRoleId: string | null;
  onRoleSelected: (roleId: string) => void;
  onCreateRoleRequested: () => void;
}

function folderNameFromPath(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

function readStoredOrder(key: string, fallback: string[] = []): string[] {
  if (typeof window === "undefined") return fallback;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : fallback;
  } catch {
    return fallback;
  }
}

function writeStoredOrder(key: string, value: string[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, JSON.stringify(value));
}

function orderItems<T extends { id: string }>(items: T[], order: string[], fallbackOrder: string[] = []): T[] {
  const orderIndex = new Map([...fallbackOrder, ...order].map((id, index) => [id, index]));
  return [...items].sort((a, b) => {
    const ai = orderIndex.has(a.id) ? orderIndex.get(a.id)! : Number.MAX_SAFE_INTEGER;
    const bi = orderIndex.has(b.id) ? orderIndex.get(b.id)! : Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return items.indexOf(a) - items.indexOf(b);
  });
}

function reorderVisibleIds(previous: string[], visibleIds: string[], fromId: string, toId: string): string[] {
  if (fromId === toId) return previous;
  const nextVisible = [...visibleIds];
  const fromIndex = nextVisible.indexOf(fromId);
  const toIndex = nextVisible.indexOf(toId);
  if (fromIndex < 0 || toIndex < 0) return previous;
  const [moved] = nextVisible.splice(fromIndex, 1);
  nextVisible.splice(toIndex, 0, moved);
  return [...nextVisible, ...previous.filter((id) => !nextVisible.includes(id))];
}

function UsagePanel({ text }: { text: string }) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let currentTitle = "";

  return (
    <div className="agent-usage-panel">
      {lines.map((line, index) => {
        const urlMatch = line.match(/https?:\/\/\S+/);
        const colonIndex = line.indexOf("：");
        if (colonIndex < 0) {
          currentTitle = line;
          return (
            <div className="usage-section-title" key={`${line}-${index}`}>
              {line}
            </div>
          );
        }

        const label = line.slice(0, colonIndex).trim();
        const detail = line.slice(colonIndex + 1).trim();
        const [value, reset] = detail.split(/，(.+)/);

        if (urlMatch) {
          return (
            <a className="usage-link-row" href={urlMatch[0]} target="_blank" rel="noreferrer" key={`${line}-${index}`}>
              <span>{label}</span>
              <strong>打开</strong>
            </a>
          );
        }

        return (
          <div className="usage-metric-row" key={`${currentTitle}-${line}-${index}`}>
            <div>
              <span>{label}</span>
              <strong>{value || detail}</strong>
            </div>
            {reset && <em>{reset}</em>}
          </div>
        );
      })}
    </div>
  );
}

function UsagePanelShell({
  children,
  onRefresh,
  refreshing,
}: {
  children: ReactNode;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <div className="agent-usage-shell">
      <button className="usage-refresh-button" type="button" onClick={onRefresh} disabled={refreshing}>
        {refreshing ? "刷新中..." : "刷新"}
      </button>
      {children}
    </div>
  );
}

function AgentRow({
  agent,
  selected,
  onSelect,
  dragging,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  agent: AgentDescriptor;
  selected: boolean;
  onSelect: () => void;
  dragging: boolean;
  onDragStart: (id: string) => void;
  onDragOver: (id: string) => void;
  onDrop: (id: string) => void;
  onDragEnd: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [usage, setUsage] = useState<string | null | undefined>(undefined); // undefined = 还没查过
  const [waiting, setWaiting] = useState(false); // 显示的是旧快照，正在等后台刷新出新的
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  async function loadUsage() {
    setLoading(true);
    let first = true;
    try {
      await loadAgentUsage(agent.id, {
        onText: (text) => {
          setUsage(text);
          if (first) { first = false; setLoading(false); }
        },
        onWaiting: (value) => { if (mounted.current) setWaiting(value); },
        isActive: () => mounted.current,
      });
    } catch {
      setUsage(null);
    } finally {
      setLoading(false);
    }
  }

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (usage === undefined) await loadUsage();
  }

  return (
    <div
      className={`draggable-row ${dragging ? "dragging" : ""}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", agent.id);
        onDragStart(agent.id);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        onDragOver(agent.id);
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop(agent.id);
      }}
      onDragEnd={onDragEnd}
    >
      <div className={`sidebar-item ${selected ? "selected" : ""}`} title={agent.configHint} onClick={onSelect}>
        <span className="drag-handle" title="拖拽排序" aria-hidden="true" />
        <span className="kind-dot" style={{ background: AGENT_COLORS[agent.kind] }} />
        <span className="name" title={agent.account ? `${agent.name} · ${accountLabel(agent.account)}` : undefined}>
          {agentDisplayName(agent)}
        </span>
        {agent.official && <span className="official-badge">推荐</span>}
        {!agent.configured && <span className="meta">未配置</span>}
        {agent.configured && agent.account && !agent.account.loggedIn && !agent.account.isDefault && <span className="meta">未登录</span>}
        {agent.supportsUsage && (
          <button
            className="sidebar-meta-button"
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              toggle();
            }}
          >
            {open ? "▲" : "剩余用量 ▾"}
          </button>
        )}
      </div>
      {open && (
        <UsagePanelShell onRefresh={loadUsage} refreshing={loading || waiting}>
          {loading && <div className="agent-usage-panel usage-loading">查询中…</div>}
          {!loading && usage && <UsagePanel text={usage} />}
          {!loading && usage === null && <div className="agent-usage-panel usage-empty">查不到用量信息</div>}
        </UsagePanelShell>
      )}
    </div>
  );
}

export function Sidebar({
  hosts,
  workspaces,
  agents,
  selectedAgentId,
  selectedWorkspaceId,
  onAgentSelected,
  onWorkspaceSelected,
  onCreateAgentRequested,
  onWorkspacesChanged,
  roles,
  selectedRoleId,
  onRoleSelected,
  onCreateRoleRequested,
}: Props) {
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentOrder, setAgentOrder] = useState(() => readStoredOrder(AGENT_ORDER_KEY, DEFAULT_AGENT_ORDER));
  const [workspaceOrder, setWorkspaceOrder] = useState(() => readStoredOrder(WORKSPACE_ORDER_KEY));
  const [draggingAgentId, setDraggingAgentId] = useState<string | null>(null);
  const [draggingWorkspaceId, setDraggingWorkspaceId] = useState<string | null>(null);

  const orderedAgents = useMemo(() => {
    const ordered = orderItems(agents.filter((agent) => !agent.role), agentOrder, DEFAULT_AGENT_ORDER);
    // 新加的账号还没被拖过排序时，放在同类 Agent（比如已有的 Codex）后面，而不是跑到列表最上面。
    const fresh = ordered.filter((agent) => agent.account && !agent.account.isDefault && !agentOrder.includes(agent.id));
    if (fresh.length === 0) return ordered;
    const rest = ordered.filter((agent) => !fresh.includes(agent));
    for (const account of fresh) {
      let anchor = rest.length - 1;
      rest.forEach((agent, index) => {
        if (agent.kind === account.kind) anchor = index;
      });
      rest.splice(anchor + 1, 0, account);
    }
    return rest;
  }, [agents, agentOrder]);
  const baseNames = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.name])), [agents]);
  const orderedWorkspaces = useMemo(() => orderItems(workspaces, workspaceOrder), [workspaces, workspaceOrder]);

  function moveAgent(toId: string) {
    if (!draggingAgentId) return;
    const visibleIds = orderedAgents.map((agent) => agent.id);
    const next = reorderVisibleIds(agentOrder, visibleIds, draggingAgentId, toId);
    setAgentOrder(next);
    writeStoredOrder(AGENT_ORDER_KEY, next);
  }

  function moveWorkspace(toId: string) {
    if (!draggingWorkspaceId) return;
    const visibleIds = orderedWorkspaces.map((workspace) => workspace.id);
    const next = reorderVisibleIds(workspaceOrder, visibleIds, draggingWorkspaceId, toId);
    setWorkspaceOrder(next);
    writeStoredOrder(WORKSPACE_ORDER_KEY, next);
  }

  async function browseFolder() {
    setPicking(true);
    setError(null);
    try {
      const res = await api.pickFolder();
      if (res.path) {
        setPath(res.path);
        setName((prev) => prev || folderNameFromPath(res.path!));
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPicking(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!path.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api.createWorkspace({ name: name.trim() || undefined, path: path.trim(), allowedAgentKinds: [] });
      setName("");
      setPath("");
      setShowForm(false);
      onWorkspacesChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function remove(w: Workspace) {
    if (!(await confirmDialog("它下面的任务记录也会一并删除，本机文件不受影响。", { title: `删除工作区「${w.name}」？`, danger: true }))) return;
    try {
      await api.deleteWorkspace(w.id);
      onWorkspacesChanged();
    } catch (err) {
      void errorDialog(err);
    }
  }

  return (
    <div className="sidebar">
      <h3>主机</h3>
      {hosts.map((h) => (
        <div key={h.id} className="sidebar-item">
          <span className="kind-dot" style={{ background: "#22c55e" }} />
          <span className="name">{h.name}</span>
        </div>
      ))}

      <h3 className="sidebar-section-title">
        Agent
        <button
          className="btn btn-ghost btn-sm"
          onClick={onCreateAgentRequested}
          title="新增 Agent 或登录账号"
        >
          +
        </button>
      </h3>
      {orderedAgents.map((a) => (
        <AgentRow
          key={a.id}
          agent={a}
          selected={selectedAgentId === a.id}
          dragging={draggingAgentId === a.id}
          onSelect={() => onAgentSelected(a.id)}
          onDragStart={setDraggingAgentId}
          onDragOver={() => undefined}
          onDrop={moveAgent}
          onDragEnd={() => setDraggingAgentId(null)}
        />
      ))}

      <h3 className="sidebar-section-title">
        角色
        <button className="btn btn-ghost btn-sm" onClick={onCreateRoleRequested} title="新建角色">
          +
        </button>
      </h3>
      {roles.length === 0 && <div className="sidebar-help">还没有角色。点 + 把一个 Agent 包装成"美工""文案"这类固定身份。</div>}
      {roles.map((role) => (
        <div
          key={role.id}
          className={`sidebar-item role-row ${selectedRoleId === role.id ? "selected" : ""} ${role.enabled ? "" : "disabled"}`}
          onClick={() => onRoleSelected(role.id)}
        >
          <span className="role-row-icon">{role.icon || "◆"}</span>
          <span className="name">{role.name}</span>
          <span className="role-row-base">{role.enabled ? baseNames.get(role.baseAgentId) ?? role.baseAgentId : "已停用"}</span>
        </div>
      ))}

      <h3 className="sidebar-section-title">
        工作区
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => setShowForm((s) => !s)}
          title="新增 workspace"
        >
          {showForm ? "×" : "+"}
        </button>
      </h3>
      {showForm && (
        <form onSubmit={submit} style={{ padding: "6px 8px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              className="field"
              placeholder="本机路径，如 D:\\code\\myrepo"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              style={{ flex: 1 }}
            />
            <button type="button" className="btn btn-sm" onClick={browseFolder} disabled={picking}>
              {picking ? "选择中…" : "浏览…"}
            </button>
          </div>
          <input
            className="field"
            placeholder="名称（留空则用文件夹名）"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {error && <div className="login-error">{error}</div>}
          <button className="btn btn-primary btn-sm" type="submit" disabled={saving || !path.trim()}>
            {saving ? "保存中..." : "创建"}
          </button>
        </form>
      )}
      {orderedWorkspaces.map((w) => (
        <div
          key={w.id}
          className={`sidebar-item workspace-item draggable-row ${selectedWorkspaceId === w.id ? "selected" : ""} ${draggingWorkspaceId === w.id ? "dragging" : ""}`}
          title={w.path}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", w.id);
            setDraggingWorkspaceId(w.id);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }}
          onDrop={(e) => {
            e.preventDefault();
            moveWorkspace(w.id);
          }}
          onDragEnd={() => setDraggingWorkspaceId(null)}
          onClick={() => onWorkspaceSelected(w.id)}
        >
          <span className="drag-handle" title="拖拽排序" aria-hidden="true" />
          <span className="kind-dot" style={{ background: "#4f8cff" }} />
          <span className="name">{w.name}</span>
          <button
            className="btn btn-ghost btn-sm"
            title="删除工作区"
            onClick={(e) => {
              e.stopPropagation();
              void remove(w);
            }}
          >
            ×
          </button>
        </div>
      ))}
      {workspaces.length === 0 && !showForm && <div className="sidebar-item meta">暂无 workspace</div>}
    </div>
  );
}
