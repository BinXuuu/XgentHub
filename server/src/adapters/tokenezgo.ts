import { config } from "../config.ts";
import {
  checkGatewayBudgetBeforeCall,
  getGatewayUsageSummaryText,
  recordGatewayUsage,
} from "../services/gatewayBillingService.ts";
import type { AgentAdapter, TaskRuntimeContext, TurnInput } from "./types.ts";
import { runtimeKeyOf } from "./types.ts";
import type { ModelOption } from "../types.ts";
import { httpAskError, networkAskError } from "./askErrors.ts";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const conversations = new Map<string, ChatMessage[]>();
const runningTokenEzgoRequests = new Map<string, AbortController>();

function baseUrl(): string {
  return config.tokenezgo.baseUrl.replace(/\/$/, "");
}

function authHeaders(): Record<string, string> {
  return config.tokenezgo.apiKey ? { authorization: `Bearer ${config.tokenezgo.apiKey}` } : {};
}

async function fetchModels(): Promise<ModelOption[]> {
  if (!config.tokenezgo.apiKey) return [];
  try {
    const res = await fetch(`${baseUrl()}/models`, { headers: authHeaders() });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: { id: string; owned_by?: string }[] };
    return (data.data ?? []).map((m) => ({ id: m.id, label: m.owned_by ? `${m.id} (${m.owned_by})` : m.id }));
  } catch {
    return [];
  }
}

// partial 是一个可变容器：流式过程中持续把已收到的文本写进去，这样即使中途被 stop() 打断
// （fetch 被 abort，正常 return 不会走到），dispatch() 在 catch 里依然能读到"已经生成了多少"，
// 用来记一笔部分用量——推荐网关是真花钱的，中途取消也不该让这部分 token 消失在本地账本之外。
async function streamChatCompletion(
  ctx: TaskRuntimeContext,
  model: string,
  messages: ChatMessage[],
  signal: AbortSignal,
  partial: { text: string }
): Promise<string> {
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
    throw new Error(`TokenEZGO 返回 ${res.status}: ${body.slice(0, 500)}`);
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
          partial.text = full;
          ctx.terminal(delta);
        }
      } catch {
        // 忽略无法解析的 SSE 分片
      }
    }
  }

  return full;
}

/** 一次性问答用：不写 ctx.terminal、不走网关预算检查，直接拿完整回复文本。查不到/失败返回 null。 */
async function askOnce(prompt: string, selectedModel?: string | null): Promise<string | null> {
  if (!config.tokenezgo.apiKey) throw new Error("推荐 API 中转站还没有配置 API Key（TOKENEZGO_API_KEY）");
  const model = selectedModel || config.tokenezgo.defaultModel;
  if (!model) throw new Error("推荐 API 中转站没有指定模型：请选一个模型，或设置 TOKENEZGO_MODEL");
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], stream: false }),
    });
  } catch (err) {
    throw networkAskError("推荐 API 中转站", err);
  }
  if (!res.ok) throw await httpAskError("推荐 API 中转站", res);
  const json = (await res.json()) as any;
  const text = json?.choices?.[0]?.message?.content;
  return typeof text === "string" && text.trim() ? text : null;
}

