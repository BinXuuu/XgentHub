import type {
  AgentDescriptor,
  AgentDiagnostics,
  AgentConfigResponse,
  AlwaysAllowRule,
  Approval,
  ApprovalDecision,
  ButlerIntentPlan,
  CreateCustomAgentInput,
  DomainEvent,
  FileChange,
  ConfigExportResult,
  ConfigImportInput,
  ChatConversation,
  ChatMessage,
  GatewayBillingSettings,
  GatewayOverview,
  GatewayTaskUsage,
  Host,
  MachineConfigApplyInput,
  MachineConfigApplyResult,
  MachineConfigDiscovery,
  McpServerDefinition,
  MemoryEntry,
  ModelOption,
  MultiAgentPlan,
  NotificationItem,
  OnboardingOverview,
  PermissionMode,
  PostInstallStatus,
  UpdateInfo,
  UpdateStatus,
  RemoteAccessStatus,
  ResourceLibraryItem,
  ResourceLibraryKind,
  SkillGroup,
  GithubSkillPreview,
  GithubSkillInstallResult,
  CatalogView,
  CatalogSourceView,
  CatalogInstallResult,
  SkillImportResult,
  QueuedMessage,
  StartupTaskStatus,
  SubtaskPlan,
  Subtask,
  SubtaskDispatchResult,
  ShortcutStatus,
  SystemCommandResult,
  SystemPathInput,
  Task,
  TaskEvent,
  TaskFlowSnapshot,
  TaskMessage,
  TaskRecoveryAction,
  TaskReviewDecision,
  Workspace,
  KnowledgeEntry,
  KnowledgeGroup,
  TaskResourcesView,
  WorkspaceResourcesInput,
  WorkspacePrompt,
  WorkspaceSnapshot,
  RestorePreview,
  AgentRole,
  AgentRoleInput,
  RoleMemory,
  AgentKind,
} from "./types";

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const UNAUTHORIZED_EVENT = "agenthub:unauthorized";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: "include",
    ...init,
    headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
  });
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    // 登录过期（或服务端会话被清掉）：通知 App 回到登录页，别让页面停在原处、所有列表都显示成空的。
    if (res.status === 401 && path !== "/login" && path !== "/session") window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new ApiError(res.status, body?.error ?? res.statusText);
  }
  return body as T;
}

function agentPath(agentId: string): string {
  return encodeURIComponent(agentId);
}

