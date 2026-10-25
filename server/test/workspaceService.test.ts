import test, { after } from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedDb } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("workspace");
const { db } = await import("../src/db/index.ts");
const workspaceService = await import("../src/services/workspaceService.ts");
const knowledgeService = await import("../src/services/knowledgeService.ts");
const { buildWorkspacePrompt } = await import("../src/adapters/workspacePrompt.ts");

after(() => {
  db.close();
  env.cleanup();
});

test("workspaceService seeds the local host and creates workspaces", () => {
  assert.deepEqual(workspaceService.listHosts().map((host) => host.id), ["local"]);

  const workspace = workspaceService.createWorkspace({
    name: "Test Workspace",
    path: "D:\\tmp\\agenthub-test",
    allowedAgentKinds: ["mock"],
  });

  assert.equal(workspace.hostId, "local");
  assert.deepEqual(workspace.allowedAgentKinds, ["mock"]);
  assert.equal(workspaceService.getWorkspace(workspace.id)?.name, "Test Workspace");
});

test("workspace prompts are stored and injected into workspace prompt text", () => {
  const workspace = workspaceService.createWorkspace({
    name: "Prompt Workspace",
    path: "D:\\tmp\\agenthub-prompt",
    allowedAgentKinds: ["codex"],
  });

  const empty = workspaceService.getWorkspacePrompt(workspace.id);
  assert.equal(empty.workspaceId, workspace.id);
  assert.equal(empty.content, "");

  const saved = workspaceService.updateWorkspacePrompt(
    workspace.id,
    "优先使用 npm run regression。\n不要修改备份目录。"
  );
  assert.equal(saved.content, "优先使用 npm run regression。\n不要修改备份目录。");

  const prompt = buildWorkspacePrompt(workspace.path, "修复失败测试", saved.content);
  assert.match(prompt, /工作区长期上下文/);
  assert.match(prompt, /优先使用 npm run regression/);
  assert.match(prompt, /用户任务：\n修复失败测试/);
});

test("knowledge lives in groups: retrieval only searches the groups a workspace uses, and is injected into the prompt", () => {
  const workspace = workspaceService.createWorkspace({
    name: "Knowledge Workspace",
    path: "D:\\tmp\\agenthub-knowledge",
    allowedAgentKinds: ["codex"],
  });
  const ops = knowledgeService.createKnowledgeGroup({ name: "运维手册" });
  const other = knowledgeService.createKnowledgeGroup({ name: "别的项目" });

  const printer = knowledgeService.createKnowledgeEntry(ops.id, {
    title: "厨房打印机排障",
    content: "厨房打印机离线时，先检查 printer-gateway 服务和 USB 转网口供电。",
    tags: ["printer", "kitchen", "printer"],
  });
  knowledgeService.createKnowledgeEntry(ops.id, { title: "支付回调约定", content: "支付回调必须先验签，再更新订单状态。", tags: ["payment"] });
  knowledgeService.createKnowledgeEntry(other.id, { title: "厨房打印机型号表", content: "别的项目里的打印机资料。" });
  assert.deepEqual(printer.tags, ["printer", "kitchen"]);
  assert.equal(knowledgeService.getKnowledgeGroup(ops.id)?.entryCount, 2);

  const linked = workspaceService.updateWorkspaceResources(workspace.id, { knowledgeGroupIds: [ops.id] });
  const matches = knowledgeService.getRelevantKnowledge(linked.knowledgeGroupIds, "检查厨房打印机为什么离线", 3);
  assert.deepEqual(matches.map((entry) => entry.id), [printer.id], "entries from groups the workspace doesn't use must not leak in");
  assert.deepEqual(knowledgeService.getRelevantKnowledge([], "厨房打印机", 3), []);

  const prompt = buildWorkspacePrompt(workspace.path, "检查厨房打印机为什么离线", null, matches);
  assert.match(prompt, /工作区相关知识库资料/);
  assert.match(prompt, /厨房打印机排障/);
  assert.match(prompt, /printer-gateway/);
  assert.match(prompt, /用户任务：\n检查厨房打印机为什么离线/);

  const deleted = knowledgeService.deleteKnowledgeEntry(printer.id);
  assert.equal(deleted?.id, printer.id);
  assert.equal(knowledgeService.getRelevantKnowledge([ops.id], "厨房打印机", 3).length, 0);

  // 组是独立的：删工作区不删组；删组会把它从工作区的关联里去掉。
  workspaceService.updateWorkspaceResources(workspace.id, { knowledgeGroupIds: [ops.id, other.id] });
  knowledgeService.deleteKnowledgeGroup(other.id);
  assert.deepEqual(workspaceService.getWorkspace(workspace.id)?.knowledgeGroupIds, [ops.id]);
  assert.equal(knowledgeService.listKnowledgeEntries({ groupIds: [other.id] }).length, 0);
  workspaceService.deleteWorkspace(workspace.id);
  assert.ok(knowledgeService.getKnowledgeGroup(ops.id));
});

