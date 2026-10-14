import type { AgentKind, AgentRuntimeProfile, RuntimeKind } from "../types.ts";

export function runtimeKindFromAgentKind(kind: AgentKind): RuntimeKind {
  if (kind === "mock") return "mock";
  if (kind === "ollama") return "local";
  if (kind === "custom-cli" || kind === "custom-api") return "custom";
  if (kind === "codex" || kind === "claude-code" || kind === "openclaw" || kind === "antigravity" || kind === "ark-cli") return "cli";
  if (kind === "tokenezgo" || kind === "doubao" || kind === "hermes") return "api";
  return "unknown";
}

const BASE: AgentRuntimeProfile = {
  kind: "unknown",
  executionKind: "http-api",
  toolBoundary: "chat-only",
  canReadWorkspace: false,
  canWriteWorkspace: false,
  canExecuteCommands: false,
  supportsImages: false,
  supportsStreaming: true,
  supportsStop: false,
  supportsResume: false,
  defaultPermissionMode: "supervised",
  notes: [],
};

const PROFILES: Record<AgentKind, AgentRuntimeProfile> = {
  mock: {
    ...BASE,
    kind: "mock",
    executionKind: "mock",
    toolBoundary: "simulated",
    canReadWorkspace: true,
    canWriteWorkspace: true,
    canExecuteCommands: true,
    supportsStop: true,
    supportsResume: true,
    notes: ["Development-only runtime that simulates files, approvals, and terminal output."],
  },
  codex: {
    ...BASE,
    kind: "cli",
    executionKind: "external-cli",
    toolBoundary: "os-sandbox",
    canReadWorkspace: true,
    canWriteWorkspace: true,
    canExecuteCommands: true,
    supportsImages: true,
    supportsStop: false,
    supportsResume: true,
    notes: ["Runs through codex exec with Codex CLI sandbox controls."],
  },
  "claude-code": {
    ...BASE,
    kind: "cli",
    executionKind: "external-cli",
    toolBoundary: "preflight-gated",
    canReadWorkspace: true,
    canWriteWorkspace: true,
    canExecuteCommands: true,
    supportsStop: false,
    supportsResume: true,
    notes: ["External CLI tool actions are not intercepted per command by AgentHub."],
  },
  openclaw: {
    ...BASE,
    kind: "cli",
    executionKind: "external-cli",
    toolBoundary: "preflight-gated",
    canReadWorkspace: true,
    canWriteWorkspace: true,
    canExecuteCommands: true,
    supportsStop: true,
    supportsResume: true,
    notes: ["OpenClaw process tree can be stopped; internal tool use is gateway-controlled."],
  },
  antigravity: {
    ...BASE,
    kind: "cli",
    executionKind: "external-cli",
    toolBoundary: "preflight-gated",
    canReadWorkspace: true,
    canWriteWorkspace: true,
    canExecuteCommands: true,
    supportsStop: false,
    supportsResume: true,
    notes: ["Headless CLI stream is parsed, but tool calls are not individually intercepted."],
  },
  "ark-cli": {
    ...BASE,
    kind: "cli",
    executionKind: "external-cli",
    toolBoundary: "preflight-gated",
    canReadWorkspace: false,
    canWriteWorkspace: false,
    canExecuteCommands: false,
    supportsImages: true,
    supportsStop: false,
    supportsResume: true,
    notes: ["Ark +chat is a stored conversation runtime, not a local coding sandbox."],
  },
  tokenezgo: {
    ...BASE,
    kind: "api",
    executionKind: "http-api",
    toolBoundary: "chat-only",
    notes: ["Official OpenAI-compatible API gateway; local cost ledger is estimated."],
  },
  doubao: {
    ...BASE,
    kind: "api",
    executionKind: "http-api",
    toolBoundary: "chat-only",
    notes: ["OpenAI-compatible Doubao / Volcengine API runtime."],
  },
  hermes: {
    ...BASE,
    kind: "api",
    executionKind: "http-api",
    toolBoundary: "chat-only",
    notes: ["Local or remote OpenAI-compatible text model service."],
  },
  ollama: {
    ...BASE,
    kind: "local",
    executionKind: "local-service",
    toolBoundary: "chat-only",
    notes: ["Local Ollama chat API; no workspace tools."],
  },
  "custom-api": {
    ...BASE,
    kind: "custom",
    executionKind: "http-api",
    toolBoundary: "user-defined",
    notes: ["User-defined OpenAI-compatible API runtime."],
  },
  "custom-cli": {
    ...BASE,
    kind: "custom",
    executionKind: "external-cli",
    toolBoundary: "user-defined",
    canReadWorkspace: true,
    canWriteWorkspace: true,
    canExecuteCommands: true,
    supportsStop: false,
    supportsResume: true,
    notes: ["User-defined CLI runtime; capabilities depend on the configured command."],
  },
};

export function getRuntimeProfile(kind: AgentKind): AgentRuntimeProfile {
  return PROFILES[kind] ?? { ...BASE, kind: runtimeKindFromAgentKind(kind) };
}
