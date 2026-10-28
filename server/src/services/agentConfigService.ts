import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { getAdapter, toDescriptor } from "../adapters/registry.ts";
import {
  customAgentFields,
  customAgentStorePath,
  getCustomAgent,
  updateCustomAgent,
} from "./customAgentService.ts";
import type { AgentConfigField, AgentConfigResponse } from "../types.ts";
import { writeTextAtomic } from "./jsonStore.ts";

type FieldType = AgentConfigField["type"];

interface FieldDefinition {
  key: string;
  label: string;
  type: FieldType;
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
  get: () => string;
  apply: (value: string) => void;
}

const envPath = path.resolve(config.serverRoot, "..", ".env");

const schemas: Record<string, FieldDefinition[]> = {
  openclaw: [
    {
      key: "OPENCLAW_BIN",
      label: "OpenClaw CLI",
      type: "text",
      placeholder: "openclaw",
      get: () => config.openclaw.bin,
      apply: (value) => {
        config.openclaw.bin = value || "openclaw";
      },
    },
    {
      key: "OPENCLAW_AGENT_ID",
      label: "默认 Agent ID",
      type: "text",
      placeholder: "留空走 OpenClaw 默认路由",
      get: () => config.openclaw.agentId,
      apply: (value) => {
        config.openclaw.agentId = value;
      },
    },
    {
      key: "OPENCLAW_TIMEOUT",
      label: "超时秒数",
      type: "number",
      placeholder: "600",
      get: () => String(config.openclaw.timeoutSec),
      apply: (value) => {
        config.openclaw.timeoutSec = Number(value || 600);
      },
    },
    {
      key: "OPENCLAW_IDLE_TIMEOUT",
      label: "无输出超时秒数",
      type: "number",
      placeholder: "180",
      help: "OpenClaw CLI 启动后如果长期没有任何 stdout/stderr 输出，就认为可能卡住并终止。大模型首次加载可适当调大。",
      get: () => String(config.openclaw.idleTimeoutSec),
      apply: (value) => {
        config.openclaw.idleTimeoutSec = Number(value || 180);
      },
    },
  ],
  codex: [
    {
      key: "CODEX_BIN",
      label: "Codex CLI",
      type: "text",
      placeholder: "codex",
      get: () => config.codex.bin,
      apply: (value) => {
        config.codex.bin = value || "codex";
      },
    },
    {
      key: "CODEX_SANDBOX_MODE",
      label: "沙箱模式",
      type: "select",
      get: () => config.codex.sandboxMode,
      apply: (value) => {
        config.codex.sandboxMode = value || "workspace-write";
      },
      options: [
        { value: "read-only", label: "read-only" },
        { value: "workspace-write", label: "workspace-write" },
        { value: "danger-full-access", label: "danger-full-access" },
      ],
    },
    {
      key: "CODEX_TIMEOUT",
      label: "超时秒数",
      type: "number",
      placeholder: "900",
      get: () => String(config.codex.timeoutSec),
      apply: (value) => {
        config.codex.timeoutSec = Number(value || 900);
      },
    },
  ],
  "claude-code": [
    {
      key: "CLAUDE_CODE_BIN",
      label: "Claude Code CLI",
      type: "text",
      placeholder: "claude",
      get: () => config.claudeCode.configuredBin,
      apply: (value) => {
        config.claudeCode.bin = value || "claude";
      },
    },
    {
      key: "CLAUDE_CODE_ARGS",
      label: "CLI 参数",
      type: "text",
      placeholder: "--print --output-format stream-json --verbose",
      get: () => config.claudeCode.args.join(" "),
      apply: (value) => {
        config.claudeCode.args = (value || "--print --output-format stream-json --verbose").split(" ").filter(Boolean);
      },
    },
  ],
  codebuddy: [
    {
      key: "CODEBUDDY_BIN",
      label: "CodeBuddy CLI",
      type: "text",
      placeholder: "codebuddy",
      help: "腾讯 CodeBuddy Code 命令行（npm i -g @tencent-ai/codebuddy-code）。不在 PATH 里就填完整路径。",
      get: () => config.codebuddy.bin,
      apply: (value) => {
        config.codebuddy.bin = value || "codebuddy";
      },
    },
    {
      key: "CODEBUDDY_MODEL",
      label: "默认模型",
      type: "text",
      placeholder: "留空用账号默认模型",
      help: "可填 fast-model / balanced-model / primary-model / deep-model，或具体模型 ID（见下方模型列表）。",
      get: () => config.codebuddy.defaultModel,
      apply: (value) => {
        config.codebuddy.defaultModel = value;
      },
    },
    {
      key: "CODEBUDDY_ARGS",
      label: "CLI 参数",
      type: "text",
      placeholder: "--print --output-format stream-json --verbose",
      get: () => config.codebuddy.args.join(" "),
      apply: (value) => {
        config.codebuddy.args = (value || "--print --output-format stream-json --verbose").split(" ").filter(Boolean);
      },
    },
  ],
  antigravity: [
    {
      key: "ANTIGRAVITY_BIN",
      label: "Antigravity CLI",
      type: "text",
      placeholder: "agy",
      help: "如果 agy 不在 PATH 里，填 agy.exe 的完整路径。",
      get: () => config.antigravity.bin,
      apply: (value) => {
        config.antigravity.bin = value || "agy";
      },
    },
    {
      key: "ANTIGRAVITY_MODEL",
      label: "默认模型",
      type: "text",
      placeholder: "留空则新建任务时手动选择或使用 CLI 默认模型",
      get: () => config.antigravity.defaultModel,
      apply: (value) => {
        config.antigravity.defaultModel = value;
      },
    },
    {
      key: "ANTIGRAVITY_EFFORT",
      label: "推理强度",
      type: "select",
      get: () => config.antigravity.effort,
      apply: (value) => {
        config.antigravity.effort = value;
      },
      options: [
        { value: "", label: "使用 CLI 默认" },
        { value: "low", label: "low" },
        { value: "medium", label: "medium" },
        { value: "high", label: "high" },
      ],
    },
    {
      key: "ANTIGRAVITY_PRINT_TIMEOUT",
      label: "单轮等待上限",
      type: "text",
      placeholder: "100m",
      help: "传给 agy --print-timeout，例如 100m、6000s。长任务建议保持大于进程超时。",
      get: () => config.antigravity.printTimeout,
      apply: (value) => {
        config.antigravity.printTimeout = value || "100m";
      },
    },
    {
      key: "ANTIGRAVITY_TIMEOUT",
      label: "进程超时秒数",
      type: "number",
      placeholder: "6000",
      get: () => String(config.antigravity.timeoutSec),
      apply: (value) => {
        config.antigravity.timeoutSec = Number(value || 6000);
      },
    },
  ],
  "ark-cli": [
    {
      key: "ARK_CLI_BIN",
      label: "Ark CLI",
      type: "text",
      placeholder: "arkcli",
      help: "如果 arkcli 不在 PATH 里，填 arkcli.cmd 的完整路径。",
      get: () => config.arkCli.bin,
      apply: (value) => {
        config.arkCli.bin = value || "arkcli";
      },
    },
    {
      key: "ARK_CLI_PROFILE",
      label: "Profile",
      type: "text",
      placeholder: "留空使用 arkcli 当前默认 profile",
      get: () => config.arkCli.profile,
      apply: (value) => {
        config.arkCli.profile = value;
      },
    },
    {
      key: "ARK_CLI_API_KEY",
      label: "API Key",
      type: "password",
      secret: true,
      help: "可留空，留空时使用 arkcli auth login / config init 保存的本机登录态。",
      get: () => config.arkCli.apiKey,
      apply: (value) => {
        config.arkCli.apiKey = value;
      },
    },
    {
      key: "ARK_CLI_BASE_URL",
      label: "Base URL",
      type: "text",
      placeholder: "留空使用 arkcli 默认；常见值 https://ark.cn-beijing.volces.com/api/v3",
      get: () => config.arkCli.baseUrl,
      apply: (value) => {
        config.arkCli.baseUrl = value;
      },
    },
    {
      key: "ARK_CLI_MODEL",
      label: "默认模型 / Endpoint ID",
      type: "text",
      placeholder: "Platform profile 通常填 ep-*；Plan profile 可填模型名或留空用默认资源",
      help: "你当前如果是 platform profile，arkcli +chat 需要 ep-* 推理接入点，不接受 doubao-seed-* 这类 Plan 模型名。",
      get: () => config.arkCli.defaultModel,
      apply: (value) => {
        config.arkCli.defaultModel = value;
      },
    },
    {
      key: "ARK_CLI_REASONING_EFFORT",
      label: "推理强度",
      type: "select",
      get: () => config.arkCli.reasoningEffort,
      apply: (value) => {
        config.arkCli.reasoningEffort = value;
      },
      options: [
        { value: "", label: "使用模型默认" },
        { value: "minimal", label: "minimal" },
        { value: "low", label: "low" },
        { value: "medium", label: "medium" },
        { value: "high", label: "high" },
      ],
    },
    {
      key: "ARK_CLI_TIMEOUT",
      label: "进程超时秒数",
      type: "number",
      placeholder: "900",
      get: () => String(config.arkCli.timeoutSec),
      apply: (value) => {
        config.arkCli.timeoutSec = Number(value || 900);
      },
    },
  ],
  tokenezgo: [
    {
      key: "TOKENEZGO_BASE_URL",
      label: "Base URL",
      type: "text",
      required: true,
      placeholder: "https://tokenezgo.com/v1",
      help: "Xgent Hub 推荐 API 中转站默认地址，一般保持这个值即可。",
      get: () => config.tokenezgo.baseUrl,
      apply: (value) => {
        config.tokenezgo.baseUrl = value || "https://tokenezgo.com/v1";
      },
    },
    {
      key: "TOKENEZGO_API_KEY",
      label: "API Key",
      type: "password",
      secret: true,
      help: "到 https://tokenezgo.com 充值后获取 API Key，再粘贴到这里；留空保存会保留当前已设置的 Key。",
      get: () => config.tokenezgo.apiKey,
      apply: (value) => {
        config.tokenezgo.apiKey = value;
      },
    },
    {
      key: "TOKENEZGO_MODEL",
      label: "默认模型",
      type: "text",
      placeholder: "留空则新建任务时手动选择",
      help: "如果推荐中转站返回模型列表，建议在新建任务时选择；如果 /models 暂时不可用，可在这里手动填默认模型。",
      get: () => config.tokenezgo.defaultModel,
      apply: (value) => {
        config.tokenezgo.defaultModel = value;
      },
    },
  ],
  doubao: [
    {
      key: "DOUBAO_BASE_URL",
      label: "Base URL",
      type: "text",
      required: true,
      placeholder: "https://ark.cn-beijing.volces.com/api/v3",
      help: "默认走火山方舟 OpenAI 兼容接口；如果你用的是代理网关，也可以改成自己的兼容地址。",
      get: () => config.doubao.baseUrl,
      apply: (value) => {
        config.doubao.baseUrl = value || "https://ark.cn-beijing.volces.com/api/v3";
      },
    },
    {
      key: "DOUBAO_API_KEY",
      label: "API Key",
      type: "password",
      secret: true,
      get: () => config.doubao.apiKey,
      apply: (value) => {
        config.doubao.apiKey = value;
      },
    },
    {
      key: "DOUBAO_MODEL",
      label: "默认模型 / 接入点 ID",
      type: "text",
      placeholder: "留空则新建任务时手动选择；也可填火山方舟模型或推理接入点 ID",
      help: "如果模型列表刷新不到你的接入点，就把这里填成火山方舟控制台给你的模型/endpoint id。",
      get: () => config.doubao.defaultModel,
      apply: (value) => {
        config.doubao.defaultModel = value;
      },
    },
  ],
  hermes: [
    {
      key: "HERMES_BASE_URL",
      label: "Base URL",
      type: "text",
      placeholder: "http://127.0.0.1:8000",
      get: () => config.hermes.baseUrl,
      apply: (value) => {
        config.hermes.baseUrl = value || "http://127.0.0.1:8000";
      },
    },
    {
      key: "HERMES_API_KEY",
      label: "API Key",
      type: "password",
      secret: true,
      get: () => config.hermes.apiKey,
      apply: (value) => {
        config.hermes.apiKey = value;
      },
    },
    {
      key: "HERMES_MODEL",
      label: "默认模型",
      type: "text",
      placeholder: "hermes",
      get: () => config.hermes.model,
      apply: (value) => {
        config.hermes.model = value || "hermes";
      },
    },
  ],
  ollama: [
    {
      key: "OLLAMA_BASE_URL",
      label: "Base URL",
      type: "text",
      placeholder: "http://127.0.0.1:11434",
      get: () => config.ollama.baseUrl,
      apply: (value) => {
        config.ollama.baseUrl = value || "http://127.0.0.1:11434";
      },
    },
    {
      key: "OLLAMA_MODEL",
      label: "默认模型",
      type: "text",
      placeholder: "留空则新建任务时手动选择",
      get: () => config.ollama.defaultModel,
      apply: (value) => {
        config.ollama.defaultModel = value;
      },
    },
    {
      key: "OLLAMA_KEEP_ALIVE",
      label: "模型保活时间",
      type: "text",
      placeholder: "0=立即释放，30s=保留30秒，5m=默认体验",
      get: () => config.ollama.keepAlive,
      apply: (value) => {
        config.ollama.keepAlive = value.trim();
      },
    },
  ],
};

