import { spawnCli, killProcessTree } from "../adapters/winSpawn.ts";

// 「测试连接」用的最小 MCP 客户端：真的做 initialize → notifications/initialized → tools/list，
// 不再只看「进程起来没崩」/「HTTP 有响应」——那样命令写错了、桥接连不上后端、令牌不对都会被当成成功。

export interface McpProbeResult {
  ok: boolean;
  message: string;
  serverName?: string;
  protocolVersion?: string;
  tools?: string[];
  /** HTTP 服务回了 401/403：要先登录授权（多半是 OAuth）才能用。 */
  authRequired?: boolean;
}

interface JsonRpcResponse {
  id?: number | string;
  result?: any;
  error?: { code?: number; message?: string };
}

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "xgent-hub-test", version: "1" };
const MAX_TOOL_PAGES = 10;

function rpcError(method: string, error: NonNullable<JsonRpcResponse["error"]>): Error {
  return new Error(`${method} 返回错误：${error.message ?? JSON.stringify(error)}${error.code !== undefined ? `（${error.code}）` : ""}`);
}

function summarize(init: any, tools: string[]): McpProbeResult {
  const name = init?.serverInfo?.name ? `${init.serverInfo.name}${init.serverInfo.version ? ` ${init.serverInfo.version}` : ""}` : undefined;
  const hasTools = Boolean(init?.capabilities?.tools);
  return {
    ok: true,
    message: `握手成功${name ? `：${name}` : ""}，协议 ${init?.protocolVersion ?? "未知"}，${hasTools || tools.length ? `发现 ${tools.length} 个工具` : "这个服务没有提供工具"}`,
    serverName: name,
    protocolVersion: init?.protocolVersion,
    tools,
  };
}

/** 用 call 依次发 initialize / initialized / tools/list（含翻页），两种传输共用。 */
async function handshake(call: (method: string, params?: unknown) => Promise<any>, notify: (method: string) => Promise<void>) {
  const init = await call("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO });
  await notify("notifications/initialized");
  const tools: string[] = [];
  if (init?.capabilities?.tools) {
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const result = await call("tools/list", cursor ? { cursor } : {});
      for (const tool of result?.tools ?? []) if (typeof tool?.name === "string") tools.push(tool.name);
      cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }
  }
  return summarize(init, tools);
}

export function probeStdioMcp(input: { command: string; args?: string[]; env?: Record<string, string> }, timeoutMs: number): Promise<McpProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<typeof spawnCli>;
    let stderr = "";
    let buffer = "";
    let nextId = 1;
    const pending = new Map<number, { method: string; resolve: (value: any) => void; reject: (err: Error) => void }>();
    const stderrTail = () => (stderr.trim() ? `；程序输出：${stderr.trim().slice(-300)}` : "");
    const finish = (result: McpProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const entry of pending.values()) entry.reject(new Error("已结束"));
      try {
        child?.stdin?.end();
      } catch {
        // 进程可能已经退出
      }
      if (child) killProcessTree(child);
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, message: `${Math.round(timeoutMs / 1000)} 秒内没有完成 MCP 握手（程序启动了，但没按 MCP 协议回应）${stderrTail()}` }),
      timeoutMs
    );

    try {
      child = spawnCli(input.command.trim(), input.args ?? [], { cwd: process.cwd(), env: { ...process.env, ...(input.env ?? {}) } });
    } catch (err) {
      finish({ ok: false, message: `启动失败：${(err as Error).message}` });
      return;
    }
    child.stderr?.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString("utf8")).slice(-4000)));
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line.startsWith("{")) continue; // 有的服务会往 stdout 打日志，跳过非 JSON 行
        let message: JsonRpcResponse;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const entry = typeof message.id === "number" ? pending.get(message.id) : undefined;
        if (!entry) continue;
        pending.delete(message.id as number);
        if (message.error) entry.reject(rpcError(entry.method, message.error));
        else entry.resolve(message.result);
      }
    });
    child.on("error", (err) => finish({ ok: false, message: `启动失败：${err.message}` }));
    child.on("close", (code) => finish({ ok: false, message: `程序在握手完成前退出了（exit ${code ?? "?"}）${stderrTail()}` }));

    const send = (payload: object) => child.stdin?.write(JSON.stringify(payload) + "\n");
    const call = (method: string, params?: unknown) =>
      new Promise<any>((res, rej) => {
        const id = nextId++;
        pending.set(id, { method, resolve: res, reject: rej });
        send({ jsonrpc: "2.0", id, method, params });
      });
    const notify = async (method: string) => {
      send({ jsonrpc: "2.0", method });
    };
    handshake(call, notify).then(finish, (err: Error) => finish({ ok: false, message: `${err.message}${stderrTail()}` }));
  });
}

