import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { ProxyAgent } from "undici";
import { db } from "../db/index.ts";
import { config } from "../config.ts";
import { spawnCli, killProcessTree } from "../adapters/winSpawn.ts";
import type { McpServerDefinition, McpTransport } from "../types.ts";
import type { McpServerSpec } from "../adapters/types.ts";

const storePath = path.join(config.dataDir, "mcp-servers.json");

export interface McpServerInput {
  name: string;
  transport: McpTransport;
  command?: string | null;
  args?: string[];
  env?: Record<string, string>;
  url?: string | null;
  headers?: Record<string, string>;
  enabled?: boolean;
}

function now(): string {
  return new Date().toISOString();
}

function slugify(raw: string): string {
  const ascii = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return ascii || nanoid(6);
}

function parseIds(value: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function readStore(): McpServerDefinition[] {
  if (!fs.existsSync(storePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStore(items: McpServerDefinition[]) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(items, null, 2) + "\n", "utf8");
}

function uniqueId(name: string, existing: McpServerDefinition[]): string {
  const base = slugify(name);
  let id = `mcp:${base}`;
  let n = 2;
  const seen = new Set(existing.map((item) => item.id));
  while (seen.has(id)) id = `mcp:${base}-${n++}`;
  return id;
}

function normalize(input: McpServerInput): Pick<McpServerDefinition, "transport" | "command" | "args" | "env" | "url" | "headers"> {
  if (input.transport === "http") {
    return { transport: "http", command: null, args: [], env: {}, url: input.url?.trim() || null, headers: input.headers ?? {} };
  }
  return {
    transport: "stdio",
    command: input.command?.trim() || null,
    args: input.args ?? [],
    env: input.env ?? {},
    url: null,
    headers: {},
  };
}

export interface McpServerTestResult {
  ok: boolean;
  message: string;
}

const STDIO_TEST_TIMEOUT_MS = 5_000;
// 实测过 Node 的 fetch 对某些域名（哪怕 curl 几秒内就拿到 200）会明显更慢，8s 太容易假阴性，给够余量。
const HTTP_TEST_TIMEOUT_MS = 15_000;

// Node 内置 fetch 不会像 curl 那样自动读 HTTP_PROXY/HTTPS_PROXY——这台机器的外网访问是走本地
// 代理的，不接这个会导致任何外部 MCP http 地址测试都假失败（连不上代理之外的真实网络）。
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
const proxyDispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

/**
 * "测试连接"：在真正保存/派发给任务之前，先确认这个 MCP server 配置是能跑起来的，而不是等
 * 用户建了任务才发现命令打错字或者 URL 连不上。不代替真实 MCP 客户端做协议握手（那需要完整
 * 实现 JSON-RPC initialize 流程），只做最基础的"连得上/启动不报错"级别的检测：
 * - http：发一个 GET，只要有响应（哪怕是 404/405，MCP 服务端通常只认 POST）就算连通；
 *   网络层失败（DNS/连接拒绝/超时）才算失败。
 * - stdio：把命令启动起来，等几秒——没有立刻崩溃退出 / 报 ENOENT 就算成功；大多数 MCP
 *   server 本来就是常驻等 stdin 输入，所以"一直没退出"反而是正常现象，用超时判定成功。
 */
export async function testMcpServerConnection(input: McpServerInput): Promise<McpServerTestResult> {
  if (input.transport === "http") {
    if (!input.url?.trim()) return { ok: false, message: "没有填 URL" };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_TEST_TIMEOUT_MS);
    try {
      const res = await fetch(input.url, {
        method: "GET",
        headers: input.headers,
        signal: controller.signal,
        ...(proxyDispatcher ? { dispatcher: proxyDispatcher } : {}),
      } as RequestInit);
      return { ok: true, message: `已连上，HTTP ${res.status}` };
    } catch (err) {
      const message =
        err instanceof Error && err.name === "AbortError" ? `${HTTP_TEST_TIMEOUT_MS / 1000} 秒内没有响应` : (err as Error).message;
      return { ok: false, message: `连接失败：${message}` };
    } finally {
      clearTimeout(timeout);
    }
  }

  if (!input.command?.trim()) return { ok: false, message: "没有填启动命令" };
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: McpServerTestResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(input.command!.trim(), input.args ?? [], {
        cwd: process.cwd(),
        env: { ...process.env, ...(input.env ?? {}) },
      });
    } catch (err) {
      finish({ ok: false, message: `启动失败：${(err as Error).message}` });
      return;
    }
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (err) => finish({ ok: false, message: `启动失败：${err.message}` }));
    const timer = setTimeout(() => {
      killProcessTree(child);
      finish({ ok: true, message: "已启动并保持运行（MCP server 常驻等待连接是正常现象）" });
    }, STDIO_TEST_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 || code === null) finish({ ok: true, message: "命令已跑起来并正常退出" });
      else finish({ ok: false, message: `退出码 ${code}${stderr.trim() ? `：${stderr.trim().slice(0, 300)}` : ""}` });
    });
  });
}

