import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type {
  AgentDescriptor,
  Approval,
  FileChange,
  MemoryEntry,
  ModelOption,
  QueuedMessage,
  Task,
  TaskEvent,
  TaskFlowSnapshot,
  TaskMessage,
  TaskRecoveryAction,
  TaskResourcesView,
  TaskReviewDecision,
  Workspace,
} from "../../api/types";
import { api, ApiError } from "../../api/client";
import { useSSE } from "../../hooks/useSSE";
import { StatusBadge } from "../StatusBadge";
import { ChatTab } from "./ChatTab";
import { EventsTab } from "./EventsTab";
import { TerminalTab } from "./TerminalTab";
import { FilesTab } from "./FilesTab";
import { DiffTab } from "./DiffTab";
import { ApprovalCard, ApprovalsTab } from "./ApprovalsTab";
import { UsageTab } from "./UsageTab";
import { MemoryTab } from "./MemoryTab";
import { RecoveryTab } from "./RecoveryTab";
import { ReviewTab } from "./ReviewTab";
import { ResourcesTab } from "./ResourcesTab";
import { alertDialog, confirmDialog, errorDialog } from "../../utils/dialog";

// 流程图（@xyflow/react，约 150KB）只有点开「流程」标签才下载，不拖慢首屏。
const FlowTab = lazy(() => import("./FlowTab").then((module) => ({ default: module.FlowTab })));

type TabKey = "chat" | "mcp" | "tools" | "skills" | "knowledge" | "flow" | "review" | "recovery" | "memory" | "events" | "terminal" | "files" | "diff" | "approvals" | "usage";
type TaskActionKey = "approve" | "changes" | "retry" | "human";
type LiveRefreshScope = "light" | "deep";

interface Props {
  taskId: string;
  agents: AgentDescriptor[];
  workspaces: Workspace[];
  onBack: () => void;
  onTaskChanged: () => void;
  onDeleted: () => void;
  onOpenWorkspace: (workspaceId: string) => void;
}

