import test from "node:test";
import assert from "node:assert/strict";
import { buildFlowTimeline, TIMELINE_TASK_LANE } from "../../web/src/components/TaskDetail/flowTimeline.ts";

// 一个「总管家拆成三个子任务」的任务：A、B 并行，C 依赖 A；B 第一次失败后转交给另一个 Agent；最后总管家汇总。
const t = (second: number) => new Date(Date.UTC(2026, 9, 26, 10, 0, second)).toISOString();
const run = (id: string, subtaskId: string | null, agentId: string, start: number, end: number | null, status: string, extra: object = {}) => ({
  id, taskId: "t1", subtaskId, agentId, agentKind: "codex", runtimeKind: "cli", model: null, status, attempt: 1, sessionKey: null,
  startedAt: t(start), finishedAt: end === null ? null : t(end), error: null, ...extra,
});
const event = (id: string, name: string, runId: string | null, second: number, payload: object = {}) => ({
  id, name, version: 1, taskId: "t1", runId, legacyType: null, payload, createdAt: t(second),
});
const subtask = (id: string, parent: string | null, title: string, deps: string[] = [], status = "done") => ({
  id, taskId: "t1", parentSubtaskId: parent, title, status, assignedAgentId: "codex", dependencyIds: deps, plannedPrompt: null, createdAt: t(0), updatedAt: t(0),
});

function snapshot(overrides: object = {}) {
  return {
    task: { id: "t1", title: "做一个网站", status: "done", agentId: "claude", agentKind: "claude-code", model: null, prompt: "", createdAt: t(0) },
    subtasks: [subtask("main", null, "总管家"), subtask("A", "main", "写页面"), subtask("B", "main", "写文案"), subtask("C", "main", "测试", ["A"])],
    runs: [
      run("r0", "main", "claude", 0, 2, "done"),
      run("rA", "A", "codex", 3, 10, "done"),
      run("rB1", "B", "codex", 3, 5, "failed", { error: "额度用完了" }),
      run("rB2", "B", "claude", 6, 9, "done", { attempt: 2, model: "opus" }),
      run("rC", "C", "codex", 11, 14, "done"),
      run("r1", "main", "claude", 15, 16, "done", { attempt: 2 }),
    ],
    artifacts: [{ id: "a1", taskId: "t1", runId: "rC", kind: "file", name: "report.md", path: "out/report.md", metadata: null, createdAt: t(13) }],
    agentRequests: [],
    recoveryActions: [],
    reviewDecisions: [{ id: "d1", taskId: "t1", runId: "r1", decision: "approved", note: null, createdAt: t(17) }],
    runCheckpoints: {},
    domainEvents: [
      event("e1", "task.message.created", "rA", 4, { role: "agent", content: "开始写" }),
      event("e2", "task.file.changed", "rA", 5, { path: "src/index.html", action: "created" }),
      event("e3", "task.file.changed", "rA", 6, { path: "src/style.css", action: "created" }),
      event("e4", "task.file.changed", "rA", 7, { path: "src/app.js", action: "created" }),
      event("e5", "task.terminal.chunk", "rC", 12, { chunk: "npm test" }),
      event("e6", "task.terminal.chunk", "rC", 12, { chunk: "ok" }),
      event("e7", "approval.requested", "rC", 12, { command: "rm -rf dist", reason: "删除目录" }),
      event("e8", "approval.resolved", "rC", 13, { command: "rm -rf dist", status: "approved" }),
      event("e9", "task.log.created", "rC", 13, { message: "[codex:stderr] noise" }),
      event("e10", "task.message.created", "r0", 1, { role: "user", content: "做一个网站" }),
    ],
    ...overrides,
  } as any;
}

const agents = new Map([["codex", { name: "Codex", defaultModel: "gpt-5" }], ["claude", { name: "Claude Code", defaultModel: null }]]);

test("one lane per subtask plus the task lane, with the agent and model that actually ran", () => {
  const timeline = buildFlowTimeline(snapshot(), agents);
  assert.deepEqual(timeline.lanes.map((lane) => [lane.id, lane.title, lane.agentLabel, lane.modelLabel]), [
    [TIMELINE_TASK_LANE, "总管家", "Claude Code", null],
    ["A", "写页面", "Codex", "gpt-5"],
    ["B", "写文案", "Claude Code", "opus"],
    ["C", "测试", "Codex", "gpt-5"],
  ]);
});

