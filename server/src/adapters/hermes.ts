import { config } from "../config.ts";
import type { AgentAdapter, TaskRuntimeContext, TurnInput } from "./types.ts";
import { runtimeKeyOf } from "./types.ts";
import { httpAskError, networkAskError } from "./askErrors.ts";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const conversations = new Map<string, ChatMessage[]>();
const runningHermesRequests = new Map<string, AbortController>();

async function streamChatCompletion(
  ctx: TaskRuntimeContext,
  model: string,
  messages: ChatMessage[],
  signal: AbortSignal
): Promise<string> {
  const url = `${config.hermes.baseUrl.replace(/\/$/, "")}/v1/chat/completions`;
  ctx.terminal(`$ POST ${url} (model=${model}, stream=true)\n`);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.hermes.apiKey ? { authorization: `Bearer ${config.hermes.apiKey}` } : {}),
    },
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  });

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw new Error(`Hermes 服务返回 ${res.status}: ${body.slice(0, 500)}`);
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
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const json = JSON.parse(data);
        const delta: string | undefined = json?.choices?.[0]?.delta?.content ?? json?.choices?.[0]?.message?.content;
        if (delta) {
          full += delta;
          ctx.terminal(delta);
        }
      } catch {
        // 忽略无法解析的分片
      }
    }
  }
  return full;
}

/** 一次性问答用：不写 ctx.terminal，直接拿完整回复文本。查不到/失败返回 null。 */
async function askOnce(prompt: string, requestedModel?: string | null): Promise<string | null> {
  const url = `${config.hermes.baseUrl.replace(/\/$/, "")}/v1/chat/completions`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.hermes.apiKey ? { authorization: `Bearer ${config.hermes.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: requestedModel || config.hermes.model,
        messages: [{ role: "user", content: prompt }],
        stream: false,
      }),
    });
  } catch (err) {
    throw networkAskError("Hermes", err);
  }
  if (!res.ok) throw await httpAskError("Hermes", res);
  const json = (await res.json()) as any;
  const text = json?.choices?.[0]?.message?.content;
  return typeof text === "string" && text.trim() ? text : null;
}

async function dispatch(ctx: TaskRuntimeContext, input: TurnInput): Promise<void> {
  const text = input.text;
  if (input.images.length) ctx.log(`Hermes 是纯文本模型服务，暂不支持图片附件，已忽略 ${input.images.length} 张图片`);
  const history = conversations.get(runtimeKeyOf(ctx)) ?? [
    {
      role: "system",
      content:
        "你是 Hermes，一个通过 Xgent Hub 调用的本机模型服务。请像一名结对编程助手一样简洁地回答问题、给出代码建议。",
    },
  ];
  history.push({ role: "user", content: text });

  const model = ctx.model || config.hermes.model;
  const controller = new AbortController();
  runningHermesRequests.set(runtimeKeyOf(ctx), controller);
  ctx.setStatus("running");
  try {
    const reply = await streamChatCompletion(ctx, model, history, controller.signal);
    history.push({ role: "assistant", content: reply });
    conversations.set(runtimeKeyOf(ctx), history);
    ctx.agentMessage(reply || "(空响应)");
    ctx.setStatus("review");
  } catch (err) {
    if (controller.signal.aborted) return;
    ctx.log(`调用 Hermes 失败：${(err as Error).message}`);
    ctx.agentMessage(
      `无法连接 Hermes 服务（${config.hermes.baseUrl}）：${(err as Error).message}\n` +
        `请确认 Hermes 的 OpenAI 兼容服务已在本机启动，并检查 HERMES_BASE_URL / HERMES_MODEL 配置。`
    );
    ctx.setStatus("failed");
  } finally {
    if (runningHermesRequests.get(runtimeKeyOf(ctx)) === controller) runningHermesRequests.delete(runtimeKeyOf(ctx));
  }
}

export class HermesAdapter implements AgentAdapter {
  readonly kind = "hermes" as const;
  readonly name = "Hermes";

  defaultModel(): string | null {
    return config.hermes.model || null;
  }
  readonly description = "通过本机 OpenAI 兼容接口调用 Hermes 模型服务";

  isConfigured() {
    return Boolean(config.hermes.baseUrl);
  }
  configHint() {
    return `HERMES_BASE_URL=${config.hermes.baseUrl}，model=${config.hermes.model}`;
  }
  async discoverWorkspaces() {
    return [];
  }

  async run(ctx: TaskRuntimeContext, input: TurnInput): Promise<void> {
    ctx.setSessionKey(`hermes-${runtimeKeyOf(ctx)}`);
    await dispatch(ctx, input);
  }

  async continueTask(ctx: TaskRuntimeContext, input: TurnInput): Promise<void> {
    await dispatch(ctx, input);
  }

  async ask(prompt: string, options?: { model?: string | null }): Promise<string | null> {
    return askOnce(prompt, options?.model);
  }

  async stop(ctx: TaskRuntimeContext): Promise<void> {
    const controller = runningHermesRequests.get(runtimeKeyOf(ctx));
    if (controller) {
      ctx.log("正在终止 Hermes 请求...");
      controller.abort();
    }
    ctx.setStatus("stopped");
  }
}
