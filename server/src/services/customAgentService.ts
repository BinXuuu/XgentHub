import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { config } from "../config.ts";
import type { AgentConfigField } from "../types.ts";

export type CustomAgentMode = "api" | "cli";
export type CustomCliOutputMode = "text" | "json" | "jsonl";

export interface CustomAgentDefinition {
  id: string;
  mode: CustomAgentMode;
  name: string;
  description: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  api?: {
    baseUrl: string;
    apiKey: string;
    defaultModel: string;
    systemPrompt: string;
  };
  cli?: {
    command: string;
    argsTemplate: string;
    stdinTemplate?: string;
    modelArgTemplate: string;
    /**
     * 可选。只有填了这个，前端才会把这个自定义 Agent 当成"支持 MCP"显示选择器。格式套用
     * Claude Code 的 --mcp-config 思路：填一个带 {mcpConfig} 占位符的参数模板（比如
     * "--mcp-config {mcpConfig}"），AgentHub 会把当前任务/聊天选中的 MCP server 写成一份
     * 临时 JSON 配置文件，{mcpConfig} 替换成这份文件的路径。只适用于"能接受一个 MCP 配置
     * 文件路径"这种按次传参的 CLI；如果目标工具是 Codex/OpenClaw 那种"先 mcp add 持久注册"
     * 的模式，这个占位符帮不上忙，得靠它自己已经注册好的 MCP。
     */
    mcpArgTemplate?: string;
    defaultModel: string;
    modelListCommand: string;
    outputMode: CustomCliOutputMode;
    timeoutSec: number;
    workspacePrompt: boolean;
  };
}

export interface CreateCustomAgentInput {
  template: "api" | "cli" | "codex-cli" | "openclaw-cli" | "claude-code-cli" | "antigravity-cli";
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  defaultModel?: string;
  command?: string;
  argsTemplate?: string;
  stdinTemplate?: string;
  modelArgTemplate?: string;
  mcpArgTemplate?: string;
}

const storePath = path.join(config.dataDir, "custom-agents.json");

function now(): string {
  return new Date().toISOString();
}