export const api = {
  getSession: () => request<{ authenticated: boolean; requiresToken: boolean }>("/session"),
  login: (token: string) => request<{ ok: boolean; error?: string }>("/login", { method: "POST", body: JSON.stringify({ token }) }),
  logout: () => request<{ ok: boolean }>("/logout", { method: "POST" }),

  listAgents: () => request<AgentDescriptor[]>("/agents"),
  listHiddenAgents: () => request<AgentDescriptor[]>("/agents/hidden"),
  restoreAgent: (agentId: string) => request<AgentDescriptor>(`/agents/${agentPath(agentId)}/restore`, { method: "POST" }),
  createCustomAgent: (input: CreateCustomAgentInput) =>
    request<AgentDescriptor>("/agents/custom", { method: "POST", body: JSON.stringify(input) }),
  deleteAgent: (agentId: string) => request<{ ok: boolean; home?: string }>(`/agents/${agentPath(agentId)}`, { method: "DELETE" }),
  createAgentAccount: (input: { kind: "codex" | "claude-code" | "codebuddy" | "deepseek-harness" | "ark-cli"; name?: string; copyConfig?: boolean }) =>
    request<AgentDescriptor>("/agents/accounts", { method: "POST", body: JSON.stringify(input) }),
  setAgentAccountNote: (agentId: string, note: string) =>
    request<AgentDescriptor>(`/agents/${agentPath(agentId)}/account-note`, { method: "PUT", body: JSON.stringify({ note }) }),
  renameAgentAccount: (agentId: string, name: string) =>
    request<AgentDescriptor>(`/agents/${agentPath(agentId)}/account`, { method: "PUT", body: JSON.stringify({ name }) }),
  agentAccountLogin: (agentId: string, input: { method: "browser" } | { method: "apikey"; apiKey: string; baseUrl?: string }) =>
    request<{ ok: boolean; message: string; opened?: boolean }>(`/agents/${agentPath(agentId)}/account-login`, { method: "POST", body: JSON.stringify(input) }),
  agentAccountLogout: (agentId: string) => request<{ ok: boolean }>(`/agents/${agentPath(agentId)}/account-logout`, { method: "POST" }),
  clearAgentApiKey: (agentId: string) => request<{ ok: boolean }>(`/agents/${agentPath(agentId)}/account-api-key`, { method: "DELETE" }),
  getAgentConfig: (agentId: string) => request<AgentConfigResponse>(`/agents/${agentPath(agentId)}/config`),
  updateAgentConfig: (agentId: string, values: Record<string, string>) =>
    request<AgentConfigResponse>(`/agents/${agentPath(agentId)}/config`, { method: "PUT", body: JSON.stringify({ values }) }),
  diagnoseAgent: (agentId: string) => request<AgentDiagnostics>(`/agents/${agentPath(agentId)}/diagnostics`),
  listModels: (agentId: string, refresh = false) =>
    request<ModelOption[]>(`/agents/${agentPath(agentId)}/models${refresh ? "?refresh=1" : ""}`),
  getAgentUsage: (agentId: string) => request<{ text: string | null }>(`/agents/${agentPath(agentId)}/usage`),
  listSubAgents: (agentId: string, refresh = false) =>
    request<ModelOption[]>(`/agents/${agentPath(agentId)}/sub-agents${refresh ? "?refresh=1" : ""}`),
  listHosts: () => request<Host[]>("/hosts"),
  listWorkspaces: () => request<Workspace[]>("/workspaces"),
  getWorkspacePrompt: (id: string) => request<WorkspacePrompt>(`/workspaces/${id}/prompt`),
  updateWorkspacePrompt: (id: string, content: string) =>
    request<WorkspacePrompt>(`/workspaces/${id}/prompt`, { method: "PUT", body: JSON.stringify({ content }) }),
  updateWorkspaceAccessPaths: (id: string, paths: string[]) =>
    request<Workspace>(`/workspaces/${id}/access-paths`, { method: "PUT", body: JSON.stringify({ paths }) }),
  updateWorkspaceResources: (id: string, input: WorkspaceResourcesInput) =>
    request<Workspace>(`/workspaces/${id}/resources`, { method: "PUT", body: JSON.stringify(input) }),
  listKnowledgeGroups: () => request<KnowledgeGroup[]>("/knowledge-groups"),
  createKnowledgeGroup: (input: { name: string; description?: string }) =>
    request<KnowledgeGroup>("/knowledge-groups", { method: "POST", body: JSON.stringify(input) }),
  updateKnowledgeGroup: (id: string, input: { name: string; description?: string }) =>
    request<KnowledgeGroup>(`/knowledge-groups/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteKnowledgeGroup: (id: string) => request<{ ok: boolean }>(`/knowledge-groups/${id}`, { method: "DELETE" }),
  listKnowledge: (input: { groupId?: string; query?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (input.groupId) params.set("groupId", input.groupId);
    if (input.query) params.set("query", input.query);
    if (input.limit) params.set("limit", String(input.limit));
    const query = params.toString();
    return request<KnowledgeEntry[]>(`/knowledge${query ? `?${query}` : ""}`);
  },
  createKnowledge: (input: { groupId: string; title: string; content: string; tags?: string[]; source?: string }) =>
    request<KnowledgeEntry>("/knowledge", { method: "POST", body: JSON.stringify(input) }),
  updateKnowledge: (id: string, input: { groupId: string; title: string; content: string; tags?: string[] }) =>
    request<KnowledgeEntry>(`/knowledge/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteKnowledge: (id: string) => request<{ ok: boolean }>(`/knowledge/${id}`, { method: "DELETE" }),
  listResourceLibraryItems: (kind: ResourceLibraryKind, input: { query?: string } = {}) => {
    const params = new URLSearchParams();
    if (input.query) params.set("query", input.query);
    const query = params.toString();
    return request<ResourceLibraryItem[]>(`/resource-library/${kind}${query ? `?${query}` : ""}`);
  },
  listSkillGroups: () => request<SkillGroup[]>("/skill-groups"),
  createSkillGroup: (input: { name: string; description?: string }) => request<SkillGroup>("/skill-groups", { method: "POST", body: JSON.stringify(input) }),
  updateSkillGroup: (id: string, input: { name: string; description?: string }) => request<SkillGroup>(`/skill-groups/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteSkillGroup: (id: string) => request<{ ok: boolean }>(`/skill-groups/${encodeURIComponent(id)}`, { method: "DELETE" }),
  moveSkillsToGroup: (ids: string[], groupId: string | null) => request<{ ok: boolean }>("/skill-group-members", { method: "PUT", body: JSON.stringify({ ids, groupId }) }),
  importInstalledSkills: () => request<SkillImportResult>("/skills/import-installed", { method: "POST" }),
  previewGithubSkills: (url: string) => request<GithubSkillPreview>("/skills/github/preview", { method: "POST", body: JSON.stringify({ url }) }),
  installGithubSkills: (input: { url: string; paths: string[]; groupId: string | null }) =>
    request<GithubSkillInstallResult>("/skills/github/install", { method: "POST", body: JSON.stringify(input) }),
  getCatalog: (refresh = false) => request<CatalogView>(`/catalog${refresh ? "?refresh=1" : ""}`),
  installCatalogItem: (input: { sourceId: string; itemId: string; inputs?: Record<string, string>; force?: boolean }) =>
    request<CatalogInstallResult>("/catalog/install", { method: "POST", body: JSON.stringify(input) }),
  addCatalogSource: (input: { name?: string; url: string; key?: string }) =>
    request<CatalogSourceView>("/catalog/sources", { method: "POST", body: JSON.stringify(input) }),
  updateCatalogSource: (id: string, input: { name?: string; url?: string; key?: string | null; enabled?: boolean }) =>
    request<CatalogSourceView>(`/catalog/sources/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteCatalogSource: (id: string) => request<{ ok: boolean }>(`/catalog/sources/${encodeURIComponent(id)}`, { method: "DELETE" }),
  createResourceLibraryItem: (
    kind: ResourceLibraryKind,
    input: { title: string; content: string; tags?: string[]; command?: string | null; groupId?: string | null }
  ) => request<ResourceLibraryItem>(`/resource-library/${kind}`, { method: "POST", body: JSON.stringify(input) }),
  updateResourceLibraryItem: (
    kind: ResourceLibraryKind,
    id: string,
    input: { title: string; content: string; tags?: string[]; command?: string | null; groupId?: string | null }
  ) => request<ResourceLibraryItem>(`/resource-library/${kind}/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteResourceLibraryItem: (kind: ResourceLibraryKind, id: string) =>
    request<{ ok: boolean }>(`/resource-library/${kind}/${encodeURIComponent(id)}`, { method: "DELETE" }),
  listMcpServers: () => request<McpServerDefinition[]>("/mcp-servers"),
  createMcpServer: (input: {
    name: string;
    transport: "stdio" | "http";
    command?: string | null;
    args?: string[];
    env?: Record<string, string>;
    url?: string | null;
    headers?: Record<string, string>;
    enabled?: boolean;
  }) => request<McpServerDefinition>("/mcp-servers", { method: "POST", body: JSON.stringify(input) }),
  updateMcpServer: (
    id: string,
    input: Partial<{
      name: string;
      transport: "stdio" | "http";
      command: string | null;
      args: string[];
      env: Record<string, string>;
      url: string | null;
      headers: Record<string, string>;
      enabled: boolean;
    }>
  ) => request<McpServerDefinition>(`/mcp-servers/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteMcpServer: (id: string) => request<{ ok: boolean }>(`/mcp-servers/${encodeURIComponent(id)}`, { method: "DELETE" }),
  testMcpServer: (input: {
    name?: string;
    transport: "stdio" | "http";
    command?: string | null;
    args?: string[];
    env?: Record<string, string>;
    url?: string | null;
    headers?: Record<string, string>;
  }) => request<{ ok: boolean; message: string }>("/mcp-servers/test", { method: "POST", body: JSON.stringify(input) }),
  planButlerIntent: (input: { prompt: string; workspaceId?: string | null; imageCount?: number }) =>
    request<ButlerIntentPlan>("/butler/intent", { method: "POST", body: JSON.stringify(input) }),
  listButlerIntents: (limit?: number) => request<ButlerIntentPlan[]>(`/butler/intents${limit ? `?limit=${limit}` : ""}`),
  createWorkspace: (input: { name?: string; path: string; allowedAgentKinds: AgentKind[]; accessPaths?: string[] }) =>
    request<Workspace>("/workspaces", { method: "POST", body: JSON.stringify(input) }),
  deleteWorkspace: (id: string) => request<{ ok: boolean }>(`/workspaces/${id}`, { method: "DELETE" }),
  pickFolder: () => request<{ path: string | null }>("/workspaces/pick-folder", { method: "POST" }),

  listTasks: () => request<Task[]>("/tasks"),
  listChats: () => request<ChatConversation[]>("/chats"),
  createChat: (input: { agentId: string; title: string; model?: string; mcpServerIds?: string[] }) =>
    request<ChatConversation>("/chats", { method: "POST", body: JSON.stringify(input) }),
  getChat: (id: string) => request<ChatConversation>(`/chats/${id}`),
  renameChat: (id: string, title: string) =>
    request<ChatConversation>(`/chats/${id}`, { method: "PUT", body: JSON.stringify({ title }) }),
  updateChatModel: (id: string, model: string | null) =>
    request<ChatConversation>(`/chats/${id}/model`, { method: "PUT", body: JSON.stringify({ model }) }),
  setChatMcpServers: (id: string, mcpServerIds: string[]) =>
    request<ChatConversation>(`/chats/${id}/mcp-servers`, { method: "PUT", body: JSON.stringify({ mcpServerIds }) }),
  setChatTools: (id: string, toolIds: string[]) =>
    request<ChatConversation>(`/chats/${id}/tools`, { method: "PUT", body: JSON.stringify({ toolIds }) }),
  setChatSkills: (id: string, skillIds: string[]) =>
    request<ChatConversation>(`/chats/${id}/skills`, { method: "PUT", body: JSON.stringify({ skillIds }) }),
  setChatKnowledge: (id: string, knowledgeIds: string[]) =>
    request<ChatConversation>(`/chats/${id}/knowledge`, { method: "PUT", body: JSON.stringify({ knowledgeIds }) }),
  updateChatAgent: (id: string, agentId: string) =>
    request<ChatConversation>(`/chats/${id}/agent`, { method: "PUT", body: JSON.stringify({ agentId }) }),
  deleteChat: (id: string) => request<{ ok: boolean }>(`/chats/${id}`, { method: "DELETE" }),
  listChatMessages: (chatId: string) => request<ChatMessage[]>(`/chats/${chatId}/messages`),
  sendChatMessage: (chatId: string, message: string, images?: string[]) =>
    request<{ userMessage: ChatMessage; agentMessage: ChatMessage }>(`/chats/${chatId}/messages`, {
      method: "POST",
      body: JSON.stringify({ message, images }),
    }),
  planSubtasks: (prompt: string) => request<SubtaskPlan>("/tasks/plan-subtasks", { method: "POST", body: JSON.stringify({ prompt }) }),
  planMultiAgentTask: (input: { prompt: string; workspaceId?: string | null; plannerAgentId: string }) =>
    request<MultiAgentPlan>("/tasks/plan-multi-agent", { method: "POST", body: JSON.stringify(input) }),
  getTask: (id: string) => request<Task>(`/tasks/${id}`),
  renameTask: (id: string, title: string) =>
    request<Task>(`/tasks/${id}/title`, { method: "PUT", body: JSON.stringify({ title }) }),
  createTask: (input: {
    agentId: string;
    workspaceId: string;
    title: string;
    prompt?: string;
    images?: string[];
    model?: string;
    permissionMode?: PermissionMode;
    subAgentId?: string;
    budgetLimitCny?: number | null;
    autoPlanSubtasks?: boolean;
    multiAgentPlan?: MultiAgentPlan;
    autoAdvancePlan?: boolean;
    /** AI 智能拆分：第一条需求到了再拆，只分给这些 Agent / 角色。 */
    splitAgentPool?: string[];
    planMode?: boolean;
  }) =>
    request<Task>("/tasks", { method: "POST", body: JSON.stringify(input) }),
  changeTaskWorkspace: (taskId: string, input: { workspaceId: string; confirmed?: boolean }) =>
    request<Task>(`/tasks/${taskId}/workspace`, { method: "PUT", body: JSON.stringify(input) }),
  setAutoAdvancePlan: (taskId: string, enabled: boolean) =>
    request<Task>(`/tasks/${taskId}/auto-advance-plan`, { method: "PUT", body: JSON.stringify({ enabled }) }),
  getTaskResources: (taskId: string) => request<TaskResourcesView>(`/tasks/${taskId}/resources`),
  setTaskPlanMode: (taskId: string, enabled: boolean) =>
    request<Task>(`/tasks/${taskId}/plan-mode`, { method: "PUT", body: JSON.stringify({ enabled }) }),
  approveTaskPlan: (taskId: string) => request<Task>(`/tasks/${taskId}/plan/approve`, { method: "POST" }),
  listRoles: () => request<AgentRole[]>("/roles"),
  createRole: (input: AgentRoleInput) => request<AgentRole>("/roles", { method: "POST", body: JSON.stringify(input) }),
  updateRole: (id: string, input: AgentRoleInput) => request<AgentRole>(`/roles/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  setRoleEnabled: (id: string, enabled: boolean) =>
    request<AgentRole>(`/roles/${id}/enabled`, { method: "PUT", body: JSON.stringify({ enabled }) }),
  deleteRole: (id: string) => request<{ ok: boolean }>(`/roles/${id}`, { method: "DELETE" }),
  listRoleMemories: (roleId: string) => request<RoleMemory[]>(`/roles/${roleId}/memories`),
  addRoleMemory: (roleId: string, input: { content: string; source?: "manual" | "message"; taskId?: string | null }) =>
    request<RoleMemory>(`/roles/${roleId}/memories`, { method: "POST", body: JSON.stringify(input) }),
  approveRoleMemory: (roleId: string, memoryId: string) =>
    request<RoleMemory>(`/roles/${roleId}/memories/${memoryId}/approve`, { method: "POST" }),
  deleteRoleMemory: (roleId: string, memoryId: string) =>
    request<{ ok: boolean }>(`/roles/${roleId}/memories/${memoryId}`, { method: "DELETE" }),
  listTaskSnapshots: (taskId: string) => request<WorkspaceSnapshot[]>(`/tasks/${taskId}/snapshots`),
  previewSnapshotRestore: (taskId: string, snapshotId: string) =>
    request<RestorePreview>(`/tasks/${taskId}/snapshots/${snapshotId}/preview`),
  restoreSnapshot: (taskId: string, snapshotId: string) =>
    request<{ preview: RestorePreview }>(`/tasks/${taskId}/snapshots/${snapshotId}/restore`, { method: "POST" }),
  setTaskModel: (taskId: string, model: string | null) =>
    request<Task>(`/tasks/${taskId}/model`, { method: "PUT", body: JSON.stringify({ model }) }),
  listMessages: (taskId: string) => request<TaskMessage[]>(`/tasks/${taskId}/messages`),
  listEvents: (taskId: string) => request<TaskEvent[]>(`/tasks/${taskId}/events`),
  listDomainEvents: (taskId: string) => request<DomainEvent[]>(`/tasks/${taskId}/domain-events`),
  getTaskFlow: (taskId: string) => request<TaskFlowSnapshot>(`/tasks/${taskId}/flow`),
  listRunnableSubtasks: (taskId: string) => request<Subtask[]>(`/tasks/${taskId}/subtasks/runnable`),
  dispatchNextSubtask: (
    taskId: string,
    input: { agentId?: string | null; prompt?: string | null; model?: string | null; images?: string[] }
  ) => request<SubtaskDispatchResult>(`/tasks/${taskId}/subtasks/dispatch-next`, { method: "POST", body: JSON.stringify(input) }),
  sendMessage: (taskId: string, message: string, images?: string[]) =>
    request<{ ok: boolean }>(`/tasks/${taskId}/messages`, { method: "POST", body: JSON.stringify({ message, images }) }),
  stopTask: (taskId: string) => request<{ ok: boolean }>(`/tasks/${taskId}/stop`, { method: "POST" }),
  retryTask: (taskId: string, note?: string) =>
    request<TaskRecoveryAction>(`/tasks/${taskId}/retry`, { method: "POST", body: JSON.stringify({ note }) }),
  redoSubtask: (taskId: string, subtaskId: string, input: { note?: string; agentId?: string | null }) =>
    request<TaskRecoveryAction>(`/tasks/${taskId}/subtasks/${encodeURIComponent(subtaskId)}/redo`, { method: "POST", body: JSON.stringify(input) }),
  handoffTask: (taskId: string, note?: string) =>
    request<TaskRecoveryAction>(`/tasks/${taskId}/handoff`, { method: "POST", body: JSON.stringify({ note }) }),
  dispatchAgentHandoff: (
    taskId: string,
    input: { agentId: string; prompt: string; subtaskId?: string | null; model?: string | null; images?: string[] }
  ) => request<{ ok: boolean }>(`/tasks/${taskId}/agent-handoff`, { method: "POST", body: JSON.stringify(input) }),
  listReviewDecisions: (taskId: string) => request<TaskReviewDecision[]>(`/tasks/${taskId}/reviews`),
  approveTaskReview: (taskId: string, note?: string) =>
    request<TaskReviewDecision>(`/tasks/${taskId}/review/approve`, { method: "POST", body: JSON.stringify({ note }) }),
  requestTaskChanges: (taskId: string, note: string) =>
    request<TaskReviewDecision>(`/tasks/${taskId}/review/request-changes`, { method: "POST", body: JSON.stringify({ note }) }),
  deleteTask: (taskId: string) => request<{ ok: boolean }>(`/tasks/${taskId}`, { method: "DELETE" }),
  getFiles: (taskId: string) => request<FileChange[]>(`/tasks/${taskId}/files`),
  getDiff: (taskId: string) => request<{ diff: string }>(`/tasks/${taskId}/diff`),

  listApprovals: (taskId?: string) => request<Approval[]>(taskId ? `/tasks/${taskId}/approvals` : "/approvals"),
  decideApproval: (approvalId: string, taskId: string, decision: ApprovalDecision, note?: string) =>
    request<Approval>(`/approvals/${approvalId}/decide`, {
      method: "POST",
      body: JSON.stringify({ taskId, decision, note }),
    }),
  listApprovalRules: () => request<AlwaysAllowRule[]>("/approval-rules"),
  deleteApprovalRule: (id: string) => request<{ ok: boolean }>(`/approval-rules/${id}`, { method: "DELETE" }),

  listNotifications: (input: { unreadOnly?: boolean; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (input.unreadOnly) params.set("unreadOnly", "1");
    if (input.limit) params.set("limit", String(input.limit));
    const query = params.toString();
    return request<NotificationItem[]>(`/notifications${query ? `?${query}` : ""}`);
  },
  markNotificationRead: (id: string) => request<NotificationItem>(`/notifications/${id}/read`, { method: "POST" }),
  markAllNotificationsRead: () => request<{ count: number }>("/notifications/read-all", { method: "POST" }),
  listMemory: (input: { workspaceId?: string; taskId?: string; agentId?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (input.workspaceId) params.set("workspaceId", input.workspaceId);
    if (input.taskId) params.set("taskId", input.taskId);
    if (input.agentId) params.set("agentId", input.agentId);
    if (input.limit) params.set("limit", String(input.limit));
    const query = params.toString();
    return request<MemoryEntry[]>(`/memory${query ? `?${query}` : ""}`);
  },
  listRecoveryActions: (taskId: string) => request<TaskRecoveryAction[]>(`/tasks/${taskId}/recovery`),

  listQueue: (taskId: string) => request<QueuedMessage[]>(`/tasks/${taskId}/queue`),
  enqueueMessage: (taskId: string, content: string, images?: string[]) =>
    request<QueuedMessage>(`/tasks/${taskId}/queue`, { method: "POST", body: JSON.stringify({ content, images }) }),
  removeQueueItem: (taskId: string, itemId: string) =>
    request<{ ok: boolean }>(`/tasks/${taskId}/queue/${itemId}`, { method: "DELETE" }),
  reorderQueue: (taskId: string, orderedIds: string[]) =>
    request<QueuedMessage[]>(`/tasks/${taskId}/queue/reorder`, { method: "PUT", body: JSON.stringify({ orderedIds }) }),

  uploadAttachment: (filename: string, dataBase64: string) =>
    request<{ path: string }>("/attachments", { method: "POST", body: JSON.stringify({ filename, dataBase64 }) }),

  getOfficialGatewayOverview: (refresh = false) => request<GatewayOverview>(`/gateway/official/overview${refresh ? "?refresh=1" : ""}`),
  updateOfficialGatewaySettings: (settings: Partial<GatewayBillingSettings>) =>
    request<GatewayOverview>("/gateway/official/settings", { method: "PUT", body: JSON.stringify({ settings }) }),
  getOfficialGatewayTaskUsage: (taskId: string) => request<GatewayTaskUsage>(`/gateway/official/tasks/${taskId}/usage`),

  getOnboardingOverview: () => request<OnboardingOverview>("/onboarding/overview"),
  runDoctor: () => request<SystemCommandResult>("/system/doctor", { method: "POST", body: JSON.stringify({}) }),
  exportSafeConfig: () => request<ConfigExportResult>("/system/config-export", { method: "POST", body: JSON.stringify({}) }),
  importConfig: (input: ConfigImportInput) => request<SystemCommandResult>("/system/config-import", { method: "POST", body: JSON.stringify(input) }),
  pickConfigBundle: () => request<{ path: string | null }>("/system/config-pick-bundle", { method: "POST", body: JSON.stringify({}) }),
  getMachineConfigDiscovery: () => request<MachineConfigDiscovery>("/system/machine-config-discovery"),
  applyMachineConfig: (input: MachineConfigApplyInput) =>
    request<MachineConfigApplyResult>("/system/machine-config-apply", { method: "POST", body: JSON.stringify(input) }),
  getPostInstallStatus: () => request<PostInstallStatus>("/system/post-install"),
  getUpdateInfo: (force = false) => request<UpdateInfo>(`/system/update${force ? "?force=1" : ""}`),
  startUpdate: () => request<{ started: true; fromVersion: string; toVersion: string }>("/system/update", { method: "POST" }),
  getUpdateStatus: () => request<UpdateStatus>("/system/update/status"),
  getRemoteAccessStatus: () => request<RemoteAccessStatus>("/system/remote-access"),
  restartAgentHub: () => request<SystemCommandResult>("/system/restart", { method: "POST", body: JSON.stringify({}) }),
  openSystemPath: (input: SystemPathInput) => request<SystemCommandResult>("/system/open-path", { method: "POST", body: JSON.stringify(input) }),
  getStartupTaskStatus: () => request<StartupTaskStatus>("/system/startup-task"),
  installStartupTask: () => request<SystemCommandResult>("/system/startup-task", { method: "POST", body: JSON.stringify({}) }),
  uninstallStartupTask: () => request<SystemCommandResult>("/system/startup-task", { method: "DELETE" }),
  getShortcutStatus: () => request<ShortcutStatus>("/system/shortcuts"),
  installShortcuts: () => request<SystemCommandResult>("/system/shortcuts", { method: "POST", body: JSON.stringify({}) }),
  uninstallShortcuts: () => request<SystemCommandResult>("/system/shortcuts", { method: "DELETE" }),
};

export { ApiError };
