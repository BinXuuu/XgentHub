import { taskManager } from "./taskManager.ts";
import { diagnoseAgent } from "./agentDiagnosticsService.ts";
import type {
  AgentDescriptor,
  AgentDiagnosticStatus,
  AgentDiagnostics,
  OnboardingChecklistStep,
  OnboardingOverview,
} from "../types.ts";

function now(): string {
  return new Date().toISOString();
}

function rankStatus(statuses: AgentDiagnosticStatus[]): AgentDiagnosticStatus {
  if (statuses.includes("error")) return "error";
  if (statuses.includes("warn")) return "warn";
  return "ok";
}

function statusFromAgents(agents: AgentDescriptor[], lookup: Map<string, AgentDiagnosticStatus>): AgentDiagnosticStatus {
  if (!agents.length) return "warn";
  return rankStatus(agents.map((agent) => lookup.get(agent.id) ?? "warn"));
}

function fallbackDiagnostics(agent: AgentDescriptor, message: string): AgentDiagnostics {
  return {
    agentId: agent.id,
    status: "error",
    summary: `${agent.name}：诊断失败`,
    updatedAt: now(),
    checks: [{ label: "诊断", status: "error", detail: message }],
    nextSteps: ["打开该 Agent 的配置页重新检测，或检查本机服务 / CLI 是否可用。"],
    setupSteps: [
      {
        title: "重新检测配置",
        status: "error",
        description: message,
        actions: [],
      },
    ],
  };
}

function buildChecklist(agents: AgentDescriptor[], statusLookup: Map<string, AgentDiagnosticStatus>): OnboardingChecklistStep[] {
  const byKind = (kinds: string[]) => agents.filter((agent) => kinds.includes(agent.kind));
  // 只算真正能改本机文件、而且诊断通过的 Agent；以前把所有 Agent 都算进来，新电脑什么都没装也会打绿勾。
  const workspaceAgents = agents.filter((agent) => agent.runtime?.canWriteWorkspace && statusLookup.get(agent.id) === "ok");
  const localModelAgents = byKind(["ollama"]);
  const cliAgents = byKind(["codex", "claude-code", "openclaw", "antigravity", "ark-cli", "custom-cli"]);
  const apiAgents = byKind(["hermes", "tokenezgo", "doubao", "custom-api"]);
  const readyAgents = agents.filter((agent) => statusLookup.get(agent.id) === "ok");
  const almostAgents = agents.filter((agent) => statusLookup.get(agent.id) === "warn");

  return [
    {
      id: "workspace",
      title: "1. 准备工作区",
      status: workspaceAgents.length ? "ok" : "warn",
      description: workspaceAgents.length
        ? "已有能改本机文件的 Agent 可用，创建任务时选择正确工作区即可。"
        : "还没有能改本机文件的 Agent 可用。先装好并登录 Codex / Claude Code / Antigravity / OpenClaw 中的一个。",
      agentIds: workspaceAgents.map((agent) => agent.id),
    },
    {
      id: "local-models",
      title: "2. 本地模型服务",
      status: statusFromAgents(localModelAgents, statusLookup),
      description: localModelAgents.length
        ? "Ollama 等本地模型服务用于低成本测试和离线任务。"
        : "如需本地模型，先添加或启用 Ollama。",
      agentIds: localModelAgents.map((agent) => agent.id),
    },
    {
      id: "cli-agents",
      title: "3. CLI Agent",
      status: statusFromAgents(cliAgents, statusLookup),
      description: "Codex / OpenClaw / Claude Code / Antigravity 这类 Agent 需要本机 CLI 和登录态可用。",
      agentIds: cliAgents.map((agent) => agent.id),
    },
    {
      id: "api-gateways",
      title: "4. API 和中转站",
      status: apiAgents.length ? statusFromAgents(apiAgents, statusLookup) : "warn",
      description: "推荐 API 中转站、Hermes、豆包或自定义 OpenAI 兼容 API 需要 Base URL、Key 和默认模型。",
      agentIds: apiAgents.map((agent) => agent.id),
    },
    {
      id: "smoke-test",
      title: "5. 创建任务测试",
      status: readyAgents.length ? "ok" : almostAgents.length ? "warn" : "error",
      description: readyAgents.length
        ? "至少有一个 Agent 可以进入任务测试。建议先用短提示验证模型、工作区和审批模式。"
        : almostAgents.length
          ? "有 Agent 还差一步（比如没登录、服务没启动），处理完黄色项再测试。"
          : "当前没有可用于测试的 Agent，先按上面的步骤装好一个。",
      agentIds: (readyAgents.length ? readyAgents : almostAgents).map((agent) => agent.id),
    },
  ];
}

export async function getOnboardingOverview(): Promise<OnboardingOverview> {
  const agents = taskManager.listAgents();
  const readiness = await Promise.all(
    agents.map(async (agent) => {
      try {
        return { agent, diagnostics: await diagnoseAgent(agent.id) };
      } catch (err) {
        return { agent, diagnostics: fallbackDiagnostics(agent, (err as Error).message) };
      }
    })
  );
  const counts = readiness.reduce(
    (acc, item) => {
      acc[item.diagnostics.status] += 1;
      return acc;
    },
    { total: readiness.length, ok: 0, warn: 0, error: 0 }
  );
  const statusLookup = new Map(readiness.map((item) => [item.agent.id, item.diagnostics.status] as const));

  return {
    updatedAt: now(),
    counts,
    checklist: buildChecklist(agents, statusLookup),
    agents: readiness.sort((a, b) => {
      const order: Record<AgentDiagnosticStatus, number> = { error: 0, warn: 1, ok: 2 };
      return order[a.diagnostics.status] - order[b.diagnostics.status] || a.agent.name.localeCompare(b.agent.name);
    }),
  };
}
