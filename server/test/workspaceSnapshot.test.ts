import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupIsolatedDb } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("workspace-snapshot");
// 跟真实布局一样：AgentHub 数据目录在工作区里面的 server/data 下。
const dataDirInWorkspace = path.join(env.root, "server", "data");
fs.mkdirSync(dataDirInWorkspace, { recursive: true });
process.env.DB_PATH = path.join(dataDirInWorkspace, "agenthub.sqlite");
const { db } = await import("../src/db/index.ts");
const snapshots = await import("../src/services/workspaceSnapshotService.ts");

after(() => {
  db.close();
  env.cleanup();
});

function write(root: string, file: string, content: string) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content, "utf8");
}

function read(root: string, file: string): string | null {
  const full = path.join(root, file);
  return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
}

test("restoring a snapshot reverts modified, deleted and added files but leaves ignored dirs and .git alone", async () => {
  const ws = path.join(env.root, "ws");
  write(ws, "a.txt", "original a");
  write(ws, "sub/b.txt", "original b");
  write(ws, "node_modules/pkg/index.js", "dep v1");
  write(ws, ".git/HEAD", "ref: refs/heads/main\n");
  write(ws, ".gitignore", "secret.env\n");
  write(ws, "secret.env", "TOKEN=1");

  const before = await snapshots.createSnapshot({ workspaceId: "ws1", workspacePath: ws, taskId: "t1", messageId: "m1", kind: "before_run" });

  write(ws, "a.txt", "agent changed a");
  fs.rmSync(path.join(ws, "sub/b.txt"));
  write(ws, "c.txt", "agent added c");
  write(ws, "node_modules/pkg/index.js", "dep v2");
  write(ws, ".git/HEAD", "ref: refs/heads/other\n");
  write(ws, "secret.env", "TOKEN=2");

  const preview = await snapshots.previewRestore(before, ws);
  assert.deepEqual(preview, { restore: ["a.txt"], remove: ["c.txt"], recreate: ["sub/b.txt"] });

  const { safety } = await snapshots.restoreSnapshot(before, ws);
  assert.equal(read(ws, "a.txt"), "original a");
  assert.equal(read(ws, "sub/b.txt"), "original b");
  assert.equal(read(ws, "c.txt"), null);
  assert.equal(read(ws, "node_modules/pkg/index.js"), "dep v2");
  assert.equal(read(ws, ".git/HEAD"), "ref: refs/heads/other\n");
  assert.equal(read(ws, "secret.env"), "TOKEN=2");

  await snapshots.restoreSnapshot(safety, ws);
  assert.equal(read(ws, "a.txt"), "agent changed a");
  assert.equal(read(ws, "sub/b.txt"), null);
  assert.equal(read(ws, "c.txt"), "agent added c");

  assert.equal(snapshots.listTaskSnapshots("t1").filter((item) => item.kind === "before_restore").length, 2);
});

test("AgentHub's own data dir is never captured when it lives inside the workspace", async () => {
  const ws = env.root;
  write(ws, "project.txt", "v1");
  write(ws, "server/data/mcp-servers.json", "[\"keep me\"]");
  const snap = await snapshots.createSnapshot({ workspaceId: "ws-root", workspacePath: ws, taskId: "t2", kind: "before_run" });

  write(ws, "project.txt", "v2");
  write(ws, "server/data/mcp-servers.json", "[\"newer config\"]");
  const preview = await snapshots.previewRestore(snap, ws);
  const touched = [...preview.restore, ...preview.remove, ...preview.recreate];
  assert.ok(touched.includes("project.txt"));
  assert.ok(touched.every((file) => !file.startsWith("server/data/")), `data dir leaked into snapshot: ${touched.join(", ")}`);

  await snapshots.restoreSnapshot(snap, ws);
  assert.equal(read(ws, "project.txt"), "v1");
  assert.equal(read(ws, "server/data/mcp-servers.json"), "[\"newer config\"]");
  assert.ok(fs.existsSync(path.join(dataDirInWorkspace, "checkpoints", "ws-root.git", "HEAD")));
});