/** 从 Streamable HTTP 的响应里取出 id 对应的 JSON-RPC 回复：可能是普通 JSON，也可能是 SSE 流里的某个 data 事件。 */
async function readHttpReply(res: Response, id: number): Promise<JsonRpcResponse> {
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("text/event-stream")) return (await res.json()) as JsonRpcResponse;
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const event = buffer.slice(0, index);
        buffer = buffer.slice(index).replace(/^\r?\n\r?\n/, "");
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        try {
          const message = JSON.parse(data) as JsonRpcResponse;
          if (message.id === id) return message;
        } catch {
          // 不是 JSON 的事件，跳过
        }
      }
      if (done) throw new Error("服务端没有返回结果就关闭了连接");
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}

export async function probeHttpMcp(
  input: { url: string; headers?: Record<string, string> },
  timeoutMs: number,
  dispatcher?: unknown
): Promise<McpProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let sessionId: string | null = null;
  let authRequired = false;
  let nextId = 1;
  const post = (payload: object) =>
    fetch(input.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sessionId ? { "mcp-session-id": sessionId, "mcp-protocol-version": PROTOCOL_VERSION } : {}),
        ...(input.headers ?? {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit);
  const explainStatus = (res: Response) => {
    if (res.status === 401 || res.status === 403)
      return `连得上，但没通过认证（HTTP ${res.status}）：需要登录授权或在请求头里带上令牌。注意 Codex 不支持自定义请求头`;
    if (res.status === 404 || res.status === 405) return `HTTP ${res.status}：这个地址不接受 MCP 请求，可能地址写错了，或者是旧版只支持 SSE 的服务`;
    return `HTTP ${res.status}`;
  };
  try {
    const call = async (method: string, params?: unknown) => {
      const id = nextId++;
      const res = await post({ jsonrpc: "2.0", id, method, params });
      if (!res.ok) {
        authRequired = res.status === 401 || res.status === 403;
        throw new Error(`${method} 失败：${explainStatus(res)}`);
      }
      sessionId = res.headers.get("mcp-session-id") ?? sessionId;
      const message = await readHttpReply(res, id);
      if (message.error) throw rpcError(method, message.error);
      return message.result;
    };
    const notify = async (method: string) => {
      const res = await post({ jsonrpc: "2.0", method });
      void res.body?.cancel().catch(() => {});
    };
    const result = await handshake(call, notify);
    if (sessionId) {
      // 用完把会话关掉（规范允许服务端不支持，失败也无所谓）。
      void fetch(input.url, { method: "DELETE", headers: { "mcp-session-id": sessionId, ...(input.headers ?? {}) }, ...(dispatcher ? { dispatcher } : {}) } as RequestInit).catch(() => {});
    }
    return result;
  } catch (err) {
    const error = err as Error & { cause?: { message?: string } };
    if (error.name === "AbortError") return { ok: false, message: `${Math.round(timeoutMs / 1000)} 秒内没有完成 MCP 握手` };
    return {
      ok: false,
      message: error.message === "fetch failed" ? `连接失败：${error.cause?.message ?? "地址连不上"}` : error.message,
      ...(authRequired ? { authRequired } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}
