import type { DomainEvent, Subtask, TaskFlowSnapshot, TaskRun } from "../../api/types";
import type { AgentInfo } from "./flowLayout";

// 流程页的「时间线」：一个子任务一条泳道（最左边是任务本身 / 总管家），从上往下按时间排列每条泳道里发生的事。
// 跟「结构」图（按依赖从左到右）用同一份 TaskFlowSnapshot，不需要后端额外数据。

export type TimelineNodeKind =
  | "start" // 一次运行开始
  | "handoff" // 换了 Agent / 模型接着做
  | "retry"
  | "message" // Agent 回复（连续几条合成一个）
  | "user" // 用户追加的消息
  | "file" // 改文件（连续几次合成一个）
  | "terminal" // 命令输出（连续几段合成一个）
  | "approval" // 等你审批
  | "approved"
  | "rejected"
  | "artifact"
  | "review_pass"
  | "review_reject"
  | "recovery"
  | "done"
  | "failed"
  | "stopped";

export interface TimelineLane {
  /** 子任务 id；任务本身那条是 TIMELINE_TASK_LANE。 */
  id: string;
  title: string;
  agentLabel: string;
  modelLabel: string | null;
  status: string;
}

export interface TimelineNode {
  id: string;
  lane: number;
  row: number;
  kind: TimelineNodeKind;
  label: string;
  /** 鼠标悬停时显示的详细说明。 */
  detail: string;
  at: string;
  count: number;
}

export interface TimelineLink {
  from: string;
  to: string;
  kind: "dispatch" | "dependency" | "merge";
}

export interface FlowTimeline {
  lanes: TimelineLane[];
  nodes: TimelineNode[];
  links: TimelineLink[];
  rows: number;
}

export const TIMELINE_TASK_LANE = "task";
/** 和服务端 subtaskPlannerService 的 PLAN_SUMMARY_PROMPT 一致：自动加在最后的「汇总结果」子任务。 */
const PLAN_SUMMARY_PROMPT = "__xgent_plan_summary__";

const MERGEABLE: TimelineNodeKind[] = ["message", "file", "terminal"];
const FINISHED = new Set(["done", "completed", "succeeded", "success"]);
const FAILED = new Set(["failed", "error", "timed_out"]);
const STOPPED = new Set(["stopped", "cancelled", "canceled", "interrupted"]);

