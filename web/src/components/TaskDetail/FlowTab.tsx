import { useEffect, useMemo, useRef, useState } from "react";
import { Background, ControlButton, Controls, ReactFlow, type NodeMouseHandler } from "@xyflow/react";
import { Maximize2, Minimize2 } from "lucide-react";
import "@xyflow/react/dist/style.css";
import type { AgentDescriptor, Subtask, TaskFlowSnapshot, TaskRun } from "../../api/types";
import { api } from "../../api/client";
import { buildFlowGraph, latestRunForSubtask, visibleSubtasks, type AgentInfo, type FlowGraph, TASK_NODE_ID } from "./flowLayout";
import { flowEdgeTypes, flowNodeTypes } from "./FlowNodes";
import { buildFlowTimeline, TIMELINE_TASK_LANE } from "./flowTimeline";
import { FlowTimelineView } from "./FlowTimelineView";
import { ArtifactRow, CheckpointList, DomainEventRow, RecoveryRow, ReviewDecisionRow, StatusPill, clip, duration, fmtTokens, sumRunTokens } from "./flowShared";

function latestPrimaryRun(snapshot: TaskFlowSnapshot): TaskRun | null {
  let latest: TaskRun | null = null;
  for (const run of snapshot.runs) {
    if (run.subtaskId) continue;
    if (!latest || new Date(run.startedAt).getTime() > new Date(latest.startedAt).getTime()) latest = run;
  }
  return latest;
}

function RunDetail({ snapshot, run }: { snapshot: TaskFlowSnapshot; run: TaskRun }) {
  const events = snapshot.domainEvents.filter((event) => event.runId === run.id);
  const terminalText = events
    .filter((event) => event.name === "task.terminal.chunk")
    .map((event) => (event.payload as { chunk?: string } | null)?.chunk ?? "")
    .join("");
  const otherEvents = events.filter((event) => event.name !== "task.terminal.chunk").slice(-20);
  const artifacts = snapshot.artifacts.filter((artifact) => artifact.runId === run.id);
  const reviewDecisions = snapshot.reviewDecisions.filter((decision) => decision.runId === run.id);
  const recoveryActions = snapshot.recoveryActions.filter((action) => action.runId === run.id);
  const checkpoints = snapshot.runCheckpoints[run.id] ?? [];

  return (
    <div className="flow-detail-body">
      <div className="flow-node-meta">
        <span>{run.agentId}</span>
        {run.model && <span>{run.model}</span>}
        <span>{run.runtimeKind}</span>
        <span>{duration(run)}</span>
        <span>第 {run.attempt} 次运行</span>
      </div>
      {run.error && <p className="flow-error">{run.error}</p>}
      <CheckpointList checkpoints={checkpoints} />

      {terminalText && (
        <div className="flow-detail-section">
          <div className="flow-detail-section-title">终端输出</div>
          <pre className="flow-detail-terminal">{clip(terminalText, 4000)}</pre>
        </div>
      )}

      {artifacts.length > 0 && (
        <div className="flow-detail-section">
          <div className="flow-detail-section-title">产物（{artifacts.length}）</div>
          {artifacts.map((artifact) => (
            <ArtifactRow key={artifact.id} artifact={artifact} run={run} />
          ))}
        </div>
      )}

      {(reviewDecisions.length > 0 || recoveryActions.length > 0) && (
        <div className="flow-detail-section">
          <div className="flow-detail-section-title">验收 / 恢复</div>
          {reviewDecisions.map((decision) => (
            <ReviewDecisionRow key={decision.id} decision={decision} run={run} />
          ))}
          {recoveryActions.map((action) => (
            <RecoveryRow key={action.id} action={action} run={run} />
          ))}
        </div>
      )}

      {otherEvents.length > 0 && (
        <div className="flow-detail-section">
          <div className="flow-detail-section-title">事件（{otherEvents.length}）</div>
          {otherEvents.map((event) => (
            <DomainEventRow key={event.id} event={event} />
          ))}
        </div>
      )}

      {!terminalText && otherEvents.length === 0 && artifacts.length === 0 && (
        <div className="flow-empty-column">这次运行还没有记录到内容</div>
      )}
    </div>
  );
}