test("events become ordered nodes; small repeated events are merged and noise is left out", () => {
  const timeline = buildFlowTimeline(snapshot(), agents);
  const lane = (index: number) => timeline.nodes.filter((node) => node.lane === index).map((node) => node.label);
  assert.deepEqual(lane(1), ["开始 · Codex", "回复", "改了 3 个文件", "完成"]);
  assert.deepEqual(lane(2), ["开始 · Codex", "失败", "交接 → Claude Code", "完成"]);
  assert.deepEqual(lane(3), ["开始 · Codex", "命令输出 ×2", "等你审批", "审批通过", "产物 · report.md", "完成"]);
  assert.deepEqual(lane(0), ["开始 · Claude Code", "你", "完成", "汇总 · Claude Code", "完成", "验收通过"]);
  assert.ok(!timeline.nodes.some((node) => node.label.includes("noise")), "CLI logs are not drawn");
  assert.equal(timeline.nodes.find((node) => node.label === "失败")!.detail, "额度用完了");
  assert.match(timeline.nodes.find((node) => node.kind === "file")!.detail, /index\.html[\s\S]*app\.js/);
  // 行号就是全局时间顺序，同一泳道里从上往下递增。
  timeline.nodes.forEach((node, index) => assert.equal(node.row, index));
  for (let index = 0; index < timeline.lanes.length; index++) {
    const times = timeline.nodes.filter((node) => node.lane === index).map((node) => new Date(node.at).getTime());
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
  }
});

test("cross-lane links: dispatch from the butler, dependency A → C, and every subtask merging into the summary", () => {
  const timeline = buildFlowTimeline(snapshot(), agents);
  const label = (id: string) => {
    const node = timeline.nodes.find((entry) => entry.id === id)!;
    return `${timeline.lanes[node.lane]!.title}:${node.label}`;
  };
  const links = timeline.links.map((link) => `${link.kind} ${label(link.from)} -> ${label(link.to)}`).sort();
  assert.deepEqual(links, [
    "dependency 写页面:完成 -> 测试:开始 · Codex",
    "dispatch 总管家:完成 -> 写文案:开始 · Codex",
    "dispatch 总管家:完成 -> 写页面:开始 · Codex",
    "merge 写文案:完成 -> 总管家:汇总 · Claude Code",
    "merge 写页面:完成 -> 总管家:汇总 · Claude Code",
    "merge 测试:完成 -> 总管家:汇总 · Claude Code",
  ]);
});

test("a task without subtasks is a single lane; running runs have no end node yet", () => {
  const timeline = buildFlowTimeline(snapshot({
    task: { id: "t1", title: "改个按钮", status: "running", agentId: "codex", agentKind: "codex", model: "gpt-5", prompt: "", createdAt: t(0) },
    subtasks: [],
    runs: [run("r0", null, "codex", 0, null, "running")],
    artifacts: [],
    reviewDecisions: [],
    domainEvents: [event("e1", "task.file.changed", "r0", 2, { path: "C:\\work\\src\\button.tsx", action: "modified" })],
  }), agents);
  assert.equal(timeline.lanes.length, 1);
  assert.equal(timeline.lanes[0]!.title, "改个按钮");
  assert.deepEqual(timeline.nodes.map((node) => node.label), ["开始 · Codex", "src/button.tsx"]);
  assert.deepEqual(timeline.links, []);
});

test("run sources decide the start label: retry, handoff and a follow-up from the user", () => {
  const base = snapshot();
  const timeline = buildFlowTimeline({
    ...base,
    subtasks: [],
    runs: [run("r0", null, "codex", 0, 2, "failed"), run("r1", null, "codex", 3, 4, "done", { attempt: 2 }), run("r2", null, "codex", 5, 6, "done", { attempt: 3 }), run("r3", null, "claude", 7, 8, "done")],
    artifacts: [],
    reviewDecisions: [],
    domainEvents: [
      event("s1", "run.started", "r1", 3, { source: "retry" }),
      event("s2", "run.started", "r2", 5, { source: "user_message" }),
      event("s3", "run.started", "r3", 7, { source: "agent_handoff" }),
    ],
  }, agents);
  assert.deepEqual(timeline.nodes.filter((node) => ["start", "retry", "handoff"].includes(node.kind)).map((node) => node.label), [
    "开始 · Codex", "重试 · Codex", "继续 · Codex", "交接 → Claude Code",
  ]);
});

