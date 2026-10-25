import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { setupIsolatedDb } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("update-service");

// 本机假 GitHub：/repos/<repo>/tags 和 /<repo>/<tag>/CHANGELOG.md
let tags: Array<{ name: string }> = [];
let tagsStatus = 200;
const server = http.createServer((req, res) => {
  if (req.url?.startsWith("/repos/test/xgent/tags")) {
    res.writeHead(tagsStatus, { "content-type": "application/json" });
    res.end(JSON.stringify(tagsStatus === 200 ? tags : { message: "Not Found" }));
    return;
  }
  if (req.url === "/test/xgent/v1.3.0/CHANGELOG.md") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("# 更新日志\n\n## v1.3.0\n\n- 子任务并行\n- 新弹窗\n\n## v1.2.0\n\n- 旧内容\n");
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.AGENTHUB_UPDATE_REPO = "test/xgent";
process.env.AGENTHUB_UPDATE_API_BASE = base;
process.env.AGENTHUB_UPDATE_RAW_BASE = base;

const { db } = await import("../src/db/index.ts");
const updates = await import("../src/services/updateService.ts");

after(() => {
  server.close();
  db.close();
  env.cleanup();
});

test("version compare and changelog section", () => {
  assert.ok(updates.compareVersions("1.10.0", "1.9.9") > 0);
  assert.ok(updates.compareVersions("v1.2.3", "1.2.3") === 0);
  assert.ok(updates.compareVersions("0.1.0", "1.0.0") < 0);
  assert.ok(updates.compareVersions("not-a-version", "0.0.1") < 0);
  const md = "## v1.3.0\n\n- a\n- b\n\n## 1.2.0\n\n- old";
  assert.equal(updates.extractChangelogSection(md, "1.3.0"), "- a\n- b");
  assert.equal(updates.extractChangelogSection(md, "v1.2.0"), "- old");
  assert.equal(updates.extractChangelogSection(md, "9.9.9"), "");
});

test("finds the highest version tag, compares it with package.json and reads its notes", async () => {
  process.env.AGENTHUB_UPDATE_MODE = "archive";
  tags = [{ name: "v1.2.0" }, { name: "v1.3.0" }, { name: "nightly" }, { name: "v1.10.0-beta" }];
  const info = await updates.checkForUpdate(true);
  assert.equal(info.error, null);
  assert.equal(info.latestTag, "v1.3.0");
  assert.equal(info.latestVersion, "1.3.0");
  assert.equal(info.currentVersion, updates.currentVersion());
  assert.equal(info.available, updates.compareVersions("1.3.0", updates.currentVersion()) > 0);
  if (info.available) assert.equal(info.notes, "- 子任务并行\n- 新弹窗");
  assert.equal(info.mode, "archive");
});

test("a missing or private repository gives a clear message instead of crashing", async () => {
  tagsStatus = 404;
  const info = await updates.checkForUpdate(true);
  assert.match(info.error ?? "", /仓库不存在或还没有公开/);
  assert.equal(info.available, false);
  tagsStatus = 200;
});

test("the development repository is never updated automatically", async () => {
  delete process.env.AGENTHUB_UPDATE_MODE;
  // 用临时仓库判断，不依赖测试代码本身放在哪（GitHub CI 拉下来的就是开源仓库，传到别的机器上的可能没有 .git）。
  const repo = (origin: string | null) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xgent-mode-"));
    if (origin !== null) {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      execFileSync("git", ["remote", "add", "origin", origin], { cwd: dir });
    }
    return dir;
  };
  const dev = updates.detectInstallMode(repo("https://github.com/someone/my-fork.git"));
  assert.equal(dev.mode, "dev");
  assert.match(dev.reason ?? "", /开发用的项目/);
  assert.equal(updates.detectInstallMode(repo("https://github.com/test/xgent.git")).mode, "git");
  assert.equal(updates.detectInstallMode(repo("git@github.com:test/xgent.git")).mode, "git");
  assert.equal(updates.detectInstallMode(repo(null)).mode, "archive");

  process.env.AGENTHUB_UPDATE_MODE = "dev";
  tags = [{ name: "v99.0.0" }];
  await assert.rejects(updates.startUpdate(), /关闭自动更新/);
  delete process.env.AGENTHUB_UPDATE_MODE;
});

test("refuses to update while a task is still running", async () => {
  process.env.AGENTHUB_UPDATE_MODE = "archive";
  tags = [{ name: "v99.0.0" }];
  const { createWorkspace } = await import("../src/services/workspaceService.ts");
  const { taskManager } = await import("../src/services/taskManager.ts");
  const workspace = createWorkspace({ name: "Update Busy Workspace", path: env.root, allowedAgentKinds: [] });
  // 不带 prompt 只建任务、不启动 Agent，再把状态标成运行中。
  const task = taskManager.createTask({ agentId: "mock", workspaceId: workspace.id, title: "还在跑的任务", actor: "test" });
  db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(task.id);
  await assert.rejects(updates.startUpdate(), /有 1 个任务正在运行/);
});
