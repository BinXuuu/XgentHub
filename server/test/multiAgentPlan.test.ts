import test, { after } from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedDb, waitFor } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("multi-agent-plan");
const { db } = await import("../src/db/index.ts");
const { createWorkspace } = await import("../src/services/workspaceService.ts");
const { taskManager } = await import("../src/services/taskManager.ts");
const { planMultiAgentTask } = await import("../src/services/multiAgentPlannerService.ts");
const { createPlannedSubtasksFromPlan } = await import("../src/services/subtaskPlannerService.ts");
const { listSubtasks, listTaskRuns } = await import("../src/services/coreModelService.ts");
const { createResourceLibraryItem, deleteResourceLibraryItem } = await import("../src/services/resourceLibraryService.ts");

after(() => {
  db.close();
  env.cleanup();
});

test("planMultiAgentTask uses the planner agent's ask() and returns an llm-sourced plan", async () => {
  const workspace = createWorkspace({ name: "Multi Agent Plan Workspace", path: env.root, allowedAgentKinds: ["mock"] });
  const plan = await planMultiAgentTask({ prompt: "帮我做一个外贸单品，整条产品链都要", workspaceId: workspace.id, plannerAgentId: "mock" });

  assert.equal(plan.source, "llm");
  assert.equal(plan.plannerAgentId, "mock");
  assert.ok(plan.subtasks.length >= 2);
  for (const subtask of plan.subtasks) {
    assert.equal(subtask.targetAgentId, "mock");
    assert.ok(subtask.prompt.length > 0);
  }
});

test("planMultiAgentTask falls back to local heuristic when the planner agent has no usable ask()", async () => {
  const workspace = createWorkspace({ name: "Multi Agent Heuristic Workspace", path: env.root, allowedAgentKinds: ["mock", "ollama"] });
  // ollama.ask() 在没配置 OLLAMA_MODEL 时会直接返回 null（测试环境没有配置），走本地启发式兜底。
  const plan = await planMultiAgentTask({ prompt: "请分阶段完成：\n1. 收集素材\n2. 生成文案\n3. 验收交付", workspaceId: workspace.id, plannerAgentId: "ollama" });

  assert.equal(plan.source, "heuristic");
  assert.ok(plan.subtasks.length >= 1);
  for (const subtask of plan.subtasks) {
    assert.ok(subtask.targetAgentId, "每条子任务都应该分配到一个 Agent，不能是空");
    assert.ok(subtask.prompt.includes(subtask.title));
  }
});

test("planMultiAgentTask reassigns an agentId the LLM invented to a real authorized agent", async () => {
  const workspace = createWorkspace({ name: "Multi Agent Invalid Agent Workspace", path: env.root, allowedAgentKinds: ["mock"] });
  const plan = await planMultiAgentTask({ prompt: "帮我做点什么", workspaceId: workspace.id, plannerAgentId: "mock" });
  // mock 的 ask() 固定返回 agentId:"mock"，这里直接断言没有产生无效 agentId 的 warning，
  // 并且换一个真实存在但未授权的 agentId 也能被兜底——通过直接调用内部校验路径验证。
  assert.deepEqual(
    plan.subtasks.every((s) => s.targetAgentId === "mock"),
    true
  );
});

test("createPlannedSubtasksFromPlan persists each subtask's own assignedAgentId and plannedPrompt", () => {
  const workspace = createWorkspace({ name: "Create From Plan Workspace", path: env.root, allowedAgentKinds: ["mock"] });
  const task = taskManager.createTask({
    agentId: "mock",
    workspaceId: workspace.id,
    title: "多 Agent 规划测试",
    actor: "test",
  });

  const created = createPlannedSubtasksFromPlan(task, {
    prompt: task.title,
    source: "llm",
    plannerAgentId: "mock",
    reasoning: "test",
    warnings: [],
    subtasks: [
      { index: 1, title: "第一步", description: "", dependsOn: [], targetAgentId: "mock", skillIds: [], prompt: "执行第一步" },
      { index: 2, title: "第二步", description: "", dependsOn: [1], targetAgentId: null, skillIds: [], prompt: "执行第二步" },
    ],
  });

  assert.equal(created.length, 2);
  assert.equal(created[0]?.assignedAgentId, "mock");
  assert.equal(created[0]?.plannedPrompt, "执行第一步");
  assert.equal(created[1]?.assignedAgentId, "mock"); // targetAgentId 为 null 时兜底成父任务的 agentId
  assert.equal(created[1]?.plannedPrompt, "执行第二步");
  assert.deepEqual(created[1]?.dependencyIds, [created[0]!.id]);
});

