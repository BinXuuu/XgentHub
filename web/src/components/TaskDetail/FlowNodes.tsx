import { BaseEdge, Handle, Position, type Edge, type EdgeProps, type NodeProps } from "@xyflow/react";
import type { CoreStatus } from "../../api/types";
import { StatusPill } from "./flowShared";
import type { FlowNode, RoutedEdgeData } from "./flowLayout";

export function TaskFlowNode({ data }: NodeProps<FlowNode>) {
  return (
    <div className={`flow-graph-node flow-node flow-task-node flow-node-${data.status}`}>
      <Handle type="source" position={Position.Right} />
      <div className="flow-node-head">
        <span className="flow-node-kind">TASK</span>
        <StatusPill status={data.status as CoreStatus} />
      </div>
      <strong title={data.label}>{data.label}</strong>
      <div className="flow-node-meta">
        <span>{data.agentLabel}</span>
        {data.modelLabel && <span>{data.modelLabel}</span>}
        <span>{data.meta}</span>
      </div>
    </div>
  );
}

export function SubtaskFlowNode({ data }: NodeProps<FlowNode>) {
  return (
    <div className={`flow-graph-node flow-node flow-node-${data.status} flow-node-clickable`}>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      <div className="flow-node-head">
        <span className="flow-node-kind">SUBTASK</span>
        <StatusPill status={data.status as CoreStatus} />
      </div>
      <strong title={data.label}>{data.label}</strong>
      <div className="flow-node-meta">
        <span>{data.agentLabel}</span>
        {data.modelLabel && <span>{data.modelLabel}</span>}
      </div>
      <div className="flow-node-meta">
        <span>{data.meta}</span>
      </div>
    </div>
  );
}

export const flowNodeTypes = {
  taskNode: TaskFlowNode,
  subtaskNode: SubtaskFlowNode,
};

/**
 * 跨了好几列的连线：从起点出发，依次穿过中间各列给它留的过道（data.points 里每列一进一出两个点），
 * 再连到终点。列与列之间用水平切线的贝塞尔曲线，看起来和普通连线一致，但不会从别的节点底下穿过去。
 */
export function RoutedEdge({ id, sourceX, sourceY, targetX, targetY, data, markerEnd, style }: EdgeProps<Edge<RoutedEdgeData>>) {
  const points = [{ x: sourceX, y: sourceY }, ...(data?.points ?? []), { x: targetX, y: targetY }];
  let path = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1]!;
    const to = points[i]!;
    // 偶数段是过道内部（同一列的进、出点之间），画直线；其余是列间，画曲线。
    if (i % 2 === 0) {
      path += ` L ${to.x} ${to.y}`;
    } else {
      const half = (to.x - from.x) / 2;
      path += ` C ${from.x + half} ${from.y}, ${to.x - half} ${to.y}, ${to.x} ${to.y}`;
    }
  }
  return <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />;
}

export const flowEdgeTypes = {
  routed: RoutedEdge,
};
