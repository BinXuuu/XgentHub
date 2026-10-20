import { MarkerType, Position, type Edge, type Node } from "@xyflow/react";
import type { Subtask, TaskFlowSnapshot, TaskRun } from "../../api/types";

export const TASK_NODE_ID = "task";
const NODE_WIDTH = 184; // 和 .flow-graph-node 的宽度一致
const COLUMN_WIDTH = 250;
const NODE_SLOT = 108; // 一个节点占的纵向空间
const LANE_SLOT = 34; // 一条跨列连线在中间列里占的"过道"

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

/** 跨了好几列的连线在中间各列经过的位置（进入点、离开点），由 RoutedEdge 画成沿过道走的曲线。 */
export interface RoutedEdgeData {
  points: Array<{ x: number; y: number }>;
  [key: string]: unknown;
}

export interface AgentInfo {
  name: string;
  defaultModel: string | null;
}

/** 每个子任务最近一次运行（用来在节点上显示真的用了哪个 agent/model，而不是"指派给谁"这个静态字段）。 */
export function latestRunForSubtask(snapshot: TaskFlowSnapshot, subtaskId: string): TaskRun | null {
  let latest: TaskRun | null = null;
  for (const run of snapshot.runs) {
    if (run.subtaskId !== subtaskId) continue;
    if (!latest || new Date(run.startedAt).getTime() > new Date(latest.startedAt).getTime()) latest = run;
  }
  return latest;
}

/** 图上显示的子任务：总管家那一轮（没有 parentSubtaskId 的主子任务）并进最左边的任务节点，不再单独画一个同名节点。 */
export function visibleSubtasks(snapshot: TaskFlowSnapshot): Subtask[] {
  return snapshot.subtasks.filter((subtask) => subtask.parentSubtaskId);
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: Edge[];
}

function modelText(model: string | null | undefined, agent: AgentInfo | undefined): string | null {
  if (model) return model;
  return agent?.defaultModel ? `默认（${agent.defaultModel}）` : "默认模型";
}

/**
 * 简化版分层布局：
 * 1. 按依赖深度分列（没依赖的在第 1 列，依赖别人的在它依赖的最深那个后一列）；
 * 2. 跨了好几列的连线，在中间每一列都占一个"过道"位置，连线从过道穿过，不会从别的节点底下穿过去；
 * 3. 同一列里按上下游的平均位置排序几轮，减少连线交叉。
 * 子任务一般是个位数，不需要 dagre / elkjs 这类库。
 */
