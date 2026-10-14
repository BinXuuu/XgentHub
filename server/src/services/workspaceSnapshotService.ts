import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { config } from "../config.ts";
import { db } from "../db/index.ts";

// 每一轮派发前给工作区拍快照，用来"撤回某一轮"。快照放在 AgentHub 数据目录里的影子 git 仓库
// （--git-dir 指过去、--work-tree 指向工作区），不碰工作区自己的 .git，没装 git 仓库的工作区也能用。
// 工作区 .gitignore 里的内容不会进快照，所以撤回也不会动它们。
// 每个快照是一个独立的 commit（不再串成一条链），各自用 refs/snapshots/<快照 id> 挂住；
// 相同的文件内容 git 只存一份，所以不串链也不会多占空间。这样清理旧快照时删掉 ref 再 gc 就能真正回收磁盘。

export type SnapshotKind = "before_run" | "before_restore";

export interface WorkspaceSnapshot {
  id: string;
  workspaceId: string;
  taskId: string;
  runId: string | null;
  messageId: string | null;
  kind: SnapshotKind;
  commitId: string;
  createdAt: string;
}

export interface RestorePreview {
  restore: string[];
  remove: string[];
  recreate: string[];
}

const DEFAULT_EXCLUDES = [
  "node_modules/",
  ".git/",
  ".venv/",
  "venv/",
  "__pycache__/",
  "*.pyc",
  "dist/",
  "build/",
  "out/",
  "coverage/",
  ".next/",
  ".nuxt/",
  ".turbo/",
  ".cache/",
  "logs/",
  "Thumbs.db",
  ".DS_Store",
];
const SNAPSHOT_REF = "refs/heads/snapshots";
const GIT_TIMEOUT_MS = 180_000;
const SNAPSHOT_MAX_FILES = Math.max(1, Number(process.env.AGENTHUB_SNAPSHOT_MAX_FILES ?? "12000") || 12000);
/** 撤回快照保留多久、每个任务最多留几轮；超出的每天清理一次。 */
export const SNAPSHOT_KEEP_DAYS = Math.max(1, Number(process.env.AGENTHUB_SNAPSHOT_KEEP_DAYS) || 30);
export const SNAPSHOT_KEEP_PER_TASK = Math.max(1, Number(process.env.AGENTHUB_SNAPSHOT_KEEP_PER_TASK) || 50);

function snapshotRefName(snapshotId: string): string {
  return `refs/snapshots/${snapshotId}`;
}

/** 这一轮按规则不拍快照（关掉了 / 文件太多）。不是故障，调用方记一条说明即可。 */
export class SnapshotSkippedError extends Error {}

function dataDir(): string {
  return path.dirname(config.dbPath);
}

function snapshotRoot(): string {
  return path.join(dataDir(), "checkpoints");
}

function repoPath(workspaceId: string): string {
  return path.join(snapshotRoot(), `${workspaceId}.git`);
}

function rowToSnapshot(row: any): WorkspaceSnapshot {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    taskId: row.task_id,
    runId: row.run_id ?? null,
    messageId: row.message_id ?? null,
    kind: row.kind,
    commitId: row.commit_id,
    createdAt: row.created_at,
  };
}

function runGit(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      stderr += "\ngit 命令超时";
    }, GIT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr || err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function shadowGit(workspaceId: string, workspacePath: string) {
  const base = [
    "--git-dir",
    repoPath(workspaceId),
    "--work-tree",
    workspacePath,
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.safecrlf=false",
    "-c",
    "core.longpaths=true",
    "-c",
    "core.quotepath=false",
    "-c",
    "gc.auto=0",
    "-c",
    "user.name=Xgent Hub",
    "-c",
    "user.email=agenthub@localhost",
  ];
  return async (args: string[]): Promise<string> => {
    const result = await runGit([...base, ...args], workspacePath);
    if (result.code !== 0) throw new Error(`git ${args[0]} 失败：${result.stderr.trim() || `exit ${result.code}`}`);
    return result.stdout;
  };
}

// AgentHub 自己的数据目录（数据库、MCP/工具配置、快照仓库本身）如果落在工作区里，必须排除，
// 否则撤回会把 AgentHub 的配置一起回滚，快照仓库还会把自己装进自己。
function excludeLines(workspacePath: string): string[] {
  const lines = [...DEFAULT_EXCLUDES];
  const relative = path.relative(path.resolve(workspacePath), path.resolve(dataDir()));
  if (relative === "") {
    lines.push("/checkpoints/", "*.sqlite", "*.sqlite-*");
  } else if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    lines.push(`/${relative.split(path.sep).join("/")}/`);
  }
  return lines;
}