function time(value: string | null | undefined): number {
  const parsed = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function shortPath(value: string): string {
  const parts = value.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.slice(-2).join("/") || value;
}

function clip(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function agentName(agents: Map<string, AgentInfo>, id: string | null | undefined): string {
  if (!id) return "未分配";
  return agents.get(id)?.name ?? id;
}

function modelName(agents: Map<string, AgentInfo>, run: TaskRun | null, fallbackAgent?: string | null): string | null {
  if (run?.model) return run.model;
  const agent = agents.get(run?.agentId ?? fallbackAgent ?? "");
  return agent?.defaultModel ?? null;
}

interface RawItem {
  lane: number;
  kind: TimelineNodeKind;
  label: string;
  detail: string;
  at: string;
  order: number;
  /** 用来接跨泳道连线：这条泳道里第一次运行开始 / 最后一次运行结束。 */
  marker?: "laneStart" | "laneEnd";
  runId?: string;
}

/** 把快照整理成泳道和节点。连续的同类小事件（回复、改文件、命令输出）合成一个节点，避免一条线长得看不过来。 */
export function buildFlowTimeline(snapshot: TaskFlowSnapshot, agents: Map<string, AgentInfo> = new Map()): FlowTimeline {
  // 跟结构图一致：总管家那一轮（没有 parentSubtaskId）并进最左边的任务泳道。
  const subtasks = snapshot.subtasks.filter((subtask) => subtask.parentSubtaskId);
  const laneOfSubtask = new Map<string, number>(subtasks.map((subtask, index) => [subtask.id, index + 1]));
  const runsById = new Map(snapshot.runs.map((run) => [run.id, run]));
  const laneOfRun = (run: TaskRun | undefined | null) => (run?.subtaskId && laneOfSubtask.get(run.subtaskId)) || 0;
  const runsByLane = new Map<number, TaskRun[]>();
  for (const run of [...snapshot.runs].sort((a, b) => time(a.startedAt) - time(b.startedAt))) {
    const lane = laneOfRun(run);
    (runsByLane.get(lane) ?? runsByLane.set(lane, []).get(lane)!).push(run);
  }
  const lastRun = (lane: number) => runsByLane.get(lane)?.at(-1) ?? null;

  const taskAgent = snapshot.task.agentId;
  const lanes: TimelineLane[] = [
    {
      id: TIMELINE_TASK_LANE,
      title: subtasks.length ? "总管家" : snapshot.task.title,
      agentLabel: agentName(agents, lastRun(0)?.agentId ?? taskAgent),
      modelLabel: modelName(agents, lastRun(0), taskAgent) ?? snapshot.task.model ?? null,
      status: snapshot.task.status,
    },
    ...subtasks.map((subtask: Subtask, index) => {
      const run = lastRun(index + 1);
      return {
        id: subtask.id,
        title: subtask.title,
        agentLabel: agentName(agents, run?.agentId ?? subtask.assignedAgentId),
        modelLabel: modelName(agents, run, subtask.assignedAgentId),
        status: subtask.status,
      };
    }),
  ];

  const raw: RawItem[] = [];
  let order = 0;
  const push = (item: Omit<RawItem, "order">) => raw.push({ ...item, order: order++ });

  // 每次运行是怎么来的（run.started 里记着来源）：重试、转交给别的 Agent、用户追加消息，还是第一次派发。
  const sourceOfRun = new Map<string, string>();
  for (const event of snapshot.domainEvents) {
    if (event.name === "run.started" && event.runId) sourceOfRun.set(event.runId, String((event.payload as { source?: string } | null)?.source ?? ""));
  }

  // 每次运行最后一条 Agent 回复：失败时没有 error 字段，就用它当说明（自定义 CLI 的报错写在回复里）。
  const lastReplyOfRun = new Map<string, string>();
  for (const event of snapshot.domainEvents) {
    const payload = event.payload as { role?: string; content?: string } | null;
    if (event.name === "task.message.created" && event.runId && payload?.role !== "user" && typeof payload?.content === "string") lastReplyOfRun.set(event.runId, payload.content);
  }

  // 每次运行的开始和结束。
  for (const [lane, runs] of runsByLane) {
    runs.forEach((run, index) => {
      const previous = index > 0 ? runs[index - 1]! : null;
      const who = `${agentName(agents, run.agentId)}${run.model ? ` · ${run.model}` : ""}`;
      const source = sourceOfRun.get(run.id) ?? "";
      const isHandoff = source === "agent_handoff" || (!source && previous !== null && previous.agentId !== run.agentId);
      // 上一轮停止 / 失败后又在同一列跑起来，就是重试（重试拆分任务时来源记的是「子任务派发」）。
      const isRetry = source === "retry" || (!isHandoff && previous !== null && ["failed", "stopped", "timed_out", "cancelled"].includes(previous.status as string));
      const isFollowUp = !isHandoff && !isRetry && previous !== null;
      push({
        lane,
        kind: isHandoff ? "handoff" : isRetry ? "retry" : "start",
        label: isHandoff
          ? `交接 → ${agentName(agents, run.agentId)}`
          : isRetry
            ? `重试 · ${agentName(agents, run.agentId)}`
            : `${isFollowUp ? "继续" : "开始"} · ${agentName(agents, run.agentId)}`,
        detail: `${who}\n第 ${run.attempt} 次运行`,
        at: run.startedAt,
        marker: index === 0 ? "laneStart" : undefined,
        runId: run.id,
      });
      const status = run.status as string;
      if (run.finishedAt || FINISHED.has(status) || FAILED.has(status) || STOPPED.has(status)) {
        const kind: TimelineNodeKind = FAILED.has(status) || run.error ? "failed" : STOPPED.has(status) ? "stopped" : "done";
        push({
          lane,
          kind,
          label: kind === "failed" ? (status === "timed_out" ? "超时" : "失败") : kind === "stopped" ? "已停止" : "完成",
          detail: run.error ? clip(run.error, 300) : kind === "failed" && lastReplyOfRun.has(run.id) ? clip(lastReplyOfRun.get(run.id)!, 300) : who,
          at: run.finishedAt ?? run.startedAt,
          marker: index === runs.length - 1 ? "laneEnd" : undefined,
          runId: run.id,
        });
      }
    });
  }

  // 没挂在某次运行上的消息（任务内容、「派发子任务给 X」这类通知）：归到前后 2 秒内开始的那次运行。
  const runNear = (at: string): TaskRun | undefined => {
    let best: TaskRun | undefined;
    let bestGap = 2000;
    for (const run of snapshot.runs) {
      const gap = Math.abs(time(run.startedAt) - time(at));
      if (gap <= bestGap) { best = run; bestGap = gap; }
    }
    return best;
  };

  for (const event of snapshot.domainEvents as DomainEvent[]) {
    const run = event.runId ? runsById.get(event.runId) : event.name === "task.message.created" ? runNear(event.createdAt) : undefined;
    // 「派发子任务给 X：「标题」」这类通知带着子任务标题，按标题对到那一列最准。
    const titled = !event.runId && event.name === "task.message.created" ? /「([^」]+)」/.exec(String((event.payload as { content?: string } | null)?.content ?? ""))?.[1] : undefined;
    const titledLane = titled ? subtasks.findIndex((subtask) => subtask.title === titled) + 1 : 0;
    const lane = titledLane > 0 ? titledLane : laneOfRun(run);
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    switch (event.name) {
      case "task.message.created": {
        const role = String(payload.role ?? "");
        const content = typeof payload.content === "string" ? payload.content : "";
        // 子任务泳道里的 user 消息是总管家派发过来的任务说明，不是用户本人发的。
        if (role === "user") push({ lane, kind: "user", label: lane === 0 ? "你" : "收到任务", detail: clip(content, 300), at: event.createdAt });
        else if (role === "assistant" || role === "agent") push({ lane, kind: "message", label: "回复", detail: clip(content, 300), at: event.createdAt });
        break;
      }
      case "task.file.changed": {
        const file = String(payload.path ?? "");
        push({ lane, kind: "file", label: shortPath(file), detail: `${payload.action ?? "修改"} ${file}`, at: event.createdAt });
        break;
      }
      case "task.terminal.chunk":
        push({ lane, kind: "terminal", label: "命令输出", detail: clip(String(payload.chunk ?? ""), 200), at: event.createdAt });
        break;
      case "approval.requested":
        push({ lane, kind: "approval", label: "等你审批", detail: clip(`${payload.command ?? ""}${payload.reason ? `
${payload.reason}` : ""}`, 300), at: event.createdAt });
        break;
      case "approval.resolved": {
        const approved = payload.status === "approved";
        push({ lane, kind: approved ? "approved" : "rejected", label: approved ? "审批通过" : "审批拒绝", detail: clip(String(payload.command ?? ""), 200), at: event.createdAt });
        break;
      }
      default:
        break;
    }
  }

  for (const artifact of snapshot.artifacts) {
    const run = artifact.runId ? runsById.get(artifact.runId) : undefined;
    push({ lane: laneOfRun(run), kind: "artifact", label: `产物 · ${shortPath(artifact.name || artifact.path || "")}`, detail: artifact.path ?? artifact.name, at: artifact.createdAt });
  }
  for (const decision of snapshot.reviewDecisions) {
    const run = decision.runId ? runsById.get(decision.runId) : undefined;
    const pass = decision.decision === "approved";
    push({ lane: laneOfRun(run), kind: pass ? "review_pass" : "review_reject", label: pass ? "验收通过" : "验收退回", detail: decision.note ?? "", at: decision.createdAt });
  }
  for (const action of snapshot.recoveryActions) {
    const run = action.runId ? runsById.get(action.runId) : undefined;
    push({ lane: laneOfRun(run), kind: "recovery", label: action.kind === "retry" ? "安排重试" : "转人工", detail: action.note ?? "", at: action.createdAt });
  }

  // 按时间排；同一时刻的保持写入顺序。开始节点排在同一时刻的其它事件前面，结束节点排在后面。
  const weight = (item: RawItem) => (item.kind === "start" || item.kind === "handoff" || item.kind === "retry" ? 0 : item.marker === "laneEnd" || item.kind === "done" || item.kind === "failed" || item.kind === "stopped" ? 2 : 1);
  raw.sort((a, b) => time(a.at) - time(b.at) || weight(a) - weight(b) || a.order - b.order);

  // 同一泳道里连续的同类小事件合成一个；只要中间没有这条泳道的别的事件就算连续。
  const nodes: TimelineNode[] = [];
  const lastInLane = new Map<number, TimelineNode>();
  const markerNode = new Map<string, string>();
  for (const item of raw) {
    const previous = lastInLane.get(item.lane);
    if (previous && previous.kind === item.kind && MERGEABLE.includes(item.kind)) {
      previous.count += 1;
      if (item.kind === "file" && !previous.detail.includes(item.detail)) previous.detail = `${previous.detail}\n${item.detail}`.split("\n").slice(-12).join("\n");
      else if (item.kind !== "file") previous.detail = item.detail || previous.detail;
      previous.label = item.kind === "file" ? `改了 ${previous.count} 个文件` : item.kind === "terminal" ? `命令输出 ×${previous.count}` : `回复 ×${previous.count}`;
      continue;
    }
    const node: TimelineNode = { id: `n${nodes.length}`, lane: item.lane, row: nodes.length, kind: item.kind, label: item.label, detail: item.detail, at: item.at, count: 1 };
    nodes.push(node);
    lastInLane.set(item.lane, node);
    if (item.marker) markerNode.set(`${item.marker}:${item.lane}`, node.id);
  }

  // 跨泳道连线：派发（总管家 → 各子任务开始）、依赖（上游结束 → 下游开始）、汇总（各子任务结束 → 总管家之后的那次运行）。
  const links: TimelineLink[] = [];
  const dispatchFrom = (beforeRow: number) => [...nodes].reverse().find((node) => node.lane === 0 && node.row < beforeRow);
  subtasks.forEach((subtask, index) => {
    const lane = index + 1;
    const start = markerNode.get(`laneStart:${lane}`);
    if (!start) return;
    const startRow = nodes.find((node) => node.id === start)!.row;
    const deps = subtask.dependencyIds.filter((id) => laneOfSubtask.has(id));
    const isSummary = subtask.plannedPrompt === PLAN_SUMMARY_PROMPT;
    if (isSummary) {
      const node = nodes.find((entry) => entry.id === start)!;
      node.label = `汇总 · ${node.label.replace(/^(开始|继续|重试) · /, "")}`;
    }
    let linked = false;
    for (const dep of deps) {
      const end = markerNode.get(`laneEnd:${laneOfSubtask.get(dep)}`);
      if (end) { links.push({ from: end, to: start, kind: isSummary ? "merge" : "dependency" }); linked = true; }
    }
    if (!linked) {
      const source = dispatchFrom(startRow);
      if (source) links.push({ from: source.id, to: start, kind: "dispatch" });
    }
  });
  const lastSubtaskEndRow = Math.max(-1, ...subtasks.map((_, index) => {
    const end = markerNode.get(`laneEnd:${index + 1}`);
    return end ? nodes.find((node) => node.id === end)!.row : -1;
  }));
  // 没有单独的「汇总结果」子任务时，汇总发生在总管家那一列：各子任务结束后总管家的下一次运行。
  if (lastSubtaskEndRow >= 0 && !subtasks.some((subtask) => subtask.plannedPrompt === PLAN_SUMMARY_PROMPT)) {
    const summary = nodes.find((node) => node.lane === 0 && node.row > lastSubtaskEndRow && (node.kind === "start" || node.kind === "retry" || node.kind === "handoff"));
    if (summary) {
      summary.label = `汇总 · ${summary.label.replace(/^(开始|继续|重试|交接 →) ?·? ?/, "")}`;
      subtasks.forEach((_, index) => {
        const end = markerNode.get(`laneEnd:${index + 1}`);
        if (end) links.push({ from: end, to: summary.id, kind: "merge" });
      });
    }
  }

  return { lanes, nodes, links, rows: nodes.length };
}
