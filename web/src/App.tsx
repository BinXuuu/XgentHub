import { useCallback, useEffect, useState } from "react";
import { api, UNAUTHORIZED_EVENT } from "./api/client";
import { Login } from "./pages/Login";
import { NavRail, BottomNav, type NavView } from "./components/NavRail";
import { ApprovalAlerts } from "./components/ApprovalAlerts";
import { Dashboard } from "./components/Dashboard";
import { Sidebar } from "./components/Sidebar";
import { ChatList } from "./components/ChatList";
import { ChatDetail } from "./components/ChatDetail";
import { NewChatModal } from "./components/NewChatModal";
import { TaskList } from "./components/TaskList";
import type { Filter } from "./components/TaskList";
import { TaskDetail } from "./components/TaskDetail";
import { NewTaskModal } from "./components/NewTaskModal";
import { AgentConfigPanel } from "./components/AgentConfigPanel";
import { AgentCreatePanel } from "./components/AgentCreatePanel";
import { OnboardingPanel } from "./components/OnboardingPanel";
import { WorkspaceDetailPanel } from "./components/WorkspaceDetailPanel";
import { ResourceCenter } from "./components/ResourceCenter";
import { useSSE } from "./hooks/useSSE";
import { RolePanel } from "./components/RolePanel";
import type {
  AgentDescriptor,
  AgentRole,
  ChatConversation,
  Host,
  Task,
  TaskStatus,
  Workspace,
} from "./api/types";

type OnboardingStepId = "doctor" | "migration" | "machine" | "agents" | "startup" | "test" | "finish";
const ONBOARDING_SEEN_KEY = "xgent-hub:onboarding-seen:v1";
// 角色编辑器借用 selectedAgentId 打开（"role-editor:<id>" 或 "role-editor:new"），这样所有"关掉详情"的地方都不用再多管一个状态。
const ROLE_EDITOR_PREFIX = "role-editor:";
const ONBOARDING_STEPS = new Set<OnboardingStepId>(["doctor", "migration", "machine", "agents", "startup", "test", "finish"]);

function hasSeenOnboarding(): boolean {
  try {
    return window.localStorage.getItem(ONBOARDING_SEEN_KEY) === "true";
  } catch {
    return true;
  }
}

function markOnboardingSeen(): void {
  try {
    window.localStorage.setItem(ONBOARDING_SEEN_KEY, "true");
  } catch {
    // localStorage 不可用时静默失败
  }
}

function readOnboardingDeepLink(): OnboardingStepId | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const view = params.get("view");
    const step = params.get("step");
    if (view !== "onboarding") return null;
    if (step && ONBOARDING_STEPS.has(step as OnboardingStepId)) return step as OnboardingStepId;
    return "doctor";
  } catch {
    return null;
  }
}

function clearOnboardingDeepLink(): void {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("view");
    url.searchParams.delete("step");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // URL rewriting is best-effort.
  }
}

