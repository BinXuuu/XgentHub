import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api/client";
import type { AgentDescriptor, AgentRole, AgentRoleInput, KnowledgeGroup, McpServerDefinition, ModelOption, ResourceLibraryItem, RoleMemory } from "../api/types";

interface Props {
  role: AgentRole | null;
  agents: AgentDescriptor[];
  onBack: () => void;
  onSaved: (role: AgentRole) => void;
  onDeleted: () => void;
}

const EMPTY: AgentRoleInput = {
  name: "",
  icon: "",
  description: "",
  baseAgentId: "",
  model: null,
  prompt: "",
  knowledgeGroupIds: [],
  mcpServerIds: [],
  toolIds: [],
  skillIds: [],
};

function toInput(role: AgentRole | null): AgentRoleInput {
  if (!role) return EMPTY;
  const { name, icon, description, baseAgentId, model, prompt, knowledgeGroupIds, mcpServerIds, toolIds, skillIds } = role;
  return { name, icon, description, baseAgentId, model, prompt, knowledgeGroupIds, mcpServerIds, toolIds, skillIds };
}

function ChipList({ items, selected, onToggle, empty }: { items: { id: string; label: string }[]; selected: string[]; onToggle: (id: string) => void; empty: string }) {
  if (items.length === 0) return <div className="sidebar-help">{empty}</div>;
  return (
    <div className="multi-agent-plan-skills">
      {items.map((item) => (
        <label key={item.id} className="multi-agent-plan-skill-chip">
          <input type="checkbox" checked={selected.includes(item.id)} onChange={() => onToggle(item.id)} />
          <span>{item.label}</span>
        </label>
      ))}
    </div>
  );
}

const MEMORY_SOURCE_LABEL: Record<RoleMemory["source"], string> = { manual: "手动添加", agent: "角色提出", message: "从对话存入" };

