import { db } from "../db/index.ts";
import { addRoleMemory, buildRoleContext, extractRememberLines, roleAgentId, type AgentRole } from "../services/roleService.ts";
import type { ModelOption } from "../types.ts";
import type { AgentAdapter, McpServerSpec, RoleInfo, TaskRuntimeContext, TurnInput } from "./types.ts";

type ResolveAdapter = (agentId: string) => AgentAdapter | undefined;

/**
 * 角色 = 套在真实底座 Agent 外面的一层：每一轮把角色身份/提示词拼进上下文，其余（会话续接、MCP、
 * 计划模式、停止）全部交给底座。任务创建时底座 id 记在 tasks.base_agent_id 上，之后改角色底座
 * 只影响新任务，避免已有任务的 CLI 会话换了一个程序就接不上。
 */
export class RoleAdapter implements AgentAdapter {
  readonly id: string;
  readonly kind: AgentAdapter["kind"];
  readonly name: string;
  readonly description: string;
  readonly supportsMcp: boolean;
  readonly enforcesPlanMode: boolean;
  readonly roleInfo: RoleInfo;
  readonly listModels?: () => Promise<ModelOption[]>;
  readonly getUsageSummary?: () => Promise<string | null>;
  readonly defaultModel: () => string | null;
  private readonly role: AgentRole;
  private readonly resolveAdapter: ResolveAdapter;

  constructor(role: AgentRole, resolveAdapter: ResolveAdapter) {
    this.role = role;
    this.resolveAdapter = resolveAdapter;
    const base = resolveAdapter(role.baseAgentId);
    this.id = roleAgentId(role.id);
    this.kind = base?.kind ?? role.baseAgentKind;
    this.name = role.name;
    this.description = role.description || `${role.name}（底座：${base?.name ?? role.baseAgentId}）`;
    this.supportsMcp = Boolean(base?.supportsMcp);
    this.enforcesPlanMode = Boolean(base?.enforcesPlanMode);
    this.roleInfo = {
      roleId: role.id,
      icon: role.icon,
      baseAgentId: role.baseAgentId,
      baseAgentName: base?.name ?? role.baseAgentId,
      model: role.model,
      knowledgeGroupIds: role.knowledgeGroupIds,
      mcpServerIds: role.mcpServerIds,
      toolIds: role.toolIds,
      skillIds: role.skillIds,
    };
    if (base?.listModels) this.listModels = () => base.listModels!();
    if (base?.getUsageSummary) this.getUsageSummary = () => base.getUsageSummary!();
    // 角色设了模型就用角色的，没设就跟底座的默认走。
    this.defaultModel = () => role.model || base?.defaultModel?.() || null;
  }

  /** 这个任务该用哪个底座：任务本身就是这个角色、且建任务时记下了底座，就用记下的；否则用角色当前的底座。 */
  private baseFor(taskId: string | null): AgentAdapter {
    let baseId = this.role.baseAgentId;
    if (taskId) {
      const row = db.prepare("SELECT agent_id, base_agent_id FROM tasks WHERE id = ?").get(taskId) as
        | { agent_id: string; base_agent_id: string | null }
        | undefined;
      if (row?.agent_id === this.id && row.base_agent_id) baseId = row.base_agent_id;
    }
    const base = this.resolveAdapter(baseId);
    if (!base) throw new Error(`角色「${this.role.name}」的底座 Agent（${baseId}）不存在了，请到角色设置里重新选一个`);
    return base;
  }

  /** 角色回复里的"【记住】xxx"行拿出来存成待确认记忆，正文里去掉，用户在界面上点确认才生效。 */
  private captureProposals(text: string, taskId: string | null): string {
    const { clean, proposals } = extractRememberLines(text);
    for (const content of proposals) {
      try {
        addRoleMemory({ roleId: this.role.id, content, status: "pending", source: "agent", taskId });
      } catch {
        // 角色在这期间被删了之类，忽略
      }
    }
    return clean;
  }

  private wrap(ctx: TaskRuntimeContext): TaskRuntimeContext {
    return {
      ...ctx,
      workspacePrompt: [buildRoleContext(this.role), ctx.workspacePrompt].filter(Boolean).join("\n\n"),
      model: ctx.model || this.role.model,
      agentMessage: (content: string) => ctx.agentMessage(this.captureProposals(content, ctx.taskId)),
    };
  }

  isConfigured(): boolean {
    return this.role.enabled && Boolean(this.resolveAdapter(this.role.baseAgentId)?.isConfigured());
  }

  configHint(): string {
    const base = this.resolveAdapter(this.role.baseAgentId);
    if (!base) return `底座 Agent（${this.role.baseAgentId}）不存在了，请在角色设置里重新选择`;
    if (!this.role.enabled) return "这个角色已停用";
    return base.configHint();
  }

  async discoverWorkspaces() {
    return [];
  }

  run(ctx: TaskRuntimeContext, input: TurnInput): Promise<void> {
    return this.baseFor(ctx.taskId).run(this.wrap(ctx), input);
  }

  continueTask(ctx: TaskRuntimeContext, input: TurnInput): Promise<void> {
    return this.baseFor(ctx.taskId).continueTask(this.wrap(ctx), input);
  }

  async stop(ctx: TaskRuntimeContext): Promise<void> {
    await this.baseFor(ctx.taskId).stop?.(ctx);
  }

  async ask(prompt: string, options?: { model?: string | null; mcpServers?: McpServerSpec[] }): Promise<string | null> {
    const base = this.baseFor(null);
    if (!base.ask) throw new Error(`「${this.role.name}」的底座 ${base.name} 不支持纯聊天`);
    const answer = await base.ask(`${buildRoleContext(this.role)}\n\n${prompt}`, { ...options, model: options?.model || this.role.model });
    return answer == null ? null : this.captureProposals(answer, null);
  }
}