test("each turn carries small knowledge groups whole and only the relevant entries of large groups", () => {
  const rules = knowledgeService.createKnowledgeGroup({ name: "美工规范" });
  const manual = knowledgeService.createKnowledgeGroup({ name: "大手册" });
  const palette = knowledgeService.createKnowledgeEntry(rules.id, { title: "配色", content: "主色只用 #0f6fff，禁止渐变。" });
  const font = knowledgeService.createKnowledgeEntry(rules.id, { title: "字体", content: "标题用思源黑体 Bold。" });
  const filler = "x".repeat(knowledgeService.SMALL_GROUP_MAX_CHARS);
  const deploy = knowledgeService.createKnowledgeEntry(manual.id, { title: "部署流程", content: `部署前先跑 doctor。${filler}` });
  knowledgeService.createKnowledgeEntry(manual.id, { title: "数据库备份", content: "每天凌晨备份一次。" });

  // 消息里完全没提到配色/字体，小组照样整组带上；大组只挑命中"部署"的那条。
  const picked = knowledgeService.selectTurnKnowledge([rules.id, manual.id], "帮我部署一下新版本");
  assert.deepEqual(picked.map((entry) => entry.id), [palette.id, font.id, deploy.id]);

  // 没有命中时大组一条都不带，小组仍在。
  assert.deepEqual(
    knowledgeService.selectTurnKnowledge([rules.id, manual.id], "画一张海报").map((entry) => entry.id),
    [palette.id, font.id]
  );
  assert.deepEqual(knowledgeService.selectTurnKnowledge([], "部署"), []);

  const prompt = buildWorkspacePrompt("D:\\tmp\\agenthub-art", "画一张海报", null, picked);
  assert.match(prompt, /配色[\s\S]*字体[\s\S]*部署流程/);

  knowledgeService.deleteKnowledgeGroup(rules.id);
  knowledgeService.deleteKnowledgeGroup(manual.id);
});

test("too many small groups fall back to relevance once the always-included budget is used up", () => {
  const groups = Array.from({ length: 4 }, (_, index) => {
    const group = knowledgeService.createKnowledgeGroup({ name: `小组${index}` });
    knowledgeService.createKnowledgeEntry(group.id, { title: `条目${index}`, content: "y".repeat(knowledgeService.SMALL_GROUP_MAX_CHARS - 10) });
    return group;
  });
  const picked = knowledgeService.selectTurnKnowledge(groups.map((group) => group.id), "无关的话");
  const total = picked.reduce((sum, entry) => sum + entry.title.length + entry.content.length, 0);
  assert.ok(total <= knowledgeService.ALWAYS_INCLUDED_MAX_CHARS, `always-included knowledge stays within budget, got ${total}`);
  assert.equal(picked.length, 2);
  for (const group of groups) knowledgeService.deleteKnowledgeGroup(group.id);
});

