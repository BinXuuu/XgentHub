import type { TokenUsage } from "../types.ts";

// 各家报 token 用量的字段名都不一样，统一成 输入 / 输出 / 缓存命中 三个数：
// - Claude Code / CodeBuddy（stream-json 的 result.usage）：input_tokens、output_tokens、cache_read_input_tokens、cache_creation_input_tokens
// - Codex（turn.completed.usage）：input_tokens、cached_input_tokens、output_tokens
// - OpenAI 兼容接口（最后一个流式块的 usage）：prompt_tokens、completion_tokens、prompt_tokens_details.cached_tokens
// - DeepSeek Harness（step_end.usage）：inputTokens、outputTokens、cacheReadTokens
// 这里的输入只算这次真正送进去的（不含缓存命中的部分），缓存命中单独记；合计 = 输入 + 缓存命中 + 输出。

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

export function normalizeUsage(raw: unknown): TokenUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, any>;
  let input = 0;
  let cached = 0;
  let output = 0;
  if ("input_tokens" in u || "output_tokens" in u) {
    // Claude 的 input_tokens 本来就不含缓存；Codex 的 input_tokens 包含 cached_input_tokens，要减掉。
    cached = num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens) + num(u.cached_input_tokens);
    input = Math.max(0, num(u.input_tokens) - num(u.cached_input_tokens));
    output = num(u.output_tokens);
  } else if ("prompt_tokens" in u || "completion_tokens" in u) {
    cached = num(u.prompt_tokens_details?.cached_tokens);
    input = Math.max(0, num(u.prompt_tokens) - cached);
    output = num(u.completion_tokens);
  } else if ("inputTokens" in u || "outputTokens" in u) {
    cached = num(u.cacheReadTokens) + num(u.cacheWriteTokens);
    input = num(u.inputTokens);
    output = num(u.outputTokens);
  } else {
    return null;
  }
  const total = input + cached + output;
  return total > 0 ? { inputTokens: input, outputTokens: output, cachedTokens: cached, totalTokens: total } : null;
}