export default function App() {
  const [sessionChecked, setSessionChecked] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [requiresToken, setRequiresToken] = useState(true);

  useEffect(() => {
    api
      .getSession()
      .then((s) => {
        setAuthenticated(s.authenticated);
        setRequiresToken(s.requiresToken);
      })
      .finally(() => setSessionChecked(true));
  }, []);

  useEffect(() => {
    const onUnauthorized = () => setAuthenticated(false);
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  if (!sessionChecked) return null;
  if (requiresToken && !authenticated) {
    return <Login onLoggedIn={() => setAuthenticated(true)} />;
  }
  return <DashboardShell />;
}

function DashboardShell() {
  const [agents, setAgents] = useState<AgentDescriptor[]>([]);
  const [roles, setRoles] = useState<AgentRole[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [chats, setChats] = useState<ChatConversation[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [showAgentCreator, setShowAgentCreator] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardingInitialStep, setOnboardingInitialStep] = useState<OnboardingStepId>("doctor");
  const [showSetupPrompt, setShowSetupPrompt] = useState(false);
  const [initialDataReady, setInitialDataReady] = useState(false);
  const [showNewChat, setShowNewChat] = useState(false);
  const [showNewTask, setShowNewTask] = useState(false);
  const [navView, setNavView] = useState<NavView>("dashboard");

  const refreshAgents = useCallback(() => {
    return Promise.all([api.listAgents().then(setAgents), api.listRoles().then(setRoles)]).catch(console.error);
  }, []);

  const refreshTasks = useCallback(() => {
    return api.listTasks().then(setTasks).catch(console.error);
  }, []);

  const refreshChats = useCallback(() => {
    return api.listChats().then(setChats).catch(console.error);
  }, []);

  const refreshWorkspaces = useCallback(() => {
    return api.listWorkspaces().then(setWorkspaces).catch(console.error);
  }, []);

  useEffect(() => {
    Promise.all([
      refreshAgents(),
      api.listHosts().then(setHosts).catch(console.error),
      refreshWorkspaces(),
      refreshChats(),
      refreshTasks(),
    ]).finally(() => setInitialDataReady(true));
  }, [refreshAgents, refreshChats, refreshTasks, refreshWorkspaces]);

  useEffect(() => {
    if (!initialDataReady || hasSeenOnboarding()) return;
    if (tasks.length === 0) {
      markOnboardingSeen();
      setSelectedAgentId(null);
      setSelectedWorkspaceId(null);
      setSelectedChatId(null);
      setSelectedTaskId(null);
      setShowAgentCreator(false);
      setShowOnboarding(true);
      setNavView("agents");
      return;
    }
    setShowSetupPrompt(true);
  }, [initialDataReady, tasks.length]);

  useEffect(() => {
    if (!initialDataReady) return;
    const step = readOnboardingDeepLink();
    if (!step) return;
    markOnboardingSeen();
    setOnboardingInitialStep(step);
    setSelectedAgentId(null);
    setSelectedWorkspaceId(null);
    setSelectedChatId(null);
    setSelectedTaskId(null);
    setShowAgentCreator(false);
    setShowOnboarding(true);
    setShowSetupPrompt(false);
    setNavView("agents");
    clearOnboardingDeepLink();
  }, [initialDataReady]);

  useSSE(`/api/dashboard/stream`, "dashboard_event", () => {
    refreshTasks();
  });

  useEffect(() => {
    if (!chats.some((chat) => chat.status === "running")) return;
    const timer = window.setInterval(() => {
      refreshChats();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [chats, refreshChats]);

  function selectTask(id: string) {
    setSelectedTaskId(id);
    setSelectedChatId(null);
    setSelectedAgentId(null);
    setSelectedWorkspaceId(null);
    setShowAgentCreator(false);
    setShowOnboarding(false);
    setShowSetupPrompt(false);
    setNavView("tasks");
  }

  function selectChat(id: string) {
    setSelectedChatId(id);
    setSelectedTaskId(null);
    setSelectedAgentId(null);
    setSelectedWorkspaceId(null);
    setShowAgentCreator(false);
    setShowOnboarding(false);
    setShowSetupPrompt(false);
    setNavView("chats");
  }

  function openTasks(filterValue?: Filter) {
    if (filterValue) setFilter(filterValue);
    setNavView("tasks");
  }

  function changeNavView(view: NavView) {
    setNavView(view);
    if (view !== "chats") setSelectedChatId(null);
    if (view !== "tasks") setSelectedTaskId(null);
    if (view !== "agents") {
      setSelectedAgentId(null);
      setSelectedWorkspaceId(null);
      setShowAgentCreator(false);
      setShowOnboarding(false);
    }
    if (view !== "agents") setShowSetupPrompt(false);
  }

  function selectAgent(id: string) {
    setSelectedAgentId(id);
    setSelectedWorkspaceId(null);
    setSelectedChatId(null);
    setSelectedTaskId(null);
    setShowAgentCreator(false);
    setShowOnboarding(false);
    setShowSetupPrompt(false);
    setNavView("agents");
  }

  function createAgent() {
    setSelectedAgentId(null);
    setSelectedWorkspaceId(null);
    setSelectedChatId(null);
    setSelectedTaskId(null);
    setShowAgentCreator(true);
    setShowOnboarding(false);
    setShowSetupPrompt(false);
    setNavView("agents");
  }

  function openOnboarding(step: OnboardingStepId = "doctor") {
    markOnboardingSeen();
    setOnboardingInitialStep(step);
    setShowSetupPrompt(false);
    setSelectedAgentId(null);
    setSelectedWorkspaceId(null);
    setSelectedChatId(null);
    setSelectedTaskId(null);
    setShowAgentCreator(false);
    setShowOnboarding(true);
    setNavView("agents");
  }

  function handleTaskDeleted(deletedTaskId?: string) {
    if (!deletedTaskId || selectedTaskId === deletedTaskId) setSelectedTaskId(null);
    setNavView("tasks");
    refreshTasks();
  }

  function handleChatDeleted(deletedChatId?: string) {
    if (!deletedChatId || selectedChatId === deletedChatId) setSelectedChatId(null);
    setNavView("chats");
    refreshChats();
  }

  function handleAgentDeleted() {
    setSelectedAgentId(null);
    setSelectedWorkspaceId(null);
    setShowAgentCreator(false);
    setShowOnboarding(false);
    setShowSetupPrompt(false);
    setNavView("dashboard");
    refreshAgents();
  }

  function dismissSetupPrompt() {
    markOnboardingSeen();
    setShowSetupPrompt(false);
  }

  function selectWorkspace(id: string) {
    setSelectedWorkspaceId(id);
    setSelectedAgentId(null);
    setSelectedChatId(null);
    setSelectedTaskId(null);
    setShowAgentCreator(false);
    setShowOnboarding(false);
    setShowSetupPrompt(false);
    setNavView("agents");
  }

  function openWorkspaceFromResource(id: string) {
    setSelectedWorkspaceId(id);
    setSelectedAgentId(null);
    setSelectedChatId(null);
    setSelectedTaskId(null);
    setShowAgentCreator(false);
    setShowOnboarding(false);
    setShowSetupPrompt(false);
    setNavView("agents");
  }

  // 任务/新建任务里点"去工作区修改"：打开工作区详情并滚到"可用资源"那一节。
  function openWorkspaceResources(id: string) {
    openWorkspaceFromResource(id);
    window.setTimeout(() => document.getElementById("workspace-resources")?.scrollIntoView({ block: "start" }), 120);
  }

  const selectedAgent = agents.find((a) => a.id === selectedAgentId) ?? null;
  const roleEditorId = selectedAgentId?.startsWith(ROLE_EDITOR_PREFIX) ? selectedAgentId.slice(ROLE_EDITOR_PREFIX.length) : null;
  const editingRole = roleEditorId && roleEditorId !== "new" ? roles.find((role) => role.id === roleEditorId) ?? null : null;
  const selectedWorkspace = workspaces.find((w) => w.id === selectedWorkspaceId) ?? null;
  const agentDetailOpen = navView === "agents" && (Boolean(selectedAgentId) || Boolean(selectedWorkspaceId) || showAgentCreator || showOnboarding);
  const mobileDetailOpen = Boolean(selectedTaskId) || Boolean(selectedChatId) || agentDetailOpen;

  useEffect(() => {
    if (selectedWorkspaceId && !workspaces.some((workspace) => workspace.id === selectedWorkspaceId)) {
      setSelectedWorkspaceId(null);
    }
  }, [selectedWorkspaceId, workspaces]);

  useEffect(() => {
    if (selectedChatId && !chats.some((chat) => chat.id === selectedChatId)) {
      setSelectedChatId(null);
    }
  }, [selectedChatId, chats]);

  // 任务状态计数
  const taskCounts = tasks.reduce(
    (acc, t) => {
      acc[t.status] = (acc[t.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<TaskStatus, number>
  );

  // 主内容区：agents 视图
  function renderAgentsView() {
    return (
      <>
        <div className="secondary-sidebar">
          <Sidebar
            hosts={hosts}
            workspaces={workspaces}
            agents={agents}
            selectedAgentId={selectedAgentId}
            selectedWorkspaceId={selectedWorkspaceId}
            onAgentSelected={selectAgent}
            onWorkspaceSelected={selectWorkspace}
            onCreateAgentRequested={createAgent}
            onWorkspacesChanged={refreshWorkspaces}
            roles={roles}
            selectedRoleId={roleEditorId}
            onRoleSelected={(roleId) => selectAgent(`${ROLE_EDITOR_PREFIX}${roleId}`)}
            onCreateRoleRequested={() => selectAgent(`${ROLE_EDITOR_PREFIX}new`)}
          />
        </div>
        <div className="main-area">
          {showOnboarding ? (
            <OnboardingPanel
              onBack={() => {
                setShowOnboarding(false);
                setNavView("dashboard");
              }}
              onSelectAgent={selectAgent}
              onCreateAgent={createAgent}
              onCreateTask={() => setShowNewTask(true)}
              initialStep={onboardingInitialStep}
            />
          ) : showAgentCreator ? (
            <AgentCreatePanel
              onBack={() => {
                setShowAgentCreator(false);
                if (!selectedAgentId) setNavView("dashboard");
              }}
              onCreated={(agent) => {
                setShowAgentCreator(false);
                refreshAgents();
                selectAgent(agent.id);
              }}
            />
          ) : roleEditorId && (roleEditorId === "new" || editingRole) ? (
            <RolePanel
              key={roleEditorId}
              role={editingRole}
              agents={agents}
              onBack={() => {
                setSelectedAgentId(null);
                setNavView("dashboard");
              }}
              onSaved={(role) => {
                void refreshAgents().then(() => setSelectedAgentId(`${ROLE_EDITOR_PREFIX}${role.id}`));
              }}
              onDeleted={handleAgentDeleted}
            />
          ) : selectedAgent ? (
            <AgentConfigPanel
              key={selectedAgent.id}
              agent={selectedAgent}
              onBack={() => {
                setSelectedAgentId(null);
                setNavView("dashboard");
              }}
              onAgentsChanged={refreshAgents}
              onDeleted={handleAgentDeleted}
            />
          ) : selectedWorkspace ? (
            <WorkspaceDetailPanel
              key={selectedWorkspace.id}
              workspace={selectedWorkspace}
              onBack={() => {
                setSelectedWorkspaceId(null);
                setNavView("dashboard");
              }}
              onWorkspacesChanged={refreshWorkspaces}
              onOpenResources={() => setNavView("knowledge")}
            />
          ) : (
            <div className="main-area-empty">
              <div className="main-area-empty-icon">◈</div>
              <strong>选择左侧 Agent 或工作区查看详情</strong>
              {showSetupPrompt && (
                <div className="setup-nudge" style={{ marginTop: 12 }}>
                  <strong>第一次使用 Xgent Hub？</strong>
                  <span>可以先检查 Agent 配置，安装开机启动，再创建测试任务。</span>
                  <div>
                    <button className="btn btn-primary" onClick={() => openOnboarding()}>
                      打开配置向导
                    </button>
                    <button className="btn btn-ghost" onClick={dismissSetupPrompt}>
                      不再提醒
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </>
    );
  }

  // 主内容区：tasks 视图
  function renderChatsView() {
    return (
      <>
        <div className="secondary-sidebar">
          <ChatList
            chats={chats}
            selectedChatId={selectedChatId}
            onSelect={selectChat}
            onNewChat={() => setShowNewChat(true)}
            onChanged={refreshChats}
            onDeleted={handleChatDeleted}
          />
        </div>
        <div className="main-area">
          {selectedChatId ? (
            <ChatDetail
              key={selectedChatId}
              chatId={selectedChatId}
              agents={agents}
              onBack={() => {
                setSelectedChatId(null);
              }}
              onChanged={refreshChats}
              onDeleted={handleChatDeleted}
            />
          ) : (
            <div className="main-area-empty">
              <div className="main-area-empty-icon">聊</div>
              <strong>选择左侧聊天查看详情</strong>
              <span>聊天不绑定工作区，也不会进入任务流程</span>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button className="btn btn-primary" onClick={() => setShowNewChat(true)}>
                  + 新建聊天
                </button>
              </div>
            </div>
          )}
        </div>
      </>
    );
  }

  // 主内容区：tasks 视图
  function renderTasksView() {
    return (
      <>
        <div className="secondary-sidebar">
          <TaskList
            tasks={tasks}
            workspaces={workspaces}
            filter={filter}
            onFilterChange={setFilter}
            selectedTaskId={selectedTaskId}
            onSelect={selectTask}
            onNewTask={() => setShowNewTask(true)}
            onTaskChanged={refreshTasks}
            onDeleted={handleTaskDeleted}
          />
        </div>
        <div className="main-area">
          {selectedTaskId ? (
            <TaskDetail
              key={selectedTaskId}
              taskId={selectedTaskId}
              agents={agents}
              workspaces={workspaces}
              onBack={() => {
                setSelectedTaskId(null);
              }}
              onTaskChanged={refreshTasks}
              onDeleted={handleTaskDeleted}
              onOpenWorkspace={openWorkspaceResources}
            />
          ) : (
            <div className="main-area-empty">
              <div className="main-area-empty-icon">✓</div>
              <strong>选择左侧任务查看详情</strong>
              <span>或在任务列表顶部新建任务</span>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button className="btn btn-primary" onClick={() => setShowNewTask(true)}>
                  + 新建任务
                </button>
              </div>
            </div>
          )}
        </div>
      </>
    );
  }

  return (
    <div
      className={`app-shell nav-${navView} ${selectedTaskId ? "task-open" : ""} ${selectedChatId ? "chat-open" : ""} ${
        mobileDetailOpen ? "mobile-detail-open" : ""
      }`}
    >
      {/* ===== 主体 ===== */}
      <div className="app-body">
        {/* 左侧导航轨道（桌面） */}
        <NavRail
          activeView={navView}
          onViewChange={changeNavView}
          taskCounts={taskCounts}
        />

        {/* 主内容容器 */}
        <div
          className={`view-container view-${navView} ${selectedTaskId ? "has-selected-task" : ""} ${
            selectedChatId ? "has-selected-chat" : ""
          } ${agentDetailOpen ? "has-agent-detail" : ""}`}
        >
          {navView === "dashboard" && (
            <Dashboard
              tasks={tasks}
              workspaces={workspaces}
              agents={agents}
              onSelectTask={selectTask}
              onSelectAgent={selectAgent}
              onSelectWorkspace={selectWorkspace}
              onOpenTasks={openTasks}
              onNewTask={() => setShowNewTask(true)}
              onOpenSettings={() => openOnboarding()}
            />
          )}
          {navView === "chats" && renderChatsView()}
          {navView === "tasks" && renderTasksView()}
          {navView === "agents" && renderAgentsView()}
          {navView === "knowledge" && <ResourceCenter mode="knowledge" workspaces={workspaces} onOpenWorkspace={openWorkspaceFromResource} />}
          {navView === "skills" && <ResourceCenter mode="skills" workspaces={workspaces} onOpenWorkspace={openWorkspaceFromResource} />}
          {navView === "tools" && <ResourceCenter mode="tools" workspaces={workspaces} onOpenWorkspace={openWorkspaceFromResource} />}
          {navView === "mcp" && <ResourceCenter mode="mcp" workspaces={workspaces} onOpenWorkspace={openWorkspaceFromResource} />}
        </div>
      </div>

      {/* 底部导航（移动端） */}
      <BottomNav
        activeView={navView}
        onViewChange={changeNavView}
        taskCounts={taskCounts}
      />

      <ApprovalAlerts tasks={tasks} agents={agents} selectedTaskId={selectedTaskId} onOpenTask={selectTask} />

      {/* 新建任务弹窗 */}
      {showNewChat && (
        <NewChatModal
          agents={agents}
          onClose={() => setShowNewChat(false)}
          onCreated={(chatId) => {
            setShowNewChat(false);
            refreshChats();
            selectChat(chatId);
          }}
        />
      )}

      {/* 新建任务弹窗 */}
      {showNewTask && (
        <NewTaskModal
          agents={agents}
          workspaces={workspaces}
          onClose={() => setShowNewTask(false)}
          onOpenWorkspace={openWorkspaceResources}
          onCreated={(taskId) => {
            setShowNewTask(false);
            refreshTasks();
            selectTask(taskId);
          }}
        />
      )}
    </div>
  );
}