export function TaskDetail({ taskId, agents, workspaces, onBack, onTaskChanged, onDeleted, onOpenWorkspace }: Props) {
  const [task, setTask] = useState<Task | null>(null);
  const [messages, setMessages] = useState<TaskMessage[]>([]);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [terminalText, setTerminalText] = useState("");
  const [files, setFiles] = useState<FileChange[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const [flow, setFlow] = useState<TaskFlowSnapshot | null>(null);
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [recoveryActions, setRecoveryActions] = useState<TaskRecoveryAction[]>([]);
  const [reviewDecisions, setReviewDecisions] = useState<TaskReviewDecision[]>([]);
  const [resources, setResources] = useState<TaskResourcesView | null>(null);
  const [resourcesError, setResourcesError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("chat");
  const [stopping, setStopping] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [handoffing, setHandoffing] = useState(false);
  const [showAgentHandoff, setShowAgentHandoff] = useState(false);
  const [agentHandoffAgentId, setAgentHandoffAgentId] = useState("");
  const [agentHandoffSubtaskId, setAgentHandoffSubtaskId] = useState("");
  const [agentHandoffPrompt, setAgentHandoffPrompt] = useState("");
  // 切换 Agent 时的模型：跟着目标 Agent 走，默认选它自己的默认模型（角色就是角色设的模型），也可以手动改。
  const [agentHandoffModel, setAgentHandoffModel] = useState("");
  const [agentHandoffModelOptions, setAgentHandoffModelOptions] = useState<ModelOption[]>([]);
  const [loadingHandoffModels, setLoadingHandoffModels] = useState(false);
  const [dispatchingAgentHandoff, setDispatchingAgentHandoff] = useState(false);
  const [showSubtaskDispatch, setShowSubtaskDispatch] = useState(false);
  const [subtaskDispatchAgentId, setSubtaskDispatchAgentId] = useState("");
  const [subtaskDispatchPrompt, setSubtaskDispatchPrompt] = useState("");
  const [dispatchingSubtask, setDispatchingSubtask] = useState(false);
  const [approvingReview, setApprovingReview] = useState(false);
  const [requestingChanges, setRequestingChanges] = useState(false);
  const [showWorkspaceSwitch, setShowWorkspaceSwitch] = useState(false);
  const [targetWorkspaceId, setTargetWorkspaceId] = useState("");
  const [changingWorkspace, setChangingWorkspace] = useState(false);
  const [activeTaskAction, setActiveTaskAction] = useState<TaskActionKey | null>(null);
  const [taskActionNote, setTaskActionNote] = useState("");
  const [togglingAutoAdvance, setTogglingAutoAdvance] = useState(false);
  const [showModelSwitch, setShowModelSwitch] = useState(false);
  const [modelDraft, setModelDraft] = useState("");
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [loadingModelOptions, setLoadingModelOptions] = useState(false);
  const [savingModel, setSavingModel] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [renamingTitle, setRenamingTitle] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const skipTitleBlurSaveRef = useRef(false);
  const renamingTitleRef = useRef(false);
  const liveRefreshTimerRef = useRef<number | null>(null);
  const pendingRefreshScopeRef = useRef<LiveRefreshScope>("light");

  const refreshFlow = useCallback(() => {
    return api.getTaskFlow(taskId).then(setFlow).catch(console.error);
  }, [taskId]);

  const refreshTask = useCallback(() => {
    return api
      .getTask(taskId)
      .then((updated) => {
        setTask(updated);
        onTaskChanged();
      })
      .catch(console.error);
  }, [taskId, onTaskChanged]);

  const refreshMemories = useCallback(() => {
    return api.listMemory({ taskId }).then(setMemories).catch(console.error);
  }, [taskId]);

  const refreshRecoveryActions = useCallback(() => {
    return api.listRecoveryActions(taskId).then(setRecoveryActions).catch(console.error);
  }, [taskId]);

  const refreshReviewDecisions = useCallback(() => {
    return api.listReviewDecisions(taskId).then(setReviewDecisions).catch(console.error);
  }, [taskId]);

  const refreshLiveStateNow = useCallback((scope: LiveRefreshScope = "light") => {
    void refreshTask();
    void api.listQueue(taskId).then(setQueue).catch(console.error);
    if (scope === "deep" || tab === "flow") void refreshFlow();
    if (scope === "deep" || tab === "memory") void refreshMemories();
    if (scope === "deep" || tab === "recovery") void refreshRecoveryActions();
    if (scope === "deep" || tab === "review" || tab === "flow") void refreshReviewDecisions();
  }, [taskId, tab, refreshTask, refreshFlow, refreshMemories, refreshRecoveryActions, refreshReviewDecisions]);

  const refreshLiveState = useCallback((scope: LiveRefreshScope = "light") => {
    // 防抖合并时以"深度"为准：状态变化（深度）后紧跟一条消息（轻量），不能把深度刷新吞掉。
    if (scope === "deep") pendingRefreshScopeRef.current = "deep";
    if (liveRefreshTimerRef.current !== null) window.clearTimeout(liveRefreshTimerRef.current);
    liveRefreshTimerRef.current = window.setTimeout(() => {
      const merged = pendingRefreshScopeRef.current;
      liveRefreshTimerRef.current = null;
      pendingRefreshScopeRef.current = "light";
      refreshLiveStateNow(merged);
    }, 450);
  }, [refreshLiveStateNow]);

  useEffect(() => {
    let cancelled = false;
    setTab("chat");
    setTerminalText("");
    setFlow(null);
    setMemories([]);
    setRecoveryActions([]);
    setReviewDecisions([]);
    setEditingTitle(false);
    setTitleDraft("");
    setTitleError(null);
    async function load() {
      const [t, msgs, evts, fls, apprs, q, flowSnapshot, memoryEntries, recoveryEntries, reviewEntries] = await Promise.all([
        api.getTask(taskId),
        api.listMessages(taskId),
        api.listEvents(taskId),
        api.getFiles(taskId),
        api.listApprovals(taskId),
        api.listQueue(taskId),
        api.getTaskFlow(taskId),
        api.listMemory({ taskId }),
        api.listRecoveryActions(taskId),
        api.listReviewDecisions(taskId),
      ]);
      if (cancelled) return;
      setTask(t);
      setMessages(msgs);
      setEvents(evts);
      setTerminalText(evts.filter((e) => e.type === "terminal").map((e) => e.payload?.chunk ?? "").join(""));
      setFiles(fls);
      setApprovals(apprs);
      setQueue(q);
      setFlow(flowSnapshot);
      setMemories(memoryEntries);
      setRecoveryActions(recoveryEntries);
      setReviewDecisions(reviewEntries);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  useEffect(() => {
    return () => {
      if (liveRefreshTimerRef.current !== null) window.clearTimeout(liveRefreshTimerRef.current);
    };
  }, []);

  useSSE<TaskEvent>(`/api/tasks/${taskId}/stream`, "task_event", (event) => {
    switch (event.type) {
      case "message":
        setMessages((prev) => [
          ...prev,
          {
            id: event.payload.id ?? event.id,
            taskId,
            role: event.payload.role,
            content: event.payload.content,
            images: event.payload.images ?? [],
            createdAt: event.createdAt,
          },
        ]);
        refreshLiveState("light");
        break;
      case "terminal":
        setTerminalText((prev) => prev + (event.payload?.chunk ?? ""));
        setEvents((prev) => [...prev, event]);
        break;
      case "status":
        setTask((prev) => (prev ? { ...prev, status: event.payload.status } : prev));
        refreshLiveState("deep");
        break;
      case "file":
        setFiles((prev) => [
          ...prev,
          { id: event.id, taskId, path: event.payload.path, action: event.payload.action, diff: event.payload.diff, createdAt: event.createdAt },
        ]);
        setEvents((prev) => [...prev, event]);
        void refreshFlow();
        void refreshReviewDecisions();
        break;
      case "approval_requested":
        // 不再跳到审批页：页面上方会弹出待批准卡片，在对话里就能直接批。
        setApprovals((prev) => [event.payload as Approval, ...prev]);
        setEvents((prev) => [...prev, event]);
        void refreshFlow();
        break;
      case "approval_resolved":
        setApprovals((prev) => prev.map((a) => (a.id === event.payload.id ? (event.payload as Approval) : a)));
        setEvents((prev) => [...prev, event]);
        void refreshFlow();
        void refreshReviewDecisions();
        break;
      case "queue_updated":
        setQueue(event.payload as QueuedMessage[]);
        void refreshFlow();
        break;
      default:
        setEvents((prev) => [...prev, event]);
        void refreshFlow();
        void refreshRecoveryActions();
        void refreshReviewDecisions();
    }
  });

  // 实际生效的资源 = 工作区配置 ∪ 角色自带：任务换了工作区/Agent、或工作区配置改了（workspaces 会刷新）都要重拉。
  const resourceWorkspace = workspaces.find((w) => w.id === task?.workspaceId);
  const resourceKey = [
    task?.workspaceId,
    task?.agentId,
    resourceWorkspace?.knowledgeGroupIds.join(","),
    resourceWorkspace?.mcpServerIds.join(","),
    resourceWorkspace?.toolIds.join(","),
    resourceWorkspace?.skillIds.join(","),
  ].join("|");
  useEffect(() => {
    if (!task) return;
    let cancelled = false;
    setResourcesError(null);
    api
      .getTaskResources(taskId)
      .then((view) => {
        if (!cancelled) setResources(view);
      })
      .catch((err) => {
        if (!cancelled) setResourcesError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, resourceKey, Boolean(task)]);

  if (!task) {
    return (
      <div className="detail-pane">
        <div className="no-task">加载中...</div>
      </div>
    );
  }

  // 最早的那条先批：Claude Code 会按顺序等每一条的答复。
  const pendingApprovalList = approvals.filter((a) => a.status === "pending").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const pendingApprovals = pendingApprovalList.length;
  const isBusy = task.status === "running" || task.status === "needs_approval";
  const canRetry = task.status === "failed" || task.status === "stopped" || task.status === "review";
  const canHandoff = !isBusy;
  const canReview = task.status === "review";
  const supportsUsageTab = task.agentId === "tokenezgo" || task.agentKind === "tokenezgo";
  const workspace = workspaces.find((w) => w.id === task.workspaceId) ?? null;
  const workspaceCandidates = workspaces.filter((w) => w.allowedAgentKinds.length === 0 || w.allowedAgentKinds.includes(task.agentKind));
  const hasWorkspaceBoundHistory =
    messages.length > 0 ||
    files.length > 0 ||
    approvals.length > 0 ||
    recoveryActions.length > 0 ||
    reviewDecisions.length > 0 ||
    Boolean(flow && (flow.runs.length > 0 || flow.artifacts.length > 0));
  const handoffCandidates = agents.filter((agent) => {
    const allowed = !workspace || workspace.allowedAgentKinds.length === 0 || workspace.allowedAgentKinds.includes(agent.kind);
    return agent.configured && allowed;
  });
  const canAgentHandoff = !isBusy && handoffCandidates.length > 0;
  const handoffSubtasks = flow?.subtasks ?? [];
  const successfulSubtaskStatuses = new Set(["done", "review"]);
  const subtaskById = new Map(handoffSubtasks.map((subtask) => [subtask.id, subtask]));
  const runnableSubtasks = handoffSubtasks.filter((subtask) => {
    if (!subtask.parentSubtaskId) return false;
    if (subtask.status !== "queued" && subtask.status !== "waiting") return false;
    return subtask.dependencyIds.every((id) => successfulSubtaskStatuses.has(subtaskById.get(id)?.status ?? ""));
  });
  const nextRunnableSubtask = runnableSubtasks[0] ?? null;
  const canDispatchNextSubtask = !isBusy && Boolean(nextRunnableSubtask) && handoffCandidates.length > 0;
  const plannedSubtasks = handoffSubtasks.filter((subtask) => subtask.parentSubtaskId);
  const pendingPlanStatuses = new Set(["queued", "waiting", "running", "needs_approval"]);
  const hasPendingPlannedSubtasks = plannedSubtasks.some((subtask) => pendingPlanStatuses.has(subtask.status));
  const agentDescriptor = agents.find((agent) => agent.id === task.agentId) ?? null;
  const supportsMcp = Boolean(agentDescriptor?.supportsMcp);
  const handoffTarget = agents.find((agent) => agent.id === agentHandoffAgentId) ?? null;

  async function stop() {
    setStopping(true);
    try {
      await api.stopTask(taskId);
      refreshLiveState();
    } catch (err) {
      void errorDialog(err);
    } finally {
      setStopping(false);
    }
  }

  async function toggleAutoAdvance() {
    if (!task) return;
    setTogglingAutoAdvance(true);
    try {
      const updated = await api.setAutoAdvancePlan(taskId, !task.autoAdvancePlan);
      setTask(updated);
      onTaskChanged();
    } catch (err) {
      void errorDialog(err);
    } finally {
      setTogglingAutoAdvance(false);
    }
  }

  async function openModelSwitch() {
    if (!task) return;
    setModelDraft(task.model ?? "");
    setShowModelSwitch(true);
    if (!agentDescriptor?.supportsModelSelection) return;
    setLoadingModelOptions(true);
    try {
      setModelOptions(await api.listModels(agentDescriptor.id));
    } catch (err) {
      void errorDialog(err);
    } finally {
      setLoadingModelOptions(false);
    }
  }

  async function refreshModelOptions() {
    if (!agentDescriptor?.supportsModelSelection) return;
    setLoadingModelOptions(true);
    try {
      setModelOptions(await api.listModels(agentDescriptor.id, true));
    } catch (err) {
      void errorDialog(err);
    } finally {
      setLoadingModelOptions(false);
    }
  }

  async function saveModel() {
    if (!task) return;
    setSavingModel(true);
    try {
      const updated = await api.setTaskModel(task.id, modelDraft.trim() || null);
      setTask(updated);
      onTaskChanged();
      setShowModelSwitch(false);
    } catch (err) {
      void errorDialog(err);
    } finally {
      setSavingModel(false);
    }
  }

  function openTitleEditor() {
    if (!task) return;
    setTitleDraft(task.title);
    setTitleError(null);
    setEditingTitle(true);
    window.setTimeout(() => {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }, 0);
  }

  function cancelTitleEditor() {
    skipTitleBlurSaveRef.current = true;
    setEditingTitle(false);
    setTitleDraft(task?.title ?? "");
    setTitleError(null);
  }

  async function saveTitle() {
    if (!task || renamingTitleRef.current) return;
    const nextTitle = titleDraft.trim();
    if (!nextTitle) {
      setTitleError("任务名称不能为空");
      window.setTimeout(() => titleInputRef.current?.focus(), 0);
      return;
    }
    if (nextTitle === task.title) {
      setEditingTitle(false);
      setTitleError(null);
      return;
    }
    renamingTitleRef.current = true;
    setRenamingTitle(true);
    setTitleError(null);
    try {
      const updated = await api.renameTask(task.id, nextTitle);
      setTask(updated);
      onTaskChanged();
      setEditingTitle(false);
    } catch (err) {
      setTitleError(err instanceof ApiError ? err.message : "改名失败");
      window.setTimeout(() => titleInputRef.current?.focus(), 0);
    } finally {
      renamingTitleRef.current = false;
      setRenamingTitle(false);
    }
  }

  function openTaskAction(action: TaskActionKey) {
    setActiveTaskAction(action);
    setTaskActionNote("");
  }

  function closeTaskAction() {
    setActiveTaskAction(null);
    setTaskActionNote("");
  }

  async function retry(note: string) {
    setRetrying(true);
    try {
      const action = await api.retryTask(taskId, note);
      setRecoveryActions((prev) => [...prev, action]);
      const updated = await api.getTask(taskId);
      setTask(updated);
      onTaskChanged();
      void refreshFlow();
      void refreshRecoveryActions();
      setTab("recovery");
    } catch (err) {
      void errorDialog(err);
    } finally {
      setRetrying(false);
    }
  }

  async function handoff(note: string) {
    setHandoffing(true);
    try {
      const action = await api.handoffTask(taskId, note);
      setRecoveryActions((prev) => [...prev, action]);
      const updated = await api.getTask(taskId);
      setTask(updated);
      onTaskChanged();
      void refreshFlow();
      void refreshRecoveryActions();
      setTab("recovery");
    } catch (err) {
      void errorDialog(err);
    } finally {
      setHandoffing(false);
    }
  }

  /** 换目标 Agent：模型立刻换成那个 Agent 的默认模型，再去拉它的模型列表。 */
  function selectHandoffAgent(agentId: string) {
    setAgentHandoffAgentId(agentId);
    const target = agents.find((agent) => agent.id === agentId) ?? null;
    setAgentHandoffModel(target?.defaultModel ?? "");
    setAgentHandoffModelOptions([]);
    if (!target?.supportsModelSelection) return;
    setLoadingHandoffModels(true);
    api
      .listModels(target.id)
      .then((options) => {
        setAgentHandoffModelOptions((current) => (agentId === target.id ? options : current));
      })
      .catch(() => setAgentHandoffModelOptions([]))
      .finally(() => setLoadingHandoffModels(false));
  }

  function openAgentHandoff() {
    const preferred = handoffCandidates.find((agent) => agent.id !== task?.agentId)?.id ?? handoffCandidates[0]?.id ?? "";
    selectHandoffAgent(preferred);
    setAgentHandoffSubtaskId("");
    setAgentHandoffPrompt("");
    setShowSubtaskDispatch(false);
    setShowAgentHandoff(true);
  }

  async function dispatchAgentHandoff(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prompt = agentHandoffPrompt.trim();
    if (!agentHandoffAgentId || !prompt) return;
    setDispatchingAgentHandoff(true);
    try {
      await api.dispatchAgentHandoff(taskId, {
        agentId: agentHandoffAgentId,
        prompt,
        subtaskId: agentHandoffSubtaskId || null,
        model: agentHandoffModel.trim() || null,
      });
      const updated = await api.getTask(taskId);
      setTask(updated);
      onTaskChanged();
      void refreshFlow();
      setShowAgentHandoff(false);
      setTab("flow");
    } catch (err) {
      void errorDialog(err);
    } finally {
      setDispatchingAgentHandoff(false);
    }
  }

  function openSubtaskDispatch() {
    if (!nextRunnableSubtask) return;
    const assignedAgent = nextRunnableSubtask.assignedAgentId;
    const preferred =
      (assignedAgent && handoffCandidates.some((agent) => agent.id === assignedAgent) ? assignedAgent : null) ??
      handoffCandidates.find((agent) => agent.id === task?.agentId)?.id ??
      handoffCandidates[0]?.id ??
      "";
    setSubtaskDispatchAgentId(preferred);
    setSubtaskDispatchPrompt("");
    setShowAgentHandoff(false);
    setShowSubtaskDispatch(true);
  }

  async function dispatchNextSubtask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!subtaskDispatchAgentId || !nextRunnableSubtask) return;
    setDispatchingSubtask(true);
    try {
      await api.dispatchNextSubtask(taskId, {
        agentId: subtaskDispatchAgentId,
        prompt: subtaskDispatchPrompt.trim() || null,
      });
      const updated = await api.getTask(taskId);
      setTask(updated);
      onTaskChanged();
      void refreshFlow();
      setShowSubtaskDispatch(false);
      setTab("flow");
    } catch (err) {
      void errorDialog(err);
    } finally {
      setDispatchingSubtask(false);
    }
  }

  async function approveReview(note: string) {
    setApprovingReview(true);
    try {
      const decision = await api.approveTaskReview(taskId, note);
      setReviewDecisions((prev) => [...prev, decision]);
      const updated = await api.getTask(taskId);
      setTask(updated);
      onTaskChanged();
      void refreshFlow();
      void refreshMemories();
      void refreshReviewDecisions();
      setTab("review");
    } catch (err) {
      void errorDialog(err);
    } finally {
      setApprovingReview(false);
    }
  }

  async function requestChanges(note: string) {
    if (!note) {
      void alertDialog("写清楚哪里需要修改，Agent 会按这条意见继续改。", { title: "还没填修改说明" });
      return;
    }
    setRequestingChanges(true);
    try {
      const decision = await api.requestTaskChanges(taskId, note);
      setReviewDecisions((prev) => [...prev, decision]);
      const updated = await api.getTask(taskId);
      setTask(updated);
      onTaskChanged();
      void refreshFlow();
      void refreshRecoveryActions();
      void refreshReviewDecisions();
      setTab("review");
    } catch (err) {
      void errorDialog(err);
    } finally {
      setRequestingChanges(false);
    }
  }

  async function submitTaskAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeTaskAction) return;
    const note = taskActionNote.trim();
    try {
      if (activeTaskAction === "approve") await approveReview(note);
      if (activeTaskAction === "changes") await requestChanges(note);
      if (activeTaskAction === "retry") await retry(note);
      if (activeTaskAction === "human") await handoff(note);
      closeTaskAction();
    } catch {
      // Individual handlers surface their own errors.
    }
  }

  async function remove() {
    if (!(await confirmDialog("会清空对话、日志、审批等记录，但不会撤销 Agent 已经改动的文件。", { title: `删除任务「${task!.title}」？`, danger: true }))) return;
    try {
      await api.deleteTask(taskId);
      onDeleted();
    } catch (err) {
      void errorDialog(err);
    }
  }

  function openWorkspaceSwitch() {
    setTargetWorkspaceId(task?.workspaceId ?? "");
    setShowWorkspaceSwitch(true);
  }

  const activeActionMeta =
    activeTaskAction === "approve"
      ? { title: "验收通过", hint: "可以补充验收说明，也可以直接确认通过。", placeholder: "例如：结果符合要求，可以收尾。", required: false }
      : activeTaskAction === "changes"
        ? { title: "要求修改", hint: "写清楚哪里不满意，Agent 会按这条意见继续修改。", placeholder: "例如：只修 UI 对齐，不要改后端逻辑。", required: true }
        : activeTaskAction === "retry"
          ? { title: "重试", hint: "适合运行失败、模型中断或服务临时异常。说明可留空。", placeholder: "例如：沿用当前上下文重新执行一次。", required: false }
          : activeTaskAction === "human"
            ? { title: "转人工", hint: "任务会暂停给人处理，不会交给其他 Agent。说明可留空。", placeholder: "例如：需要我手动检查登录状态后再继续。", required: false }
            : null;
  const actionSubmitting = approvingReview || requestingChanges || retrying || handoffing;

  async function changeWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!task || !targetWorkspaceId || targetWorkspaceId === task.workspaceId) {
      setShowWorkspaceSwitch(false);
      return;
    }
    const nextWorkspace = workspaces.find((w) => w.id === targetWorkspaceId);
    const confirmed =
      hasWorkspaceBoundHistory &&
      (await confirmDialog("这个任务已有运行记录或对话。切换工作区只影响后续消息，不会迁移历史产物、文件记录和 Diff。", {
        title: `切换到「${nextWorkspace?.name ?? "新工作区"}」？`,
        confirmText: "切换",
      }));
    if (hasWorkspaceBoundHistory && !confirmed) return;
    setChangingWorkspace(true);
    try {
      const updated = await api.changeTaskWorkspace(task.id, { workspaceId: targetWorkspaceId, confirmed });
      setTask(updated);
      setMessages(await api.listMessages(task.id));
      void refreshFlow();
      onTaskChanged();
      setShowWorkspaceSwitch(false);
      setTab("chat");
    } catch (err) {
      void errorDialog(err);
    } finally {
      setChangingWorkspace(false);
    }
  }

  return (
    <div className="detail-pane">
      <div className="detail-header">
        <div className="title-row">
          <button className="btn btn-ghost btn-sm back-btn" onClick={onBack}>
            ← 返回
          </button>
          {editingTitle ? (
            <div className="task-title-editor">
              <input
                ref={titleInputRef}
                className="field"
                value={titleDraft}
                disabled={renamingTitle}
                onChange={(event) => setTitleDraft(event.target.value)}
                onBlur={() => {
                  if (skipTitleBlurSaveRef.current) {
                    skipTitleBlurSaveRef.current = false;
                    return;
                  }
                  void saveTitle();
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void saveTitle();
                  }
                  if (event.key === "Escape") {
                    cancelTitleEditor();
                  }
                }}
                aria-label="任务名称"
              />
              {renamingTitle && <span className="task-title-save-state">保存中...</span>}
              {titleError && <span className="task-title-error">{titleError}</span>}
            </div>
          ) : (
            <div className="task-title-display">
              <h2 onDoubleClick={openTitleEditor} title="双击重命名">
                {task.title}
              </h2>
            </div>
          )}
        </div>
        <div className="meta-row">
          <StatusBadge status={task.status} />
          <span className="agent-meta-chip">
            Agent：
            {agentDescriptor?.role
              ? `${agentDescriptor.role.icon ? `${agentDescriptor.role.icon} ` : ""}${agentDescriptor.name}（${agentDescriptor.role.baseAgentName}）`
              : task.agentKind}
            {canAgentHandoff && (
              <button className="meta-inline-button" type="button" onClick={openAgentHandoff} disabled={dispatchingAgentHandoff}>
                切换
              </button>
            )}
          </span>
          {task.subAgentId && <span>子 Agent：{task.subAgentId}</span>}
          {agentDescriptor && agentDescriptor.kind !== "mock" && (
            <span className="agent-meta-chip">
              模型：{task.model || (agentDescriptor.defaultModel ? `默认（${agentDescriptor.defaultModel}）` : "默认")}
              <button className="meta-inline-button" type="button" onClick={openModelSwitch}>
                切换
              </button>
            </span>
          )}
          {task.budgetLimitCny && <span>预算：¥{task.budgetLimitCny}</span>}
          <span className="workspace-meta-chip">
            工作区：{workspace?.name ?? "未知工作区"}
            {workspaceCandidates.length > 1 && !isBusy && (
              <button className="meta-inline-button" type="button" onClick={openWorkspaceSwitch}>
                切换
              </button>
            )}
          </span>
          {task.permissionMode !== "supervised" && (
            <span style={{ color: task.permissionMode === "full" ? "var(--danger)" : "var(--warning)" }}>
              {task.permissionMode === "full" ? "完全访问权限" : "帮我批准"}
            </span>
          )}
          {task.planMode && <span className="plan-mode-chip">计划模式</span>}
          {hasPendingPlannedSubtasks && (
            <span className={`auto-advance-chip ${task.autoAdvancePlan ? "running" : "paused"}`}>
              {task.autoAdvancePlan
                ? `自动执行中${nextRunnableSubtask ? ` · 下一步「${nextRunnableSubtask.title}」` : ""}`
                : "自动执行已暂停"}
              <button className="meta-inline-button" type="button" onClick={toggleAutoAdvance} disabled={togglingAutoAdvance}>
                {task.autoAdvancePlan ? "暂停" : "恢复"}
              </button>
            </span>
          )}
        </div>
      </div>

      {showWorkspaceSwitch && (
        <form className="workspace-switch-panel" onSubmit={changeWorkspace}>
          <div className="workspace-switch-copy">
            <strong>切换工作区</strong>
            <span>只影响后续 Agent 执行位置，历史记录不会迁移。</span>
          </div>
          <select className="field" value={targetWorkspaceId} onChange={(event) => setTargetWorkspaceId(event.target.value)}>
            {workspaceCandidates.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} - {w.path}
              </option>
            ))}
          </select>
          <button className="btn btn-primary btn-sm" type="submit" disabled={changingWorkspace || !targetWorkspaceId || targetWorkspaceId === task.workspaceId}>
            {changingWorkspace ? "切换中..." : "确认切换"}
          </button>
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => setShowWorkspaceSwitch(false)}>
            取消
          </button>
        </form>
      )}


      {showModelSwitch && (
        <form className="workspace-switch-panel" onSubmit={(event) => { event.preventDefault(); void saveModel(); }}>
          <div className="workspace-switch-copy">
            <strong>切换模型</strong>
            <span>只影响下一轮对话，不影响正在跑的这次。留空用 agent 默认模型。</span>
          </div>
          {agentDescriptor?.supportsModelSelection ? (
            <div className="field-label-row">
              <select className="field" value={modelDraft} onChange={(event) => setModelDraft(event.target.value)} disabled={loadingModelOptions}>
                <option value="">{loadingModelOptions ? "加载中…" : "（默认）"}</option>
                {modelOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              <button className="btn btn-ghost btn-sm" type="button" onClick={refreshModelOptions} disabled={loadingModelOptions}>
                刷新
              </button>
            </div>
          ) : (
            <input
              className="field"
              value={modelDraft}
              onChange={(event) => setModelDraft(event.target.value)}
              placeholder="留空用默认模型"
            />
          )}
          <button className="btn btn-primary btn-sm" type="submit" disabled={savingModel}>
            {savingModel ? "保存中..." : "保存"}
          </button>
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => setShowModelSwitch(false)}>
            取消
          </button>
        </form>
      )}

      {showSubtaskDispatch && nextRunnableSubtask && (
        <form className="agent-handoff-panel subtask-dispatch-panel" onSubmit={dispatchNextSubtask}>
          <div className="agent-handoff-head">
            <strong>执行下个子任务</strong>
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => setShowSubtaskDispatch(false)}>
              关闭
            </button>
          </div>
          <div className="subtask-dispatch-target">
            <span>子任务</span>
            <strong title={nextRunnableSubtask.title}>{nextRunnableSubtask.title}</strong>
          </div>
          <div className="agent-handoff-grid">
            <label>
              <span>目标 Agent</span>
              <select className="field" value={subtaskDispatchAgentId} onChange={(event) => setSubtaskDispatchAgentId(event.target.value)}>
                {handoffCandidates.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name} ({agent.kind})
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>依赖</span>
              <input className="field" value={nextRunnableSubtask.dependencyIds.length ? `${nextRunnableSubtask.dependencyIds.length} 已满足` : "无依赖"} readOnly />
            </label>
          </div>
          <label className="agent-handoff-prompt">
            <span>说明</span>
            <textarea
              className="field"
              rows={3}
              value={subtaskDispatchPrompt}
              onChange={(event) => setSubtaskDispatchPrompt(event.target.value)}
              placeholder="补充执行约束（可留空）"
            />
          </label>
          <div className="agent-handoff-actions">
            <button className="btn btn-primary btn-sm" type="submit" disabled={!subtaskDispatchAgentId || dispatchingSubtask}>
              {dispatchingSubtask ? "派发中..." : "派发子任务"}
            </button>
          </div>
        </form>
      )}

      {showAgentHandoff && (
        <form className="agent-handoff-panel" onSubmit={dispatchAgentHandoff}>
          <div className="agent-handoff-head">
            <strong>切换 Agent</strong>
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => setShowAgentHandoff(false)}>
              关闭
            </button>
          </div>
          <div className="agent-handoff-grid">
            <label>
              <span>目标 Agent</span>
              <select className="field" value={agentHandoffAgentId} onChange={(event) => selectHandoffAgent(event.target.value)}>
                {handoffCandidates.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name} ({agent.kind})
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>模型</span>
              {handoffTarget?.supportsModelSelection ? (
                <select className="field" value={agentHandoffModel} onChange={(event) => setAgentHandoffModel(event.target.value)} disabled={loadingHandoffModels}>
                  <option value="">{loadingHandoffModels ? "加载中…" : `默认（${handoffTarget.name} 自己决定）`}</option>
                  {agentHandoffModel && !agentHandoffModelOptions.some((option) => option.id === agentHandoffModel) && (
                    <option value={agentHandoffModel}>{agentHandoffModel}</option>
                  )}
                  {agentHandoffModelOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                      {option.id === handoffTarget.defaultModel ? "（默认）" : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className="field"
                  value={agentHandoffModel}
                  onChange={(event) => setAgentHandoffModel(event.target.value)}
                  placeholder={handoffTarget ? `留空用 ${handoffTarget.name} 的默认模型` : "留空用默认模型"}
                />
              )}
            </label>
            <label>
              <span>子任务</span>
              <select className="field" value={agentHandoffSubtaskId} onChange={(event) => setAgentHandoffSubtaskId(event.target.value)}>
                <option value="">自动创建</option>
                {handoffSubtasks.map((subtask) => (
                  <option key={subtask.id} value={subtask.id}>
                    {subtask.title}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="agent-handoff-prompt">
            <span>说明</span>
            <textarea
              className="field"
              rows={3}
              value={agentHandoffPrompt}
              onChange={(event) => setAgentHandoffPrompt(event.target.value)}
              placeholder="写给目标 Agent 的任务说明"
            />
          </label>
          <div className="agent-handoff-actions">
            <button className="btn btn-primary btn-sm" type="submit" disabled={!agentHandoffAgentId || !agentHandoffPrompt.trim() || dispatchingAgentHandoff}>
              {dispatchingAgentHandoff ? "派发中..." : "派发"}
            </button>
          </div>
        </form>
      )}

      <div className="tabs">
        <div className="tab-strip">
          <TabButton active={tab === "chat"} onClick={() => setTab("chat")} label="对话" />
          <TabButton active={tab === "flow"} onClick={() => setTab("flow")} label="流程" />
          <TabButton active={tab === "review"} onClick={() => setTab("review")} label="验收" />
          <TabButton active={tab === "mcp"} onClick={() => setTab("mcp")} label="MCP" count={resources?.mcpServers.length} />
          <TabButton active={tab === "tools"} onClick={() => setTab("tools")} label="工具" count={resources?.tools.length} />
          <TabButton active={tab === "skills"} onClick={() => setTab("skills")} label="Skill" count={resources?.skills.length} />
          <TabButton active={tab === "knowledge"} onClick={() => setTab("knowledge")} label="知识库" count={resources?.knowledgeGroups.length} />
          <TabButton active={tab === "recovery"} onClick={() => setTab("recovery")} label="恢复" />
          <TabButton active={tab === "memory"} onClick={() => setTab("memory")} label="记忆" />
          <TabButton active={tab === "events"} onClick={() => setTab("events")} label="事件" />
          <TabButton active={tab === "terminal"} onClick={() => setTab("terminal")} label="终端" />
          <TabButton active={tab === "files"} onClick={() => setTab("files")} label="文件" />
          <TabButton active={tab === "diff"} onClick={() => setTab("diff")} label="Diff" />
          <TabButton active={tab === "approvals"} onClick={() => setTab("approvals")} label="审批" count={pendingApprovals} />
          {supportsUsageTab && <TabButton active={tab === "usage"} onClick={() => setTab("usage")} label="用量" />}
        </div>
        <div className="tab-actions">
          {canReview && (
            <button className="btn btn-primary btn-sm" onClick={() => openTaskAction("approve")} disabled={approvingReview}>
              验收通过
            </button>
          )}
          {canReview && (
            <button className="btn btn-attention btn-sm" onClick={() => openTaskAction("changes")} disabled={requestingChanges}>
              要求修改
            </button>
          )}
          {canRetry && (
            <button className="btn btn-attention btn-sm" onClick={() => openTaskAction("retry")} disabled={retrying}>
              重试
            </button>
          )}
          {canDispatchNextSubtask && (
            <button className="btn btn-primary btn-sm" onClick={openSubtaskDispatch} disabled={dispatchingSubtask}>
              执行下个子任务
            </button>
          )}
          {canHandoff && (
            <button className="btn btn-ghost btn-sm" onClick={() => openTaskAction("human")} disabled={handoffing}>
              转人工
            </button>
          )}
          {isBusy && (
            <button className="btn btn-danger btn-sm" onClick={stop} disabled={stopping}>
              停止
            </button>
          )}
          {!isBusy && (
            <button className="btn btn-ghost btn-sm" onClick={remove} title="删除任务">
              删除
            </button>
          )}
        </div>
      </div>

      {activeActionMeta && (
        <form className="task-action-panel" onSubmit={submitTaskAction}>
          <div className="task-action-copy">
            <strong>{activeActionMeta.title}</strong>
            <span>{activeActionMeta.hint}</span>
          </div>
          <textarea
            className="field"
            rows={1}
            value={taskActionNote}
            onChange={(event) => setTaskActionNote(event.target.value)}
            placeholder={activeActionMeta.placeholder}
            autoFocus
          />
          <div className="task-action-buttons">
            <button className="btn btn-primary btn-sm" type="submit" disabled={actionSubmitting || (activeActionMeta.required && !taskActionNote.trim())}>
              {actionSubmitting ? "提交中..." : "确认"}
            </button>
            <button className="btn btn-ghost btn-sm" type="button" onClick={closeTaskAction} disabled={actionSubmitting}>
              取消
            </button>
          </div>
        </form>
      )}

      {tab !== "approvals" && pendingApprovalList.length > 0 && (
        <section className="approval-popup" role="alert">
          <div className="approval-popup-head">
            <strong>
              {agentDescriptor?.name ?? task.agentKind} 在等你批准
              {pendingApprovalList.length > 1 ? `（还有 ${pendingApprovalList.length - 1} 条排队）` : ""}
            </strong>
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => setTab("approvals")}>
              查看全部审批
            </button>
          </div>
          <ApprovalCard key={pendingApprovalList[0].id} approval={pendingApprovalList[0]} />
        </section>
      )}

      <div className={`tab-content ${tab === "chat" ? "chat-tab-content" : tab === "flow" ? "flow-tab-content" : ""}`}>
        {tab === "chat" && (
          <ChatTab
            taskId={taskId}
            messages={messages}
            queue={queue}
            status={task.status}
            onMessageSent={refreshLiveState}
            planMode={task.planMode}
            planModeSince={task.planModeSince}
            role={agentDescriptor?.role ? { roleId: agentDescriptor.role.roleId, name: agentDescriptor.name } : null}
            planEnforced={Boolean(agentDescriptor?.enforcesPlanMode)}
            onSetPlanMode={async (enabled) => {
              setTask(await api.setTaskPlanMode(taskId, enabled));
              onTaskChanged();
            }}
            onApprovePlan={async () => {
              setTask(await api.approveTaskPlan(taskId));
              onTaskChanged();
              refreshLiveState();
            }}
          />
        )}
        {(tab === "mcp" || tab === "tools" || tab === "skills" || tab === "knowledge") && (
          <ResourcesTab
            kind={tab}
            resources={resources}
            error={resourcesError}
            supportsMcp={supportsMcp}
            agentName={agentDescriptor?.name ?? task.agentKind}
            onOpenWorkspace={onOpenWorkspace}
          />
        )}
        {tab === "flow" && (
          <Suspense fallback={<div className="workspace-loading">正在加载流程图…</div>}>
            <FlowTab snapshot={flow} agents={agents} />
          </Suspense>
        )}
        {tab === "review" && <ReviewTab decisions={reviewDecisions} runs={flow?.runs ?? []} />}
        {tab === "recovery" && <RecoveryTab actions={recoveryActions} runs={flow?.runs ?? []} />}
        {tab === "memory" && <MemoryTab memories={memories} />}
        {tab === "events" && <EventsTab events={events} />}
        {tab === "terminal" && <TerminalTab text={terminalText} />}
        {tab === "files" && <FilesTab files={files} onOpenDiff={() => setTab("diff")} />}
        {tab === "diff" && <DiffTab files={files} />}
        {tab === "approvals" && <ApprovalsTab approvals={approvals} />}
        {tab === "usage" && <UsageTab taskId={taskId} />}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count?: number }) {
  return (
    <button className={`tab-btn ${active ? "active" : ""}`} onClick={onClick}>
      {label}
      {!!count && <span className="badge">{count}</span>}
    </button>
  );
}
