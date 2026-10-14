import { MarkerType, Position, type Edge, type Node } from "@xyflow/react";
import type { Subtask, TaskFlowSnapshot, TaskRun } from "../../api/types";

export const TASK_NODE_ID = "task";
const COLUMN_WIDTH = 220;
const ROW_HEIGHT = 108;

export interface FlowNodeData {
  kind: "task" | "subtask";
  label: string;
  status: string;
  agentLabel: string;
  modelLabel: string | null;
  meta: string;
  [key: string]: unknown;
}

export type FlowNode = Node<FlowNodeData>;

/** 每个子任务最近一次运行（用来在节点上显示真的用了哪个 agent/model，而不是"指派给谁"这个静态字段）。 */
export function latestRunForSubtask(snapshot: TaskFlowSnapshot, subtaskId: string): TaskRun | null {
  let latest: TaskRun | null = null;
  for (const run of snapshot.runs) {
    if (run.subtaskId !== subtaskId) continue;
    if (!latest || new Date(run.startedAt).getTime() > new Date(latest.startedAt).getTime()) latest = run;
  }
  return latest;
}

/**
 * 把 TaskFlowSnapshot 转成 React Flow 能直接渲染的 nodes/edges。不用 dagre/elkjs 这类自动布局库——
 * 子任务数量一般是个位数，用"按依赖深度分层、同层纵向排开"这个简单算法就够了。
 * 深度规则：没有 dependencyIds 的子任务挂在任务根节点正右边（深度 1）；
 * 依赖了别的子任务的，深度 = 1 + 它依赖的子任务里最大的深度。
 */
export interface FlowGraph {
  nodes: FlowNode[];
  edges: Edge[];
}

export function buildFlowGraph(snapshot: TaskFlowSnapshot): FlowGraph {
  const subtasks = snapshot.subtasks;
  const byId = new Map(subtasks.map((item) => [item.id, item]));
  const depthCache = new Map<string, number>();

  function depthOf(id: string, trail: Set<string>): number {
    const cached = depthCache.get(id);
    if (cached !== undefined) return cached;
    const subtask = byId.get(id);
    if (!subtask || subtask.dependencyIds.length === 0 || trail.has(id)) {
      depthCache.set(id, 1);
      return 1;
    }
    const nextTrail = new Set(trail).add(id);
    const depth = 1 + Math.max(...subtask.dependencyIds.map((depId) => depthOf(depId, nextTrail)));
    depthCache.set(id, depth);
    return depth;
  }

  const columns = new Map<number, Subtask[]>();
  for (const subtask of subtasks) {
    const depth = depthOf(subtask.id, new Set());
    const list = columns.get(depth) ?? [];
    list.push(subtask);
    columns.set(depth, list);
  }
  const maxRows = Math.max(1, ...[...columns.values()].map((list) => list.length));

  const nodes: FlowNode[] = [
    {
      id: TASK_NODE_ID,
      type: "taskNode",
      position: { x: 0, y: ((maxRows - 1) * ROW_HEIGHT) / 2 },
      data: {
        kind: "task",
        label: snapshot.task.title,
        status: snapshot.task.status,
        agentLabel: snapshot.task.agentKind,
        modelLabel: snapshot.task.model,
        meta: fmtCreatedAt(snapshot.task.createdAt),
      },
      sourcePosition: Position.Right,
      draggable: true,
    },
  ];
  const edges: Edge[] = [];

  for (const [depth, list] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    const offsetY = ((maxRows - list.length) * ROW_HEIGHT) / 2;
    list.forEach((subtask, index) => {
      const run = latestRunForSubtask(snapshot, subtask.id);
      nodes.push({
        id: subtask.id,
        type: "subtaskNode",
        position: { x: depth * COLUMN_WIDTH, y: offsetY + index * ROW_HEIGHT },
        data: {
          kind: "subtask",
          label: subtask.title,
          status: subtask.status,
          agentLabel: subtask.assignedAgentId ?? "未分配",
          modelLabel: run?.model ?? null,
          meta: run ? `运行 #${run.attempt}` : "尚未运行",
        },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        draggable: true,
      });

      const sourceIds = subtask.dependencyIds.length ? subtask.dependencyIds : [TASK_NODE_ID];
      for (const sourceId of sourceIds) {
        edges.push({
          id: `${sourceId}->${subtask.id}`,
          source: sourceId,
          target: subtask.id,
          type: "default",
          animated: subtask.status === "running",
          markerEnd: { type: MarkerType.ArrowClosed },
        });
      }
    });
  }

  return { nodes, edges };
}

function fmtCreatedAt(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}