function readStore(): CustomAgentDefinition[] {
  if (!fs.existsSync(storePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStore(items: CustomAgentDefinition[]) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(items, null, 2) + "\n", "utf8");
}

function slugify(raw: string): string {
  const ascii = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return ascii || nanoid(6);
}

function uniqueId(name: string, existing: CustomAgentDefinition[]): string {
  const base = slugify(name);
  let id = `custom:${base}`;
  let n = 2;
  const seen = new Set(existing.map((item) => item.id));
  while (seen.has(id)) id = `custom:${base}-${n++}`;
  return id;
}

function makeTemplate(input: CreateCustomAgentInput, existing: CustomAgentDefinition[]): CustomAgentDefinition {
  const stamp = now();
  const name =
    input.name?.trim() ||
    (input.template === "api"
      ? "自定义 API"
      : input.template === "codex-cli"
        ? "自定义 Codex CLI"
        : input.template === "openclaw-cli"
          ? "自定义 OpenClaw CLI"
          : input.template === "claude-code-cli"
            ? "自定义 Claude Code CLI"
            : input.template === "antigravity-cli"
              ? "自定义 Antigravity CLI"
              : "自定义 CLI");

  const base: Omit<CustomAgentDefinition, "api" | "cli"> = {
    id: uniqueId(name, existing),
    mode: input.template === "api" ? "api" : "cli",
    name,
    description: "",
    enabled: true,
    createdAt: stamp,
    updatedAt: stamp,
  };

  if (input.template === "api") {
    return {
      ...base,
      description: "OpenAI 兼容 API，自定义 Base URL / API Key / 模型",
      api: {
        baseUrl: input.baseUrl?.trim() || "https://api.example.com/v1",
        apiKey: input.apiKey?.trim() || "",
        defaultModel: input.defaultModel?.trim() || "",
        systemPrompt: "你是通过 Xgent Hub 调用的自定义 API Agent，请简洁、准确地完成用户任务。",
      },
    };
  }

  const cliDefaults = {
    command: input.command?.trim() || "",
    argsTemplate: input.argsTemplate?.trim() || "{prompt}",
    stdinTemplate: input.stdinTemplate?.trim() || "",
    modelArgTemplate: input.modelArgTemplate?.trim() || "",
    mcpArgTemplate: input.mcpArgTemplate?.trim() || "",
    defaultModel: input.defaultModel?.trim() || "",
    modelListCommand: "",
    outputMode: "text" as CustomCliOutputMode,
    timeoutSec: 900,
    workspacePrompt: true,
  };

  if (input.template === "codex-cli") {
    cliDefaults.command = input.command?.trim() || "codex";
    cliDefaults.argsTemplate =
      input.argsTemplate?.trim() || "exec --sandbox workspace-write --skip-git-repo-check {addDirArgs} -C {workspace} -";
    cliDefaults.stdinTemplate = input.stdinTemplate?.trim() || "{prompt}";
    cliDefaults.modelArgTemplate = input.modelArgTemplate?.trim() || "-m {model}";
    cliDefaults.modelListCommand = "codex debug models";
    cliDefaults.outputMode = "text";
  } else if (input.template === "openclaw-cli") {
    cliDefaults.command = input.command?.trim() || "openclaw";
    cliDefaults.argsTemplate = input.argsTemplate?.trim() || "agent --session-key {session} --message {prompt} --json";
    cliDefaults.modelArgTemplate = input.modelArgTemplate?.trim() || "--model {model}";
    cliDefaults.modelListCommand = "openclaw models list --json";
    cliDefaults.outputMode = "json";
  } else if (input.template === "claude-code-cli") {
    cliDefaults.command = input.command?.trim() || "claude";
    cliDefaults.argsTemplate = input.argsTemplate?.trim() || "--print --output-format stream-json --verbose {addDirArgs}";
    cliDefaults.stdinTemplate = input.stdinTemplate?.trim() || "{prompt}";
    cliDefaults.modelArgTemplate = input.modelArgTemplate?.trim() || "--model {model}";
    // 跟内置 Claude Code adapter 实测验证过的用法一致：claude 真的认 --mcp-config <json文件>。
    cliDefaults.mcpArgTemplate = input.mcpArgTemplate?.trim() || "--mcp-config {mcpConfig}";
    cliDefaults.outputMode = "jsonl";
  } else if (input.template === "antigravity-cli") {
    cliDefaults.command = input.command?.trim() || "agy";
    cliDefaults.argsTemplate =
      input.argsTemplate?.trim() || "--add-dir {workspace} {addDirArgs} --output-format json --print-timeout 100m -p {prompt}";
    cliDefaults.modelArgTemplate = input.modelArgTemplate?.trim() || "--model {model}";
    cliDefaults.modelListCommand = "agy models";
    cliDefaults.outputMode = "json";
    cliDefaults.timeoutSec = 6000;
  }

  return {
    ...base,
    description: "自定义本机 CLI，通过参数模板把任务交给命令行工具",
    cli: cliDefaults,
  };
}

export function listCustomAgents(): CustomAgentDefinition[] {
  return readStore().filter((item) => item.enabled !== false);
}

export function getCustomAgent(id: string): CustomAgentDefinition | undefined {
  return readStore().find((item) => item.id === id);
}

export function createCustomAgent(input: CreateCustomAgentInput): CustomAgentDefinition {
  const items = readStore();
  const item = makeTemplate(input, items);
  writeStore([...items, item]);
  return item;
}

export function deleteCustomAgent(id: string): boolean {
  const items = readStore();
  const next = items.filter((item) => item.id !== id);
  if (next.length === items.length) return false;
  writeStore(next);
  return true;
}

export function updateCustomAgent(id: string, values: Record<string, string | undefined>): CustomAgentDefinition {
  const items = readStore();
  const idx = items.findIndex((item) => item.id === id);
  if (idx < 0) throw new Error(`未知自定义 Agent: ${id}`);
  const item = structuredClone(items[idx]);
  if ("CUSTOM_NAME" in values) item.name = String(values.CUSTOM_NAME ?? "").trim() || item.name;
  if ("CUSTOM_DESCRIPTION" in values) item.description = String(values.CUSTOM_DESCRIPTION ?? "").trim();

  if (item.mode === "api") {
    item.api ??= { baseUrl: "", apiKey: "", defaultModel: "", systemPrompt: "" };
    if ("CUSTOM_API_BASE_URL" in values) item.api.baseUrl = String(values.CUSTOM_API_BASE_URL ?? "").trim();
    if ("CUSTOM_API_KEY" in values && String(values.CUSTOM_API_KEY ?? "").trim()) {
      item.api.apiKey = String(values.CUSTOM_API_KEY ?? "").trim();
    }
    if ("CUSTOM_API_MODEL" in values) item.api.defaultModel = String(values.CUSTOM_API_MODEL ?? "").trim();
    if ("CUSTOM_API_SYSTEM_PROMPT" in values) item.api.systemPrompt = String(values.CUSTOM_API_SYSTEM_PROMPT ?? "").trim();
  } else {
    item.cli ??= {
      command: "",
      argsTemplate: "{prompt}",
      stdinTemplate: "",
      modelArgTemplate: "",
      mcpArgTemplate: "",
      defaultModel: "",
      modelListCommand: "",
      outputMode: "text",
      timeoutSec: 900,
      workspacePrompt: true,
    };
    if ("CUSTOM_CLI_COMMAND" in values) item.cli.command = String(values.CUSTOM_CLI_COMMAND ?? "").trim();
    if ("CUSTOM_CLI_ARGS_TEMPLATE" in values) item.cli.argsTemplate = String(values.CUSTOM_CLI_ARGS_TEMPLATE ?? "").trim();
    if ("CUSTOM_CLI_STDIN_TEMPLATE" in values) item.cli.stdinTemplate = String(values.CUSTOM_CLI_STDIN_TEMPLATE ?? "").trim();
    if ("CUSTOM_CLI_MODEL_ARG_TEMPLATE" in values) item.cli.modelArgTemplate = String(values.CUSTOM_CLI_MODEL_ARG_TEMPLATE ?? "").trim();
    if ("CUSTOM_CLI_MCP_ARG_TEMPLATE" in values) item.cli.mcpArgTemplate = String(values.CUSTOM_CLI_MCP_ARG_TEMPLATE ?? "").trim();
    if ("CUSTOM_CLI_MODEL" in values) item.cli.defaultModel = String(values.CUSTOM_CLI_MODEL ?? "").trim();
    if ("CUSTOM_CLI_MODEL_LIST_COMMAND" in values) item.cli.modelListCommand = String(values.CUSTOM_CLI_MODEL_LIST_COMMAND ?? "").trim();
    if ("CUSTOM_CLI_OUTPUT_MODE" in values) {
      const mode = String(values.CUSTOM_CLI_OUTPUT_MODE ?? "text") as CustomCliOutputMode;
      item.cli.outputMode = mode === "json" || mode === "jsonl" ? mode : "text";
    }
    if ("CUSTOM_CLI_TIMEOUT" in values) {
      const n = Number(values.CUSTOM_CLI_TIMEOUT || 900);
      if (!Number.isFinite(n) || n <= 0) throw new Error("CLI 超时秒数必须是正数");
      item.cli.timeoutSec = n;
    }
    if ("CUSTOM_CLI_WORKSPACE_PROMPT" in values) item.cli.workspacePrompt = String(values.CUSTOM_CLI_WORKSPACE_PROMPT ?? "true") === "true";
  }

  item.updatedAt = now();
  items[idx] = item;
  writeStore(items);
  return item;
}

export function customAgentFields(item: CustomAgentDefinition): AgentConfigField[] {
  const common: AgentConfigField[] = [
    { key: "CUSTOM_NAME", label: "名称", type: "text", value: item.name, hasValue: Boolean(item.name) },
    { key: "CUSTOM_DESCRIPTION", label: "描述", type: "text", value: item.description, hasValue: Boolean(item.description) },
  ];
  if (item.mode === "api") {
    const api = item.api ?? { baseUrl: "", apiKey: "", defaultModel: "", systemPrompt: "" };
    return [
      ...common,
      { key: "CUSTOM_API_BASE_URL", label: "Base URL", type: "text", value: api.baseUrl, hasValue: Boolean(api.baseUrl) },
      {
        key: "CUSTOM_API_KEY",
        label: "API Key",
        type: "password",
        value: "",
        hasValue: Boolean(api.apiKey),
        placeholder: api.apiKey ? "已设置，留空则保留当前值" : "sk-...",
      },
      { key: "CUSTOM_API_MODEL", label: "默认模型", type: "text", value: api.defaultModel, hasValue: Boolean(api.defaultModel) },
      {
        key: "CUSTOM_API_SYSTEM_PROMPT",
        label: "系统提示词",
        type: "text",
        value: api.systemPrompt,
        hasValue: Boolean(api.systemPrompt),
      },
    ];
  }
  const cli = item.cli ?? {
    command: "",
    argsTemplate: "{prompt}",
    stdinTemplate: "",
    modelArgTemplate: "",
    mcpArgTemplate: "",
    defaultModel: "",
    modelListCommand: "",
    outputMode: "text" as CustomCliOutputMode,
    timeoutSec: 900,
    workspacePrompt: true,
  };
  return [
    ...common,
    { key: "CUSTOM_CLI_COMMAND", label: "CLI 命令 / exe 路径", type: "text", value: cli.command, hasValue: Boolean(cli.command) },
    {
      key: "CUSTOM_CLI_ARGS_TEMPLATE",
      label: "参数模板",
      type: "text",
      value: cli.argsTemplate,
      hasValue: Boolean(cli.argsTemplate),
      help: "可用占位符：{prompt}、{rawPrompt}、{workspace}、{accessPaths}、{addDirArgs}、{model}、{session}、{mcpConfig}",
    },
    {
      key: "CUSTOM_CLI_STDIN_TEMPLATE",
      label: "标准输入模板",
      type: "text",
      value: cli.stdinTemplate ?? "",
      hasValue: Boolean(cli.stdinTemplate),
      help: "可选。需要从 stdin 读取 prompt 的 CLI 可填 {prompt}，参数模板里通常用 - 作为 stdin 占位。",
    },
    {
      key: "CUSTOM_CLI_MODEL_ARG_TEMPLATE",
      label: "模型参数模板",
      type: "text",
      value: cli.modelArgTemplate ?? "",
      hasValue: Boolean(cli.modelArgTemplate),
      help: "可选。只有选了模型或设置默认模型时才追加，例如 Codex 用 -m {model}，OpenClaw/Antigravity 用 --model {model}",
    },
    {
      key: "CUSTOM_CLI_MCP_ARG_TEMPLATE",
      label: "MCP 参数模板",
      type: "text",
      value: cli.mcpArgTemplate ?? "",
      hasValue: Boolean(cli.mcpArgTemplate),
      help:
        "可选，填了才会在创建任务/聊天时显示 MCP 选择器。只适用于能接受一个 MCP 配置文件路径的 CLI，" +
        "例如 Claude Code 用 --mcp-config {mcpConfig}。Codex/OpenClaw 这种靠先注册再用的 CLI，这个字段帮不上忙。",
    },
    { key: "CUSTOM_CLI_MODEL", label: "默认模型", type: "text", value: cli.defaultModel, hasValue: Boolean(cli.defaultModel) },
    {
      key: "CUSTOM_CLI_MODEL_LIST_COMMAND",
      label: "模型列表命令",
      type: "text",
      value: cli.modelListCommand,
      hasValue: Boolean(cli.modelListCommand),
      help: "可选。例如：agy models / openclaw models list --json",
    },
    {
      key: "CUSTOM_CLI_OUTPUT_MODE",
      label: "输出解析",
      type: "select",
      value: cli.outputMode,
      hasValue: true,
      options: [
        { value: "text", label: "纯文本" },
        { value: "json", label: "JSON：取 response/result/message/text" },
        { value: "jsonl", label: "JSONL：逐行取文本字段" },
      ],
    },
    { key: "CUSTOM_CLI_TIMEOUT", label: "超时秒数", type: "number", value: String(cli.timeoutSec), hasValue: true },
    {
      key: "CUSTOM_CLI_WORKSPACE_PROMPT",
      label: "注入工作区提示",
      type: "select",
      value: String(cli.workspacePrompt),
      hasValue: true,
      options: [
        { value: "true", label: "是" },
        { value: "false", label: "否" },
      ],
    },
  ];
}

export { storePath as customAgentStorePath };
