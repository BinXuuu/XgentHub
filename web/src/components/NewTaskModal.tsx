import { useEffect, useState } from "react";
import type {
  AgentDescriptor,
  GatewayOverview,
  KnowledgeGroup,
  McpServerDefinition,
  ModelOption,
  PermissionMode,
  ResourceLibraryItem,
  Workspace,
} from "../api/types";
import { api } from "../api/client";

interface Props {
  agents: AgentDescriptor[];
  workspaces: Workspace[];
  onClose: () => void;
  onCreated: (taskId: string) => void;
  onOpenWorkspace: (workspaceId: string) => void;
}

const PERMISSION_OPTIONS: { key: PermissionMode; icon: string; title: string; desc: string }[] = [
  { key: "supervised", icon: "🖐", title: "请求批准", desc: "有风险的操作（装依赖、跑命令、git push 等）都会先进审批队列询问你" },
  { key: "auto", icon: "🤝", title: "帮我批准", desc: "只对检测到的高风险操作（比如 git push、rm -rf）询问，其余自动放行" },
  { key: "full", icon: "⚠️", title: "完全访问权限", desc: "不设限，agent 可以不经确认执行任何命令 / 改任何文件，风险自负" },
];

interface OptionCacheEntry {
  value: ModelOption[];
  expiresAt: number;
}

const OPTION_CACHE_TTL_MS = 5 * 60 * 1000;
const EMPTY_OPTION_CACHE_TTL_MS = 15 * 1000;
const modelOptionsCache = new Map<string, OptionCacheEntry>();
const subAgentOptionsCache = new Map<string, OptionCacheEntry>();

function readCachedOptions(cache: Map<string, OptionCacheEntry>, key: string): ModelOption[] | null {
  const cached = cache.get(key);
  if (!cached || cached.expiresAt <= Date.now()) return null;
  return cached.value;
}

function writeCachedOptions(cache: Map<string, OptionCacheEntry>, key: string, value: ModelOption[]) {
  cache.set(key, { value, expiresAt: Date.now() + (value.length > 0 ? OPTION_CACHE_TTL_MS : EMPTY_OPTION_CACHE_TTL_MS) });
}

function resourceSummary(label: string, ids: string[], names: Map<string, string>): string {
  const known = ids.map((id) => names.get(id)).filter((name): name is string => Boolean(name));
  if (known.length === 0) return `${label} 无`;
  if (known.length > 3) return `${label} ${known.slice(0, 3).join("、")} 等 ${known.length} 个`;
  return `${label} ${known.join("、")}`;
}

