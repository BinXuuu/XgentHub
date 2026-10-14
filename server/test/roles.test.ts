import test, { after } from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedDb, waitFor } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("roles");
const { db } = await import("../src/db/index.ts");
const { createWorkspace, updateWorkspaceResources } = await import("../src/services/workspaceService.ts");
const { resolveEffectiveResources, describeTaskResources } = await import("../src/services/taskResourceService.ts");
const knowledge = await import("../src/services/knowledgeService.ts");
const { buildChatPrompt } = await import("../src/services/chatService.ts");
const { taskManager } = await import("../src/services/taskManager.ts");
const roles = await import("../src/services/roleService.ts");
const { RoleAdapter } = await import("../src/adapters/role.ts");
const { getAdapter } = await import("../src/adapters/registry.ts");
const { waitForSnapshotsIdle } = await import("../src/services/workspaceSnapshotService.ts");

after(async () => {
  await waitForSnapshotsIdle();
  db.close();
  env.cleanup();
});

function waitIdle(taskId: string) {
  return waitFor(
    () => {
      const current = taskManager.getTask(taskId);
      return current && !["running", "queued", "waiting", "needs_approval"].includes(current.status) ? current : null;
    },
    { timeoutMs: 15000, description: "task to finish" }
  );
}

test("a role shows up as an agent, records its base, and adds its defaults on top of the workspace's resources", async () => {
  const workspace = createWorkspace({ name: "Role Workspace", path: env.root, allowedAgentKinds: [] });
  updateWorkspaceResources(workspace.id, { mcpServerIds: ["mcp:shared"], toolIds: ["tool:a"], skillIds: [] });
  const role = roles.createRole({
    name: "美工",
    icon: "🎨",
    description: "负责界面视觉和配图",
    baseAgentId: "mock",
    baseAgentKind: "mock",
    model: "role-default-model",
    prompt: "出图时调用 ComfyUI。",
    mcpServerIds: ["mcp:comfyui"],
    toolIds: ["tool:a"],
    skillIds: ["skill:b"],
  });
  const agentId = roles.roleAgentId(role.id);

  const descriptor = taskManager.listAgents().find((agent) => agent.id === agentId);
  assert.equal(descriptor?.name, "美工");
  assert.equal(descriptor?.role?.baseAgentId, "mock");

  const task = taskManager.createTask({ agentId, workspaceId: workspace.id, title: "做个 logo", prompt: "画一个 logo", permissionMode: "full", actor: "test" });
  assert.equal(task.agentId, agentId);
  assert.equal(task.agentKind, "mock");
  assert.equal(task.model, "role-default-model");
  assert.deepEqual(resolveEffectiveResources(task), {
    knowledgeGroupIds: [],
    mcpServerIds: ["mcp:shared", "mcp:comfyui"],
    toolIds: ["tool:a"],
    skillIds: ["skill:b"],
  });
  const row = db.prepare("SELECT base_agent_id FROM tasks WHERE id = ?").get(task.id) as { base_agent_id: string };
  assert.equal(row.base_agent_id, "mock");
  await waitIdle(task.id);

  assert.throws(() => roles.deleteRole(role.id), /不能删除/);

  roles.setRoleEnabled(role.id, false);
  assert.equal(taskManager.listAgents().some((agent) => agent.id === agentId), false);
  assert.ok(getAdapter(agentId), "disabled roles must still resolve for existing tasks");
  taskManager.sendMessage(task.id, "继续", [], "test");
  await waitIdle(task.id);
  assert.equal(taskManager.listMessages(task.id).filter((message) => message.role === "user").length, 2);
});

