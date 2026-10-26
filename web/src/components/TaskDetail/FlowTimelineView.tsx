import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import type { FlowTimeline, TimelineNode, TimelineNodeKind } from "./flowTimeline";

const MIN_LANE_WIDTH = 150;
const MAX_LANE_WIDTH = 260;
const ROW_HEIGHT = 34;
const TIME_GUTTER = 64;
const HEADER_HEIGHT = 58;
const NODE_X = 22; // 节点圆点在泳道里的横向位置

const KIND_CLASS: Record<TimelineNodeKind, string> = {
  start: "start",
  handoff: "handoff",
  retry: "retry",
  message: "minor",
  user: "user",
  file: "file",
  terminal: "minor",
  approval: "waiting",
  approved: "ok",
  rejected: "bad",
  artifact: "artifact",
  review_pass: "ok",
  review_reject: "bad",
  recovery: "retry",
  done: "ok",
  failed: "bad",
  stopped: "muted",
};

const LEGEND: Array<[string, string]> = [
  ["start", "开始"],
  ["handoff", "交接 / 换 Agent"],
  ["file", "改文件"],
  ["minor", "回复 / 命令输出"],
  ["waiting", "等你审批"],
  ["artifact", "产物"],
  ["ok", "完成 / 通过"],
  ["bad", "失败 / 退回"],
  ["retry", "重试 / 恢复"],
];

function clock(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString("zh-CN", { hour12: false });
}

function laneStatusClass(status: string): string {
  if (status === "running") return "running";
  if (status === "needs_approval" || status === "waiting" || status === "review") return "waiting";
  if (status === "done") return "ok";
  if (status === "failed" || status === "timed_out") return "bad";
  return "muted";
}

