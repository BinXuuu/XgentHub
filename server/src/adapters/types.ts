import type { AgentAccountInfo, AgentKind, ApprovalDecision, FileChange, McpTransport, ModelOption, PermissionMode, RiskLevel, KnowledgeEntry } from "../types.ts";

/** 精简给 adapter 用的 MCP server 描述；name 已经按 AgentHub 的命名规则加好前缀，可以直接当 CLI 里的注册名用。 */
export interface McpServerSpec {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

// TaskManager 在执行任务时注入给 adapter 的运行时上下文。
// adapter 通过它写日志/终端输出/文件改动/发起审批，而不用直接碰数据库或事件总线。
export interface TaskRuntimeContext {
  taskId: string;
  /**
   * 这一次运行在适配器内部的标识：记正在跑的进程、对话历史、会话名都用它，不要直接用 taskId。
   * 普通的一轮等于 taskId；并行子任务是 "<taskId>:<subtaskId>"，同一个任务里同时跑两个同类 Agent 才不会互相覆盖。
   * 用 runtimeKeyOf(ctx) 取值（没设时退回 taskId）。
   */
  runtimeKey?: string;
  agentId: string;
  workspaceId: string;
  workspacePath: string;
  /** 允许 Agent 理解和访问的路径空间。第一项通常是 workspacePath，后续是网络盘/备份盘等额外路径。 */
  workspaceAccessPaths: string[];
  /** 工作区长期上下文/约束，会由 prompt engine 注入给支持工作区的 adapter。 */
  workspacePrompt: string | null;
  /** 从工作区关联的知识组里检索出的、与当前消息相关的知识条目，会由 prompt engine 以低优先级项目资料注入。 */
  workspaceKnowledge: KnowledgeEntry[];
  sessionKey: string | null;
  /** 创建任务时选定的模型（如果 adapter 支持 listModels 且用户选了的话），否则为 null 表示用 adapter 默认值。 */
  model: string | null;
  /** 创建任务时选定的权限等级，见 PermissionMode 注释。 */
  permissionMode: PermissionMode;
  /** 计划模式：这一轮只出方案不改文件。Claude Code / Codex 会用原生只读机制强制，其它 adapter 只靠提示词约束。 */
  planMode: boolean;
  /** 创建任务时选定的子 agent id（比如 OpenClaw 的 main/designer/...），不支持的 adapter 就是 null。 */
  subAgentId: string | null;
  /** 单任务预算上限，当前主要用于推荐 API 中转站的本地估算提醒。 */
  budgetLimitCny: number | null;
  /** 这一轮要带上的 MCP server（工作区配置 ∪ 角色自带，每轮实时解析）。只有 supportsMcp 的 adapter 需要读这个，其它 adapter 直接忽略。 */
  mcpServers: McpServerSpec[];

  log(message: string): void;
  terminal(chunk: string): void;
  agentMessage(content: string): void;
  fileChange(path: string, action: FileChange["action"], diff?: string): void;

  /** 发起一次审批请求；返回值在用户在审批队列里做出决定后 resolve。 */
  requestApproval(input: { command: string; cwd: string; riskLevel: RiskLevel; reason: string }): Promise<{
    decision: ApprovalDecision;
    note: string | null;
  }>;

  /**
   * 把这个任务还在等的审批全部标成"已取消"（拒绝）：Agent 进程已经没了、答复再也送不回去时用，
   * 免得审批页里留着点了也没用的按钮。只改记录，不会唤醒等待中的 requestApproval。
   */
  cancelPendingApprovals?(note: string): void;