const SUMMARY_PROMPT = "__xgent_plan_summary__";

/** 重做这一步会连带重跑哪些：顺着依赖往下找到的后续步骤，加上最后的汇总（和服务端 redoSubtask 一致）。 */
function redoFollowers(snapshot: TaskFlowSnapshot, target: Subtask): Subtask[] {
  const planned = snapshot.subtasks.filter((item) => item.parentSubtaskId);
  const affected = new Set([target.id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const item of planned) {
      if (!affected.has(item.id) && item.dependencyIds.some((id) => affected.has(id))) {
        affected.add(item.id);
        grew = true;
      }
    }
  }
  return planned.filter((item) => item.id !== target.id && (affected.has(item.id) || item.plannedPrompt === SUMMARY_PROMPT));
}

function RedoForm({ snapshot, subtask, agents }: { snapshot: TaskFlowSnapshot; subtask: Subtask; agents: AgentDescriptor[] }) {
  const [note, setNote] = useState("");
  const [agentId, setAgentId] = useState(subtask.assignedAgentId ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { setAgentId(subtask.assignedAgentId ?? ""); setMessage(null); setNote(""); }, [subtask.id, subtask.assignedAgentId]);
  const isSummary = subtask.plannedPrompt === SUMMARY_PROMPT;
  const followers = redoFollowers(snapshot, subtask);
  const running = [subtask, ...followers].some((item) => item.status === "running" || item.status === "needs_approval");
  const usable = agents.filter((agent) => agent.configured);

  async function submit() {
    setBusy(true);
    setMessage(null);
    try {
      await api.redoSubtask(snapshot.task.id, subtask.id, { note: note.trim() || undefined, agentId: agentId || null });
      setMessage({ ok: true, text: isSummary ? "已安排重新汇总。" : "已安排重做，进度可以在时间线上看。" });
      setNote("");
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flow-detail-section flow-redo">
      <div className="flow-detail-section-title">{isSummary ? "重新汇总" : "重做这一步"}</div>
      {!isSummary && (
        <>
          <textarea className="field" rows={3} placeholder="修改要求（可选），比如：配色改成深色，按钮再大一点" value={note} onChange={(event) => setNote(event.target.value)} />
          <label className="flow-redo-agent">
            <span>交给</span>
            <select className="field" value={agentId} onChange={(event) => setAgentId(event.target.value)}>
              {!usable.some((agent) => agent.id === agentId) && agentId && <option value={agentId}>{agentId}</option>}
              {usable.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
            </select>
          </label>
        </>
      )}
      <p className="flow-redo-hint">
        {followers.length
          ? `完成后会跟着重跑：${followers.map((item) => (item.plannedPrompt === SUMMARY_PROMPT ? "汇总结果" : item.title)).join("、")}。其它步骤保留原来的结果。`
          : "其它步骤保留原来的结果。"}
      </p>
      {running && <p className="flow-redo-hint">这一步或它后面的步骤还在运行，等结束（或先停止）后再重做。</p>}
      {message && <p className={message.ok ? "flow-redo-ok" : "flow-error"}>{message.text}</p>}
      <button className="btn btn-primary btn-sm" type="button" disabled={busy || running} onClick={() => void submit()}>
        {busy ? "安排中..." : isSummary ? "重新汇总" : "重做这一步"}
      </button>
    </div>
  );
}

function FlowDetailPanel({ snapshot, selectedId, agents, onClose }: { snapshot: TaskFlowSnapshot; selectedId: string; agents: AgentDescriptor[]; onClose: () => void }) {
  const isTask = selectedId === TASK_NODE_ID;
  const subtask = isTask ? null : snapshot.subtasks.find((item) => item.id === selectedId) ?? null;
  const run = isTask ? latestPrimaryRun(snapshot) : subtask ? latestRunForSubtask(snapshot, subtask.id) : null;
  const title = isTask ? snapshot.task.title : subtask?.title ?? "未知节点";
  const status = isTask ? snapshot.task.status : subtask?.status;

  return (
    <div className="flow-detail-panel">
      <div className="flow-detail-head">
        <div>
          <span className="flow-node-kind">{isTask ? "TASK" : "SUBTASK"}</span>
          <strong title={title}>{title}</strong>
        </div>
        <button className="btn btn-ghost btn-sm" type="button" onClick={onClose}>
          关闭
        </button>
      </div>
      {status && <StatusPill status={status} />}
      {isTask && <p className="flow-detail-prompt">{clip(snapshot.task.prompt, 400)}</p>}
      {subtask?.parentSubtaskId && <RedoForm snapshot={snapshot} subtask={subtask} agents={agents} />}
      {run ? (
        <RunDetail snapshot={snapshot} run={run} />
      ) : (
        <div className="flow-empty-column">{isTask ? "还没有运行记录" : "这个子任务还没有被派发运行"}</div>
      )}
    </div>
  );
}

type FlowView = "timeline" | "structure";
const VIEW_KEY = "xgent.flowView";

const TOKENS_KEY = "xgent.flow.showTokens";

function storedShowTokens(): boolean {
  try {
    return localStorage.getItem(TOKENS_KEY) === "1";
  } catch {
    return false;
  }
}

function storedView(): FlowView | null {
  try {
    const value = localStorage.getItem(VIEW_KEY);
    return value === "timeline" || value === "structure" ? value : null;
  } catch {
    return null;
  }
}

export function FlowTab({ snapshot, agents = [] }: { snapshot: TaskFlowSnapshot | null; agents?: AgentDescriptor[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 默认：记住上次选的；没选过时运行中看时间线，其它时候看结构。
  const [view, setView] = useState<FlowView | null>(storedView);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showTokens, setShowTokens] = useState(storedShowTokens);
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const agentInfo = useMemo(
    () => new Map<string, AgentInfo>(agents.map((agent) => [agent.id, { name: agent.name, defaultModel: agent.defaultModel ?? null }])),
    [agents]
  );
  const { nodes, edges } = useMemo<FlowGraph>(
    () => (snapshot ? buildFlowGraph(snapshot, agentInfo, showTokens) : { nodes: [], edges: [] }),
    [snapshot, agentInfo, showTokens]
  );
  const tokensByRunEnd = useMemo(() => {
    if (!showTokens || !snapshot) return undefined;
    const map = new Map<string, number>();
    for (const run of snapshot.runs) if (run.finishedAt && run.usage) map.set(run.finishedAt, (map.get(run.finishedAt) ?? 0) + run.usage.totalTokens);
    return map;
  }, [snapshot, showTokens]);
  const totalTokens = snapshot ? sumRunTokens(snapshot.runs) : null;
  const timeline = useMemo(() => (snapshot ? buildFlowTimeline(snapshot, agentInfo) : null), [snapshot, agentInfo]);
  const running = snapshot?.task.status === "running" || snapshot?.task.status === "needs_approval";
  // 没选过时按打开那一刻定默认（运行中看时间线），之后状态变了也不自动跳，免得正看着界面自己切走。
  const defaultView = useRef<FlowView | null>(null);
  if (!defaultView.current && snapshot) defaultView.current = running ? "timeline" : "structure";
  const activeView: FlowView = view ?? defaultView.current ?? "timeline";

  function toggleTokens(next: boolean) {
    setShowTokens(next);
    try { localStorage.setItem(TOKENS_KEY, next ? "1" : "0"); } catch { /* 存不了就只在这次有效 */ }
  }

  function chooseView(next: FlowView) {
    setView(next);
    try { localStorage.setItem(VIEW_KEY, next); } catch { /* 存不了就只在这次有效 */ }
  }

  const onNodeClick: NodeMouseHandler = (_event, node) => {
    setSelectedId((prev) => (prev === node.id ? null : node.id));
  };

  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void canvasWrapRef.current?.requestFullscreen();
    }
  }

  if (!snapshot) return <div className="empty-state flow-empty">加载中...</div>;

  const approvalIds = new Set(
    snapshot.domainEvents
      .filter((event) => event.name.startsWith("approval."))
      .map((event) => (event.payload as { id?: string } | null)?.id ?? event.id)
  );

  return (
    <div className="flow-tab">
      <div className="flow-summary">
        <div className="flow-metric">
          <span>子任务</span>
          <strong>{visibleSubtasks(snapshot).length}</strong>
        </div>
        <div className="flow-metric">
          <span>运行</span>
          <strong>{snapshot.runs.length}</strong>
        </div>
        <div className="flow-metric">
          <span>审批</span>
          <strong>{approvalIds.size}</strong>
        </div>
        <div className="flow-metric">
          <span>恢复</span>
          <strong>{snapshot.recoveryActions.length}</strong>
        </div>
        <div className="flow-metric">
          <span>验收</span>
          <strong>{snapshot.reviewDecisions.length}</strong>
        </div>
        <div className="flow-metric">
          <span>产物</span>
          <strong>{snapshot.artifacts.length}</strong>
        </div>
        <div className="flow-metric">
          <span>事件</span>
          <strong>{snapshot.domainEvents.length}</strong>
        </div>
        {showTokens && (
          <div className="flow-metric" title="所有运行用掉的 token 合计（输入 + 缓存命中 + 输出）；不报用量的 Agent 不计入">
            <span>Token</span>
            <strong>{totalTokens === null ? "—" : fmtTokens(totalTokens)}</strong>
          </div>
        )}
      </div>

      <div className="flow-view-switch" role="tablist" aria-label="流程视图">
        <button type="button" role="tab" aria-selected={activeView === "timeline"} className={activeView === "timeline" ? "active" : ""} onClick={() => chooseView("timeline")}>时间线</button>
        <button type="button" role="tab" aria-selected={activeView === "structure"} className={activeView === "structure" ? "active" : ""} onClick={() => chooseView("structure")}>结构</button>
        <span>{activeView === "timeline" ? "每列一个子任务，从上往下按时间排；点节点或列头看详情" : "子任务按依赖关系从左到右排列；可拖动、缩放"}</span>
        <label className="flow-token-toggle" title="Agent 报了用量才有数字；不报用量的显示「—」">
          <input type="checkbox" checked={showTokens} onChange={(e) => toggleTokens(e.target.checked)} />
          显示 Token
        </label>
      </div>

      {activeView === "timeline" && timeline ? (
        <div className="flow-canvas-wrap flow-timeline-wrap">
          <FlowTimelineView timeline={timeline} running={running} tokensByRunEnd={tokensByRunEnd} onSelectLane={(laneId) => setSelectedId(laneId === TIMELINE_TASK_LANE ? TASK_NODE_ID : laneId)} />
          {selectedId && <FlowDetailPanel snapshot={snapshot} selectedId={selectedId} agents={agents} onClose={() => setSelectedId(null)} />}
        </div>
      ) : (
      <div className={`flow-canvas-wrap ${isFullscreen ? "flow-canvas-fullscreen" : ""}`} ref={canvasWrapRef}>
        <ReactFlow
          style={{ position: "absolute", inset: 0 }}
          nodes={nodes}
          edges={edges}
          nodeTypes={flowNodeTypes}
          edgeTypes={flowEdgeTypes}
          onNodeClick={onNodeClick}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          proOptions={{ hideAttribution: true }}
          minZoom={0.15}
          maxZoom={2}
        >
          <Background gap={24} />
          <Controls showInteractive={false}>
            <ControlButton onClick={toggleFullscreen} title={isFullscreen ? "退出全屏" : "全屏"}>
              {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </ControlButton>
          </Controls>
        </ReactFlow>
        {selectedId && <FlowDetailPanel snapshot={snapshot} selectedId={selectedId} agents={agents} onClose={() => setSelectedId(null)} />}
        {visibleSubtasks(snapshot).length === 0 && (
          <div className="flow-canvas-hint">这个任务还没有拆分子任务，图上只有任务节点本身。</div>
        )}
      </div>
      )}
    </div>
  );
}