async function ensureRepo(workspaceId: string, workspacePath: string): Promise<void> {
  if (!fs.existsSync(workspacePath)) throw new Error(`工作区目录不存在：${workspacePath}`);
  const repo = repoPath(workspaceId);
  if (!fs.existsSync(path.join(repo, "HEAD"))) {
    fs.mkdirSync(snapshotRoot(), { recursive: true });
    const init = await runGit(["init", "--bare", "--quiet", repo], snapshotRoot());
    if (init.code !== 0) throw new Error(`初始化快照仓库失败：${init.stderr.trim()}`);
    const bare = await runGit(["--git-dir", repo, "config", "core.bare", "false"], snapshotRoot());
    if (bare.code !== 0) throw new Error(`配置快照仓库失败：${bare.stderr.trim()}`);
  }
  fs.mkdirSync(path.join(repo, "info"), { recursive: true });
  fs.writeFileSync(path.join(repo, "info", "exclude"), `${excludeLines(workspacePath).join("\n")}\n`, "utf8");
}

const workspaceLocks = new Map<string, Promise<unknown>>();

/** 等所有工作区上正在进行的快照/撤回结束（关库、退出前用），再让出一轮事件循环，让调用方拍完快照后的收尾逻辑也跑完。 */
export async function waitForSnapshotsIdle(): Promise<void> {
  await Promise.allSettled([...workspaceLocks.values()]);
  await new Promise((resolve) => setImmediate(resolve));
}

