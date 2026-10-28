import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS hosts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'local',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL REFERENCES hosts(id),
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  access_paths TEXT NOT NULL DEFAULT '[]',
  allowed_agent_kinds TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_prompts (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_entries (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES knowledge_groups(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_entries_group ON knowledge_entries(group_id, updated_at);

CREATE TABLE IF NOT EXISTS app_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- 登录会话：只存 cookie 的 sha256，库文件泄露也拿不到能直接用的会话。存库是为了服务重启不掉登录。
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

-- 旧的"知识条目直接挂工作区"表：2026-10-12 起改成知识组，数据已迁到 knowledge_entries，这张表只留作迁移来源。
CREATE TABLE IF NOT EXISTS workspace_knowledge_entries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  agent_kind TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  session_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_messages (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  images TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  agent_kind TEXT NOT NULL,
  title TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  images TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS domain_events (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
  legacy_type TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  base_agent_id TEXT NOT NULL,
  base_agent_kind TEXT NOT NULL,
  model TEXT,
  prompt TEXT NOT NULL DEFAULT '',
  mcp_server_ids TEXT NOT NULL DEFAULT '[]',
  tool_ids TEXT NOT NULL DEFAULT '[]',
  skill_ids TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_memories (
  id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  task_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_role_memories_role ON role_memories(role_id);

CREATE TABLE IF NOT EXISTS workspace_snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT,
  message_id TEXT,
  kind TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspace_snapshots_task ON workspace_snapshots(task_id);

CREATE TABLE IF NOT EXISTS file_changes (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  path TEXT NOT NULL,
  action TEXT NOT NULL,
  diff TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  note TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  agent_id TEXT,
  task_id TEXT,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS always_allow_rules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  pattern TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  level TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  task_id TEXT,
  source TEXT NOT NULL,
  source_key TEXT NOT NULL UNIQUE,
  read_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  task_id TEXT,
  agent_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS message_queue (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  content TEXT NOT NULL,
  images TEXT NOT NULL DEFAULT '[]',
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  runtime_kind TEXT NOT NULL DEFAULT 'unknown',
  capabilities TEXT NOT NULL DEFAULT '{}',
  custom INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subtasks (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  parent_subtask_id TEXT REFERENCES subtasks(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  assigned_agent_id TEXT,
  dependency_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  subtask_id TEXT REFERENCES subtasks(id) ON DELETE SET NULL,
  agent_id TEXT NOT NULL,
  agent_kind TEXT NOT NULL,
  runtime_kind TEXT NOT NULL DEFAULT 'unknown',
  model TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  attempt INTEGER NOT NULL DEFAULT 1,
  session_key TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_requests (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  source_run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
  target_run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
  requested_agent_id TEXT NOT NULL,
  requested_agent_kind TEXT NOT NULL,
  prompt TEXT NOT NULL,
  images TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'user_message',
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS run_checkpoints (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  label TEXT NOT NULL,
  status TEXT,
  state TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_recovery_actions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  note TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS task_review_decisions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
  decision TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS butler_intents (
  id TEXT PRIMARY KEY,
  prompt TEXT NOT NULL,
  workspace_id TEXT,
  recommended_agent_id TEXT,
  recommended_permission_mode TEXT NOT NULL,
  confidence REAL NOT NULL,
  signals TEXT NOT NULL DEFAULT '[]',
  reasons TEXT NOT NULL DEFAULT '[]',
  warnings TEXT NOT NULL DEFAULT '[]',
  agent_scores TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subtasks_task_id ON subtasks(task_id);
CREATE INDEX IF NOT EXISTS idx_workspace_prompts_updated ON workspace_prompts(updated_at);
CREATE INDEX IF NOT EXISTS idx_workspace_knowledge_workspace ON workspace_knowledge_entries(workspace_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_task_runs_task_id ON task_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_subtask_id ON task_runs(subtask_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_task_id ON artifacts(task_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_run_id ON artifacts(run_id);
CREATE INDEX IF NOT EXISTS idx_agent_requests_task_id ON agent_requests(task_id);
CREATE INDEX IF NOT EXISTS idx_agent_requests_target_run_id ON agent_requests(target_run_id);
CREATE INDEX IF NOT EXISTS idx_run_checkpoints_run_id ON run_checkpoints(run_id, sequence);
CREATE INDEX IF NOT EXISTS idx_task_recovery_actions_task ON task_recovery_actions(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_task_recovery_actions_run ON task_recovery_actions(run_id);
CREATE INDEX IF NOT EXISTS idx_task_review_decisions_task ON task_review_decisions(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_task_review_decisions_run ON task_review_decisions(run_id);
CREATE INDEX IF NOT EXISTS idx_butler_intents_workspace ON butler_intents(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_butler_intents_recommended_agent ON butler_intents(recommended_agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chats_updated ON chats(updated_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_id ON chat_messages(chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_domain_events_task_id ON domain_events(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_domain_events_run_id ON domain_events(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_domain_events_name ON domain_events(name, created_at);
CREATE INDEX IF NOT EXISTS idx_always_allow_rules_scope ON always_allow_rules(workspace_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_always_allow_rules_pattern ON always_allow_rules(pattern);
CREATE INDEX IF NOT EXISTS idx_notifications_read_at ON notifications(read_at, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_task_id ON notifications(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_memory_entries_workspace ON memory_entries(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_memory_entries_task ON memory_entries(task_id);
CREATE INDEX IF NOT EXISTS idx_memory_entries_agent ON memory_entries(agent_id, created_at);
`);

// 轻量迁移：老库没有这一列就补上（node:sqlite 没有迁移框架，简单场景用 try/catch 兜底即可）
try {
  db.exec("ALTER TABLE tasks ADD COLUMN model TEXT");
} catch {
  // 列已存在
}
try {
  db.exec("ALTER TABLE tasks ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'supervised'");
} catch {
  // 列已存在
}
try {
  db.exec("ALTER TABLE tasks ADD COLUMN sub_agent_id TEXT");
} catch {
  // 列已存在
}
try {
  db.exec("ALTER TABLE tasks ADD COLUMN budget_limit_cny REAL");
} catch {
  // 列已存在
}
try {
  db.exec("ALTER TABLE task_messages ADD COLUMN images TEXT NOT NULL DEFAULT '[]'");
} catch {
  // 列已存在
}
try {
  db.exec("ALTER TABLE workspaces ADD COLUMN access_paths TEXT NOT NULL DEFAULT '[]'");
} catch {
  // 列已存在
}
try {
  db.exec("ALTER TABLE tasks ADD COLUMN auto_advance_plan INTEGER NOT NULL DEFAULT 0");
} catch {
  // 列已存在
}
try {
  db.exec("ALTER TABLE subtasks ADD COLUMN planned_prompt TEXT");
} catch {
  // 列已存在
}
try {
  db.exec("ALTER TABLE tasks ADD COLUMN mcp_server_ids TEXT NOT NULL DEFAULT '[]'");
} catch {
  // 列已存在
}
try {
  db.exec("ALTER TABLE chats ADD COLUMN model TEXT");
} catch {
  // 列已存在
}
try {
  db.exec("ALTER TABLE chats ADD COLUMN status TEXT NOT NULL DEFAULT 'idle'");
} catch {
  // 列已存在
}
try {
  db.exec("ALTER TABLE chats ADD COLUMN mcp_server_ids TEXT NOT NULL DEFAULT '[]'");
} catch {
  // 列已存在
}
for (const statement of [
  "ALTER TABLE tasks ADD COLUMN tool_ids TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE chats ADD COLUMN tool_ids TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE chats ADD COLUMN knowledge_ids TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE tasks ADD COLUMN knowledge_ids TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE tasks ADD COLUMN skill_ids TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE chats ADD COLUMN skill_ids TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE tasks ADD COLUMN plan_mode INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE tasks ADD COLUMN base_agent_id TEXT",
  "ALTER TABLE workspaces ADD COLUMN knowledge_group_ids TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE workspaces ADD COLUMN mcp_server_ids TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE workspaces ADD COLUMN tool_ids TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE workspaces ADD COLUMN skill_ids TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE agent_roles ADD COLUMN knowledge_group_ids TEXT NOT NULL DEFAULT '[]'",
]) {
  try {
    db.exec(statement);
  } catch {
    // 列已存在
  }
}

function runMigrationOnce(id: string, migrate: () => void) {
  if (db.prepare("SELECT 1 FROM app_migrations WHERE id = ?").get(id)) return;
  db.exec("BEGIN");
  try {
    migrate();
    db.prepare("INSERT INTO app_migrations (id, applied_at) VALUES (?, ?)").run(id, new Date().toISOString());
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * 知识库 / MCP / 工具 / Skill 从"每个任务各自勾选"改成"工作区统一配置"：
 * - 每个工作区原有的知识条目搬进一个同名知识组（保留条目 id，聊天里勾过的条目照样有效），并把这个组关联回原工作区；
 * - 工作区下所有任务勾过的 MCP / 工具 / Skill / 固定知识，合并成这个工作区的配置，改完之后现有任务不会少东西。
 */
export function migrateToWorkspaceResources(): void {
  const parse = (value: unknown): string[] => {
    try {
      const parsed = JSON.parse(String(value ?? "[]"));
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return [];
    }
  };
  const now = new Date().toISOString();
  const groupOfEntry = new Map<string, string>();
  const workspaces = db.prepare("SELECT id, name FROM workspaces").all() as { id: string; name: string }[];
  const groupIdsByWorkspace = new Map<string, string[]>();

  for (const workspace of workspaces) {
    const entries = db.prepare("SELECT * FROM workspace_knowledge_entries WHERE workspace_id = ?").all(workspace.id) as any[];
    if (entries.length === 0) continue;
    const groupId = randomUUID();
    db.prepare("INSERT INTO knowledge_groups (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
      groupId,
      workspace.name,
      `从工作区「${workspace.name}」迁移过来的知识`,
      now,
      now
    );
    for (const entry of entries) {
      db.prepare(
        "INSERT OR IGNORE INTO knowledge_entries (id, group_id, title, content, tags, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(entry.id, groupId, entry.title, entry.content, entry.tags ?? "[]", entry.source ?? "manual", entry.created_at, entry.updated_at);
      groupOfEntry.set(entry.id, groupId);
    }
    groupIdsByWorkspace.set(workspace.id, [groupId]);
  }

  for (const workspace of workspaces) {
    const mcp = new Set<string>();
    const tools = new Set<string>();
    const skills = new Set<string>();
    const groups = new Set<string>(groupIdsByWorkspace.get(workspace.id) ?? []);
    for (const task of db.prepare("SELECT mcp_server_ids, tool_ids, skill_ids, knowledge_ids FROM tasks WHERE workspace_id = ?").all(workspace.id) as any[]) {
      parse(task.mcp_server_ids).forEach((id) => mcp.add(id));
      parse(task.tool_ids).forEach((id) => tools.add(id));
      parse(task.skill_ids).forEach((id) => skills.add(id));
      parse(task.knowledge_ids).forEach((id) => {
        const groupId = groupOfEntry.get(id);
        if (groupId) groups.add(groupId);
      });
    }
    db.prepare("UPDATE workspaces SET knowledge_group_ids = ?, mcp_server_ids = ?, tool_ids = ?, skill_ids = ? WHERE id = ?").run(
      JSON.stringify([...groups]),
      JSON.stringify([...mcp]),
      JSON.stringify([...tools]),
      JSON.stringify([...skills]),
      workspace.id
    );
  }
}

runMigrationOnce("2026-10-12-workspace-resources", migrateToWorkspaceResources);

db.exec("UPDATE chats SET status = 'failed' WHERE status = 'running'");

// 默认本机 host，方便前端左栏直接展示
const hostCount = db.prepare("SELECT COUNT(*) as c FROM hosts").get() as { c: number };
if (hostCount.c === 0) {
  db.prepare("INSERT INTO hosts (id, name, kind, created_at) VALUES (?, ?, ?, ?)").run(
    "local",
    "本机 (localhost)",
    "local",
    new Date().toISOString()
  );
}

db.exec(`
INSERT OR IGNORE INTO agents (id, kind, name, description, runtime_kind, capabilities, custom, created_at, updated_at)
SELECT
  agent_id,
  agent_kind,
  agent_id,
  '',
  CASE
    WHEN agent_kind IN ('codex', 'claude-code', 'codebuddy', 'openclaw', 'antigravity', 'ark-cli', 'custom-cli') THEN 'cli'
    WHEN agent_kind IN ('tokenezgo', 'doubao', 'hermes', 'custom-api') THEN 'api'
    WHEN agent_kind = 'ollama' THEN 'local'
    WHEN agent_kind = 'mock' THEN 'mock'
    ELSE 'unknown'
  END,
  '{}',
  CASE WHEN agent_id LIKE 'custom:%' THEN 1 ELSE 0 END,
  MIN(created_at),
  MAX(updated_at)
FROM tasks
GROUP BY agent_id, agent_kind;
`);

/**
 * 给还没有主子任务 / 运行记录的老任务补上（引入子任务和运行之前创建的任务）。每次启动都会跑一遍：
 * 以前没加「缺了才补」的条件，新任务每次重启都会多出一条空的 primary: 子任务和 initial: 运行，
 * 流程页因此多一条空运行；这里顺带把这种多出来、什么都没挂着的空记录清掉。
 */
export function backfillCoreRecords(): void {
  db.exec(`
DELETE FROM task_runs
WHERE id LIKE 'initial:%'
  AND EXISTS (SELECT 1 FROM task_runs other WHERE other.task_id = task_runs.task_id AND other.id NOT LIKE 'initial:%')
  AND NOT EXISTS (SELECT 1 FROM agent_requests request WHERE request.target_run_id = task_runs.id)
  AND NOT EXISTS (SELECT 1 FROM domain_events event WHERE event.run_id = task_runs.id);

DELETE FROM subtasks
WHERE id LIKE 'primary:%'
  AND EXISTS (SELECT 1 FROM subtasks other WHERE other.task_id = subtasks.task_id AND other.parent_subtask_id IS NULL AND other.id NOT LIKE 'primary:%')
  AND NOT EXISTS (SELECT 1 FROM task_runs run WHERE run.subtask_id = subtasks.id)
  AND NOT EXISTS (SELECT 1 FROM subtasks child WHERE child.parent_subtask_id = subtasks.id);

INSERT OR IGNORE INTO subtasks (id, task_id, parent_subtask_id, title, status, assigned_agent_id, dependency_ids, created_at, updated_at)
SELECT
  'primary:' || id,
  id,
  NULL,
  title,
  status,
  agent_id,
  '[]',
  created_at,
  updated_at
FROM tasks
WHERE NOT EXISTS (SELECT 1 FROM subtasks existing WHERE existing.task_id = tasks.id AND existing.parent_subtask_id IS NULL);

INSERT OR IGNORE INTO task_runs (id, task_id, subtask_id, agent_id, agent_kind, runtime_kind, model, status, attempt, session_key, started_at, finished_at, error)
SELECT
  'initial:' || id,
  id,
  (SELECT primary_subtask.id FROM subtasks primary_subtask WHERE primary_subtask.task_id = tasks.id AND primary_subtask.parent_subtask_id IS NULL ORDER BY primary_subtask.created_at, primary_subtask.rowid LIMIT 1),
  agent_id,
  agent_kind,
  CASE
    WHEN agent_kind IN ('codex', 'claude-code', 'codebuddy', 'openclaw', 'antigravity', 'ark-cli', 'custom-cli') THEN 'cli'
    WHEN agent_kind IN ('tokenezgo', 'doubao', 'hermes', 'custom-api') THEN 'api'
    WHEN agent_kind = 'ollama' THEN 'local'
    WHEN agent_kind = 'mock' THEN 'mock'
    ELSE 'unknown'
  END,
  model,
  status,
  1,
  session_key,
  created_at,
  CASE WHEN status IN ('review', 'done', 'failed', 'stopped') THEN updated_at ELSE NULL END,
  NULL
FROM tasks
WHERE NOT EXISTS (SELECT 1 FROM task_runs existing WHERE existing.task_id = tasks.id);
`);
}

backfillCoreRecords();