export function listMcpServers(): McpServerDefinition[] {
  return readStore().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getMcpServer(id: string): McpServerDefinition | undefined {
  return readStore().find((item) => item.id === id);
}

export function createMcpServer(input: McpServerInput): McpServerDefinition {
  const name = input.name.trim();
  if (!name) throw new Error("名字不能为空");
  if (input.transport === "stdio" && !input.command?.trim()) throw new Error("stdio 类型需要填启动命令");
  if (input.transport === "http" && !input.url?.trim()) throw new Error("http 类型需要填 URL");

  const items = readStore();
  const stamp = now();
  const item: McpServerDefinition = {
    id: uniqueId(name, items),
    name,
    enabled: input.enabled ?? true,
    createdAt: stamp,
    updatedAt: stamp,
    ...normalize(input),
  };
  writeStore([item, ...items]);
  return item;
}

export function updateMcpServer(id: string, patch: Partial<McpServerInput>): McpServerDefinition {
  const items = readStore();
  const idx = items.findIndex((item) => item.id === id);
  if (idx < 0) throw new Error(`未知 MCP server: ${id}`);
  const current = items[idx]!;
  const merged: McpServerInput = {
    name: patch.name?.trim() || current.name,
    transport: patch.transport ?? current.transport,
    command: patch.command !== undefined ? patch.command : current.command,
    args: patch.args ?? current.args,
    env: patch.env ?? current.env,
    url: patch.url !== undefined ? patch.url : current.url,
    headers: patch.headers ?? current.headers,
    enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
  };
  if (merged.transport === "stdio" && !merged.command?.trim()) throw new Error("stdio 类型需要填启动命令");
  if (merged.transport === "http" && !merged.url?.trim()) throw new Error("http 类型需要填 URL");

  const updated: McpServerDefinition = {
    ...current,
    name: merged.name,
    enabled: merged.enabled ?? true,
    updatedAt: now(),
    ...normalize(merged),
  };
  items[idx] = updated;
  writeStore(items);
  return updated;
}

/** 删掉 MCP server，并把它从所有工作区、聊天、角色的勾选里去掉（不留下指向不存在条目的 id）。 */
export function deleteMcpServer(id: string): McpServerDefinition | undefined {
  const items = readStore();
  const item = items.find((entry) => entry.id === id);
  if (!item) return undefined;
  writeStore(items.filter((entry) => entry.id !== id));
  for (const table of ["workspaces", "chats", "agent_roles"]) {
    for (const row of db.prepare(`SELECT id, mcp_server_ids FROM ${table} WHERE mcp_server_ids LIKE ?`).all(`%${JSON.stringify(id)}%`) as {
      id: string;
      mcp_server_ids: string;
    }[]) {
      const ids = parseIds(row.mcp_server_ids);
      db.prepare(`UPDATE ${table} SET mcp_server_ids = ? WHERE id = ?`).run(JSON.stringify(ids.filter((entry) => entry !== id)), row.id);
    }
  }
  return item;
}

/**
 * 把一串 McpServerDefinition.id 实时解析成 adapter 能直接用的 McpServerSpec[]——每次都重新查一遍，
 * 不是建任务/聊天时定死的：这样"随时加/减 MCP"不需要额外的热更新机制，下一轮自然生效。
 * 只取 enabled 的；name 统一加 agenthub- 前缀，避免和用户自己在 Codex/OpenClaw 里配的撞名。
 * Task 和 Chat 两边共用这一份解析逻辑。
 */
export function resolveMcpServers(mcpServerIds: string[]): McpServerSpec[] {
  if (mcpServerIds.length === 0) return [];
  const byId = new Map(listMcpServers().map((item) => [item.id, item]));
  return mcpServerIds
    .map((id) => byId.get(id))
    .filter((item): item is NonNullable<typeof item> => Boolean(item) && item!.enabled)
    .map((item) => {
      const slug = item.id.startsWith("mcp:") ? item.id.slice(4) : item.id;
      const spec: McpServerSpec = { name: `agenthub-${slug}`, transport: item.transport };
      if (item.transport === "stdio") {
        spec.command = item.command ?? undefined;
        spec.args = item.args;
        if (Object.keys(item.env).length) spec.env = item.env;
      } else {
        spec.url = item.url ?? undefined;
        if (Object.keys(item.headers).length) spec.headers = item.headers;
      }
      return spec;
    });
}

export interface McpServerUsageRef {
  id: string;
  title: string;
}

export interface McpServerUsage {
  workspaces: McpServerUsageRef[];
  chats: McpServerUsageRef[];
  roles: McpServerUsageRef[];
}

/**
 * 删除/停用一个 MCP server 之前，让用户能看清楚"现在被哪些工作区 / 聊天 / 角色引用"，不用凭感觉猜影响面。
 * 任务不再单独勾 MCP，而是继承工作区（和角色）的配置，所以看这三处就够了。表都不大，在 JS 里解析 JSON 列即可，
 * 不拼 SQL LIKE（容易因为 id 前缀撞字符串而误匹配）。
 */
export function getMcpServerUsage(id: string): McpServerUsage {
  const references = (sql: string): McpServerUsageRef[] =>
    (db.prepare(sql).all() as { id: string; title: string; mcp_server_ids: string }[])
      .filter((row) => {
        try {
          return (JSON.parse(row.mcp_server_ids) as string[]).includes(id);
        } catch {
          return false;
        }
      })
      .map((row) => ({ id: row.id, title: row.title }));

  return {
    workspaces: references("SELECT id, name AS title, mcp_server_ids FROM workspaces"),
    chats: references("SELECT id, title, mcp_server_ids FROM chats"),
    roles: references("SELECT id, name AS title, mcp_server_ids FROM agent_roles"),
  };
}

/** 给 MCP 管理列表用：每一项都带上当前引用情况，列表项不多，直接一次性算好，不用前端再逐项请求。 */
export function listMcpServersWithUsage(): (McpServerDefinition & { usage: McpServerUsage })[] {
  return listMcpServers().map((item) => ({ ...item, usage: getMcpServerUsage(item.id) }));
}

export { storePath as mcpServerStorePath };
