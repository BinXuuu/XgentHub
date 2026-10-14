import type { AgentAdapter } from "./types.ts";
import { MockAdapter } from "./mock.ts";
import { OpenClawAdapter } from "./openclaw.ts";
import { CodexAdapter } from "./codex.ts";
import { ClaudeCodeAdapter } from "./claudeCode.ts";
import { AntigravityAdapter } from "./antigravity.ts";
import { ArkCliAdapter } from "./arkCli.ts";
import { HermesAdapter } from "./hermes.ts";
import { OllamaAdapter } from "./ollama.ts";
import { TokenEzgoAdapter } from "./tokenezgo.ts";
import { DoubaoAdapter } from "./doubao.ts";
import { createCustomAdapter } from "./custom.ts";
import { getRuntimeProfile } from "./runtimeMetadata.ts";
import type { AgentDescriptor } from "../types.ts";
import { listCustomAgents } from "../services/customAgentService.ts";
import { getRole, listRoles, roleIdFromAgentId } from "../services/roleService.ts";
import { RoleAdapter } from "./role.ts";

const AGENT_META: Record<string, Partial<AgentDescriptor>> = {
  tokenezgo: {
    official: true,
    locked: true,
    billingUrl: "https://tokenezgo.com",
    billingLabel: "充值 / 获取 API Key",
  },
};

// agentId === adapter kind（单实例）。以后要支持“同一 runtime 多个已配置 agent”
// （例如两个不同 workspace 绑定的 OpenClaw agent id），可以在这里按需要生成多个
// descriptor + 一个 Map<agentId, AgentAdapter> 而不改变上层接口。
// Mock Agent 只给开发和自动化测试用，正式使用时不出现在列表里。
// 设 AGENTHUB_ENABLE_MOCK=1 打开；node --test 跑测试时（会带 NODE_TEST_CONTEXT）自动打开。
const mockEnabled = process.env.AGENTHUB_ENABLE_MOCK === "1" || Boolean(process.env.NODE_TEST_CONTEXT);

const adapters: AgentAdapter[] = [
  new TokenEzgoAdapter(),
  new CodexAdapter(),
  new ClaudeCodeAdapter(),
  new AntigravityAdapter(),
  new ArkCliAdapter(),
  new OpenClawAdapter(),
  new DoubaoAdapter(),
  new HermesAdapter(),
  new OllamaAdapter(),
  ...(mockEnabled ? [new MockAdapter()] : []),
];

const byId = new Map<string, AgentAdapter>(adapters.map((a) => [a.id ?? a.kind, a]));

/** 内置 + 自定义 Agent，不含角色——角色的底座只能是它们，角色不能套角色。 */
function getBaseAdapter(agentId: string): AgentAdapter | undefined {
  const builtin = byId.get(agentId);
  if (builtin) return builtin;
  const custom = listCustomAgents().find((agent) => agent.id === agentId);
  return custom ? createCustomAdapter(custom) : undefined;
}

export function getAdapter(agentId: string): AgentAdapter | undefined {
  const roleId = roleIdFromAgentId(agentId);
  if (roleId) {
    const role = getRole(roleId);
    return role ? new RoleAdapter(role, getBaseAdapter) : undefined;
  }
  return getBaseAdapter(agentId);
}

export function listBaseAdapters(): AgentAdapter[] {
  return [...adapters, ...listCustomAgents().map(createCustomAdapter)];
}

/** 停用的角色不出现在可选列表里，但 getAdapter 仍能解析，已有任务照常继续。 */
export function listAdapters(): AgentAdapter[] {
  const roles = listRoles()
    .filter((role) => role.enabled)
    .map((role) => new RoleAdapter(role, getBaseAdapter));
  return [...listBaseAdapters(), ...roles];
}

export function isProtectedAgent(agentId: string): boolean {
  return Boolean(AGENT_META[agentId]?.locked);
}

export function toDescriptor(a: AgentAdapter): AgentDescriptor {
  const id = a.id ?? a.kind;
  const meta = AGENT_META[id] ?? {};
  return {
    id,
    kind: a.kind,
    name: a.name,
    description: a.description,
    configured: a.isConfigured(),
    configHint: a.configHint(),
    custom: Boolean(a.id),
    official: Boolean(meta.official),
    locked: Boolean(meta.locked),
    billingUrl: meta.billingUrl,
    billingLabel: meta.billingLabel,
    supportsModelSelection: Boolean(a.listModels),
    supportsUsage: Boolean(a.getUsageSummary),
    supportsSubAgentSelection: Boolean(a.listSubAgents),
    supportsMcp: Boolean(a.supportsMcp),
    supportsAsk: Boolean(a.ask),
    defaultModel: a.defaultModel?.() || null,
    enforcesPlanMode: Boolean(a.enforcesPlanMode),
    role: a.roleInfo ?? null,
    runtime: getRuntimeProfile(a.kind),
  };
}