test("dispatched instructions read as 收到任务 in subtask lanes, and failures fall back to the last reply", () => {
  const base = snapshot();
  const timeline = buildFlowTimeline({
    ...base,
    domainEvents: [
      ...base.domainEvents,
      event("x1", "task.message.created", "rA", 3, { role: "user", content: "写落地页 HTML" }),
      event("x2", "task.message.created", "rB1", 5, { role: "agent", content: "自定义 CLI Agent 调用失败（exit code 1）" }),
    ],
    runs: base.runs.map((entry: any) => (entry.id === "rB1" ? { ...entry, error: null } : entry)),
  }, agents);
  assert.equal(timeline.nodes.find((node) => node.lane === 1 && node.kind === "user")!.label, "收到任务");
  assert.equal(timeline.nodes.find((node) => node.lane === 0 && node.kind === "user")!.label, "你");
  assert.match(timeline.nodes.find((node) => node.lane === 2 && node.kind === "failed")!.detail, /exit code 1/);
});

test("a separate 汇总结果 subtask is drawn as the merge point", () => {
  const base = snapshot();
  const summary = { ...subtask("S", "main", "汇总结果", ["B", "C"]), plannedPrompt: "__xgent_plan_summary__" };
  const timeline = buildFlowTimeline({
    ...base,
    subtasks: [...base.subtasks, summary],
    runs: [...base.runs.filter((entry: any) => entry.id !== "r1"), run("rS", "S", "claude", 15, 16, "done")],
    reviewDecisions: [],
  }, agents);
  const label = (id: string) => {
    const node = timeline.nodes.find((entry) => entry.id === id)!;
    return `${timeline.lanes[node.lane]!.title}:${node.label}`;
  };
  assert.deepEqual(timeline.links.filter((link) => link.kind === "merge").map((link) => `${label(link.from)} -> ${label(link.to)}`).sort(), [
    "写文案:完成 -> 汇总结果:汇总 · Claude Code",
    "测试:完成 -> 汇总结果:汇总 · Claude Code",
  ]);
  assert.ok(!timeline.nodes.some((node) => node.lane === 0 && node.label.startsWith("汇总")), "the butler lane is not relabelled when a summary lane exists");
});

test("messages without a run go to the run that started within 2 seconds", () => {
  const base = snapshot();
  const timeline = buildFlowTimeline({
    ...base,
    domainEvents: [
      event("m1", "task.message.created", null, 3, { role: "user", content: "派发子任务给 Codex：「写页面」" }),
      event("m2", "task.message.created", null, 0, { role: "user", content: "做一个网站" }),
      event("m3", "task.message.created", null, 40, { role: "user", content: "再改一下颜色" }),
    ],
  }, agents);
  const where = (detail: string) => {
    const node = timeline.nodes.find((entry) => entry.detail.includes(detail))!;
    return `${timeline.lanes[node.lane]!.title}:${node.label}`;
  };
  assert.equal(where("写页面"), "写页面:收到任务");
  assert.equal(where("做一个网站"), "总管家:你");
  assert.equal(where("改一下颜色"), "总管家:你", "a much later message with no run nearby stays in the task lane");
});

test("a run that follows a stopped run in the same lane reads as a retry even when dispatched as a subtask", () => {
  const base = snapshot();
  const timeline = buildFlowTimeline({
    ...base,
    runs: [...base.runs.filter((entry: any) => entry.id !== "rA"), run("rA1", "A", "codex", 3, 5, "stopped"), run("rA2", "A", "codex", 6, 10, "done", { attempt: 2 })],
    domainEvents: [event("s1", "run.started", "rA2", 6, { source: "subtask_dispatch" })],
  }, agents);
  assert.deepEqual(timeline.nodes.filter((node) => node.lane === 1).map((node) => node.label), ["开始 · Codex", "已停止", "重试 · Codex", "完成"]);
});
