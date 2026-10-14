import test, { after } from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedDb } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("workspace-resources-migration");
const { db, migrateToWorkspaceResources } = await import("../src/db/index.ts");
const workspaceService = await import("../src/services/workspaceService.ts");
const knowledgeService = await import("../src/services/knowledgeService.ts");

after(() => {
  db.close();
  env.cleanup();
});

test("legacy per-workspace knowledge becomes a linked group and per-task picks are merged into the workspace", () => {
  const now = new Date().toISOString();
  const withKnowledge = workspaceService.createWorkspace({ name: "老项目", path: "D:\\tmp\\legacy-a", allowedAgentKinds: [] });
  const empty = workspaceService.createWorkspace({ name: "空项目", path: "D:\\tmp\\legacy-b", allowedAgentKinds: [] });

  const insertEntry = db.prepare(
    "INSERT INTO workspace_knowledge_entries (id, workspace_id, title, content, tags, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'manual', ?, ?)"
  );
  insertEntry.run("kb-1", withKnowledge.id, "部署流程", "先跑 doctor。", JSON.stringify(["ops"]), now, now);
  insertEntry.run("kb-2", withKnowledge.id, "命名约定", "kebab-case。", "[]", now, now);

  const insertTask = db.prepare(
    `INSERT INTO tasks (id, agent_id, agent_kind, workspace_id, title, prompt, status, permission_mode, mcp_server_ids, tool_ids, skill_ids, knowledge_ids, created_at, updated_at)
     VALUES (?, 'mock', 'mock', ?, 't', '', 'review', 'supervised', ?, ?, ?, ?, ?, ?)`
  );
  insertTask.run("task-1", withKnowledge.id, JSON.stringify(["mcp:a"]), JSON.stringify(["tool:x"]), "[]", JSON.stringify(["kb-1"]), now, now);
  insertTask.run("task-2", withKnowledge.id, JSON.stringify(["mcp:a", "mcp:b"]), "[]", JSON.stringify(["skill:y"]), "[]", now, now);
  insertTask.run("task-3", empty.id, "[]", "[]", "[]", "[]", now, now);

  migrateToWorkspaceResources();

  const migrated = workspaceService.getWorkspace(withKnowledge.id)!;
  assert.equal(migrated.knowledgeGroupIds.length, 1);
  const group = knowledgeService.getKnowledgeGroup(migrated.knowledgeGroupIds[0])!;
  assert.equal(group.name, "老项目");
  assert.equal(group.entryCount, 2);
  assert.deepEqual(
    knowledgeService.getKnowledgeEntriesByIds(["kb-1", "kb-2"]).map((entry) => [entry.id, entry.groupId, entry.tags]),
    [
      ["kb-1", group.id, ["ops"]],
      ["kb-2", group.id, []],
    ],
    "entry ids are preserved so chats that picked them keep working"
  );
  assert.deepEqual(migrated.mcpServerIds, ["mcp:a", "mcp:b"]);
  assert.deepEqual(migrated.toolIds, ["tool:x"]);
  assert.deepEqual(migrated.skillIds, ["skill:y"]);

  const untouched = workspaceService.getWorkspace(empty.id)!;
  assert.deepEqual([untouched.knowledgeGroupIds, untouched.mcpServerIds, untouched.toolIds, untouched.skillIds], [[], [], [], []]);
});