// 同一个工作区的快照/撤回串行执行，避免两个任务同时动影子仓库的 index。
function withWorkspaceLock<T>(workspaceId: string, job: () => Promise<T>): Promise<T> {
  const previous = workspaceLocks.get(workspaceId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(job);
  workspaceLocks.set(workspaceId, next);
  return next;
}

/**
 * 让 git 自己数这次快照要管的文件：已在快照里的 + 新出现且没被忽略的。这样 .gitignore 和上面的排除规则
 * 都算数（比如 AgentHub 自己的 backups/ 有上万个文件，但早被忽略，不该算进来），而且是异步子进程，不卡服务。
 */
async function countSnapshotFiles(workspaceId: string, workspacePath: string): Promise<number> {
  const output = await shadowGit(workspaceId, workspacePath)(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  let count = 0;
  for (let i = 0; i < output.length; i++) if (output.charCodeAt(i) === 0) count++;
  return count;
}

async function commitCurrentState(workspaceId: string, workspacePath: string, message: string): Promise<string> {
  await ensureRepo(workspaceId, workspacePath);
  const git = shadowGit(workspaceId, workspacePath);
  await git(["add", "-A", "--ignore-errors", "."]);
  const tree = (await git(["write-tree"])).trim();
  const parent = await runGit(["--git-dir", repoPath(workspaceId), "rev-parse", "--verify", "-q", SNAPSHOT_REF], snapshotRoot());
  const parentCommit = parent.code === 0 ? parent.stdout.trim() : "";
  if (parentCommit) {
    const parentTree = await runGit(["--git-dir", repoPath(workspaceId), "rev-parse", `${parentCommit}^{tree}`], snapshotRoot());
    if (parentTree.code === 0 && parentTree.stdout.trim() === tree) return parentCommit;
  }
  // 不挂父 commit：每个快照独立，由各自的 refs/snapshots/<id> 挂住，清理时才能真正回收。
  const commit = (await git(["commit-tree", tree, "-m", message])).trim();
  await git(["update-ref", SNAPSHOT_REF, commit]);
  return commit;
}

async function insertSnapshot(input: Omit<WorkspaceSnapshot, "id" | "createdAt">): Promise<WorkspaceSnapshot> {
  const snapshot: WorkspaceSnapshot = { ...input, id: nanoid(), createdAt: new Date().toISOString() };
  const ref = await runGit(["--git-dir", repoPath(snapshot.workspaceId), "update-ref", snapshotRefName(snapshot.id), snapshot.commitId], snapshotRoot());
  if (ref.code !== 0) throw new Error(`记录快照失败：${ref.stderr.trim()}`);
  db.prepare(
    "INSERT INTO workspace_snapshots (id, workspace_id, task_id, run_id, message_id, kind, commit_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(snapshot.id, snapshot.workspaceId, snapshot.taskId, snapshot.runId, snapshot.messageId, snapshot.kind, snapshot.commitId, snapshot.createdAt);
  return snapshot;
}

export function createSnapshot(input: {
  workspaceId: string;
  workspacePath: string;
  taskId: string;
  runId?: string | null;
  messageId?: string | null;
  kind: SnapshotKind;
}): Promise<WorkspaceSnapshot> {
  return withWorkspaceLock(input.workspaceId, async () => {
    if (process.env.AGENTHUB_DISABLE_WORKSPACE_SNAPSHOTS === "1") {
      throw new SnapshotSkippedError("工作区快照已通过 AGENTHUB_DISABLE_WORKSPACE_SNAPSHOTS=1 关闭，这一轮之后不能撤回");
    }
    await ensureRepo(input.workspaceId, input.workspacePath);
    const fileCount = await countSnapshotFiles(input.workspaceId, input.workspacePath);
    if (fileCount > SNAPSHOT_MAX_FILES) {
      throw new SnapshotSkippedError(
        `工作区快照已跳过：需要快照的文件有 ${fileCount} 个（已排除 .gitignore 忽略的），超过上限 ${SNAPSHOT_MAX_FILES}，这一轮之后不能撤回。` +
          `可以在工作区的 .gitignore 里排除大目录，或用环境变量 AGENTHUB_SNAPSHOT_MAX_FILES 调高上限。`
      );
    }
    const commitId = await commitCurrentState(input.workspaceId, input.workspacePath, `${input.kind} task=${input.taskId}`);
    return insertSnapshot({
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      runId: input.runId ?? null,
      messageId: input.messageId ?? null,
      kind: input.kind,
      commitId,
    });
  });
}

export function getSnapshot(id: string): WorkspaceSnapshot | null {
  const row = db.prepare("SELECT * FROM workspace_snapshots WHERE id = ?").get(id);
  return row ? rowToSnapshot(row) : null;
}

export function listTaskSnapshots(taskId: string): WorkspaceSnapshot[] {
  return (db.prepare("SELECT * FROM workspace_snapshots WHERE task_id = ? ORDER BY created_at ASC").all(taskId) as any[]).map(rowToSnapshot);
}

export function linkSnapshotMessage(snapshotId: string, messageId: string): void {
  db.prepare("UPDATE workspace_snapshots SET message_id = ? WHERE id = ?").run(messageId, snapshotId);
}

function parseNameStatus(output: string): RestorePreview {
  const preview: RestorePreview = { restore: [], remove: [], recreate: [] };
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [status, ...rest] = line.split("\t");
    const file = rest.join("\t");
    // diff 方向是"快照 → 现在"：A=快照之后新增（撤回会删掉），D=快照之后被删（撤回会恢复出来），其余=改过（撤回会还原）。
    if (status.startsWith("A")) preview.remove.push(file);
    else if (status.startsWith("D")) preview.recreate.push(file);
    else preview.restore.push(file);
  }
  return preview;
}

export function previewRestore(snapshot: WorkspaceSnapshot, workspacePath: string): Promise<RestorePreview> {
  return withWorkspaceLock(snapshot.workspaceId, async () => {
    await ensureRepo(snapshot.workspaceId, workspacePath);
    const git = shadowGit(snapshot.workspaceId, workspacePath);
    await git(["add", "-A", "--ignore-errors", "."]);
    return parseNameStatus(await git(["diff", "--cached", "--name-status", "--no-renames", snapshot.commitId]));
  });
}

/** 把工作区恢复到快照那一刻。恢复前先自动存一份当前状态（before_restore），撤回本身也能再撤回。 */
export function restoreSnapshot(
  snapshot: WorkspaceSnapshot,
  workspacePath: string
): Promise<{ preview: RestorePreview; safety: WorkspaceSnapshot }> {
  return withWorkspaceLock(snapshot.workspaceId, async () => {
    const safetyCommit = await commitCurrentState(snapshot.workspaceId, workspacePath, `before_restore task=${snapshot.taskId}`);
    const safety = await insertSnapshot({
      workspaceId: snapshot.workspaceId,
      taskId: snapshot.taskId,
      runId: null,
      messageId: null,
      kind: "before_restore",
      commitId: safetyCommit,
    });
    const git = shadowGit(snapshot.workspaceId, workspacePath);
    const preview = parseNameStatus(await git(["diff", "--name-status", "--no-renames", snapshot.commitId, safetyCommit]));
    await git(["read-tree", "-u", "--reset", snapshot.commitId]);
    return { preview, safety };
  });
}

/**
 * 清理撤回快照：超过 SNAPSHOT_KEEP_DAYS 天的、以及每个任务最新 SNAPSHOT_KEEP_PER_TASK 轮以外的都删掉，
 * 再把影子仓库里没人用的 ref 删掉、gc 回收空间。删任务/删工作区留下的孤儿 ref 也一起清。
 */
export async function pruneSnapshots(now = Date.now()): Promise<{ removed: number; workspaces: number }> {
  const cutoff = new Date(now - SNAPSHOT_KEEP_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const rows = db.prepare("SELECT id, task_id, created_at FROM workspace_snapshots ORDER BY created_at DESC").all() as {
    id: string;
    task_id: string;
    created_at: string;
  }[];
  const perTask = new Map<string, number>();
  const expired: string[] = [];
  for (const row of rows) {
    const seen = (perTask.get(row.task_id) ?? 0) + 1;
    perTask.set(row.task_id, seen);
    if (row.created_at < cutoff || seen > SNAPSHOT_KEEP_PER_TASK) expired.push(row.id);
  }
  const removeRow = db.prepare("DELETE FROM workspace_snapshots WHERE id = ?");
  for (const id of expired) removeRow.run(id);

  let workspaces = 0;
  if (fs.existsSync(snapshotRoot())) {
    for (const entry of fs.readdirSync(snapshotRoot(), { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.endsWith(".git")) continue;
      const workspaceId = entry.name.slice(0, -4);
      await withWorkspaceLock(workspaceId, () => compactRepo(workspaceId));
      workspaces += 1;
    }
  }
  return { removed: expired.length, workspaces };
}

/** 让影子仓库里只剩数据库里还记着的快照：补齐缺的 ref（老版本的快照没挂 ref）、删掉多余的，再 gc。 */
async function compactRepo(workspaceId: string): Promise<void> {
  const repo = repoPath(workspaceId);
  const kept = db.prepare("SELECT id, commit_id FROM workspace_snapshots WHERE workspace_id = ?").all(workspaceId) as { id: string; commit_id: string }[];
  const keptRefs = new Map(kept.map((row) => [snapshotRefName(row.id), row.commit_id]));
  const listed = await runGit(["--git-dir", repo, "for-each-ref", "--format=%(refname)", "refs/snapshots/"], snapshotRoot());
  if (listed.code !== 0) throw new Error(`读取快照仓库失败：${listed.stderr.trim()}`);
  const existing = new Set(listed.stdout.split(/\r?\n/).filter(Boolean));
  for (const ref of existing) {
    if (!keptRefs.has(ref)) await runGit(["--git-dir", repo, "update-ref", "-d", ref], snapshotRoot());
  }
  for (const [ref, commit] of keptRefs) {
    if (!existing.has(ref)) await runGit(["--git-dir", repo, "update-ref", ref, commit], snapshotRoot());
  }
  // SNAPSHOT_REF 只用来"内容没变就不重复记"，删了无妨（下次快照会重建）；老版本的快照是串成链的，
  // 不删它的话最新那个 commit 会通过父链把所有旧快照都挂住，空间回收不了。
  await runGit(["--git-dir", repo, "update-ref", "-d", SNAPSHOT_REF], snapshotRoot());
  await runGit(["--git-dir", repo, "reflog", "expire", "--expire=now", "--all"], snapshotRoot());
  await runGit(["--git-dir", repo, "gc", "--prune=now", "--quiet"], snapshotRoot());
}

/** 服务启动后一分钟清理一次，之后每天一次。失败只记日志。 */
export function startSnapshotPruneSchedule(log: (message: string) => void): () => void {
  const run = () => {
    pruneSnapshots()
      .then(({ removed, workspaces }) => {
        if (removed > 0) log(`撤回快照清理：删掉 ${removed} 个（保留 ${SNAPSHOT_KEEP_DAYS} 天内、每个任务最近 ${SNAPSHOT_KEEP_PER_TASK} 轮），整理了 ${workspaces} 个快照仓库`);
      })
      .catch((err) => log(`撤回快照清理失败：${(err as Error).message}`));
  };
  const first = setTimeout(run, 60_000);
  const daily = setInterval(run, 24 * 60 * 60 * 1000);
  first.unref();
  daily.unref();
  return () => {
    clearTimeout(first);
    clearInterval(daily);
  };
}

export function deleteTaskSnapshots(taskId: string): void {
  db.prepare("DELETE FROM workspace_snapshots WHERE task_id = ?").run(taskId);
}

export function deleteWorkspaceSnapshots(workspaceId: string): void {
  db.prepare("DELETE FROM workspace_snapshots WHERE workspace_id = ?").run(workspaceId);
  fs.rmSync(repoPath(workspaceId), { recursive: true, force: true });
}
