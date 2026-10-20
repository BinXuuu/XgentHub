import { useEffect, useMemo, useRef, useState } from "react";
import { Background, ControlButton, Controls, ReactFlow, type NodeMouseHandler } from "@xyflow/react";
import { Maximize2, Minimize2 } from "lucide-react";
import "@xyflow/react/dist/style.css";
import type { AgentDescriptor, TaskFlowSnapshot, TaskRun } from "../../api/types";
import { buildFlowGraph, latestRunForSubtask, visibleSubtasks, type AgentInfo, type FlowGraph, TASK_NODE_ID } from "./flowLayout";
import { flowEdgeTypes, flowNodeTypes } from "./FlowNodes";
import { ArtifactRow, CheckpointList, DomainEventRow, RecoveryRow, ReviewDecisionRow, StatusPill, clip, duration } from "./flowShared";

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

function FlowDetailPanel({ snapshot, selectedId, onClose }: { snapshot: TaskFlowSnapshot; selectedId: string; onClose: () => void }) {
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
      {run ? (
        <RunDetail snapshot={snapshot} run={run} />
      ) : (
        <div className="flow-empty-column">{isTask ? "还没有运行记录" : "这个子任务还没有被派发运行"}</div>
      )}
    </div>
  );
}

export function FlowTab({ snapshot, agents = [] }: { snapshot: TaskFlowSnapshot | null; agents?: AgentDescriptor[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const agentInfo = useMemo(
    () => new Map<string, AgentInfo>(agents.map((agent) => [agent.id, { name: agent.name, defaultModel: agent.defaultModel ?? null }])),
    [agents]
  );
  const { nodes, edges } = useMemo<FlowGraph>(() => (snapshot ? buildFlowGraph(snapshot, agentInfo) : { nodes: [], edges: [] }), [snapshot, agentInfo]);

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
      </div>

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
        {selectedId && <FlowDetailPanel snapshot={snapshot} selectedId={selectedId} onClose={() => setSelectedId(null)} />}
        {visibleSubtasks(snapshot).length === 0 && (
          <div className="flow-canvas-hint">这个任务还没有拆分子任务，图上只有任务节点本身。</div>
        )}
      </div>
    </div>
  );
}
