import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { db } from "../db/index.ts";

// 数据备份：数据库 + JSON 配置（MCP / 工具库 / 自定义 Agent 等）。代码备份（backup-version.ps1）和 git
// 都故意不碰这些（有 API Key），以前任务、对话、知识库、角色记忆只有 agenthub.sqlite 这一份。
// 只写本机 backups/data，不往共享盘 / 网络位置写。附件（图片，几十 MB）不备份。

/** 跟着数据库一起备份的 JSON 配置。 */
const DATA_FILES = [
  "custom-agents.json",
  "mcp-servers.json",
  "resource-library.json",
  "hidden-agents.json",
  "gateway-settings.json",
  "gateway-usage-ledger.json",
];

export const DATA_BACKUP_KEEP = 14;
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const NAME_PATTERN = /^\d{8}-\d{6}-[a-z]+(?:-[a-z]+)*(?:-\d+)?$/;

/** 正式环境放项目根目录 backups/data；用别的数据库位置（测试、隔离验证实例）时放在那个数据库旁边，不混进真实备份。 */
export function defaultDataBackupDir(): string {
  if (process.env.AGENTHUB_DATA_BACKUP_DIR) return process.env.AGENTHUB_DATA_BACKUP_DIR;
  const standardDataDir = path.resolve(config.serverRoot, "data");
  return path.resolve(config.dataDir) === standardDataDir
    ? path.resolve(config.serverRoot, "..", "backups", "data")
    : path.join(config.dataDir, "backups");
}

function stamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export interface DataBackup {
  name: string;
  path: string;
  createdAt: string;
  sizeBytes: number;
}

export function listDataBackups(backupDir = defaultDataBackupDir()): DataBackup[] {
  if (!fs.existsSync(backupDir)) return [];
  return fs
    .readdirSync(backupDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && NAME_PATTERN.test(entry.name))
    .map((entry) => {
      const dir = path.join(backupDir, entry.name);
      const files = fs.readdirSync(dir).map((file) => fs.statSync(path.join(dir, file)));
      return {
        name: entry.name,
        path: dir,
        createdAt: fs.statSync(dir).mtime.toISOString(),
        sizeBytes: files.reduce((sum, stat) => sum + stat.size, 0),
      };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

/**
 * 备份一次：数据库用 VACUUM INTO 导出（服务跑着也能拿到一致的副本，不用停服务），JSON 直接复制。
 * 先写到 .partial 目录，全部成功再改名，半截的备份不会被当成可用备份。
 */
export function backupData(reason: string, backupDir = defaultDataBackupDir(), keep = DATA_BACKUP_KEEP): DataBackup {
  const safeReason = reason.toLowerCase().replace(/[^a-z-]+/g, "-").replace(/^-+|-+$/g, "") || "manual";
  const base = `${stamp()}-${safeReason}`;
  let name = base;
  for (let n = 2; fs.existsSync(path.join(backupDir, name)); n++) name = `${base}-${n}`;
  const finalDir = path.join(backupDir, name);
  const tempDir = `${finalDir}.partial`;
  fs.mkdirSync(tempDir, { recursive: true });
  try {
    const target = path.join(tempDir, "agenthub.sqlite").replace(/'/g, "''");
    db.exec(`VACUUM INTO '${target}'`);
    for (const file of DATA_FILES) {
      const source = path.join(config.dataDir, file);
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(tempDir, file));
    }
    fs.renameSync(tempDir, finalDir);
  } catch (err) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw err;
  }
  pruneDataBackups(backupDir, keep);
  return listDataBackups(backupDir).find((item) => item.name === name)!;
}

export function pruneDataBackups(backupDir = defaultDataBackupDir(), keep = DATA_BACKUP_KEEP): string[] {
  const removed: string[] = [];
  for (const backup of listDataBackups(backupDir).slice(keep)) {
    fs.rmSync(backup.path, { recursive: true, force: true });
    removed.push(backup.name);
  }
  return removed;
}

/** 服务启动时备份一次，之后每 24 小时一次。失败只记日志，不影响服务。 */
export function startDataBackupSchedule(log: (message: string) => void): () => void {
  const run = (reason: string) => {
    try {
      const backup = backupData(reason);
      log(`数据备份完成：${backup.name}（${(backup.sizeBytes / 1024 / 1024).toFixed(1)} MB）`);
    } catch (err) {
      log(`数据备份失败：${(err as Error).message}`);
    }
  };
  const startup = setTimeout(() => run("startup"), 5_000);
  const daily = setInterval(() => run("daily"), BACKUP_INTERVAL_MS);
  startup.unref();
  daily.unref();
  return () => {
    clearTimeout(startup);
    clearInterval(daily);
  };
}
