import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupIsolatedDb } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("snapshot-limit");
process.env.AGENTHUB_SNAPSHOT_MAX_FILES = "5";
const { db } = await import("../src/db/index.ts");
const snapshots = await import("../src/services/workspaceSnapshotService.ts");

after(() => {
  db.close();
  env.cleanup();
});

function writeFiles(root: string, dir: string, count: number) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (let i = 0; i < count; i++) fs.writeFileSync(path.join(root, dir, `f${i}.txt`), String(i), "utf8");
}

test("files ignored by .gitignore don't count towards the snapshot limit", async () => {
  const ws = path.join(env.root, "ignored-heavy");
  writeFiles(ws, "backups", 50);
  writeFiles(ws, "src", 3);
  fs.writeFileSync(path.join(ws, ".gitignore"), "backups/\n", "utf8");
  const snapshot = await snapshots.createSnapshot({ workspaceId: "ws-ignored", workspacePath: ws, taskId: "t1", kind: "before_run" });
  assert.ok(snapshot.commitId);
});

test("too many real files skips the snapshot with an explanation instead of silently", async () => {
  const ws = path.join(env.root, "too-many");
  writeFiles(ws, "src", 10);
  await assert.rejects(
    snapshots.createSnapshot({ workspaceId: "ws-many", workspacePath: ws, taskId: "t2", kind: "before_run" }),
    (err: Error) => err instanceof snapshots.SnapshotSkippedError && /10 个/.test(err.message) && /上限 5/.test(err.message)
  );
  assert.equal(snapshots.listTaskSnapshots("t2").length, 0);
});

test("snapshots can be switched off entirely", async () => {
  const ws = path.join(env.root, "disabled");
  writeFiles(ws, "src", 1);
  process.env.AGENTHUB_DISABLE_WORKSPACE_SNAPSHOTS = "1";
  try {
    await assert.rejects(
      snapshots.createSnapshot({ workspaceId: "ws-off", workspacePath: ws, taskId: "t3", kind: "before_run" }),
      snapshots.SnapshotSkippedError
    );
  } finally {
    delete process.env.AGENTHUB_DISABLE_WORKSPACE_SNAPSHOTS;
  }
});