/** 时间线泳道：每列一个子任务，从上往下按时间排；跨列虚线表示派发、依赖和汇总。 */
export function FlowTimelineView({ timeline, running, onSelectLane }: { timeline: FlowTimeline; running: boolean; onSelectLane: (laneId: string) => void }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  const [available, setAvailable] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  // 列宽按可用宽度平分（150～260 像素），列多了才横向滚动。
  const laneWidth = Math.max(MIN_LANE_WIDTH, Math.min(MAX_LANE_WIDTH, Math.floor((available - TIME_GUTTER - 4) / Math.max(1, timeline.lanes.length)) || MAX_LANE_WIDTH));
  const width = TIME_GUTTER + timeline.lanes.length * laneWidth;
  const height = Math.max(timeline.rows, 1) * ROW_HEIGHT + 24;
  const nodeById = useMemo(() => new Map(timeline.nodes.map((node) => [node.id, node])), [timeline]);
  const center = (node: TimelineNode) => ({ x: TIME_GUTTER + node.lane * laneWidth + NODE_X, y: node.row * ROW_HEIGHT + ROW_HEIGHT / 2 });

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setAvailable(el.clientWidth));
    observer.observe(el);
    setAvailable(el.clientWidth);
    // 全屏的是外层容器，点节点弹出的详情面板也在里面。
    const onFullscreen = () => setFullscreen(Boolean(document.fullscreenElement) && document.fullscreenElement === rootRef.current?.parentElement);
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => { observer.disconnect(); document.removeEventListener("fullscreenchange", onFullscreen); };
  }, []);

  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void rootRef.current?.parentElement?.requestFullscreen();
  }

  // 运行中有新事件时自动滚到最下面；用户往上翻看的时候不打扰。
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && running && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [timeline.rows, running]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => { stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const laneSpans = timeline.lanes.map((_, lane) => {
    const rows = timeline.nodes.filter((node) => node.lane === lane).map((node) => node.row);
    return rows.length ? { first: Math.min(...rows), last: Math.max(...rows) } : null;
  });

  return (
    <div className={`flow-timeline${fullscreen ? " is-fullscreen" : ""}`} ref={rootRef}>
      <div className="flow-timeline-scroll" ref={scrollRef}>
        <div className="flow-timeline-header" style={{ width, gridTemplateColumns: `${TIME_GUTTER}px repeat(${timeline.lanes.length}, ${laneWidth}px)`, height: HEADER_HEIGHT }}>
          <div className="flow-timeline-corner">时间</div>
          {timeline.lanes.map((lane) => (
            <button type="button" key={lane.id} className={`flow-timeline-lane-head status-${laneStatusClass(lane.status)}`} onClick={() => onSelectLane(lane.id)} title={lane.title}>
              <strong>{lane.title}</strong>
              <span>{lane.agentLabel}{lane.modelLabel ? ` · ${lane.modelLabel}` : ""}</span>
            </button>
          ))}
        </div>
        <div className="flow-timeline-body" style={{ width, height }}>
          <svg className="flow-timeline-svg" width={width} height={height} aria-hidden="true">
            {timeline.lanes.map((lane, index) => {
              const span = laneSpans[index];
              if (!span) return null;
              const x = TIME_GUTTER + index * laneWidth + NODE_X;
              const y1 = span.first * ROW_HEIGHT + ROW_HEIGHT / 2;
              const y2 = span.last * ROW_HEIGHT + ROW_HEIGHT / 2;
              const status = laneStatusClass(lane.status);
              return (
                <g key={lane.id} className={`flow-timeline-lane-line status-${status}`}>
                  <line x1={x} x2={x} y1={y1} y2={y2} />
                  {status === "running" && <line className="flow-timeline-tail" x1={x} x2={x} y1={y2} y2={height - 6} />}
                </g>
              );
            })}
            {timeline.links.map((link) => {
              const from = nodeById.get(link.from);
              const to = nodeById.get(link.to);
              if (!from || !to) return null;
              const a = center(from);
              const b = center(to);
              const bend = Math.max(18, Math.abs(b.y - a.y) / 2);
              return <path key={`${link.from}-${link.to}`} className={`flow-timeline-link link-${link.kind}`} d={`M ${a.x} ${a.y} C ${a.x} ${a.y + bend}, ${b.x} ${b.y - bend}, ${b.x} ${b.y}`} />;
            })}
          </svg>
          {timeline.nodes.map((node, index) => {
            const previous = index > 0 ? timeline.nodes[index - 1] : null;
            const showTime = !previous || clock(previous.at) !== clock(node.at);
            const { x, y } = center(node);
            return (
              <div key={node.id}>
                {showTime && <span className="flow-timeline-time" style={{ top: y - 8 }}>{clock(node.at)}</span>}
                <button
                  type="button"
                  className={`flow-timeline-node kind-${KIND_CLASS[node.kind]}`}
                  style={{ left: x - 7, top: y - 7 }}
                  title={`${node.label}${node.detail ? `\n${node.detail}` : ""}\n${new Date(node.at).toLocaleString("zh-CN", { hour12: false })}`}
                  onClick={() => onSelectLane(timeline.lanes[node.lane]!.id)}
                  aria-label={node.label}
                />
                <span className="flow-timeline-label" style={{ left: x + 13, top: y - 9, maxWidth: laneWidth - NODE_X - 22 }} title={node.detail || node.label}>
                  {node.label}
                </span>
              </div>
            );
          })}
          {timeline.nodes.length === 0 && <div className="flow-timeline-empty">还没有运行记录</div>}
        </div>
      </div>
      <div className="flow-timeline-legend">
        {LEGEND.map(([kind, label]) => (
          <span key={kind}><i className={`flow-timeline-node kind-${kind}`} />{label}</span>
        ))}
        <span><i className="flow-timeline-legend-link" />派发 / 依赖 / 汇总</span>
        <button type="button" className="btn btn-ghost btn-sm flow-timeline-fullscreen" onClick={toggleFullscreen} title={fullscreen ? "退出全屏" : "全屏"}>
          {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
      </div>
    </div>
  );
}
