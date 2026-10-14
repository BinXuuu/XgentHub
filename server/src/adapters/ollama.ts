import { config } from "../config.ts";
import type { AgentAdapter, TaskRuntimeContext, TurnInput } from "./types.ts";
import type { ModelOption } from "../types.ts";
import { httpAskError, networkAskError } from "./askErrors.ts";

// Ollama adapter：直连本机 Ollama（`ollama serve`，默认 127.0.0.1:11434）的原生 API
// （不是 OpenAI 兼容层）。/api/tags 拿真实已安装的模型列表用于下拉框，/api/chat 走
// stream:true 的 NDJSON 流式响应。和 Hermes 一样，它是纯对话模型，没有文件读写/执行能力。

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const conversations = new Map<string, ChatMessage[]>();
const runningOllamaRequests = new Map<string, AbortController>();

function keepAliveValue(): string | number | undefined {
  const value = config.ollama.keepAlive.trim();
  if (!value) return undefined;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

async function fetchModels(): Promise<ModelOption[]> {
  try {
    const res = await fetch(`${config.ollama.baseUrl.replace(/\/$/, "")}/api/tags`);
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: { name: string }[] };
    return (data.models ?? []).map((m) => ({ id: m.name, label: m.name }));
  } catch {
    return []; // ollama 没跑起来就正常返回空列表，不抛错——前端会话框自然显示"暂无模型"
  }
}

async function streamChat(ctx: TaskRuntimeContext, model: string, messages: ChatMessage[], signal: AbortSignal): Promise<string> {
  const url = `${config.ollama.baseUrl.replace(/\/$/, "")}/api/chat`;
  const keepAlive = keepAliveValue();
  ctx.terminal(`$ POST ${url} (model=${model}, stream=true${keepAlive !== undefined ? `, keep_alive=${keepAlive}` : ""})\n`);

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages, stream: true, ...(keepAlive !== undefined ? { keep_alive: keepAlive } : {}) }),
    signal,
  });

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ollama 服务返回 ${res.status}: ${body.slice(0, 500)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const json = JSON.parse(line);
        const delta: string | undefined = json?.message?.content;
        if (delta) {
          full += delta;
          ctx.terminal(delta);
        }
        if (json?.error) throw new Error(json.error);
      } catch (err) {
        if (err instanceof SyntaxError) continue; // 分片不完整的一行，忽略
        throw err;
      }
    }
  }
  return full;
}

/** 一次性问答用：不走流式、不写 ctx.terminal，直接拿完整回复文本。查不到/失败返回 null。 */
async function askOnce(prompt: string, requestedModel?: string | null): Promise<string | null> {
  const model = requestedModel || config.ollama.defaultModel;
  if (!model) throw new Error("Ollama 没有指定模型：请选一个已安装的模型，或设置 OLLAMA_MODEL");
  let res: Response;
  try {
    res = await fetch(`${config.ollama.baseUrl.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], stream: false }),
    });
  } catch (err) {
    throw networkAskError("Ollama", err);
  }
  if (!res.ok) throw await httpAskError("Ollama", res);
  const json = (await res.json()) as any;
  const text = json?.message?.content;
  return typeof text === "string" && text.trim() ? text : null;
}

async function dispatch(ctx: TaskRuntimeContext, input: TurnInput): Promise<void> {
  const model = ctx.model || config.ollama.defaultModel;
  if (!model) {
    ctx.agentMessage("没有指定模型：新建任务时请从下拉框选择一个已安装的 Ollama 模型，或设置 OLLAMA_MODEL 作为默认值。");
    ctx.setStatus("failed");
    return;
  }
  if (input.images.length) ctx.log(`Ollama adapter 暂不支持图片附件，已忽略 ${input.images.length} 张图片`);

  const history = conversations.get(ctx.taskId) ?? [
    { role: "system", content: "你是通过 Xgent Hub 调用的本机 Ollama 模型，像结对编程助手一样简洁地回答问题。" },
  ];
  history.push({ role: "user", content: input.text });

  const controller = new AbortController();
  runningOllamaRequests.set(ctx.taskId, controller);
  ctx.setStatus("running");
  try {
    const reply = await streamChat(ctx, model, history, controller.signal);
    history.push({ role: "assistant", content: reply });
    conversations.set(ctx.taskId, history);
    ctx.agentMessage(reply || "(空响应)");
    ctx.setStatus("review");
  } catch (err) {
    // stop() 已经把状态设成 stopped 了，这里不要再改回 failed 盖过去。
    if (controller.signal.aborted) return;
    ctx.log(`调用 Ollama 失败：${(err as Error).message}`);
    ctx.agentMessage(
      `无法连接 Ollama（${config.ollama.baseUrl}）：${(err as Error).message}\n` +
        `请确认本机已经 \`ollama serve\`，且模型 "${model}" 已经 \`ollama pull\` 过。`
    );
    ctx.setStatus("failed");
  } finally {
    if (runningOllamaRequests.get(ctx.taskId) === controller) runningOllamaRequests.delete(ctx.taskId);
  }
}

export class OllamaAdapter implements AgentAdapter {
  readonly kind = "ollama" as const;
  readonly name = "Ollama";
  readonly description = "直连本机 Ollama，用你已安装的本地模型对话";

  isConfigured() {
    return Boolean(config.ollama.baseUrl);
  }
  configHint() {
    return `OLLAMA_BASE_URL=${config.ollama.baseUrl}；OLLAMA_KEEP_ALIVE=${config.ollama.keepAlive || "默认"}；需要本机已 \`ollama serve\` 且至少 pull 过一个模型`;
  }
  async discoverWorkspaces() {
    return [];
  }
  defaultModel(): string | null {
    return config.ollama.defaultModel || null;
  }

  async listModels(): Promise<ModelOption[]> {
    return fetchModels();
  }

  async run(ctx: TaskRuntimeContext, input: TurnInput): Promise<void> {
    ctx.setSessionKey(`ollama-${ctx.taskId}`);
    await dispatch(ctx, input);
  }

  async continueTask(ctx: TaskRuntimeContext, input: TurnInput): Promise<void> {
    await dispatch(ctx, input);
  }

  async ask(prompt: string, options?: { model?: string | null }): Promise<string | null> {
    return askOnce(prompt, options?.model);
  }

  async stop(ctx: TaskRuntimeContext): Promise<void> {
    const controller = runningOllamaRequests.get(ctx.taskId);
    if (controller) {
      ctx.log("正在终止 Ollama 请求...");
      controller.abort();
    }
    ctx.setStatus("stopped");
  }
}
