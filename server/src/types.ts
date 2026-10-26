// 共享类型定义（后端内部 + 通过路由序列化给前端）

export type AgentKind =
  | "mock"
  | "openclaw"
  | "codex"
  | "claude-code"
  | "antigravity"
  | "ark-cli"
  | "hermes"
  | "ollama"
  | "tokenezgo"
  | "doubao"
  | "custom-api"
  | "custom-cli";

export type TaskStatus =
  | "running"
  | "needs_approval"
  | "review"
  | "done"
  | "failed"
  | "stopped";

export type CoreStatus = "queued" | "waiting" | "cancelled" | "timed_out" | TaskStatus;

export type RuntimeKind = "cli" | "api" | "local" | "mock" | "custom" | "unknown";

export type ArtifactKind = "file" | "diff" | "log" | "report" | "image" | "other";

export type RuntimeExecutionKind = "external-cli" | "http-api" | "local-service" | "mock";

export type ToolBoundary = "os-sandbox" | "preflight-gated" | "chat-only" | "simulated" | "user-defined";

export interface AgentRuntimeProfile {
  kind: RuntimeKind;
  executionKind: RuntimeExecutionKind;
  toolBoundary: ToolBoundary;
  canReadWorkspace: boolean;
  canWriteWorkspace: boolean;
  canExecuteCommands: boolean;
  supportsImages: boolean;
  supportsStreaming: boolean;
  supportsStop: boolean;
  supportsResume: boolean;
  defaultPermissionMode: PermissionMode;
  notes: string[];
}

export type MessageRole = "user" | "agent" | "system";

export type EventType =
  | "log"
  | "status"
  | "terminal"
  | "file"
  | "diff"
  | "message"
  | "approval_requested"
  | "approval_resolved"
  | "queue_updated";

export type DomainEventName =
  | "task.created"
  | "task.status.changed"
  | "task.message.created"
  | "task.log.created"
  | "task.terminal.chunk"
  | "task.file.changed"
  | "task.diff.created"
  | "approval.requested"
  | "approval.resolved"
  | "queue.updated"
  | "run.started"
  | "run.status.changed"
  | "run.finished"
  | "run.stopped"
  | "run.timed_out"
  | "agent.handoff.dispatched"
  | "task.workspace.changed"
  | "subtask.ready"
  | "subtask.dispatched"
  | "recovery.action.created"
  | "review.decision.created"
  | "subtask.plan.created";

export type RiskLevel = "low" | "medium" | "high";

export type ApprovalStatus = "pending" | "approved" | "denied" | "always_allowed";
export type ApprovalDecision = "approve_once" | "approve_always" | "deny";
export type NotificationLevel = "info" | "success" | "warn" | "danger";
export type MemoryKind = "task_summary";
export type RecoveryActionKind = "retry" | "human_handoff";
export type RecoveryActionStatus = "open" | "dispatched" | "resolved";
export type TaskReviewDecisionKind = "approved" | "changes_requested";
export type ButlerSignal =
  | "coding"
  | "workspace_write"
  | "command_execution"
  | "image_input"
  | "local_model"
  | "chat"
  | "research"
  | "demo";

export interface Host {
  id: string;
  name: string;
  kind: "local" | "remote";
  createdAt: string;
}

export interface Workspace {
  id: string;
  hostId: string;
  name: string;
  path: string;
  accessPaths: string[];
  allowedAgentKinds: AgentKind[];
  /** 这个工作区里的任务能用的知识组 / MCP / 工具 / Skill，统一在工作区配置，任务只读继承。 */
  knowledgeGroupIds: string[];
  mcpServerIds: string[];
  toolIds: string[];
  skillIds: string[];
  createdAt: string;
}

export interface WorkspacePrompt {
  workspaceId: string;
  content: string;
  updatedAt: string;
}