async function dispatch(ctx: TaskRuntimeContext, input: TurnInput): Promise<void> {
  if (!config.tokenezgo.apiKey) {
    ctx.agentMessage("推荐 API 中转站尚未配置 API Key：请打开 TokenEZGO（https://tokenezgo.com）充值后获取 Key，再回到配置页填写 TOKENEZGO_API_KEY。");
    ctx.setStatus("failed");
    return;
  }

  const model = ctx.model || config.tokenezgo.defaultModel;
  if (!model) {
    ctx.agentMessage("没有指定模型：新建任务时请从推荐 API 中转站模型下拉框选择一个模型，或设置 TOKENEZGO_MODEL 作为默认值。");
    ctx.setStatus("failed");
    return;
  }

  if (input.images.length) ctx.log(`TokenEZGO adapter 暂不支持图片附件，已忽略 ${input.images.length} 张图片`);

  const history = conversations.get(runtimeKeyOf(ctx)) ?? [
    {
      role: "system",
      content: "你是通过 Xgent Hub 推荐 API 中转站调用的模型。请像结对编程助手一样简洁、准确地回答。",
    },
  ];
  history.push({ role: "user", content: input.text });
  const requestText = history.map((message) => `${message.role}: ${message.content}`).join("\n\n");
  const budgetCheck = checkGatewayBudgetBeforeCall({ promptText: requestText, model, budgetLimitCny: ctx.budgetLimitCny });
  if (!budgetCheck.ok) {
    ctx.agentMessage(budgetCheck.message);
    ctx.setStatus("failed");
    return;
  }
  ctx.log(`推荐网关预算检查：${budgetCheck.note}`);

  const controller = new AbortController();
  const partial = { text: "" };
  runningTokenEzgoRequests.set(runtimeKeyOf(ctx), controller);
  ctx.setStatus("running");
  try {
    const reply = await streamChatCompletion(ctx, model, history, controller.signal, partial);
    const usageRecord = recordGatewayUsage({
      taskId: ctx.taskId,
      model,
      promptText: requestText,
      completionText: reply,
      budgetLimitCny: ctx.budgetLimitCny,
    });
    ctx.log(
      `推荐网关本地账本：${usageRecord.totalTokens} tokens，估算 ¥${usageRecord.estimatedCostCny}` +
        `${usageRecord.budgetExceeded ? "，已超过单任务预算" : ""}`
    );
    history.push({ role: "assistant", content: reply });
    conversations.set(runtimeKeyOf(ctx), history);
    ctx.agentMessage(reply || "(空响应)");
    ctx.setStatus("review");
  } catch (err) {
    if (controller.signal.aborted) {
      // 被 stop() 打断：上游很可能已经按已生成的这部分内容计费了，就算没拿到完整回复，
      // 本地账本也要记一笔，不然用户在 TokenEZGO 那边扣了钱、AgentHub 这边完全不知道。
      if (partial.text.trim()) {
        const usageRecord = recordGatewayUsage({
          taskId: ctx.taskId,
          model,
          promptText: requestText,
          completionText: partial.text,
          budgetLimitCny: ctx.budgetLimitCny,
        });
        ctx.log(`请求被用户停止，按已生成的部分内容记了一笔本地账本：约 ${usageRecord.totalTokens} tokens，估算 ¥${usageRecord.estimatedCostCny}`);
      }
      return;
    }
    ctx.log(`调用推荐 API 中转站失败：${(err as Error).message}`);
    ctx.agentMessage(
      `无法连接推荐 API 中转站（${config.tokenezgo.baseUrl}）：${(err as Error).message}\n` +
        "请确认 TOKENEZGO_BASE_URL / TOKENEZGO_API_KEY / TOKENEZGO_MODEL 配置正确。"
    );
    ctx.setStatus("failed");
  } finally {
    if (runningTokenEzgoRequests.get(runtimeKeyOf(ctx)) === controller) runningTokenEzgoRequests.delete(runtimeKeyOf(ctx));
  }
}

export class TokenEzgoAdapter implements AgentAdapter {
  readonly kind = "tokenezgo" as const;
  readonly name = "推荐 API 中转站";
  readonly description = "通过 tokenezgo.com 的 OpenAI 兼容 API 调用充值后的模型额度";

  isConfigured() {
    return Boolean(config.tokenezgo.baseUrl && config.tokenezgo.apiKey);
  }

  configHint() {
    return config.tokenezgo.apiKey
      ? `TOKENEZGO_BASE_URL=${config.tokenezgo.baseUrl}`
      : "去 tokenezgo.com 充值并获取 API Key";
  }

  async discoverWorkspaces() {
    return [];
  }

  defaultModel(): string | null {
    return config.tokenezgo.defaultModel || null;
  }

  async listModels(): Promise<ModelOption[]> {
    return fetchModels();
  }

  async getUsageSummary(): Promise<string | null> {
    return getGatewayUsageSummaryText();
  }

  async run(ctx: TaskRuntimeContext, input: TurnInput): Promise<void> {
    ctx.setSessionKey(`tokenezgo-${runtimeKeyOf(ctx)}`);
    await dispatch(ctx, input);
  }

  async continueTask(ctx: TaskRuntimeContext, input: TurnInput): Promise<void> {
    await dispatch(ctx, input);
  }

  async ask(prompt: string, options?: { model?: string | null }): Promise<string | null> {
    return askOnce(prompt, options?.model);
  }

  async stop(ctx: TaskRuntimeContext): Promise<void> {
    const controller = runningTokenEzgoRequests.get(runtimeKeyOf(ctx));
    if (controller) {
      ctx.log("正在终止推荐 API 中转站请求...");
      controller.abort();
    }
    ctx.setStatus("stopped");
  }
}
