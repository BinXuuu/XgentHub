import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setupIsolatedDb } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("snapshot-prune");
// 每个任务只留最近 2 轮，方便测"超出轮数"；天数用默认的 30 天。
process.env.AGENTHUB_SNAPSHOT_KEEP_PER_TASK = "2";
const { db } = await import("../src/db/index.ts");
const snapshots = await import("../src/services/workspaceSnapshotService.ts");

after(async () => {
  await snapshots.waitForSnapshotsIdle();
  db.close();
  env.cleanup();
});

const repo = (workspaceId: string) => path.join(env.root, "checkpoints", `${workspaceId}.git`);
const git = (workspaceId: string, args: string[]) =>
  execFileSync("git", ["--git-dir", repo(workspaceId), ...args], { encoding: "utf8" }).trim();
const objectExists = (workspaceId: string, commit: string) => {
  try {
    git(workspaceId, ["cat-file", "-e", `${commit}^{commit}`]);
    return true;
  } catch {
    return false;
  }
};

test("old snapshots and rounds beyond the per-task limit are removed and their disk space is reclaimed", async () => {
  const workspaceId = "ws-prune";
  const wsPath = path.join(env.root, "project");
  fs.mkdirSync(wsPath, { recursive: true });
  const take = async (taskId: string, content: string) => {
    fs.writeFileSync(path.join(wsPath, "app.txt"), content);
    // 每轮写一个独有的大文件，才看得出空间有没有被回收
    fs.writeFileSync(path.join(wsPath, "blob.bin"), Buffer.alloc(200_000, content));
    return snapshots.createSnapshot({ workspaceId, workspacePath: wsPath, taskId, kind: "before_run" });
  };

  const a1 = await take("task-a", "a1");
  const a2 = await take("task-a", "a2");
  const a3 = await take("task-a", "a3");
  const old = await take("task-b", "b-old");
  // task-b 的快照是 40 天前的
  db.prepare("UPDATE workspace_snapshots SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 40 * 86400_000).toISOString(), old.id);
  for (const item of [a1, a2, a3, old]) assert.ok(objectExists(workspaceId, item.commitId));

  const result = await snapshots.pruneSnapshots();
  assert.equal(result.removed, 2, "a1 (beyond the newest 2 of task-a) and the 40-day-old task-b snapshot");
  assert.deepEqual(
    snapshots.listTaskSnapshots("task-a").map((item) => item.id),
    [a2.id, a3.id]
  );
  assert.deepEqual(snapshots.listTaskSnapshots("task-b"), []);

  // 被删的快照在影子仓库里真的没了（空间回收），留下的还在
  assert.equal(objectExists(workspaceId, a1.commitId), false);
  assert.equal(objectExists(workspaceId, old.commitId), false);
  assert.ok(objectExists(workspaceId, a2.commitId));
  assert.ok(objectExists(workspaceId, a3.commitId));
  assert.deepEqual(git(workspaceId, ["for-each-ref", "--format=%(refname)", "refs/snapshots/"]).split("\n").sort(), [
    `refs/snapshots/${a2.id}`,
    `refs/snapshots/${a3.id}`,
  ].sort());

  // 留下的快照照样能撤回
  fs.writeFileSync(path.join(wsPath, "app.txt"), "changed later");
  await snapshots.restoreSnapshot(a2, wsPath);
  assert.equal(fs.readFileSync(path.join(wsPath, "app.txt"), "utf8"), "a2");

  // 清理之后继续拍快照、再清理也正常
  const a4 = await take("task-a", "a4");
  await snapshots.pruneSnapshots();
  assert.ok(objectExists(workspaceId, a4.commitId));
});

test("refs left behind by deleted tasks are cleaned up too", async () => {
  const workspaceId = "ws-orphan";
  const wsPath = path.join(env.root, "project-2");
  fs.mkdirSync(wsPath, { recursive: true });
  fs.writeFileSync(path.join(wsPath, "x.txt"), "x");
  const snap = await snapshots.createSnapshot({ workspaceId, workspacePath: wsPath, taskId: "task-gone", kind: "before_run" });
  snapshots.deleteTaskSnapshots("task-gone"); // 删任务只删记录
  assert.ok(objectExists(workspaceId, snap.commitId));

  await snapshots.pruneSnapshots();
  assert.equal(objectExists(workspaceId, snap.commitId), false);
  assert.equal(git(workspaceId, ["for-each-ref", "refs/snapshots/"]), "");
});