function getSchema(agentId: string): FieldDefinition[] {
  return schemas[agentId] ?? [];
}

function toField(def: FieldDefinition): AgentConfigField {
  const raw = def.get();
  const hasValue = raw.length > 0;
  return {
    key: def.key,
    label: def.label,
    type: def.type,
    value: def.secret ? "" : raw,
    hasValue,
    placeholder: def.secret && hasValue ? "已设置，留空则保留当前值" : def.placeholder,
    help: def.help,
    options: def.options,
  };
}

function formatEnvValue(value: string): string {
  const clean = value.replace(/\r?\n/g, " ").trim();
  if (clean === "") return "";
  if (/^[^\s#"']+$/.test(clean)) return clean;
  return JSON.stringify(clean);
}

function writeEnvValues(updates: Map<string, string>) {
  if (updates.size === 0) return;
  const original = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const lines = original ? original.split(/\r?\n/) : [];
  const seen = new Set<string>();
  const next = lines.map((line) => {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    const key = match?.[1];
    if (!key || !updates.has(key)) return line;
    seen.add(key);
    return `${key}=${formatEnvValue(updates.get(key) ?? "")}`;
  });

  const missing = [...updates.keys()].filter((key) => !seen.has(key));
  if (missing.length > 0 && next.some((line) => line.trim() !== "")) next.push("");
  for (const key of missing) next.push(`${key}=${formatEnvValue(updates.get(key) ?? "")}`);

  // 先写临时文件再替换，并留上一版 .env.bak：写到一半出问题不会丢掉 ADMIN_TOKEN 这些配置。
  writeTextAtomic(envPath, next.join("\n").replace(/\n*$/, "\n"));
}

export function getAgentConfig(agentId: string): AgentConfigResponse {
  const adapter = getAdapter(agentId);
  if (!adapter) throw new Error(`未知 agent: ${agentId}`);
  const custom = getCustomAgent(agentId);
  if (custom) {
    return {
      agent: toDescriptor(adapter),
      editable: true,
      fields: customAgentFields(custom),
      envPath: customAgentStorePath,
    };
  }
  const fields = getSchema(agentId).map(toField);
  return {
    agent: toDescriptor(adapter),
    editable: fields.length > 0,
    fields,
    envPath,
    note: fields.length > 0 ? undefined : "这个 Agent 不需要额外配置。",
  };
}

export function updateAgentConfig(agentId: string, values: Record<string, string | undefined>): AgentConfigResponse {
  const schema = getSchema(agentId);
  if (schema.length === 0) {
    if (!getCustomAgent(agentId)) throw new Error(`agent "${agentId}" 没有可编辑配置`);
    updateCustomAgent(agentId, values);
    return getAgentConfig(agentId);
  }

  const updates = new Map<string, string>();
  for (const def of schema) {
    if (!(def.key in values)) continue;
    const raw = String(values[def.key] ?? "");
    if (def.secret && raw.trim() === "") continue;
    const value = raw.trim();
    if (def.required && !value) throw new Error(`${def.label} 不能为空`);
    if (def.type === "number" && value && !Number.isFinite(Number(value))) throw new Error(`${def.label} 必须是数字`);
    updates.set(def.key, value);
  }

  writeEnvValues(updates);
  for (const def of schema) {
    if (!updates.has(def.key)) continue;
    const value = updates.get(def.key) ?? "";
    process.env[def.key] = value;
    def.apply(value);
  }

  return getAgentConfig(agentId);
}