test("workspace prompt includes image attachment paths as a fallback", () => {
  const prompt = buildWorkspacePrompt(
    "D:\\tmp\\agenthub-images",
    "提取文字",
    null,
    [],
    ["C:\\XgentHub\\server\\data\\attachments\\pending\\sample.png"]
  );

  assert.match(prompt, /本轮用户附带了图片附件/);
  assert.match(prompt, /sample\.png/);
  assert.match(prompt, /用户任务：\n提取文字/);
});

test("deleteWorkspace removes task-owned records without touching unrelated audit rows", () => {
  const workspace = workspaceService.createWorkspace({
    name: "Cascade Workspace",
    path: "D:\\tmp\\agenthub-cascade",
    allowedAgentKinds: [],
  });
  const taskId = "task-cascade";
  const createdAt = new Date().toISOString();

  db.prepare(
    `INSERT INTO tasks (id, agent_id, agent_kind, workspace_id, title, prompt, status, session_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(taskId, "mock", "mock", workspace.id, "Cascade", "prompt", "review", null, createdAt, createdAt);
  db.prepare("INSERT INTO task_messages (id, task_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)").run(
    "message-1",
    taskId,
    "user",
    "hello",
    createdAt
  );
  db.prepare("INSERT INTO task_events (id, task_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)").run(
    "event-1",
    taskId,
    "log",
    JSON.stringify({ message: "hello" }),
    createdAt
  );
  db.prepare("INSERT INTO domain_events (id, name, version, task_id, run_id, legacy_type, payload, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)").run(
    "domain-event-1",
    "task.log.created",
    1,
    taskId,
    "log",
    JSON.stringify({ message: "hello" }),
    createdAt
  );
  db.prepare("INSERT INTO file_changes (id, task_id, path, action, diff, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    "file-1",
    taskId,
    "src/a.ts",
    "modified",
    null,
    createdAt
  );
  db.prepare(
    "INSERT INTO approvals (id, task_id, command, cwd, risk_level, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run("approval-1", taskId, "git push", workspace.path, "medium", "test", "pending", createdAt);
  db.prepare("INSERT INTO always_allow_rules (id, workspace_id, agent_id, pattern, created_at) VALUES (?, ?, ?, ?, ?)").run(
    "allow-rule-1",
    workspace.id,
    "mock",
    "npm install left-pad",
    createdAt
  );
  db.prepare(
    "INSERT INTO notifications (id, level, title, detail, task_id, source, source_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run("notification-1", "success", "Task review", "Cascade", taskId, "task_status", "task:task-cascade:status:review", createdAt);
  db.prepare(
    "INSERT INTO memory_entries (id, workspace_id, task_id, agent_id, kind, title, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run("memory-1", workspace.id, taskId, "mock", "task_summary", "Cascade", "remember cascade", "{}", createdAt);
  db.prepare(
    "INSERT INTO task_recovery_actions (id, task_id, run_id, kind, status, note, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)"
  ).run("recovery-1", taskId, "human_handoff", "open", "manual check", createdAt);
  db.prepare(
    "INSERT INTO task_review_decisions (id, task_id, run_id, decision, note, created_at) VALUES (?, ?, NULL, ?, ?, ?)"
  ).run("review-1", taskId, "approved", "looks good", createdAt);
  db.prepare(
    `INSERT INTO butler_intents (
      id, prompt, workspace_id, recommended_agent_id, recommended_permission_mode,
      confidence, signals, reasons, warnings, agent_scores, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "butler-1",
    "plan this",
    workspace.id,
    "mock",
    "supervised",
    0.75,
    "[]",
    "[]",
    "[]",
    "[]",
    createdAt
  );
  db.prepare("INSERT INTO workspace_prompts (workspace_id, content, updated_at) VALUES (?, ?, ?)").run(
    workspace.id,
    "keep project conventions",
    createdAt
  );
  db.prepare(
    "INSERT INTO workspace_knowledge_entries (id, workspace_id, title, content, tags, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    "knowledge-1",
    workspace.id,
    "Project convention",
    "Use npm run regression before backup.",
    JSON.stringify(["test"]),
    "manual",
    createdAt,
    createdAt
  );
  db.prepare("INSERT INTO message_queue (id, task_id, content, images, position, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    "queue-1",
    taskId,
    "next",
    "[]",
    0,
    createdAt
  );
  db.prepare("INSERT INTO audit_log (id, actor, agent_id, task_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "audit-task",
    "test",
    "mock",
    taskId,
    "create_task",
    "{}",
    createdAt
  );
  db.prepare("INSERT INTO audit_log (id, actor, agent_id, task_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "audit-global",
    "test",
    null,
    null,
    "global",
    "{}",
    createdAt
  );

  workspaceService.deleteWorkspace(workspace.id);

  for (const table of [
    "tasks",
    "task_messages",
    "task_events",
    "domain_events",
    "file_changes",
    "approvals",
    "message_queue",
    "notifications",
    "task_recovery_actions",
    "task_review_decisions",
  ]) {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    assert.equal(row.count, 0, `${table} should be empty`);
  }
  const ruleRows = db.prepare("SELECT COUNT(*) AS count FROM always_allow_rules WHERE workspace_id = ?").get(workspace.id) as { count: number };
  assert.equal(ruleRows.count, 0);
  const memoryRows = db.prepare("SELECT COUNT(*) AS count FROM memory_entries WHERE workspace_id = ?").get(workspace.id) as { count: number };
  assert.equal(memoryRows.count, 0);
  const butlerRows = db.prepare("SELECT COUNT(*) AS count FROM butler_intents WHERE workspace_id = ?").get(workspace.id) as { count: number };
  assert.equal(butlerRows.count, 0);
  const promptRows = db.prepare("SELECT COUNT(*) AS count FROM workspace_prompts WHERE workspace_id = ?").get(workspace.id) as { count: number };
  assert.equal(promptRows.count, 0);
  const knowledgeRows = db.prepare("SELECT COUNT(*) AS count FROM workspace_knowledge_entries WHERE workspace_id = ?").get(workspace.id) as {
    count: number;
  };
  assert.equal(knowledgeRows.count, 0);
  const auditTaskRows = db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE task_id = ?").get(taskId) as { count: number };
  assert.equal(auditTaskRows.count, 0);
  const auditGlobalRows = db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE id = 'audit-global'").get() as { count: number };
  assert.equal(auditGlobalRows.count, 1);
});

test("a knowledge entry can be edited in place and moved to another group", () => {
  const from = knowledgeService.createKnowledgeGroup({ name: "旧组" });
  const to = knowledgeService.createKnowledgeGroup({ name: "新组" });
  const entry = knowledgeService.createKnowledgeEntry(from.id, { title: "部署", content: "旧内容", tags: ["a"] });

  const edited = knowledgeService.updateKnowledgeEntry(entry.id, { title: "部署流程", content: "先跑 doctor 再部署", tags: ["ops", "ops"] });
  assert.deepEqual([edited.id, edited.groupId, edited.title, edited.content, edited.tags], [entry.id, from.id, "部署流程", "先跑 doctor 再部署", ["ops"]]);

  const moved = knowledgeService.updateKnowledgeEntry(entry.id, { groupId: to.id, title: edited.title, content: edited.content });
  assert.equal(moved.groupId, to.id);
  assert.equal(knowledgeService.getKnowledgeGroup(from.id)?.entryCount, 0);
  assert.equal(knowledgeService.getKnowledgeGroup(to.id)?.entryCount, 1);

  assert.throws(() => knowledgeService.updateKnowledgeEntry(entry.id, { title: "", content: "x" }), /title/);
  assert.throws(() => knowledgeService.updateKnowledgeEntry("missing", { title: "x", content: "y" }), /找不到/);
  knowledgeService.deleteKnowledgeGroup(from.id);
  knowledgeService.deleteKnowledgeGroup(to.id);
});