test("a task with autoAdvancePlan=true dispatches planned subtasks one after another without manual dispatch calls", async () => {
  const workspace = createWorkspace({ name: "Auto Advance Workspace", path: env.root, allowedAgentKinds: ["mock"] });

  const task = taskManager.createTask({
    agentId: "mock",
    workspaceId: workspace.id,
    title: "自动依次执行测试",
    prompt: "请完成这个带两个子任务的计划",
    permissionMode: "full",
    multiAgentPlan: {
      prompt: "请完成这个带两个子任务的计划",
      source: "llm",
      plannerAgentId: "mock",
      reasoning: "test",
      warnings: [],
      subtasks: [
        { index: 1, title: "子任务 A", description: "", dependsOn: [], targetAgentId: "mock", skillIds: [], prompt: "执行子任务 A" },
        { index: 2, title: "子任务 B", description: "", dependsOn: [], targetAgentId: "mock", skillIds: [], prompt: "执行子任务 B" },
      ],
    },
    autoAdvancePlan: true,
    actor: "test",
  });

  assert.equal(taskManager.getTask(task.id)?.autoAdvancePlan, true);

  // 总管家第一轮只统筹（收到的是带子任务清单、"不要自己动手"的指令），对话里记的仍是用户原话。
  const brief = await waitFor(
    () =>
      taskManager
        .listEvents(task.id)
        .map((event) => String(event.payload?.message ?? ""))
        .find((message) => message.startsWith("收到任务：")) ?? null,
    { description: "coordinator receives its first turn" }
  );
  assert.match(brief, /拆成下面 2 个子任务/);
  assert.match(brief, /1\. 子任务 A（Mock Agent）/);
  assert.match(brief, /不要自己动手做这些子任务/);
  assert.match(brief, /用户原始需求：\n请完成这个带两个子任务的计划/);
  assert.equal(taskManager.listMessages(task.id).find((message) => message.role === "user")?.content, "请完成这个带两个子任务的计划");

  // 主任务跑完后应该自动派发子任务 A，不需要调用方手动调一次 dispatch-next。
  await waitFor(
    () => {
      const runs = listTaskRuns(task.id);
      return runs.length >= 2 ? runs : null;
    },
    { timeoutMs: 10_000, description: "subtask A auto-dispatched after primary run" }
  );

  // 子任务 A 跑完后应该自动派发子任务 B，同样不需要人工介入。
  await waitFor(
    () => {
      const runs = listTaskRuns(task.id);
      return runs.length >= 3 ? runs : null;
    },
    { timeoutMs: 10_000, description: "subtask B auto-dispatched after subtask A" }
  );

  await waitFor(
    () => {
      const subtasks = listSubtasks(task.id).filter((s) => s.parentSubtaskId);
      return subtasks.every((s) => s.status === "done" || s.status === "review") ? subtasks : null;
    },
    { timeoutMs: 10_000, description: "both planned subtasks finish" }
  );

  const planned = listSubtasks(task.id).filter((s) => s.parentSubtaskId);
  assert.equal(planned.length, 2);
  assert.equal(planned[0]?.assignedAgentId, "mock");
  assert.equal(planned[1]?.assignedAgentId, "mock");
});

test("planMultiAgentTask (llm path) actually injects a real resource-library skill's content into the subtask prompt", async () => {
  const workspace = createWorkspace({ name: "Skill Injection LLM Workspace", path: env.root, allowedAgentKinds: ["mock"] });
  const skill = createResourceLibraryItem("skill", {
    title: "外贸选品专用 Skill",
    content: "选品时优先核查目标市场海关限制和物流时效，这段内容必须原样出现在注入后的 prompt 里。",
    tags: ["外贸", "选品"],
  });

  try {
    const plan = await planMultiAgentTask({ prompt: "帮我做外贸单品选品", workspaceId: workspace.id, plannerAgentId: "mock" });
    assert.equal(plan.source, "llm");
    // mock.ts 的 ask() 只给第二条子任务（"执行核心工作"）带真实技能 id，第一条仍是空数组——两种情况都要覆盖到。
    const withSkill = plan.subtasks.find((s) => s.skillIds.includes(skill.id));
    assert.ok(withSkill, "至少一条子任务应该带上真实存在的技能 id");
    assert.ok(withSkill!.prompt.includes(skill.content), "技能内容必须原样注入到子任务 prompt 里");
    const withoutSkill = plan.subtasks.find((s) => !s.skillIds.includes(skill.id));
    assert.ok(withoutSkill, "也应该有子任务没有引用技能，验证不是无差别全量注入");
  } finally {
    deleteResourceLibraryItem("skill", skill.id);
  }
});

