import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { api } from "../api/client";
import type { AgentDescriptor, Automation, AutomationInput, AutomationKind, AutomationRun, ModelOption, PermissionMode, Task, Workspace } from "../api/types";
import { agentDisplayName } from "../utils/agentAccount";
import { buildRrule, DEFAULT_SCHEDULE, formFromRrule, WEEKDAYS, type ScheduleForm } from "../utils/automationSchedule";
import { confirmDialog } from "../utils/dialog";
import { StatusBadge } from "./StatusBadge";

// 定时任务页：照 Codex 的自动化。左边列表，右边是详情（运行记录）或编辑表单。
// 「每次新建任务」= Codex 的 cron；「在已有任务里继续」= Codex 的 heartbeat。

interface Props {
  agents: AgentDescriptor[];
  workspaces: Workspace[];
  tasks: Task[];
  /** 服务端推了 automation_changed 就加一，页面跟着重新拉数据。 */
  version: number;
  onOpenTask: (taskId: string) => void;
}

const PERMISSION_LABEL: Record<PermissionMode, string> = {
  supervised: "请求批准（有风险的操作先问你）",
  auto: "帮我批准（只问高风险操作）",
  full: "完全访问权限（不经确认，风险自负）",
};

const RUN_STATUS_LABEL: Record<AutomationRun["status"], string> = {
  started: "已开始",
  queued: "已排队",
  skipped: "已跳过",
  failed: "没能启动",
};

interface Draft {
  name: string;
  prompt: string;
  kind: AutomationKind;
  agentId: string;
  workspaceId: string;
  model: string;
  permissionMode: PermissionMode;
  targetTaskId: string;
  schedule: ScheduleForm;
}

const pad = (value: number) => String(value).padStart(2, "0");
function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return sameDay ? `今天 ${time}` : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

function describeSchedule(form: ScheduleForm): string {
  if (form.mode === "hourly") return `每 ${form.intervalHours} 小时，第 ${form.minute} 分`;
  if (form.mode === "daily") return `每天 ${form.time}`;
  if (form.mode === "weekdays") return `工作日 ${form.time}`;
  const days = WEEKDAYS.filter((day) => form.days.includes(day.code)).map((day) => day.label);
  return `每周${days.join("、") || "?"} ${form.time}`;
}