export function buildFlowGraph(snapshot: TaskFlowSnapshot, agents: Map<string, AgentInfo> = new Map()): FlowGraph {
  const subtasks = visibleSubtasks(snapshot);
  const byId = new Map(subtasks.map((item) => [item.id, item]));
  const depsOf = (subtask: Subtask) => subtask.dependencyIds.filter((id) => byId.has(id));
  const depthCache = new Map<string, number>();

  function depthOf(id: string, trail: Set<string>): number {
    const cached = depthCache.get(id);
    if (cached !== undefined) return cached;
    const subtask = byId.get(id);
    const deps = subtask ? depsOf(subtask) : [];
    if (!subtask || deps.length === 0 || trail.has(id)) {
      depthCache.set(id, 1);
      return 1;
    }
    const nextTrail = new Set(trail).add(id);
    const depth = 1 + Math.max(...deps.map((depId) => depthOf(depId, nextTrail)));
    depthCache.set(id, depth);
    return depth;
  }

  // 每列里的条目：真实节点，或一条跨列连线经过这一列的过道。
  type Item = { id: string; kind: "node" } | { id: string; kind: "lane"; edgeId: string };
  const layers: Item[][] = [[{ id: TASK_NODE_ID, kind: "node" }]];
  const depthById = new Map<string, number>([[TASK_NODE_ID, 0]]);
  for (const subtask of subtasks) {
    const depth = depthOf(subtask.id, new Set());
    depthById.set(subtask.id, depth);
    (layers[depth] ??= []).push({ id: subtask.id, kind: "node" });
  }
  for (let i = 0; i < layers.length; i++) layers[i] ??= [];

  interface LogicalEdge {
    id: string;
    source: string;
    target: string;
    lanes: string[]; // 经过的过道 id，按列从左到右
    animated: boolean;
  }
  const logicalEdges: LogicalEdge[] = [];
  // 图上的相邻关系（包括过道），排序时用
  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    (succs.get(a) ?? succs.set(a, []).get(a)!).push(b);
    (preds.get(b) ?? preds.set(b, []).get(b)!).push(a);
  };

  for (const subtask of subtasks) {
    const sources = depsOf(subtask).length ? depsOf(subtask) : [TASK_NODE_ID];
    for (const source of sources) {
      const edgeId = `${source}->${subtask.id}`;
      const from = depthById.get(source) ?? 0;
      const to = depthById.get(subtask.id) ?? 1;
      const lanes: string[] = [];
      let previous = source;
      for (let column = from + 1; column < to; column++) {
        const laneId = `${edgeId}#${column}`;
        layers[column]!.push({ id: laneId, kind: "lane", edgeId });
        lanes.push(laneId);
        link(previous, laneId);
        previous = laneId;
      }
      link(previous, subtask.id);
      logicalEdges.push({ id: edgeId, source, target: subtask.id, lanes, animated: subtask.status === "running" });
    }
  }

  // 按上下游平均位置排序（重心法），来回扫几轮。
  const order = new Map<string, number>();
  const refreshOrder = () => layers.forEach((layer) => layer.forEach((item, index) => order.set(item.id, index)));
  refreshOrder();
  const barycenter = (ids: string[] | undefined, fallback: number) =>
    ids && ids.length ? ids.reduce((sum, id) => sum + (order.get(id) ?? 0), 0) / ids.length : fallback;
  for (let pass = 0; pass < 4; pass++) {
    for (let column = 1; column < layers.length; column++) {
      layers[column]!.sort((a, b) => barycenter(preds.get(a.id), order.get(a.id)!) - barycenter(preds.get(b.id), order.get(b.id)!));
      refreshOrder();
    }
    for (let column = layers.length - 2; column >= 1; column--) {
      layers[column]!.sort((a, b) => barycenter(succs.get(a.id), order.get(a.id)!) - barycenter(succs.get(b.id), order.get(b.id)!));
      refreshOrder();
    }
  }

  // 纵向坐标：每列各自上下居中。
  const slotOf = (item: Item) => (item.kind === "node" ? NODE_SLOT : LANE_SLOT);
  const columnHeight = (layer: Item[]) => layer.reduce((sum, item) => sum + slotOf(item), 0);
  const tallest = Math.max(NODE_SLOT, ...layers.map(columnHeight));
  const topById = new Map<string, number>();
  layers.forEach((layer) => {
    let y = (tallest - columnHeight(layer)) / 2;
    for (const item of layer) {
      topById.set(item.id, y);
      y += slotOf(item);
    }
  });

  const nodes: FlowNode[] = [];
  const taskAgent = agents.get(snapshot.task.agentId);
  nodes.push({
    id: TASK_NODE_ID,
    type: "taskNode",
    position: { x: 0, y: topById.get(TASK_NODE_ID) ?? 0 },
    data: {
      kind: "task",
      label: snapshot.task.title,
      status: snapshot.task.status,
      agentLabel: taskAgent?.name ?? snapshot.task.agentKind,
      modelLabel: modelText(snapshot.task.model, taskAgent),
      meta: fmtCreatedAt(snapshot.task.createdAt),
    },
    sourcePosition: Position.Right,
    draggable: true,
  });

  for (const subtask of subtasks) {
    const run = latestRunForSubtask(snapshot, subtask.id);
    const agentId = run?.agentId ?? subtask.assignedAgentId ?? "";
    const agent = agents.get(agentId);
    nodes.push({
      id: subtask.id,
      type: "subtaskNode",
      position: { x: (depthById.get(subtask.id) ?? 1) * COLUMN_WIDTH, y: topById.get(subtask.id) ?? 0 },
      data: {
        kind: "subtask",
        label: subtask.title,
        status: subtask.status,
        agentLabel: agent?.name ?? (agentId || "未分配"),
        modelLabel: modelText(run?.model, agent),
        meta: run ? `运行 #${run.attempt}` : "尚未运行",
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      draggable: true,
    });
  }

  // 节点的连接点大约在节点纵向中间（节点实际高度约 82px）。
  const HANDLE_Y = 41;
  const edges: Edge[] = logicalEdges.map((edge) => {
    const base = {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      animated: edge.animated,
      markerEnd: { type: MarkerType.ArrowClosed },
    };
    if (edge.lanes.length === 0) return { ...base, type: "default" };
    const points = edge.lanes.flatMap((laneId) => {
      const column = Number(laneId.slice(laneId.lastIndexOf("#") + 1));
      const y = (topById.get(laneId) ?? 0) + Math.min(LANE_SLOT / 2, HANDLE_Y);
      return [
        { x: column * COLUMN_WIDTH - 6, y },
        { x: column * COLUMN_WIDTH + NODE_WIDTH + 6, y },
      ];
    });
    return { ...base, type: "routed", data: { points } satisfies RoutedEdgeData };
  });

  return { nodes, edges };
}

function fmtCreatedAt(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}