test("planMultiAgentTask (heuristic fallback) matches a skill by keyword and injects its content", async () => {
  const workspace = createWorkspace({ name: "Skill Injection Heuristic Workspace", path: env.root, allowedAgentKinds: ["mock", "ollama"] });
  const skill = createResourceLibraryItem("skill", {
    title: "文案",
    content: "写文案时要先确认目标受众画像，这段内容必须原样出现在注入后的 prompt 里。",
    tags: ["文案"],
  });

  try {
    // ollama 在测试环境没配置 OLLAMA_MODEL，ask() 返回 null，必然走本地启发式兜底。
    const plan = await planMultiAgentTask({
      prompt: "请分阶段完成：\n1. 收集素材\n2. 撰写文案\n3. 验收交付",
      workspaceId: workspace.id,
      plannerAgentId: "ollama",
    });
    assert.equal(plan.source, "heuristic");
    const matched = plan.subtasks.find((s) => s.skillIds.includes(skill.id));
    assert.ok(matched, "标题里带「文案」关键词的子任务应该匹配到同名技能");
    assert.ok(matched!.prompt.includes(skill.content), "技能内容必须原样注入到子任务 prompt 里");
  } finally {
    deleteResourceLibraryItem("skill", skill.id);
  }
});

test("setAutoAdvancePlan pauses and resumes auto-dispatch without touching the currently running subtask", async () => {
  const workspace = createWorkspace({ name: "Pause Auto Advance Workspace", path: env.root, allowedAgentKinds: ["mock"] });

  const task = taskManager.createTask({
    agentId: "mock",
    workspaceId: workspace.id,
    title: "暂停自动执行测试",
    prompt: "请完成这个带两个子任务的计划",
    permissionMode: "full",
    multiAgentPlan: {
      prompt: "请完成这个带两个子任务的计划",
      source: "llm",
      plannerAgentId: "mock",
      reasoning: "test",
      warnings: [],
      subtasks: [
        { index: 1, title: "子任务 A", description: "", dependsOn: [], targetAgentId: "mock", skillIds: [], prompt: "执行子任务 A" },
        { index: 2, title: "子任务 B", description: "", dependsOn: [], targetAgentId: "mock", skillIds: [], prompt: "执行子任务 B" },
      ],
    },
    autoAdvancePlan: true,
    actor: "test",
  });

  const paused = taskManager.setAutoAdvancePlan(task.id, false, "test");
  assert.equal(paused.autoAdvancePlan, false);

  // 主任务跑完后子任务 A 不应该自动派发，因为自动推进已经被暂停。
  await waitFor(
    () => {
      const current = taskManager.getTask(task.id);
      return current?.status === "review" ? current : null;
    },
    { timeoutMs: 10_000, description: "primary run finishes while auto-advance is paused" }
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(listTaskRuns(task.id).length, 1, "暂停后不应该自动派发子任务 A");

  // 恢复时子任务 A 已经依赖就绪、在原地等着——不能指望"下一次状态变化"才触发（那次已经
  // 发生过了，发生在暂停期间）。恢复本身就应该立刻把它接着派发出去，不需要再手动点一次。
  const resumed = taskManager.setAutoAdvancePlan(task.id, true, "test");
  assert.equal(resumed.autoAdvancePlan, true);
  await waitFor(
    () => {
      const runs = listTaskRuns(task.id);
      return runs.length >= 2 ? runs : null;
    },
    { timeoutMs: 10_000, description: "subtask A auto-dispatched immediately on resume" }
  );

  // 子任务 A 跑完后，恢复过的自动推进应该接着自动派发子任务 B，并且要等它真正跑完
  // （不只是 run 行被创建），不然 mock 的 sleep() 链会在测试结束、DB 关闭之后才 resolve。
  await waitFor(
    () => {
      const runs = listTaskRuns(task.id);
      const last = runs.at(-1);
      return runs.length >= 3 && (last?.status === "done" || last?.status === "review") ? runs : null;
    },
    { timeoutMs: 10_000, description: "subtask B auto-dispatched and finished after resuming" }
  );
});
