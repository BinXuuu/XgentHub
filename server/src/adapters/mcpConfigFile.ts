import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServerSpec } from "./types.ts";

/**
 * `{"mcpServers": {name: {...}}}` 是 Claude Code `--mcp-config` 用的格式，目前也是流传最广的
 * "MCP 配置文件" JSON 约定——其它支持从文件读 MCP 配置的 CLI（包括用户自己接的自定义 CLI）
 * 大概率也认这个格式。写到临时目录，按次传入、用完即删，不碰任何 CLI 自己的持久配置。
 * Claude Code adapter 和自定义 CLI Agent（配了 mcpArgTemplate 的）共用这一份。
 */
export function writeTempMcpConfigFile(label: string, servers: McpServerSpec[]): string {
  const mcpServers: Record<string, unknown> = {};
  for (const server of servers) {
    mcpServers[server.name] =
      server.transport === "http"
        ? { type: "http", url: server.url, ...(server.headers && Object.keys(server.headers).length ? { headers: server.headers } : {}) }
        : { command: server.command, args: server.args ?? [], ...(server.env && Object.keys(server.env).length ? { env: server.env } : {}) };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agenthub-mcp-${label}-`));
  const filePath = path.join(dir, "mcp-config.json");
  fs.writeFileSync(filePath, JSON.stringify({ mcpServers }, null, 2), "utf8");
  return filePath;
}

export function cleanupTempMcpConfigFile(filePath: string | null): void {
  if (!filePath) return;
  try {
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  } catch {
    // best-effort，删不掉就留着，不影响任务结果
  }
}
