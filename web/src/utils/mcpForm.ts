// MCP 表单里「参数」输入框和「粘贴 JSON 导入」用到的纯函数（服务端测试直接导入这个文件）。

/**
 * 参数框 → 参数数组。可以一行一个，也可以一行写几个用空格分开；带空格的参数用双引号括起来。
 * 反斜杠不当转义符，Windows 路径（D:\My Tools\bridge.js）原样保留。
 */
export function parseArgsText(text: string): string[] {
  const args: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    let current = "";
    let inQuote = false;
    let started = false;
    for (const ch of line) {
      if (ch === '"') {
        inQuote = !inQuote;
        started = true;
      } else if (!inQuote && /\s/.test(ch)) {
        if (started) args.push(current);
        current = "";
        started = false;
      } else {
        current += ch;
        started = true;
      }
    }
    if (started) args.push(current);
  }
  return args;
}

/** 参数数组 → 参数框：一行一个，带空格的加双引号，保证再解析回来不变。 */
const quoteIfNeeded = (arg: string) => (arg === "" || /\s/.test(arg) ? `"${arg}"` : arg);

export function formatArgsText(args: string[]): string {
  return args.map(quoteIfNeeded).join("\n");
}

/** 列表里显示的一整行命令：带空格的部分加引号，不然 C:\Program Files\... 看起来像被拆成了两个参数。 */
export function formatCommandLine(command: string | null | undefined, args: string[]): string {
  return [...(command ? [command] : []), ...args].map(quoteIfNeeded).join(" ");
}

export interface ImportedMcpServer {
  name: string;
  transport: "stdio" | "http";
  command: string | null;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  headers: Record<string, string>;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, v]) => [key, String(v)]));
}

function toServer(name: string, raw: unknown): ImportedMcpServer {
  if (!raw || typeof raw !== "object") throw new Error(`「${name || "未命名"}」不是一个对象`);
  const item = raw as Record<string, unknown>;
  const url = typeof item.url === "string" ? item.url : typeof item.serverUrl === "string" ? item.serverUrl : null;
  const type = String(item.transport ?? item.type ?? "").toLowerCase();
  const isHttp = Boolean(url) && type !== "stdio";
  if (!isHttp && typeof item.command !== "string") throw new Error(`「${name || "未命名"}」缺少 command（stdio）或 url（http）`);
  return {
    name,
    transport: isHttp ? "http" : "stdio",
    command: isHttp ? null : (item.command as string),
    args: isHttp ? [] : Array.isArray(item.args) ? item.args.map(String) : [],
    env: isHttp ? {} : stringRecord(item.env),
    url: isHttp ? url : null,
    headers: isHttp ? stringRecord(item.headers) : {},
  };
}

/**
 * 粘贴的 JSON → MCP 配置。支持三种常见写法：
 * - 单个条目：{ "name": "...", "command": "...", "args": [...], "env": {...} }（比如桥接程序生成的配置文件）
 * - 标准包装：{ "mcpServers": { "名字": { "command": ... } | { "url": ... } } }（Claude Desktop / Cursor 等用的格式）
 * - 上面单个条目组成的数组
 */
export function parseMcpImport(text: string): ImportedMcpServer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`不是有效的 JSON：${(err as Error).message}`);
  }
  let servers: ImportedMcpServer[];
  if (Array.isArray(parsed)) {
    servers = parsed.map((item, index) => toServer(String((item as { name?: unknown })?.name ?? `mcp-${index + 1}`), item));
  } else if (parsed && typeof parsed === "object" && "mcpServers" in parsed) {
    const map = (parsed as { mcpServers: unknown }).mcpServers;
    if (!map || typeof map !== "object") throw new Error("mcpServers 应该是一个对象");
    servers = Object.entries(map as Record<string, unknown>).map(([name, item]) => toServer(name, item));
  } else if (parsed && typeof parsed === "object") {
    servers = [toServer(String((parsed as { name?: unknown }).name ?? ""), parsed)];
  } else {
    throw new Error("没有找到 MCP 配置");
  }
  if (servers.length === 0) throw new Error("没有找到 MCP 配置");
  return servers;
}
