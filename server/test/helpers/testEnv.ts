import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface IsolatedDbEnv {
  root: string;
  dbPath: string;
  cleanup(): void;
}

export function setupIsolatedDb(prefix: string): IsolatedDbEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `agenthub-${prefix}-`));
  const dbPath = path.join(root, "agenthub.sqlite");

  process.env.DB_PATH = dbPath;
  process.env.ADMIN_TOKEN = "test-token";
  process.env.HOST = "127.0.0.1";
  process.env.PORT = "0";
  process.env.LOG_LEVEL = "silent";

  return {
    root,
    dbPath,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export async function waitFor<T>(
  read: () => T | null | undefined,
  options: { timeoutMs?: number; intervalMs?: number; description?: string } = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const intervalMs = options.intervalMs ?? 25;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const value = read();
    if (value != null) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out waiting for ${options.description ?? "condition"}`);
}