  setStatus(status: "running" | "needs_approval" | "review" | "done" | "failed" | "stopped"): void;
  setSessionKey(sessionKey: string): void;
  /**
   * 没指定模型时，Agent 用的是它自己 CLI 的默认模型，我们事先不知道是哪个。Agent 启动后报告实际用的模型，
   * 记进这次运行（只在原来没记模型时才写），流程图等地方就能显示真实的模型名。
   */
  reportModel?(model: string): void;
}

/** 一轮对话的输入：文本 + 可选的图片附件（本机绝对路径）。 */
export interface TurnInput {
  text: string;
  images: string[];
}

export interface RoleInfo {
  roleId: string;
  icon: string;
  baseAgentId: string;
  baseAgentName: string;
  model: string | null;
  knowledgeGroupIds: string[];
  mcpServerIds: string[];
  toolIds: string[];
  skillIds: string[];
}

export interface AgentAdapter {
  readonly id?: string;
  readonly kind: AgentKind;
  readonly name: string;
  readonly description: string;
  /** 这个 adapter 能不能接 AgentHub 统一管理的 MCP server（目前只有 claude-code/codex/openclaw 真的支持）。不声明就当不支持。 */
  readonly supportsMcp?: boolean;
  /** 计划模式能否用 CLI 原生机制强制只读（claude-code 的 plan 模式、codex 的 read-only 沙箱）。不声明就只靠提示词约束。 */
  readonly enforcesPlanMode?: boolean;
  /** 只有角色（adapters/role.ts）才有：它是哪个角色、底座是谁、默认带哪些 MCP/工具/Skill。 */
  readonly roleInfo?: RoleInfo;
  /** 不指定模型时这个 Agent 实际会用的模型（.env 默认值 / Agent 自己的配置）；说不准就返回 null。 */
  defaultModel?(): string | null;
  /** 这个 Agent 当前登录的账号（目前只有 Codex 实现）。 */
  account?(): AgentAccountInfo;

  /** 是否已具备运行所需的配置/可执行文件（用于前端卡片显示“未配置”状态）。 */
  isConfigured(): boolean;
  configHint(): string;

  /** 该 adapter 能发现的本机 workspace（可选，多数依赖全局 workspace 列表，返回 []）。 */
  discoverWorkspaces(): Promise<{ name: string; path: string }[]>;

  /**
   * 该 adapter 可选的模型列表（用于新建任务时的模型下拉框）。不实现或返回 [] 就代表
   * 不支持/不需要选模型（比如 mock）；实现了但暂时探测失败也应该返回 []，不要抛错。
   */
  listModels?(): Promise<ModelOption[]>;

  /** 该 agent 的账号/订阅剩余用量摘要（人类可读文本），不支持就不实现，返回 null 也可以。 */
  getUsageSummary?(): Promise<string | null>;

  /** 该 runtime 下可选的子 agent 列表（比如 OpenClaw 的 main/designer/...）。不支持就不实现。 */
  listSubAgents?(): Promise<ModelOption[]>;

  /**
   * 一次性问答：发一段 prompt，拿到纯文本回答，不经过 Task/SSE 生命周期、不写终端/日志。
   * 用于聊天，以及"智能多 Agent 规划"里让用户选的总管家 Agent 判断子任务怎么拆、分给谁。
   * 调用失败（启动不了、连不上、超时、报错）要抛出带原因的 Error：聊天据此把这一轮标成失败并显示原因，
   * 规划会捕获后退回本地启发式兜底。只有 Agent 确实正常结束但没说话时才返回 null。
   */
  ask?(prompt: string, options?: { model?: string | null; mcpServers?: McpServerSpec[] }): Promise<string | null>;

  /** 开始一次新任务（首轮消息）。 */
  run(ctx: TaskRuntimeContext, input: TurnInput): Promise<void>;

  /** 在已有任务上继续对话。 */
  continueTask(ctx: TaskRuntimeContext, input: TurnInput): Promise<void>;

  /** 尽力停止正在运行的任务（可选）。 */
  stop?(ctx: TaskRuntimeContext): Promise<void>;
}

/** 适配器内部按"这一次运行"记状态用的 key，见 TaskRuntimeContext.runtimeKey。 */
export function runtimeKeyOf(ctx: Pick<TaskRuntimeContext, "taskId" | "runtimeKey">): string {
  return ctx.runtimeKey || ctx.taskId;
}