function RoleMemorySection({ roleId }: { roleId: string }) {
  const [memories, setMemories] = useState<RoleMemory[] | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  function reload() {
    api.listRoleMemories(roleId).then(setMemories).catch((err) => setError((err as Error).message));
  }

  useEffect(reload, [roleId]);

  async function run(action: () => Promise<unknown>): Promise<boolean> {
    setError(null);
    try {
      await action();
      reload();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  }

  function addDraft() {
    const content = draft.trim();
    if (!content) return;
    void run(() => api.addRoleMemory(roleId, { content })).then((ok) => ok && setDraft(""));
  }

  const pending = (memories ?? []).filter((item) => item.status === "pending");
  const active = (memories ?? []).filter((item) => item.status === "active");

  return (
    <section className="config-section">
      <div className="config-section-head">
        <div>
          <h3>角色记忆</h3>
          <p>已确认的记忆每一轮都会带给这个角色（最近 30 条、约 4000 字以内）。角色在对话里提出的记忆，要你确认后才会生效。</p>
        </div>
      </div>
      {pending.length > 0 && (
        <div className="role-memory-list">
          <span className="config-field-help">待确认（{pending.length}）</span>
          {pending.map((memory) => (
            <div key={memory.id} className="role-memory-item pending">
              <span>{memory.content}</span>
              <div className="role-memory-proposal-actions">
                <button className="btn btn-primary btn-sm" type="button" onClick={() => void run(() => api.approveRoleMemory(roleId, memory.id))}>
                  记住
                </button>
                <button className="btn btn-ghost btn-sm" type="button" onClick={() => void run(() => api.deleteRoleMemory(roleId, memory.id))}>
                  不用
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="role-memory-list">
        <span className="config-field-help">已记住（{active.length}）</span>
        {memories !== null && active.length === 0 && <div className="sidebar-help">还没有记忆。</div>}
        {active.map((memory) => (
          <div key={memory.id} className="role-memory-item">
            <span>{memory.content}</span>
            <small>{MEMORY_SOURCE_LABEL[memory.source]}</small>
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => void run(() => api.deleteRoleMemory(roleId, memory.id))}>
              删除
            </button>
          </div>
        ))}
      </div>
      <div className="role-memory-add">
        <input
          className="field"
          value={draft}
          maxLength={500}
          placeholder="手动添加一条，比如：品牌主色 #FF6600，图标统一线性风格"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addDraft();
          }}
        />
        <button className="btn btn-sm" type="button" disabled={!draft.trim()} onClick={addDraft}>
          添加
        </button>
      </div>
      {error && <div className="login-error">{error}</div>}
    </section>
  );
}

export function RolePanel({ role, agents, onBack, onSaved, onDeleted }: Props) {
  const [form, setForm] = useState<AgentRoleInput>(() => toInput(role));
  const [models, setModels] = useState<ModelOption[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerDefinition[]>([]);
  const [tools, setTools] = useState<ResourceLibraryItem[]>([]);
  const [skills, setSkills] = useState<ResourceLibraryItem[]>([]);
  const [knowledgeGroups, setKnowledgeGroups] = useState<KnowledgeGroup[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const baseOptions = useMemo(() => agents.filter((agent) => agent.supportsMcp && !agent.role), [agents]);
  const base = baseOptions.find((agent) => agent.id === form.baseAgentId) ?? null;

  useEffect(() => setForm(toInput(role)), [role?.id]);

  useEffect(() => {
    Promise.all([
      api.listMcpServers().catch(() => []),
      api.listResourceLibraryItems("tool").catch(() => []),
      api.listResourceLibraryItems("skill").catch(() => []),
      api.listKnowledgeGroups().catch(() => []),
    ]).then(([servers, toolList, skillList, groups]) => {
      setMcpServers(servers.filter((server) => server.enabled));
      setTools(toolList);
      setSkills(skillList);
      setKnowledgeGroups(groups);
    });
  }, []);

  useEffect(() => {
    setModels([]);
    if (!base?.supportsModelSelection) return;
    api.listModels(base.id).then(setModels).catch(() => setModels([]));
  }, [base?.id]);

  function set<K extends keyof AgentRoleInput>(key: K, value: AgentRoleInput[K]) {
    setMessage(null);
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function toggle(key: "knowledgeGroupIds" | "mcpServerIds" | "toolIds" | "skillIds", id: string) {
    set(key, form[key].includes(id) ? form[key].filter((item) => item !== id) : [...form[key], id]);
  }

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const saved = role ? await api.updateRole(role.id, form) : await api.createRole(form);
      setMessage({
        ok: true,
        text: role
          ? "已保存。提示词、知识组、MCP / 工具 / Skill 下一轮对话就生效；换底座只影响之后新建的任务。"
          : "角色已创建，新建任务时可以直接选它。",
      });
      onSaved(saved);
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : "保存失败" });
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled() {
    if (!role) return;
    try {
      onSaved(await api.setRoleEnabled(role.id, !role.enabled));
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    }
  }

  async function remove() {
    if (!role || !window.confirm(`删除角色「${role.name}」？`)) return;
    try {
      await api.deleteRole(role.id);
      onDeleted();
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    }
  }

  return (
    <div className="detail-pane agent-create-pane">
      <div className="detail-header">
        <div className="title-row">
          <button className="btn btn-ghost btn-sm back-btn" onClick={onBack}>
            ← 返回
          </button>
          <h2>{role ? `${role.icon ? `${role.icon} ` : ""}${role.name}` : "新建角色"}</h2>
          {role && <span className={`config-state ${role.enabled ? "ok" : "warn"}`}>{role.enabled ? "已启用" : "已停用"}</span>}
        </div>
        <div className="meta-row">
          <span>角色 = 一个真实 Agent（底座）+ 固定的身份提示词 + 自带的知识组 / MCP / 工具 / Skill。新建任务、聊天、转交、AI 智能拆分里都能直接选它。</span>
        </div>
      </div>

      <div className="agent-config-content">
        <section className="config-section">
          <div className="config-section-head">
            <div>
              <h3>基本信息</h3>
              <p>简介会给"AI 智能拆分"看，写清楚这个角色擅长什么，它才知道什么活该派给它。</p>
            </div>
          </div>
          <div className="config-form">
            <div className="role-name-row">
              <label className="config-field role-icon-field">
                <span className="config-label-row">
                  <span>图标</span>
                </span>
                <input className="field" value={form.icon} maxLength={8} placeholder="🎨" onChange={(e) => set("icon", e.target.value)} />
              </label>
              <label className="config-field">
                <span className="config-label-row">
                  <span>名称</span>
                </span>
                <input className="field" value={form.name} maxLength={40} placeholder="例如：美工" onChange={(e) => set("name", e.target.value)} />
              </label>
            </div>
            <label className="config-field">
              <span className="config-label-row">
                <span>一句话简介</span>
              </span>
              <input
                className="field"
                value={form.description}
                maxLength={300}
                placeholder="例如：负责界面视觉、配色和配图，需要出图时用 ComfyUI"
                onChange={(e) => set("description", e.target.value)}
              />
            </label>
          </div>
        </section>

        <section className="config-section">
          <div className="config-section-head">
            <div>
              <h3>底座</h3>
              <p>真正干活的 Agent。只能选支持 MCP 的；MCP 按任务隔离的只有 Claude Code，其余几个是整台电脑共用的。</p>
            </div>
          </div>
          <div className="config-form">
            <label className="config-field">
              <span className="config-label-row">
                <span>底座 Agent</span>
              </span>
              <select className="field" value={form.baseAgentId} onChange={(e) => set("baseAgentId", e.target.value)}>
                <option value="">请选择</option>
                {baseOptions.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                    {agent.configured ? "" : "（未配置）"}
                  </option>
                ))}
              </select>
            </label>
            <label className="config-field">
              <span className="config-label-row">
                <span>默认模型</span>
              </span>
              {models.length > 0 ? (
                <select className="field" value={form.model ?? ""} onChange={(e) => set("model", e.target.value || null)}>
                  <option value="">（用底座默认）</option>
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input className="field" value={form.model ?? ""} placeholder="留空用底座默认模型" onChange={(e) => set("model", e.target.value || null)} />
              )}
            </label>
          </div>
        </section>

        <section className="config-section">
          <div className="config-section-head">
            <div>
              <h3>角色提示词</h3>
              <p>每一轮都会带给底座。写清楚身份、职责、什么时候用哪个工具、风格要求；只写"你是美工"它不一定会主动调工具。</p>
            </div>
          </div>
          <textarea
            className="field role-prompt-field"
            value={form.prompt}
            maxLength={12000}
            placeholder={"例如：\n你是团队的美工，负责界面视觉、配色和配图。\n需要出图时调用 ComfyUI，默认尺寸 1024×1024，风格偏扁平插画。\n交付前说明每张图的用途和尺寸。"}
            onChange={(e) => set("prompt", e.target.value)}
          />
        </section>

        <section className="config-section">
          <div className="config-section-head">
            <div>
              <h3>自带的知识组 / MCP / 工具 / Skill</h3>
              <p>
                任务里：叠加在工作区配置之上，每一轮按角色当前设置生效。聊天里：知识组每一轮带上；MCP / 工具 / Skill 在新建聊天时自动勾上，之后在聊天里调整。
              </p>
            </div>
          </div>
          <div className="config-form">
            <span className="config-field-help">知识组（小组整组带上，大组按消息挑相关的）</span>
            <ChipList
              items={knowledgeGroups.map((group) => ({ id: group.id, label: `${group.name}（${group.entryCount} 条）` }))}
              selected={form.knowledgeGroupIds}
              onToggle={(id) => toggle("knowledgeGroupIds", id)}
              empty="还没有知识组，去左侧「知识库」页新建。"
            />
            <span className="config-field-help">MCP</span>
            <ChipList
              items={mcpServers.map((server) => ({ id: server.id, label: server.name }))}
              selected={form.mcpServerIds}
              onToggle={(id) => toggle("mcpServerIds", id)}
              empty="还没有注册 MCP server，去左侧「MCP」页添加。"
            />
            <span className="config-field-help">工具</span>
            <ChipList
              items={tools.map((tool) => ({ id: tool.id, label: tool.title }))}
              selected={form.toolIds}
              onToggle={(id) => toggle("toolIds", id)}
              empty="工具库是空的。"
            />
            <span className="config-field-help">Skill</span>
            <ChipList
              items={skills.map((skill) => ({ id: skill.id, label: skill.title }))}
              selected={form.skillIds}
              onToggle={(id) => toggle("skillIds", id)}
              empty="Skill 库是空的。"
            />
          </div>
        </section>

        {role && <RoleMemorySection roleId={role.id} />}

        {message && <div className={message.ok ? "resource-tab-note ok" : "login-error"}>{message.text}</div>}
        <div className="modal-actions role-actions">
          {role && (
            <>
              <button className="btn btn-ghost" type="button" onClick={() => void remove()}>
                删除
              </button>
              <button className="btn" type="button" onClick={() => void toggleEnabled()}>
                {role.enabled ? "停用" : "启用"}
              </button>
            </>
          )}
          <button className="btn btn-primary" type="button" onClick={() => void save()} disabled={saving}>
            {saving ? "保存中..." : role ? "保存" : "创建角色"}
          </button>
        </div>
      </div>
    </div>
  );
}
