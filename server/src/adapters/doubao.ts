import { config } from "../config.ts";
import type { AgentAdapter, TaskRuntimeContext, TurnInput } from "./types.ts";
import type { ModelOption } from "../types.ts";
import { httpAskError, networkAskError } from "./askErrors.ts";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OpenAIChoice {
  delta?: { content?: string };
  message?: { content?: string };
  text?: string;
}

interface OpenAIResponse {
  choices?: OpenAIChoice[];
}

const conversations = new Map<string, ChatMessage[]>();
const runningDoubaoRequests = new Map<string, AbortController>();

function baseUrl(): string {
  return config.doubao.baseUrl.replace(/\/$/, "");
}

function authHeaders(): Record<string, string> {
  return config.doubao.apiKey ? { authorization: `Bearer ${config.doubao.apiKey}` } : {};
}

function extractText(json: OpenAIResponse): string {
  return json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.message?.content ?? json.choices?.[0]?.text ?? "";
}

function parseSseDelta(line: string): string {
  if (!line.startsWith("data:")) return "";
  const data = line.slice(5).trim();
  if (!data || data === "[DONE]") return "";
  try {
    return extractText(JSON.parse(data) as OpenAIResponse);
  } catch {
    return "";
  }
}

async function fetchModels(): Promise<ModelOption[]> {
  if (!config.doubao.apiKey) return [];
  try {
    const res = await fetch(`${baseUrl()}/models`, { headers: authHeaders() });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: { id: string; owned_by?: string }[] };
    return (data.data ?? []).map((m) => ({ id: m.id, label: m.owned_by ? `${m.id} (${m.owned_by})` : m.id }));
  } catch {
    return [];
  }
}

async function streamChatCompletion(ctx: TaskRuntimeContext, model: string, messages: ChatMessage[], signal: AbortSignal): Promise<string> {
  const url = `${baseUrl()}/chat/completions`;
  ctx.terminal(`$ POST ${url} (model=${model}, stream=true)\n`);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  });

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw new Error(`Doubao 返回 ${res.status}: ${body.slice(0, 500)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let raw = "";
  let full = "";
  let sawSse = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    raw += chunk;
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      const delta = parseSseDelta(line);
      if (delta) {
        sawSse = true;
        full += delta;
        ctx.terminal(delta);
      }
    }
  }

  const tail = parseSseDelta(buffer.trim());
  if (tail) {
    sawSse = true;
    full += tail;
    ctx.terminal(tail);
  }

  if (!sawSse && raw.trim()) {
    try {
      const reply = extractText(JSON.parse(raw) as OpenAIResponse);
      if (reply) {
        ctx.terminal(reply);
        return reply;
      }
    } catch {
      // 部分网关只返回 SSE；非 JSON 尾巴不用当成致命错误。
    }
  }

  return full;
}

/** 一次性问答用：不写 ctx.terminal，直接拿完整回复文本。查不到/失败返回 null。 */
async function askOnce(prompt: string, requestedModel?: string | null): Promise<string | null> {
  if (!config.doubao.apiKey) throw new Error("Doubao 还没有配置 API Key（DOUBAO_API_KEY）");
  const model = requestedModel || config.doubao.defaultModel;
  if (!model) throw new Error("Doubao 没有指定模型：请选一个模型，或设置 DOUBAO_MODEL");
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], stream: false }),
    });
  } catch (err) {
    throw networkAskError("Doubao", err);
  }
  if (!res.ok) throw await httpAskError("Doubao", res);
  const json = (await res.json()) as OpenAIResponse;
  const text = extractText(json);
  return text.trim() ? text : null;
}

async function dispatch(ctx: TaskRuntimeContext, input: TurnInput): Promise<void> {
  if (!config.doubao.apiKey) {
    ctx.agentMessage("Doubao 尚未配置 API key：请在左侧点击 Doubao，填入 DOUBAO_API_KEY。");
    ctx.setStatus("failed");
    return;
  }

  const model = ctx.model || config.doubao.defaultModel;
  if (!model) {
    ctx.agentMessage(
      "没有指定模型：请在新建任务时选择一个 Doubao / 火山方舟模型，或在 Doubao 配置里设置 DOUBAO_MODEL。"
    );
    ctx.setStatus("failed");
    return;
  }

  if (input.images.length) ctx.log(`Doubao adapter 暂不支持图片附件，已忽略 ${input.images.length} 张图片`);

  const history = conversations.get(ctx.taskId) ?? [
    {
      role: "system",
      content: "你是通过 Xgent Hub 调用的豆包/火山方舟模型。请简洁、准确地回答，并在涉及代码时给出可执行建议。",
    },
  ];
  history.push({ role: "user", content: input.text });

  const controller = new AbortController();
  runningDoubaoRequests.set(ctx.taskId, controller);
  ctx.setStatus("running");
  try {
    const reply = await streamChatCompletion(ctx, model, history, controller.signal);
    history.push({ role: "assistant", content: reply });
    conversations.set(ctx.taskId, history);
    ctx.agentMessage(reply || "(空响应)");
    ctx.setStatus("review");
  } catch (err) {
    if (controller.signal.aborted) return;
    ctx.log(`调用 Doubao 失败：${(err as Error).message}`);
    ctx.agentMessage(
      `无法连接 Doubao / 火山方舟（${config.doubao.baseUrl}）：${(err as Error).message}\n` +
        "请确认 DOUBAO_BASE_URL / DOUBAO_API_KEY / DOUBAO_MODEL 配置正确。"
    );
    ctx.setStatus("failed");
  } finally {
    if (runningDoubaoRequests.get(ctx.taskId) === controller) runningDoubaoRequests.delete(ctx.taskId);
  }
}

export class DoubaoAdapter implements AgentAdapter {
  readonly kind = "doubao" as const;
  readonly name = "Doubao";
  readonly description = "通过火山方舟 OpenAI 兼容 API 调用豆包模型";

  isConfigured() {
    return Boolean(config.doubao.baseUrl && config.doubao.apiKey);
  }

  configHint() {
    return config.doubao.apiKey ? `DOUBAO_BASE_URL=${config.doubao.baseUrl}` : "请设置 DOUBAO_API_KEY";
  }

  async discoverWorkspaces() {
    return [];
  }

  defaultModel(): string | null {
    return config.doubao.defaultModel || null;
  }

  async listModels(): Promise<ModelOption[]> {
    return fetchModels();
  }

  async run(ctx: TaskRuntimeContext, input: TurnInput): Promise<void> {
    ctx.setSessionKey(`doubao-${ctx.taskId}`);
    await dispatch(ctx, input);
  }

  async continueTask(ctx: TaskRuntimeContext, input: TurnInput): Promise<void> {
    await dispatch(ctx, input);
  }

  async ask(prompt: string, options?: { model?: string | null }): Promise<string | null> {
    return askOnce(prompt, options?.model);
  }

  async stop(ctx: TaskRuntimeContext): Promise<void> {
    const controller = runningDoubaoRequests.get(ctx.taskId);
    if (controller) {
      ctx.log("正在终止 Doubao 请求...");
      controller.abort();
    }
    ctx.setStatus("stopped");
  }
}