export function AutomationsView({ agents, workspaces, tasks, version, onOpenTask }: Props) {
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  // null：看详情；"new"：新建；其它：编辑这个 id。
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selected = automations.find((item) => item.id === selectedId) ?? null;
  const usableAgents = useMemo(() => agents.filter((agent) => agent.configured), [agents]);
  const agentName = useCallback((id: string | null) => {
    const agent = agents.find((item) => item.id === id);
    return agent ? agentDisplayName(agent) : id ?? "—";
  }, [agents]);
  const workspaceName = (id: string | null) => workspaces.find((item) => item.id === id)?.name ?? id ?? "—";
  const taskTitle = (id: string | null) => tasks.find((item) => item.id === id)?.title ?? "（任务已删除）";

  const refresh = useCallback(async () => {
    try {
      setAutomations(await api.listAutomations());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, version]);

  useEffect(() => {
    if (!selectedId) {
      setRuns([]);
      return;
    }
    let cancelled = false;
    api
      .listAutomationRuns(selectedId)
      .then((items) => !cancelled && setRuns(items))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selectedId, version]);

  // 选的 Agent 支持选模型就拉一下模型列表。
  const draftAgent = draft ? agents.find((agent) => agent.id === draft.agentId) : undefined;
  useEffect(() => {
    setModelOptions([]);
    if (!draftAgent?.supportsModelSelection) return;
    let cancelled = false;
    api
      .listModels(draftAgent.id)
      .then((options) => !cancelled && setModelOptions(options))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [draftAgent?.id, draftAgent?.supportsModelSelection]);

  function startNew() {
    setError(null);
    setNotice(null);
    setEditing("new");
    setDraft({
      name: "",
      prompt: "",
      kind: "cron",
      agentId: usableAgents[0]?.id ?? "",
      workspaceId: workspaces[0]?.id ?? "",
      model: "",
      permissionMode: "supervised",
      targetTaskId: tasks[0]?.id ?? "",
      schedule: { ...DEFAULT_SCHEDULE },
    });
  }

  function startEdit(item: Automation) {
    setError(null);
    setNotice(null);
    setEditing(item.id);
    setDraft({
      name: item.name,
      prompt: item.prompt,
      kind: item.kind,
      agentId: item.agentId ?? usableAgents[0]?.id ?? "",
      workspaceId: item.workspaceId ?? workspaces[0]?.id ?? "",
      model: item.model ?? "",
      permissionMode: item.permissionMode,
      targetTaskId: item.targetTaskId ?? tasks[0]?.id ?? "",
      schedule: formFromRrule(item.rrule),
    });
  }

  function patchDraft(patch: Partial<Draft>) {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }
  function patchSchedule(patch: Partial<ScheduleForm>) {
    setDraft((current) => (current ? { ...current, schedule: { ...current.schedule, ...patch } } : current));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setError(null);
    let input: AutomationInput;
    try {
      input = {
        name: draft.name,
        prompt: draft.prompt,
        kind: draft.kind,
        rrule: buildRrule(draft.schedule),
        agentId: draft.kind === "cron" ? draft.agentId : null,
        workspaceId: draft.kind === "cron" ? draft.workspaceId : null,
        model: draft.kind === "cron" ? draft.model : null,
        permissionMode: draft.permissionMode,
        targetTaskId: draft.kind === "heartbeat" ? draft.targetTaskId : null,
      };
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    setBusy(true);
    try {
      const saved = editing && editing !== "new" ? await api.updateAutomation(editing, input) : await api.createAutomation(input);
      setEditing(null);
      setDraft(null);
      setSelectedId(saved.id);
      setNotice(`已保存，下次运行：${formatTime(saved.nextRunAt)}`);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function act(action: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (done) setNotice(done);
      await refresh();
      if (selectedId) setRuns(await api.listAutomationRuns(selectedId));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function runNow(item: Automation) {
    await act(async () => {
      const run = await api.runAutomation(item.id);
      if (run.status === "failed") throw new Error(`没能启动：${run.message}`);
      setNotice(run.status === "skipped" ? run.message : run.status === "queued" ? run.message : "已开始运行，结果会出现在下面的运行记录里");
    });
  }

  async function remove(item: Automation) {
    if (!(await confirmDialog("它已经建出来的任务会保留。", { title: `删除定时任务「${item.name}」？`, danger: true }))) return;
    await act(async () => {
      await api.deleteAutomation(item.id);
      setSelectedId(null);
    }, "已删除");
  }

  function openRun(run: AutomationRun) {
    if (!run.taskId) return;
    if (!run.readAt) void api.markAutomationRead(run.automationId, run.id).catch(() => {});
    onOpenTask(run.taskId);
  }

  const detailOpen = Boolean(editing || selected);

  return (
    <div className={`automations-layout ${detailOpen ? "detail-open" : ""}`}>
      <div className="secondary-sidebar">
        <div className="task-list-pane">
          <div className="task-list-head">
            <div>
              <strong>定时任务</strong>
              <span>{automations.length} 个</span>
            </div>
            <button className="btn btn-primary btn-sm" type="button" onClick={startNew}>
              + 新建定时任务
            </button>
          </div>
          <div className="task-list">
            {loading && <div className="empty-state">读取中...</div>}
            {!loading && automations.length === 0 && <div className="empty-state">还没有定时任务。可以让 Agent 每天固定时间做巡检、汇总、跟进。</div>}
            {automations.map((item) => (
              <div
                key={item.id}
                className={`task-row ${item.id === selectedId && !editing ? "selected" : ""}`}
                onClick={() => {
                  setEditing(null);
                  setDraft(null);
                  setNotice(null);
                  setError(null);
                  setSelectedId(item.id);
                }}
              >
                <div className="task-row-main">
                  <span className="title">{item.name}</span>
                  <span className="sub">
                    <span>{item.scheduleText}</span>
                    <span aria-hidden="true">·</span>
                    <span>{item.kind === "heartbeat" ? `继续：${taskTitle(item.targetTaskId)}` : agentName(item.agentId)}</span>
                  </span>
                </div>
                <div className="task-row-aside">
                  <span className="task-row-time">{item.status === "PAUSED" ? "已暂停" : `下次 ${formatTime(item.nextRunAt)}`}</span>
                  {item.unreadCount > 0 && <span className="automation-unread" title={`${item.unreadCount} 次运行结果还没看`}>{item.unreadCount}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="main-area">
        {editing && draft ? (
          <form className="automation-panel" onSubmit={(event) => void save(event)}>
            <div className="automation-panel-head">
              <button className="btn btn-ghost btn-sm automation-back" type="button" onClick={() => (setEditing(null), setDraft(null))}>
                ← 返回
              </button>
              <h2>{editing === "new" ? "新建定时任务" : "编辑定时任务"}</h2>
            </div>

            <label className="field-label">名字</label>
            <input className="field" value={draft.name} onChange={(e) => patchDraft({ name: e.target.value })} placeholder="比如 每日依赖安全巡检" />

            <label className="field-label">每次运行做什么</label>
            <div className="resource-radio-row">
              <label>
                <input type="radio" checked={draft.kind === "cron"} onChange={() => patchDraft({ kind: "cron" })} /> 每次新建一个任务
              </label>
              <label>
                <input type="radio" checked={draft.kind === "heartbeat"} onChange={() => patchDraft({ kind: "heartbeat" })} /> 在已有任务里继续
              </label>
            </div>
            <p className="mcp-transport-hint">
              {draft.kind === "cron"
                ? "到点按下面的 Agent、工作区新建一个任务去做；上一次建的任务还没跑完时，这次会跳过。"
                : "到点往选中的任务里发这段话，让它接着做（适合长期跟进、定期检查有没有新进展）；那个任务正忙时会排进它的队列。"}
            </p>

            <label className="field-label">提示词</label>
            <textarea
              className="field"
              rows={6}
              value={draft.prompt}
              onChange={(e) => patchDraft({ prompt: e.target.value })}
              placeholder="每次运行要它做的事，比如：检查项目依赖有没有安全更新，有的话列出来并给出升级建议；没有变化就简短说明。"
            />

            {draft.kind === "cron" ? (
              <>
                <label className="field-label">Agent / 角色</label>
                <select className="field" value={draft.agentId} onChange={(e) => patchDraft({ agentId: e.target.value, model: "" })}>
                  {usableAgents.length === 0 && <option value="">（没有已配置的 Agent）</option>}
                  {usableAgents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.role ? `角色 · ${agent.name}（${agent.role.baseAgentName}）` : agentDisplayName(agent)}
                    </option>
                  ))}
                </select>

                <label className="field-label">工作区</label>
                <select className="field" value={draft.workspaceId} onChange={(e) => patchDraft({ workspaceId: e.target.value })}>
                  {workspaces.length === 0 && <option value="">（暂无工作区，请先创建）</option>}
                  {workspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.name} — {workspace.path}
                    </option>
                  ))}
                </select>

                {draftAgent && draftAgent.kind !== "mock" && (
                  <>
                    <label className="field-label">模型（可选，留空用默认）</label>
                    {draftAgent.supportsModelSelection && modelOptions.length > 0 ? (
                      <select className="field" value={draft.model} onChange={(e) => patchDraft({ model: e.target.value })}>
                        <option value="">（默认）</option>
                        {modelOptions.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input className="field" value={draft.model} onChange={(e) => patchDraft({ model: e.target.value })} placeholder="留空用默认模型" />
                    )}
                  </>
                )}

                <label className="field-label">权限</label>
                <select className="field" value={draft.permissionMode} onChange={(e) => patchDraft({ permissionMode: e.target.value as PermissionMode })}>
                  {(Object.keys(PERMISSION_LABEL) as PermissionMode[]).map((mode) => (
                    <option key={mode} value={mode}>
                      {PERMISSION_LABEL[mode]}
                    </option>
                  ))}
                </select>
                {draft.permissionMode === "supervised" && <p className="mcp-transport-hint">没人看着时，遇到要批准的操作会停在「待审批」，等你回来点。</p>}
              </>
            ) : (
              <>
                <label className="field-label">要继续的任务</label>
                <select className="field" value={draft.targetTaskId} onChange={(e) => patchDraft({ targetTaskId: e.target.value })}>
                  {tasks.length === 0 && <option value="">（还没有任务）</option>}
                  {[...tasks]
                    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                    .map((task) => (
                      <option key={task.id} value={task.id}>
                        {task.title}
                      </option>
                    ))}
                </select>
              </>
            )}

            <label className="field-label">运行时间</label>
            <div className="automation-schedule">
              <select className="field" value={draft.schedule.mode} onChange={(e) => patchSchedule({ mode: e.target.value as ScheduleForm["mode"] })}>
                <option value="hourly">每隔几小时</option>
                <option value="daily">每天</option>
                <option value="weekdays">工作日（周一到周五）</option>
                <option value="weekly">每周指定几天</option>
              </select>
              {draft.schedule.mode === "hourly" ? (
                <>
                  <label className="automation-inline">
                    每
                    <input className="field" type="number" min={1} max={720} value={draft.schedule.intervalHours} onChange={(e) => patchSchedule({ intervalHours: Number(e.target.value) })} />
                    小时，第
                    <input className="field" type="number" min={0} max={59} value={draft.schedule.minute} onChange={(e) => patchSchedule({ minute: Number(e.target.value) })} />
                    分
                  </label>
                </>
              ) : (
                <input className="field" type="time" value={draft.schedule.time} onChange={(e) => patchSchedule({ time: e.target.value })} />
              )}
            </div>
            {draft.schedule.mode === "weekly" && (
              <div className="automation-days">
                {WEEKDAYS.map((day) => (
                  <label key={day.code} className={draft.schedule.days.includes(day.code) ? "selected" : ""}>
                    <input
                      type="checkbox"
                      checked={draft.schedule.days.includes(day.code)}
                      onChange={(e) =>
                        patchSchedule({ days: e.target.checked ? [...draft.schedule.days, day.code] : draft.schedule.days.filter((code) => code !== day.code) })
                      }
                    />
                    周{day.label}
                  </label>
                ))}
              </div>
            )}
            <p className="mcp-transport-hint">
              {describeSchedule(draft.schedule)}，按这台电脑的时间。Xgent 没开着时到点不会跑，下次打开后补跑一次（错过的几次不会挨个补）。
            </p>

            {error && <div className="login-error">{error}</div>}
            <div className="resource-card-actions">
              <button className="btn btn-ghost" type="button" onClick={() => (setEditing(null), setDraft(null))}>
                取消
              </button>
              <button className="btn btn-primary" type="submit" disabled={busy}>
                {busy ? "保存中..." : editing === "new" ? "创建" : "保存修改"}
              </button>
            </div>
          </form>
        ) : selected ? (
          <div className="automation-panel">
            <div className="automation-panel-head">
              <button className="btn btn-ghost btn-sm automation-back" type="button" onClick={() => setSelectedId(null)}>
                ← 返回
              </button>
              <h2>{selected.name}</h2>
              <span className={`automation-state ${selected.status === "PAUSED" ? "paused" : "active"}`}>{selected.status === "PAUSED" ? "已暂停" : "启用中"}</span>
            </div>
            <div className="resource-card-actions automation-actions">
              <button className="btn btn-primary btn-sm" type="button" disabled={busy} onClick={() => void runNow(selected)}>
                立即运行
              </button>
              <button
                className="btn btn-ghost btn-sm"
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(() => api.setAutomationStatus(selected.id, selected.status === "PAUSED" ? "ACTIVE" : "PAUSED"), selected.status === "PAUSED" ? "已恢复" : "已暂停")
                }
              >
                {selected.status === "PAUSED" ? "恢复" : "暂停"}
              </button>
              <button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={() => startEdit(selected)}>
                编辑
              </button>
              <button className="btn btn-danger btn-sm" type="button" disabled={busy} onClick={() => void remove(selected)}>
                删除
              </button>
            </div>
            {notice && <div className="mcp-test-result ok">{notice}</div>}
            {error && <div className="login-error">{error}</div>}

            <dl className="automation-meta">
              <dt>运行时间</dt>
              <dd>{selected.scheduleText}</dd>
              <dt>下次运行</dt>
              <dd>{selected.status === "PAUSED" ? "已暂停" : formatTime(selected.nextRunAt)}</dd>
              <dt>上次运行</dt>
              <dd>{formatTime(selected.lastRunAt)}</dd>
              {selected.kind === "heartbeat" ? (
                <>
                  <dt>继续的任务</dt>
                  <dd>
                    {selected.targetTaskId && tasks.some((task) => task.id === selected.targetTaskId) ? (
                      <button className="link-button" type="button" onClick={() => onOpenTask(selected.targetTaskId!)}>
                        {taskTitle(selected.targetTaskId)}
                      </button>
                    ) : (
                      taskTitle(selected.targetTaskId)
                    )}
                  </dd>
                </>
              ) : (
                <>
                  <dt>Agent</dt>
                  <dd>
                    {agentName(selected.agentId)}
                    {selected.model ? ` · ${selected.model}` : ""}
                  </dd>
                  <dt>工作区</dt>
                  <dd>{workspaceName(selected.workspaceId)}</dd>
                  <dt>权限</dt>
                  <dd>{PERMISSION_LABEL[selected.permissionMode]}</dd>
                </>
              )}
            </dl>
            <div className="automation-prompt">{selected.prompt}</div>

            <div className="automation-runs-head">
              <strong>运行记录</strong>
              {selected.unreadCount > 0 && (
                <button className="btn btn-ghost btn-sm" type="button" onClick={() => void act(() => api.markAutomationRead(selected.id))}>
                  全部标为已读
                </button>
              )}
            </div>
            <div className="automation-runs">
              {runs.length === 0 && <div className="empty-state">还没运行过。可以先点「立即运行」试一次。</div>}
              {runs.map((run) => (
                <div
                  key={run.id}
                  className={`automation-run ${run.unread ? "unread" : ""} ${run.taskId ? "clickable" : ""}`}
                  onClick={() => openRun(run)}
                  title={run.taskId ? "打开这次运行的任务" : undefined}
                >
                  <span className="automation-run-dot" aria-hidden="true" />
                  <div className="automation-run-main">
                    <span className="title">{run.taskTitle ?? (run.taskId ? "（任务已删除）" : RUN_STATUS_LABEL[run.status])}</span>
                    <span className="sub">
                      {formatTime(run.createdAt)} · {run.trigger === "manual" ? "手动运行" : "到点运行"}
                      {run.message ? ` · ${run.message}` : ""}
                    </span>
                  </div>
                  {run.taskStatus && (run.status === "started" || run.status === "queued") ? (
                    <StatusBadge status={run.taskStatus} />
                  ) : (
                    <span className={`automation-run-status ${run.status}`}>{RUN_STATUS_LABEL[run.status]}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="main-area-empty">
            <div className="main-area-empty-icon">⏰</div>
            <strong>定时让 Agent 去做事</strong>
            <span>每天巡检、定期汇总、长期跟进某个任务，到点自动运行，跑完在这里和左侧「定时」上提醒你</span>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button className="btn btn-primary" type="button" onClick={startNew}>
                + 新建定时任务
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
