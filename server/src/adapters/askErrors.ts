import "../config.ts"; // 先加载 .env，AGENTHUB_ASK_TIMEOUT_SEC 才读得到
// ask()（聊天、AI 智能拆分用的一次性问答）失败时抛出的错误：带上是哪个 Agent、为什么失败，
// 聊天据此把这一轮标成"失败"并把原因显示给用户，而不是笼统的"没有返回内容"。

function clip(text: string, max = 300): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** HTTP 接口返回非 2xx：读出响应体里的报错（常见的 {error:{message}} / {error} / {message} 格式优先）。 */
export async function httpAskError(agentName: string, res: Response): Promise<Error> {
  let detail = "";
  try {
    const body = await res.text();
    try {
      const json = JSON.parse(body);
      const message = json?.error?.message ?? json?.error ?? json?.message;
      detail = typeof message === "string" ? message : body;
    } catch {
      detail = body;
    }
  } catch {
    // 读不到响应体就只报状态码
  }
  return new Error(`${agentName} 返回 HTTP ${res.status}${detail.trim() ? `：${clip(detail)}` : ""}`);
}

/** 连不上服务（服务没启动、地址写错、网络断了）。 */
export function networkAskError(agentName: string, err: unknown): Error {
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  const reason = cause?.code ?? cause?.message ?? (err as Error)?.message ?? String(err);
  return new Error(`连不上 ${agentName}：${clip(reason)}`);
}

/** 命令行 Agent 退出码非 0 或没有任何输出。 */
export function cliAskError(agentName: string, code: number | null, output: string): Error {
  const detail = clip(output, 500);
  return new Error(`${agentName} 调用失败（退出码 ${code ?? "未知"}）${detail ? `：${detail}` : "，没有输出"}`);
}

/**
 * 一次性问答（聊天、AI 智能拆分）等多久算超时。以前 60 秒，复杂一点的问题 Agent 还在想就被判失败；
 * 默认放宽到 10 分钟，可以在 .env 里用 AGENTHUB_ASK_TIMEOUT_SEC 调。
 */
export const ASK_TIMEOUT_SEC = Math.max(30, Number(process.env.AGENTHUB_ASK_TIMEOUT_SEC) || 600);
export const ASK_TIMEOUT_MS = ASK_TIMEOUT_SEC * 1000;
