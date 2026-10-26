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

export type TaskStatus = "running" | "needs_approval" | "review" | "done" | "failed" | "stopped";
export type CoreStatus = "queued" | "waiting" | "cancelled" | "timed_out" | TaskStatus;

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
  supportsAsk: boolean;
  defaultModel: string | null;
  enforcesPlanMode: boolean;
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
  /** 这个 Agent 登录的账号（Codex、Claude Code、Antigravity）。 */
  account: AgentAccountInfo | null;
}

export interface AgentAccountInfo {
  id: string;
  name: string;
  home: string;
  isDefault: boolean;
  /** 能不能再添加别的账号（Antigravity 不能）。 */
  supportsMultiple: boolean;
  loggedIn: boolean;
  authMode: "chatgpt" | "claudeai" | "google" | "apikey" | null;
  email: string | null;
  plan: string | null;
  apiKeyHint: string | null;
  /** 走中转站时的地址。 */
  baseUrl: string | null;
}

export type McpTransport = "stdio" | "http";

export interface McpServerUsageRef {
  id: string;
  title: string;
}

export interface McpServerUsage {
  workspaces: McpServerUsageRef[];
  chats: McpServerUsageRef[];
  roles: McpServerUsageRef[];
}

export interface McpServerDefinition {
  id: string;
  name: string;
  transport: McpTransport;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  headers: Record<string, string>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  /** 只有 GET /api/mcp-servers 列表接口会带这个；其它创建/更新接口的返回值里没有。 */
  usage?: McpServerUsage;
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

export interface ModelOption {
  id: string;
  label: string;
}

export interface GatewayBillingSettings {
  defaultTaskBudgetCny: number;
  monthlyBudgetCny: number;
  inputPriceCnyPer1K: number;
  outputPriceCnyPer1K: number;
  modelPriceRules: GatewayModelPriceRule[];
}

export interface GatewayModelPriceRule {
  id: string;
  label: string;
  pattern: string;
  inputPriceCnyPer1K: number;
  outputPriceCnyPer1K: number;
  enabled: boolean;
}

export interface GatewayUsageSummary {
  monthKey: string;
  recordCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostCny: number;
}

export interface GatewayUsageRecord {
  id: string;
  provider: "tokenezgo";
  taskId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostCny: number;
  budgetLimitCny: number | null;
  priceConfigured: boolean;
  budgetExceeded: boolean;
  priceRuleLabel: string;
  createdAt: string;
  note: string;
}

export interface GatewayPriceRow {
  id: string;
  label: string;
  pattern: string;
  inputPriceCnyPer1K: number;
  outputPriceCnyPer1K: number;
  configured: boolean;
  enabled: boolean;
  note: string;
}

export interface GatewayTaskUsage {
  taskId: string;
  summary: GatewayUsageSummary;
  records: GatewayUsageRecord[];
}

export interface GatewayCloudAccountStatus {
  provider: "tokenezgo";
  status: "external_only";
  signedIn: false;
  loginSupported: false;
  accountLabel: string;
  balanceLabel: string;
  billingUrl: string;
  reservedCapabilities: string[];
  notes: string[];
}

export interface GatewayOverview {
  provider: "tokenezgo";
  name: string;
  baseUrl: string;
  billingUrl: string;
  apiKeyConfigured: boolean;
  balanceMode: "external";
  balanceLabel: string;
  balanceUrl: string;
  settings: GatewayBillingSettings;
  month: GatewayUsageSummary;
  recentRecords: GatewayUsageRecord[];
  priceTable: GatewayPriceRow[];
  notices: string[];
  updatedAt: string;
}

export type PermissionMode = "supervised" | "auto" | "full";

export interface Workspace {
  id: string;
  hostId: string;
  name: string;
  path: string;
  accessPaths: string[];
  allowedAgentKinds: AgentKind[];
  knowledgeGroupIds: string[];
  mcpServerIds: string[];
  toolIds: string[];
  skillIds: string[];
  createdAt: string;
}

export interface WorkspaceResourcesInput {
  knowledgeGroupIds?: string[];
  mcpServerIds?: string[];
  toolIds?: string[];
  skillIds?: string[];
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

export interface ResourceItemView {
  id: string;
  name: string;
  sources: ("workspace" | "role")[];
}

export interface TaskResourcesView {
  workspace: { id: string; name: string } | null;
  role: { id: string; name: string } | null;
  knowledgeGroups: (ResourceItemView & { entryCount: number })[];
  mcpServers: ResourceItemView[];
  tools: ResourceItemView[];
  skills: ResourceItemView[];
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

export interface AgentRole {
  id: string;
  name: string;
  icon: string;
  description: string;
  baseAgentId: string;
  baseAgentKind: AgentKind;
  model: string | null;
  prompt: string;
  knowledgeGroupIds: string[];
  mcpServerIds: string[];
  toolIds: string[];
  skillIds: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RoleMemory {
  id: string;
  roleId: string;
  content: string;
  status: "active" | "pending";
  source: "manual" | "agent" | "message";
  taskId: string | null;
  createdAt: string;
}

export interface AgentRoleInput {
  name: string;
  icon: string;
  description: string;
  baseAgentId: string;
  model: string | null;
  prompt: string;
  knowledgeGroupIds: string[];
  mcpServerIds: string[];
  toolIds: string[];
  skillIds: string[];
}

export interface WorkspaceSnapshot {
  id: string;
  workspaceId: string;
  taskId: string;
  runId: string | null;
  messageId: string | null;
  kind: "before_run" | "before_restore";
  commitId: string;
  createdAt: string;
}

export interface RestorePreview {
  restore: string[];
  remove: string[];
  recreate: string[];
}

export interface ResourceLibraryItem {
  id: string;
  kind: ResourceLibraryKind;
  title: string;
  content: string;
  tags: string[];
  command: string | null;
  groupId?: string | null;
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

export interface SkillImportResult {
  imported: number;
  skipped: number;
  groups: number;
  warnings: string[];
}

export interface GithubSkillCandidate {
  path: string;
  name: string;
  description: string;
  files: number;
  bytes: number;
  license: string;
  openLicense: boolean | null;
  installed: boolean;
}

export interface GithubSkillPreview {
  repo: string;
  ref: string;
  commit: string;
  url: string;
  skills: GithubSkillCandidate[];
  warnings: string[];
}

export interface GithubSkillInstallResult {
  installed: number;
  updated: number;
  groupId: string | null;
  warnings: string[];
}

export interface Host {
  id: string;
  name: string;
  kind: string;
  created_at: string;
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
  subAgentId: string | null;
  budgetLimitCny: number | null;
  autoAdvancePlan: boolean;
  planMode: boolean;
  planModeSince: string | null;
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
  mcpServerIds: string[];
  toolIds: string[];
  skillIds: string[];
  knowledgeIds: string[];
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
  payload: any;
  createdAt: string;
}

export interface DomainEvent {
  id: string;
  name: DomainEventName;
  version: number;
  taskId: string | null;
  runId: string | null;
  legacyType: EventType | null;
  payload: any;
  createdAt: string;
}

export type AgentRequestSource = "create_task" | "user_message" | "queue" | "retry" | "agent_handoff" | "subtask_dispatch";

export interface Subtask {
  id: string;
  taskId: string;
  parentSubtaskId: string | null;
  title: string;
  status: CoreStatus;
  assignedAgentId: string | null;
  dependencyIds: string[];
  plannedPrompt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlannedSubtask {
  index: number;
  title: string;
  description: string;
  dependsOn: number[];
  /** 智能多 Agent 规划时才有值：这条子任务指派给哪个 Agent。本地启发式拆分时为 null。 */
  targetAgentId: string | null;
  /** 注入这条子任务 prompt 的资源库 skill 条目 id 列表。 */
  skillIds: string[];
  /** 发给目标 Agent 的最终 prompt；本地启发式拆分时为空字符串。 */
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
  metadata: any;
  createdAt: string;
}

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
  state: any;
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

export interface FileChange {
  id: string;
  taskId: string;
  path: string;
  action: "created" | "modified" | "deleted";
  diff: string | null;
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
  metadata: any;
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

export interface UpdateInfo {
  repo: string;
  currentVersion: string;
  latestVersion: string | null;
  latestTag: string | null;
  available: boolean;
  notes: string;
  mode: "archive" | "git" | "dev";
  modeReason: string | null;
  checkedAt: string;
  error: string | null;
}

export interface UpdateStatus {
  state: "idle" | "running" | "done" | "failed";
  step?: string;
  fromVersion?: string;
  toVersion?: string;
  error?: string;
  updatedAt?: string;
  log?: string;
}

export type CatalogKind = "skill" | "mcp" | "tool";

export interface CatalogInput {
  key: string;
  label: string;
  help?: string;
  placeholder?: string;
  secret?: boolean;
  required?: boolean;
  default?: string;
}

export interface CatalogItemView {
  id: string;
  sourceId: string;
  kind: CatalogKind;
  group?: string;
  version: string;
  name: string;
  summary: string;
  tags?: string[];
  license?: string;
  homepage?: string;
  source?: { type: "github"; repo: string; ref?: string; path: string };
  mcp?: { transport: "stdio" | "http"; command?: string; args?: string[]; url?: string };
  inputs?: CatalogInput[];
  status: "not_installed" | "installed" | "update";
  installedVersion: string | null;
  savedInputs: Record<string, string>;
}

export interface CatalogSourceView {
  id: string;
  name: string;
  url: string;
  hasKey: boolean;
  builtin: boolean;
  enabled: boolean;
  catalogName: string | null;
  description: string | null;
  updatedAt: string | null;
  bundled: boolean;
  error: string | null;
}

export interface CatalogView {
  sources: CatalogSourceView[];
  groups: Array<{ sourceId: string; id: string; name: string; description: string }>;
  items: CatalogItemView[];
  warnings: string[];
}

export interface CatalogInstallResult {
  kind: CatalogKind;
  targetId: string;
  action: "installed" | "updated";
  warnings: string[];
}
