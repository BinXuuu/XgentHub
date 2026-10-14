import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { CoreStatus } from "../../api/types";
import { StatusPill } from "./flowShared";
import type { FlowNode } from "./flowLayout";

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