test("remember lines are pulled out of replies, stay pending until approved, then get injected every round", async () => {
  assert.deepEqual(roles.extractRememberLines("没有要记的"), { clean: "没有要记的", proposals: [] });
  assert.deepEqual(roles.extractRememberLines("做好了。\n\n【记住】品牌主色 #FF6600\n  【记住】 图标统一线性风格 "), {
    clean: "做好了。",
    proposals: ["品牌主色 #FF6600", "图标统一线性风格"],
  });

  const prompts: (string | null)[] = [];
  const delivered: string[] = [];
  const base = {
    kind: "mock" as const,
    name: "fake",
    description: "fake",
    supportsMcp: true,
    isConfigured: () => true,
    configHint: () => "",
    discoverWorkspaces: async () => [],
    run: async (ctx: any) => {
      prompts.push(ctx.workspacePrompt);
      ctx.agentMessage("logo 已经画好。\n【记住】品牌主色 #FF6600");
    },
    continueTask: async () => undefined,
  };
  const role = roles.createRole({ name: "记忆美工", baseAgentId: "fake", baseAgentKind: "mock" });
  const adapter = () => new RoleAdapter(roles.getRole(role.id)!, (() => base) as any);
  const ctx = { taskId: null, workspacePrompt: null, model: null, agentMessage: (text: string) => delivered.push(text) } as any;

  await adapter().run(ctx, { text: "画 logo", images: [] });
  assert.equal(delivered[0], "logo 已经画好。");
  const pending = roles.listRoleMemories(role.id);
  assert.deepEqual(pending.map((item) => [item.content, item.status, item.source]), [["品牌主色 #FF6600", "pending", "agent"]]);
  assert.doesNotMatch(prompts[0] ?? "", /品牌主色/);

  await adapter().run(ctx, { text: "再画一个", images: [] });
  assert.equal(roles.listRoleMemories(role.id).length, 1, "the same proposal must not be stored twice");
  assert.doesNotMatch(prompts[1] ?? "", /品牌主色/, "pending memories are not injected");

  roles.approveRoleMemory(pending[0].id);
  roles.addRoleMemory({ roleId: role.id, content: "交付图要附尺寸说明", status: "active", source: "manual" });
  await adapter().run(ctx, { text: "第三张", images: [] });
  assert.match(prompts[2] ?? "", /【你之前记住的事】\n- 交付图要附尺寸说明\n- 品牌主色 #FF6600/);
});

test("the role adapter injects its persona and keeps an existing task on the base it was created with", async () => {
  const seen: { base: string; workspacePrompt: string | null; model: string | null }[] = [];
  const fake = (id: string) => ({
    kind: "mock" as const,
    name: id,
    description: id,
    supportsMcp: true,
    isConfigured: () => true,
    configHint: () => "",
    discoverWorkspaces: async () => [],
    run: async (ctx: any) => {
      seen.push({ base: id, workspacePrompt: ctx.workspacePrompt, model: ctx.model });
    },
    continueTask: async () => undefined,
  });
  const resolver = (id: string) => (id === "base-a" || id === "base-b" ? fake(id) : undefined);

  const role = roles.createRole({ name: "文案", description: "写营销文案", baseAgentId: "base-a", baseAgentKind: "mock", model: "m1", prompt: "语气要活泼。" });
  const agentId = roles.roleAgentId(role.id);
  const workspace = createWorkspace({ name: "Role Adapter Workspace", path: env.root, allowedAgentKinds: [] });
  db.prepare(
    "INSERT INTO tasks (id, agent_id, agent_kind, workspace_id, title, prompt, status, permission_mode, base_agent_id, created_at, updated_at) VALUES (?, ?, 'mock', ?, 't', '', 'review', 'supervised', 'base-a', ?, ?)"
  ).run("role-task", agentId, workspace.id, new Date().toISOString(), new Date().toISOString());

  const ctx = { taskId: "role-task", workspacePrompt: "工作区约束", model: null } as any;
  await new RoleAdapter(role, resolver as any).run(ctx, { text: "hi", images: [] });
  assert.equal(seen[0].base, "base-a");
  assert.match(seen[0].workspacePrompt ?? "", /【你的角色】你是「文案」。写营销文案\n语气要活泼。/);
  assert.match(seen[0].workspacePrompt ?? "", /工作区约束$/);
  assert.equal(seen[0].model, "m1");

  const moved = roles.updateRole(role.id, { ...role, baseAgentId: "base-b", baseAgentKind: "mock" });
  await new RoleAdapter(moved, resolver as any).run(ctx, { text: "hi", images: [] });
  assert.equal(seen[1].base, "base-a", "existing task must stay on the base it started with");
  await new RoleAdapter(moved, resolver as any).run({ ...ctx, taskId: "some-other-task" }, { text: "hi", images: [] });
  assert.equal(seen[2].base, "base-b", "new work uses the role's current base");
});

test("a role can carry its own knowledge groups: unioned with the workspace's for tasks, and used by chats too", async () => {
  const shared = knowledge.createKnowledgeGroup({ name: "项目资料" });
  const art = knowledge.createKnowledgeGroup({ name: "美工规范" });
  knowledge.createKnowledgeEntry(art.id, { title: "配色规范", content: "主色只用 #0f6fff。" });
  const workspace = createWorkspace({ name: "Role Knowledge Workspace", path: env.root, allowedAgentKinds: [] });
  updateWorkspaceResources(workspace.id, { knowledgeGroupIds: [shared.id] });
  const role = roles.createRole({ name: "带规范的美工", baseAgentId: "mock", baseAgentKind: "mock", knowledgeGroupIds: [art.id, shared.id] });
  assert.deepEqual(roles.getRole(role.id)?.knowledgeGroupIds, [art.id, shared.id]);
  const agentId = roles.roleAgentId(role.id);

  const task = taskManager.createTask({ agentId, workspaceId: workspace.id, title: "画海报", prompt: "画一张海报", permissionMode: "full", actor: "test" });
  assert.deepEqual(resolveEffectiveResources(task).knowledgeGroupIds, [shared.id, art.id]);
  assert.deepEqual(
    describeTaskResources(task).knowledgeGroups.map((group) => [group.name, group.sources]),
    [
      ["项目资料", ["workspace", "role"]],
      ["美工规范", ["role"]],
    ]
  );
  await waitIdle(task.id);

  // 聊天没有工作区：角色自带的小知识组照样整组带上。
  const chatPrompt = buildChatPrompt({ skillIds: [], toolIds: [], knowledgeIds: [] }, "画一张海报", [], getAdapter(agentId)?.roleInfo?.knowledgeGroupIds);
  assert.match(chatPrompt, /配色规范\n主色只用 #0f6fff。/);

  // 删组时角色里的引用也一起清掉。
  knowledge.deleteKnowledgeGroup(art.id);
  assert.deepEqual(roles.getRole(role.id)?.knowledgeGroupIds, [shared.id]);
});