export function NewTaskModal({ agents, workspaces, onClose, onCreated, onOpenWorkspace }: Props) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [model, setModel] = useState("");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("supervised");
  const [planMode, setPlanMode] = useState(false);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [subAgentId, setSubAgentId] = useState("");
  const [subAgentOptions, setSubAgentOptions] = useState<ModelOption[]>([]);
  const [loadingSubAgents, setLoadingSubAgents] = useState(false);
  const [gatewayOverview, setGatewayOverview] = useState<GatewayOverview | null>(null);
  const [loadingGateway, setLoadingGateway] = useState(false);
  const [budgetLimitCny, setBudgetLimitCny] = useState("");
  const [toolOptions, setToolOptions] = useState<ResourceLibraryItem[]>([]);
  const [skillOptions, setSkillOptions] = useState<ResourceLibraryItem[]>([]);
  const [loadingResources, setLoadingResources] = useState(true);
  const [knowledgeGroups, setKnowledgeGroups] = useState<KnowledgeGroup[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerDefinition[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // AI 智能拆分：所选 Agent 当总管家。建任务时只勾这次能分给谁，需求在任务里发第一条消息时再拆，
  // 拆完依赖满足的子任务同时派发，最后交回总管家汇总；拆分结果在流程图里看、能改派和重做。
  const [smartSplit, setSmartSplit] = useState(false);
  const [splitPool, setSplitPool] = useState<string[]>([]);
  const selectedAgent = agents.find((a) => a.id === agentId);
  const selectedWorkspace = workspaces.find((w) => w.id === workspaceId) ?? null;
  const planAgents = agents.filter(
    (agent) =>
      agent.configured &&
      (!selectedWorkspace || selectedWorkspace.allowedAgentKinds.length === 0 || selectedWorkspace.allowedAgentKinds.includes(agent.kind))
  );
  const planAgentIds = planAgents.map((agent) => agent.id).join("|");

  // 刚打开智能拆分时默认全选；换了工作区，去掉新工作区里用不了的。
  useEffect(() => {
    if (!smartSplit) return;
    const usable = new Set(planAgentIds.split("|").filter(Boolean));
    setSplitPool((prev) => (prev.length ? prev.filter((id) => usable.has(id)) : [...usable]));
  }, [smartSplit, planAgentIds]);

  function toggleSplitAgent(id: string, checked: boolean) {
    setSplitPool((prev) => (checked ? [...new Set([...prev, id])] : prev.filter((item) => item !== id)));
  }

  useEffect(() => {
    setModel(selectedAgent?.role?.model ?? "");
    setModelOptions([]);
    if (!selectedAgent || !selectedAgent.supportsModelSelection) return;
    const cached = readCachedOptions(modelOptionsCache, selectedAgent.id);
    if (cached) {
      setModelOptions(cached);
      return;
    }
    let cancelled = false;
    setLoadingModels(true);
    api
      .listModels(selectedAgent.id)
      .then((opts) => {
        if (!cancelled) {
          writeCachedOptions(modelOptionsCache, selectedAgent.id, opts);
          setModelOptions(opts);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoadingModels(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  useEffect(() => {
    setGatewayOverview(null);
    setBudgetLimitCny("");
    if (selectedAgent?.id !== "tokenezgo") return;
    let cancelled = false;
    setLoadingGateway(true);
    api
      .getOfficialGatewayOverview()
      .then((overview) => {
        if (cancelled) return;
        setGatewayOverview(overview);
        if (overview.settings.defaultTaskBudgetCny > 0) setBudgetLimitCny(String(overview.settings.defaultTaskBudgetCny));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoadingGateway(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  useEffect(() => {
    setSubAgentId("");
    setSubAgentOptions([]);
    if (!selectedAgent || !selectedAgent.supportsSubAgentSelection) return;
    const cached = readCachedOptions(subAgentOptionsCache, selectedAgent.id);
    if (cached) {
      setSubAgentOptions(cached);
      return;
    }
    let cancelled = false;
    setLoadingSubAgents(true);
    api
      .listSubAgents(selectedAgent.id)
      .then((opts) => {
        if (!cancelled) {
          writeCachedOptions(subAgentOptionsCache, selectedAgent.id, opts);
          setSubAgentOptions(opts);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoadingSubAgents(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  useEffect(() => {
    let cancelled = false;
    setLoadingResources(true);
    Promise.all([
      api.listMcpServers().catch(() => []),
      api.listResourceLibraryItems("tool").catch(() => []),
      api.listResourceLibraryItems("skill").catch(() => []),
      api.listKnowledgeGroups().catch(() => []),
    ])
      .then(([servers, tools, skills, groups]) => {
        if (cancelled) return;
        setMcpServers(servers.filter((item) => item.enabled));
        setToolOptions(tools);
        setSkillOptions(skills);
        setKnowledgeGroups(groups);
      })
      .finally(() => {
        if (!cancelled) setLoadingResources(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function refreshModels() {
    if (!selectedAgent?.supportsModelSelection) return;
    setLoadingModels(true);
    try {
      const opts = await api.listModels(selectedAgent.id, true);
      writeCachedOptions(modelOptionsCache, selectedAgent.id, opts);
      setModelOptions(opts);
    } finally {
      setLoadingModels(false);
    }
  }

  async function refreshSubAgents() {
    if (!selectedAgent?.supportsSubAgentSelection) return;
    setLoadingSubAgents(true);
    try {
      const opts = await api.listSubAgents(selectedAgent.id, true);
      writeCachedOptions(subAgentOptionsCache, selectedAgent.id, opts);
      setSubAgentOptions(opts);
    } finally {
      setLoadingSubAgents(false);
    }
  }

  async function submit() {
    if (!agentId || !workspaceId || !title.trim()) {
      setError("请选择 agent、workspace 并填写任务名称");
      return;
    }
    if (smartSplit && splitPool.length === 0) {
      setError("AI 智能拆分至少要勾一个能分配的 Agent，或者关掉智能拆分");
      return;
    }
    const budgetValue = budgetLimitCny.trim() ? Number(budgetLimitCny) : null;
    if (selectedAgent?.id === "tokenezgo" && budgetValue !== null && (!Number.isFinite(budgetValue) || budgetValue <= 0)) {
      setError("单任务预算上限必须是正数，或者留空不限制");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const task = await api.createTask({
        agentId,
        workspaceId,
        title: title.trim(),
        model: model.trim() || undefined,
        permissionMode,
        subAgentId: subAgentId || undefined,
        budgetLimitCny: selectedAgent?.id === "tokenezgo" ? budgetValue : undefined,
        planMode: smartSplit ? false : planMode,
        splitAgentPool: smartSplit ? splitPool : undefined,
      });
      onCreated(task.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h2>新建任务</h2>

        <label className="field-label">任务名称</label>
        <input
          className="field"
          placeholder="例如：修复图片附件预览"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={160}
          autoFocus
        />

        <label className="field-label">选择 Agent</label>
        <div className="agent-grid">
          {agents.map((a) => (
            <div
              key={a.id}
              className={`agent-card ${agentId === a.id ? "selected" : ""}`}
              onClick={() => setAgentId(a.id)}
            >
              <div className="agent-name">
                <span>
                  {a.role?.icon ? `${a.role.icon} ` : ""}
                  {a.name}
                </span>
                {a.official && <span className="official-badge">推荐</span>}
                {a.role && <span className="agent-role-badge">角色 · {a.role.baseAgentName}</span>}
              </div>
              <div className="agent-desc">{a.description}</div>
              {!a.configured && <div className="not-configured">未配置 · {a.configHint}</div>}
            </div>
          ))}
        </div>

        <label className="field-label">选择工作区</label>
        <select className="field" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
          {workspaces.length === 0 && <option value="">（暂无 workspace，请先在左侧栏创建）</option>}
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name} — {w.path}
            </option>
          ))}
        </select>

        {selectedAgent && selectedAgent.supportsSubAgentSelection && (
          <>
            <div className="field-label-row">
              <label className="field-label">子 Agent（可选，留空走默认路由）</label>
              <button className="btn btn-ghost btn-sm" type="button" onClick={refreshSubAgents} disabled={loadingSubAgents}>
                刷新
              </button>
            </div>
            <select className="field" value={subAgentId} onChange={(e) => setSubAgentId(e.target.value)} disabled={loadingSubAgents}>
              <option value="">{loadingSubAgents ? "加载中…" : "（默认路由）"}</option>
              {subAgentOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
            {!loadingSubAgents && subAgentOptions.length === 0 && (
              <div className="not-configured">没探测到已配置的子 agent，会走默认路由</div>
            )}
          </>
        )}

        {selectedAgent && selectedAgent.kind !== "mock" && (
          <>
            <div className="field-label-row">
              <label className="field-label">模型（可选，留空用 agent 默认）</label>
              {selectedAgent.supportsModelSelection && (
                <button className="btn btn-ghost btn-sm" type="button" onClick={refreshModels} disabled={loadingModels}>
                  刷新
                </button>
              )}
            </div>
            {selectedAgent.supportsModelSelection ? (
              <select className="field" value={model} onChange={(e) => setModel(e.target.value)} disabled={loadingModels}>
                <option value="">{loadingModels ? "加载中…" : "（默认）"}</option>
                {modelOptions.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="field"
                placeholder={`比如 ${selectedAgent.kind === "codex" ? "gpt-5.1-codex" : "opus"}，留空用默认模型`}
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
            )}
            {selectedAgent.supportsModelSelection && !loadingModels && modelOptions.length === 0 && (
              <div className="not-configured">
                {selectedAgent.kind === "antigravity"
                  ? "模型列表读取本地额度快照；点击左侧额度刷新后会在后台更新。留空会用 agent 默认设置。"
                  : "没探测到可用模型（服务没起来，或者还没装/配置模型），留空会用 agent 默认设置"}
              </div>
            )}
          </>
        )}

        {selectedWorkspace && (
          <div className="task-create-default-resources">
            {loadingResources ? (
              "正在读取工作区资源..."
            ) : (
              <>
                <div>
                  工作区「{selectedWorkspace.name}」可用：
                  {resourceSummary(
                    "知识组",
                    selectedWorkspace.knowledgeGroupIds,
                    new Map(knowledgeGroups.map((group) => [group.id, group.name]))
                  )}
                  ；{resourceSummary("MCP", selectedWorkspace.mcpServerIds, new Map(mcpServers.map((server) => [server.id, server.name])))}
                  ；{resourceSummary("工具", selectedWorkspace.toolIds, new Map(toolOptions.map((tool) => [tool.id, tool.title])))}
                  ；{resourceSummary("Skill", selectedWorkspace.skillIds, new Map(skillOptions.map((skill) => [skill.id, skill.title])))}
                </div>
                {selectedAgent?.role && (
                  <div>
                    再加上角色「{selectedAgent.name}」自带的：知识组 {selectedAgent.role.knowledgeGroupIds.length} 个、MCP {selectedAgent.role.mcpServerIds.length} 个、工具 {selectedAgent.role.toolIds.length} 个、Skill{" "}
                    {selectedAgent.role.skillIds.length} 个。
                  </div>
                )}
                {selectedAgent && !selectedAgent.supportsMcp && selectedWorkspace.mcpServerIds.length > 0 && (
                  <div>{selectedAgent.name} 不支持 MCP，MCP 对它不生效。</div>
                )}
                <button
                  className="link-button"
                  type="button"
                  onClick={() => {
                    onClose();
                    onOpenWorkspace(selectedWorkspace.id);
                  }}
                >
                  去工作区修改
                </button>
              </>
            )}
          </div>
        )}

        {selectedAgent?.id === "tokenezgo" && (
          <div className="official-task-budget">
            <div className="field-label-row">
              <label className="field-label">中转站额度与预算</label>
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => window.open("https://tokenezgo.com", "_blank", "noopener,noreferrer")}>
                充值 / 获取 Key
              </button>
            </div>
            <div className="budget-summary-grid">
              <div>
                <span>余额</span>
                <strong>{loadingGateway ? "读取中..." : gatewayOverview?.balanceLabel ?? "到 TokenEZGO 查看"}</strong>
              </div>
              <div>
                <span>本月本地估算</span>
                <strong>¥{gatewayOverview?.month.estimatedCostCny ?? 0}</strong>
              </div>
              <div>
                <span>估算 token</span>
                <strong>{gatewayOverview?.month.totalTokens ?? 0}</strong>
              </div>
            </div>
            <label className="config-field">
              <span className="config-label-row">
                <span>单任务预算上限（元，可选）</span>
              </span>
              <input
                className="field"
                type="number"
                min="0"
                step="0.01"
                placeholder="留空不限制"
                value={budgetLimitCny}
                onChange={(e) => setBudgetLimitCny(e.target.value)}
              />
              <span className="config-field-help">
                本地预算只用于提醒和拦截明显超额的输入；真实扣费、余额和充值仍以 TokenEZGO 页面为准。
              </span>
            </label>
          </div>
        )}

        <label className="field-label">应如何批准 agent 的操作？</label>
        <div className="permission-options">
          {PERMISSION_OPTIONS.map((opt) => (
            <div
              key={opt.key}
              className={`permission-option ${permissionMode === opt.key ? "selected" : ""} ${opt.key === "full" ? "danger" : ""}`}
              onClick={() => setPermissionMode(opt.key)}
            >
              <span className="permission-icon">{opt.icon}</span>
              <div>
                <div className="permission-title">{opt.title}</div>
                <div className="permission-desc">{opt.desc}</div>
              </div>
            </div>
          ))}
        </div>

        <label className="plan-mode-check">
          <input type="checkbox" checked={planMode && !smartSplit} disabled={smartSplit} onChange={(e) => setPlanMode(e.target.checked)} />
          <span>
            <strong>计划模式</strong>：Agent 先调研、出方案，不改文件；你批准后再动手
            {smartSplit && <em>（和 AI 智能拆分不能同时用：子任务要真正动手）</em>}
            {planMode && !smartSplit && selectedAgent && !selectedAgent.enforcesPlanMode && (
              <em>（{selectedAgent.name} 没有原生只读机制，只能靠指令约束，不能完全保证不改文件）</em>
            )}
          </span>
        </label>

        <label className="plan-mode-check">
          <input type="checkbox" checked={smartSplit} onChange={(e) => setSmartSplit(e.target.checked)} />
          <span>
            <strong>AI 智能拆分并分配 Agent</strong>：上面选的 Agent 当总管家。在任务里发第一条需求时，它把需求拆成几个子任务、从下面勾的 Agent 里分配；互不依赖的子任务同时跑，全部完成后交回总管家汇总
          </span>
        </label>

        {smartSplit && (
          <section className="subtask-plan multi-agent-plan">
            <div className="field-label-row">
              <label className="field-label">这次可以分给（{splitPool.length}/{planAgents.length}）</label>
              <button
                className="btn btn-ghost btn-sm"
                type="button"
                onClick={() => setSplitPool(splitPool.length === planAgents.length ? [] : planAgents.map((agent) => agent.id))}
              >
                {splitPool.length === planAgents.length ? "全不选" : "全选"}
              </button>
            </div>
            <div className="split-pool-grid">
              {planAgents.map((agent) => (
                <label key={agent.id} className={`split-pool-item ${splitPool.includes(agent.id) ? "selected" : ""}`}>
                  <input type="checkbox" checked={splitPool.includes(agent.id)} onChange={(e) => toggleSplitAgent(agent.id, e.target.checked)} />
                  <span>
                    {agent.role?.icon ? `${agent.role.icon} ` : ""}
                    {agent.name}
                  </span>
                </label>
              ))}
            </div>
            <div className="config-field-help">
              只管第一次自动分配。之后在任务的流程图里，每个子任务都能改派给任何 Agent 或角色并重做。
              {selectedAgent && !selectedAgent.supportsAsk && ` ${selectedAgent.name} 不支持一次性问答，会用本地规则拆分。`}
            </div>
          </section>
        )}

        {error && <div className="login-error">{error}</div>}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={submitting}>
            {submitting ? "创建中..." : "创建任务"}
          </button>
        </div>
      </div>
    </div>
  );
}