export interface KnowledgeGroup {
  id: string;
  name: string;
  description: string;
  entryCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeEntry {
  id: string;
  groupId: string;
  title: string;
  content: string;
  tags: string[];
  source: string;
  createdAt: string;
  updatedAt: string;
}

export type ResourceLibraryKind = "skill" | "tool" | "mcp";

export interface ResourceLibraryItem {
  id: string;
  kind: ResourceLibraryKind;
  title: string;
  content: string;
  tags: string[];
  command: string | null;
  groupId?: string | null;
  /** 本机已安装 Skill 的入口；正文与配套资源仍由原安装目录维护。 */
  sourcePath?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SkillGroup {
  id: string;
  name: string;
  description: string;
  source: string | null;
  skillCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ModelOption {
  id: string;
  label: string;
}

// 参考 ChatGPT/Codex 自己的"如何批准操作"三档：
// supervised（请求批准，默认）/ auto（帮我批准，只对检测到的风险操作询问）/
// full（完全访问权限，不设限，非常危险，谨慎使用）。
export type PermissionMode = "supervised" | "auto" | "full";

export interface AgentDescriptor {
  id: string;
  kind: AgentKind;
  name: string;
  description: string;
  configured: boolean;
  configHint?: string;
  custom?: boolean;
  official?: boolean;
  locked?: boolean;
  billingUrl?: string;
  billingLabel?: string;
  supportsModelSelection: boolean;
  supportsUsage: boolean;
  supportsSubAgentSelection: boolean;
  supportsMcp: boolean;
  /** 支持一次性问答（ask）：能用来聊天，也能当 AI 智能拆分的规划 Agent。 */
  supportsAsk: boolean;
  /** 不指定模型时实际用的模型；Agent 自己决定（如 Claude Code）时为 null。 */
  defaultModel: string | null;
  enforcesPlanMode: boolean;
  /** 角色才有：底座、默认配置等。普通 Agent 为 null。 */
  role: {
    roleId: string;
    icon: string;
    baseAgentId: string;
    baseAgentName: string;
    model: string | null;
    knowledgeGroupIds: string[];
    mcpServerIds: string[];
    toolIds: string[];
    skillIds: string[];
  } | null;
  runtime: AgentRuntimeProfile;
  /** 这个 Agent 登录的是哪个账号（Codex、Claude Code、Antigravity）。没有账号概念的 Agent 为 null。 */
  account: AgentAccountInfo | null;
}

/**
 * 登录方式：chatgpt = Codex 的 ChatGPT 账号；claudeai = Claude 订阅账号；google = Antigravity 的 Google 账号；
 * apikey = API Key（填了 baseUrl 就是走中转站）。
 */
export type AgentAuthMode = "chatgpt" | "claudeai" | "google" | "apikey";

export interface AgentAccountInfo {
  /** 对应的 agentId（默认账号就是内置 Agent 的 id，比如 "codex"）。 */
  id: string;
  /** 账号名：默认账号是"默认账号"，其它是添加时起的名字。 */
  name: string;
  /** 这个账号的配置目录（Codex 的 CODEX_HOME、Claude Code 的 CLAUDE_CONFIG_DIR）。 */
  home: string;
  isDefault: boolean;
  /** 能不能再添加别的账号。Antigravity 的登录存在系统凭据里，一台电脑只能有一个。 */
  supportsMultiple: boolean;
  loggedIn: boolean;
  authMode: AgentAuthMode | null;
  email: string | null;
  plan: string | null;
  /** API Key 登录时 Key 的末 4 位。 */
  apiKeyHint: string | null;
  /** 走中转站时的地址。 */
  baseUrl: string | null;
}

export interface AgentRecord {
  id: string;
  kind: AgentKind;
  name: string;
  description: string;
  runtimeKind: RuntimeKind;
  capabilities: AgentRuntimeProfile & {
    configured?: boolean;
    supportsModelSelection?: boolean;
    supportsUsage?: boolean;
    supportsSubAgentSelection?: boolean;
    official?: boolean;
    locked?: boolean;
  };
  custom: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Subtask {
  id: string;
  taskId: string;
  parentSubtaskId: string | null;
  title: string;
  status: CoreStatus;
  assignedAgentId: string | null;
  dependencyIds: string[];
  /** 自动推进计划时要发给 assignedAgentId 的 prompt（已经注入好技能资料）；人工手动派发的子任务没有这个字段。 */
  plannedPrompt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlannedSubtask {
  index: number;
  title: string;
  description: string;
  dependsOn: number[];
  /** 智能多 Agent 规划时才有值：这条子任务指派给哪个 Agent。本地启发式拆分（无 Agent 分配）时为 null。 */
  targetAgentId: string | null;
  /** 注入这条子任务 prompt 的资源库 skill 条目 id 列表。 */
  skillIds: string[];
  /** 发给目标 Agent 的最终 prompt（已注入技能资料）；本地启发式拆分时为空字符串，需要人工在派发面板里手填。 */
  prompt: string;
}

export interface SubtaskPlan {
  prompt: string;
  shouldCreate: boolean;
  confidence: number;
  reasons: string[];
  subtasks: PlannedSubtask[];
}

export type MultiAgentPlanSource = "llm" | "heuristic";

export interface MultiAgentPlan {
  prompt: string;
  source: MultiAgentPlanSource;
  plannerAgentId: string;
  subtasks: PlannedSubtask[];
  reasoning: string;
  warnings: string[];
}

export interface TaskRun {
  id: string;
  taskId: string;
  subtaskId: string | null;
  agentId: string;
  agentKind: AgentKind;
  runtimeKind: RuntimeKind;
  model: string | null;
  status: CoreStatus;
  attempt: number;
  sessionKey: string | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface Artifact {
  id: string;
  taskId: string;
  runId: string | null;
  kind: ArtifactKind;
  name: string;
  path: string | null;
  metadata: unknown;
  createdAt: string;
}

export type AgentRequestSource = "create_task" | "user_message" | "queue" | "retry" | "agent_handoff" | "subtask_dispatch";

export interface AgentRequest {
  id: string;
  taskId: string;
  sourceRunId: string | null;
  targetRunId: string | null;
  requestedAgentId: string;
  requestedAgentKind: AgentKind;
  prompt: string;
  images: string[];
  source: AgentRequestSource;
  status: CoreStatus;
  error: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface SubtaskDispatchResult {
  subtask: Subtask;
  run: TaskRun;
  request: AgentRequest;
}

export interface RunCheckpoint {
  id: string;
  runId: string;
  taskId: string;
  sequence: number;
  label: string;
  status: CoreStatus | null;
  state: unknown;
  createdAt: string;
}

export interface TaskFlowSnapshot {
  task: Task;
  subtasks: Subtask[];
  runs: TaskRun[];
  artifacts: Artifact[];
  agentRequests: AgentRequest[];
  recoveryActions: TaskRecoveryAction[];
  reviewDecisions: TaskReviewDecision[];
  runCheckpoints: Record<string, RunCheckpoint[]>;
  domainEvents: DomainEvent[];
}

export type AgentConfigFieldType = "text" | "password" | "number" | "select";

export interface AgentConfigField {
  key: string;
  label: string;
  type: AgentConfigFieldType;
  value: string;
  hasValue?: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
}

export interface AgentConfigResponse {
  agent: AgentDescriptor;
  editable: boolean;
  fields: AgentConfigField[];
  envPath: string;
  note?: string;
}

export type AgentDiagnosticStatus = "ok" | "warn" | "error";

export interface AgentDiagnosticCheck {
  label: string;
  status: AgentDiagnosticStatus;
  detail: string;
}

export interface AgentDiagnosticSummary {
  count: number;
  sample: string[];
}

export type AgentSetupActionKind = "copy_command" | "copy_value" | "config_field" | "open_url";

export interface AgentSetupAction {
  kind: AgentSetupActionKind;
  label: string;
  value?: string;
  fieldKey?: string;
  url?: string;
  description?: string;
}

export interface AgentSetupStep {
  title: string;
  status: AgentDiagnosticStatus;
  description: string;
  actions: AgentSetupAction[];
}

export interface AgentDiagnostics {
  agentId: string;
  status: AgentDiagnosticStatus;
  summary: string;
  updatedAt: string;
  checks: AgentDiagnosticCheck[];
  nextSteps: string[];
  setupSteps: AgentSetupStep[];
  models?: AgentDiagnosticSummary;
  subAgents?: AgentDiagnosticSummary;
  usage?: string | null;
}

export interface ButlerAgentScore {
  agentId: string;
  agentKind: AgentKind;
  name: string;
  configured: boolean;
  score: number;
  reasons: string[];
  blockedReasons: string[];
}

export interface ButlerIntentPlan {
  id: string;
  prompt: string;
  workspaceId: string | null;
  recommendedAgentId: string | null;
  recommendedPermissionMode: PermissionMode;
  confidence: number;
  signals: ButlerSignal[];
  reasons: string[];
  warnings: string[];
  agentScores: ButlerAgentScore[];
  createdAt: string;
}

export interface OnboardingChecklistStep {
  id: string;
  title: string;
  status: AgentDiagnosticStatus;
  description: string;
  agentIds: string[];
}

export interface OnboardingAgentReadiness {
  agent: AgentDescriptor;
  diagnostics: AgentDiagnostics;
}

export interface OnboardingOverview {
  updatedAt: string;
  counts: {
    total: number;
    ok: number;
    warn: number;
    error: number;
  };
  checklist: OnboardingChecklistStep[];
  agents: OnboardingAgentReadiness[];
}

export interface SystemCommandResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  startedAt: string;
  finishedAt: string;
}

export interface StartupTaskStatus {
  taskName: string;
  installed: boolean;
  detail: string;
}

export interface ConfigExportResult extends SystemCommandResult {
  bundlePath: string | null;
  zipPath: string | null;
}

export interface ShortcutStatus {
  desktopShortcut: string;
  desktopInstalled: boolean;
  startMenuDir: string;
  startMenuInstalled: boolean;
  installed: boolean;
}

export interface ConfigImportInput {
  bundlePath: string;
  restoreSecrets?: boolean;
  restoreDatabase?: boolean;
}

export type SystemPathKind = "root" | "logs" | "backups";

export interface SystemPathInput {
  kind: SystemPathKind;
}

export interface PostInstallCheck {
  id: string;
  title: string;
  status: AgentDiagnosticStatus;
  description: string;
}

export interface PostInstallStatus {
  updatedAt: string;
  root: string;
  logsDir: string;
  backupsDir: string;
  webUrl: string;
  checks: PostInstallCheck[];
}

export interface RemoteAccessUrl {
  name: string;
  address: string;
  url: string;
}

export interface RemoteAccessStatus {
  updatedAt: string;
  host: string;
  port: number;
  localUrl: string;
  boundForLan: boolean;
  allowLanBind: boolean;
  adminTokenConfigured: boolean;
  lanUrls: RemoteAccessUrl[];
  warnings: string[];
  notes: string[];
}

export type MachineConfigDiscoveryStatus = "configured" | "recommended" | "different" | "not_found" | "manual";

export interface MachineConfigDiscoveryItem {
  id: string;
  agentId?: string;
  label: string;
  envKey: string;
  currentValue: string;
  discoveredValue: string;
  source: string;
  status: MachineConfigDiscoveryStatus;
  note: string;
}

export interface MachineConfigDiscovery {
  updatedAt: string;
  envPath: string;
  items: MachineConfigDiscoveryItem[];
  summary: {
    configured: number;
    recommended: number;
    different: number;
    notFound: number;
    manual: number;
    applicable: number;
  };
}

export interface MachineConfigApplyInput {
  keys?: string[];
  overwrite?: boolean;
}

export interface MachineConfigApplyResult extends SystemCommandResult {
  applied: { envKey: string; value: string; previousValue: string }[];
  skipped: { envKey: string; reason: string }[];
  discovery: MachineConfigDiscovery;
}

export interface Task {
  id: string;
  agentId: string;
  agentKind: AgentKind;
  workspaceId: string;
  title: string;
  prompt: string;
  status: TaskStatus;
  sessionKey: string | null;
  model: string | null;
  permissionMode: PermissionMode;
  /** OpenClaw 之类支持"多个子 agent"的 runtime 里，选中要对话的那个子 agent id。 */
  subAgentId: string | null;
  /** 单任务预算上限，当前主要用于推荐 API 中转站的本地估算提醒。 */
  budgetLimitCny: number | null;
  /** 创建任务时确认了智能多 Agent 规划、且勾选了自动依次执行：子任务跑完一个就自动派发下一个，不需要人工逐步点确认。 */
  autoAdvancePlan: boolean;
  /** 计划模式：Agent 只调研、出方案，不改文件；用户批准后关闭并按计划执行。 */
  planMode: boolean;
  /** 这次开启计划模式的时间：只有这之后 Agent 给出过回复，才算有方案可以批准。 */
  planModeSince: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---- MCP server 统一管理（mcpServerService.ts 用）----
export type McpTransport = "stdio" | "http";

export interface McpServerDefinition {
  id: string;
  name: string;
  transport: McpTransport;
  /** stdio */
  command: string | null;
  args: string[];
  env: Record<string, string>;
  /** http */
  url: string | null;
  headers: Record<string, string>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TaskMessage {
  id: string;
  taskId: string;
  role: MessageRole;
  content: string;
  images: string[];
  createdAt: string;
}

export interface ChatConversation {
  id: string;
  agentId: string;
  agentKind: AgentKind;
  title: string;
  model: string | null;
  status: ChatStatus;
  createdAt: string;
  updatedAt: string;
}

export type ChatStatus = "idle" | "running" | "failed";

export interface ChatMessage {
  id: string;
  chatId: string;
  role: MessageRole;
  content: string;
  images: string[];
  createdAt: string;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  type: EventType;
  payload: unknown;
  createdAt: string;
}

export interface DomainEvent {
  id: string;
  name: DomainEventName;
  version: number;
  taskId: string | null;
  runId: string | null;
  legacyType: EventType | null;
  payload: unknown;
  createdAt: string;
}

export interface FileChange {
  id: string;
  taskId: string;
  path: string;
  action: "created" | "modified" | "deleted";
  diff: string | null;
  createdAt: string;
}

export interface Approval {
  id: string;
  taskId: string;
  command: string;
  cwd: string;
  riskLevel: RiskLevel;
  reason: string;
  status: ApprovalStatus;
  note: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface AlwaysAllowRule {
  id: string;
  workspaceId: string;
  agentId: string;
  pattern: string;
  createdAt: string;
}

export interface NotificationItem {
  id: string;
  level: NotificationLevel;
  title: string;
  detail: string;
  taskId: string | null;
  source: string;
  sourceKey: string;
  readAt: string | null;
  createdAt: string;
}

export interface MemoryEntry {
  id: string;
  workspaceId: string;
  taskId: string | null;
  agentId: string | null;
  kind: MemoryKind;
  title: string;
  content: string;
  metadata: unknown;
  createdAt: string;
}

export interface TaskRecoveryAction {
  id: string;
  taskId: string;
  runId: string | null;
  kind: RecoveryActionKind;
  status: RecoveryActionStatus;
  note: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface TaskReviewDecision {
  id: string;
  taskId: string;
  runId: string | null;
  decision: TaskReviewDecisionKind;
  note: string | null;
  createdAt: string;
}

export interface QueuedMessage {
  id: string;
  taskId: string;
  content: string;
  images: string[];
  position: number;
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  actor: string;
  agentId: string | null;
  taskId: string | null;
  action: string;
  detail: unknown;
  createdAt: string;
}
