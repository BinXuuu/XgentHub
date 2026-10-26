import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setupIsolatedDb } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("data-backup");
const { db } = await import("../src/db/index.ts");
const { config } = await import("../src/config.ts");
const { backupData, defaultDataBackupDir, listDataBackups } = await import("../src/services/dataBackupService.ts");
const { createKnowledgeGroup } = await import("../src/services/knowledgeService.ts");

after(() => {
  db.close();
  env.cleanup();
});

test("with a non-standard database location, backups stay next to that database (never in the real backups folder)", () => {
  assert.equal(defaultDataBackupDir(), path.join(config.dataDir, "backups"));
});

test("a backup is a consistent, openable copy of the live database plus the JSON configs", () => {
  createKnowledgeGroup({ name: "备份前就有的组" });
  fs.writeFileSync(path.join(config.dataDir, "mcp-servers.json"), JSON.stringify([{ id: "mcp:x", name: "X" }]));
  fs.writeFileSync(path.join(config.dataDir, "skill-groups.json"), JSON.stringify([{ id: "skill-group:x", name: "插件组" }]));
  const backupDir = path.join(env.root, "backups-a");

  const backup = backupData("manual", backupDir);
  assert.match(backup.name, /^\d{8}-\d{6}-manual$/);
  assert.ok(backup.sizeBytes > 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(backup.path, "mcp-servers.json"), "utf8")), [{ id: "mcp:x", name: "X" }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(backup.path, "skill-groups.json"), "utf8")), [{ id: "skill-group:x", name: "插件组" }]);

  // 备份之后的改动不影响备份；备份文件能单独打开、数据完整。
  createKnowledgeGroup({ name: "备份后才建的组" });
  const copy = new DatabaseSync(path.join(backup.path, "agenthub.sqlite"), { readOnly: true });
  const names = (copy.prepare("SELECT name FROM knowledge_groups").all() as { name: string }[]).map((row) => row.name);
  copy.close();
  assert.deepEqual(names, ["备份前就有的组"]);
  assert.equal(fs.readdirSync(backupDir).some((name) => name.endsWith(".partial")), false);
});

test("only the newest N backups are kept", () => {
  const backupDir = path.join(env.root, "backups-b");
  for (let i = 0; i < 4; i++) backupData("daily", backupDir, 2);
  const kept = listDataBackups(backupDir);
  assert.equal(kept.length, 2);
  assert.equal(fs.readdirSync(backupDir).length, 2);
  // 同一秒连续备份也不会互相覆盖（名字自动加序号）。
  assert.equal(new Set(kept.map((item) => item.name)).size, 2);
});
