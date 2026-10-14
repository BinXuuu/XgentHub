import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api/client";
import type { AgentDescriptor, McpServerDefinition, ModelOption } from "../api/types";

interface Props {
  agents: AgentDescriptor[];
  onClose: () => void;
  onCreated: (chatId: string) => void;
}

export function NewChatModal({ agents, onClose, onCreated }: Props) {
  const availableAgents = useMemo(() => agents.filter((agent) => agent.configured), [agents]);
  const [agentId, setAgentId] = useState(availableAgents[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [model, setModel] = useState("");
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [mcpServers, setMcpServers] = useState<McpServerDefinition[]>([]);
  const [mcpServerIds, setMcpServerIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedAgent = agents.find((agent) => agent.id === agentId);

  useEffect(() => {
    api
      .listMcpServers()
      .then((list) => setMcpServers(list.filter((item) => item.enabled)))
      .catch(() => {});
  }, []);

  function toggleMcpServer(id: string) {
    setMcpServerIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  }

  useEffect(() => {
    setMcpServerIds(selectedAgent?.role?.mcpServerIds ?? []);
    setModel(selectedAgent?.role?.model ?? "");
    setModelOptions([]);
    if (!selectedAgent?.supportsModelSelection) return;
    let cancelled = false;
    setLoadingModels(true);
    api
      .listModels(selectedAgent.id)
      .then((opts) => {
        if (!cancelled) setModelOptions(opts);
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

  async function submit() {
    if (!agentId || !title.trim()) {
      setError("请选择 Agent，并填写聊天名称");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const chat = await api.createChat({
        agentId,
        title: title.trim(),
        model: model.trim() || undefined,
        mcpServerIds: selectedAgent?.supportsMcp && mcpServerIds.length > 0 ? mcpServerIds : undefined,
      });
      onCreated(chat.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "创建失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal-card" onMouseDown={(event) => event.stopPropagation()}>
        <div className="chat-modal-head">
          <h2>新建聊天</h2>
          <button className="btn btn-ghost btn-sm" type="button" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="form-grid">
          <label>
            <span>Agent</span>
            <select className="field" value={agentId} onChange={(event) => setAgentId(event.target.value)}>
              {availableAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.role ? `${agent.role.icon ? `${agent.role.icon} ` : ""}${agent.name}（角色 · ${agent.role.baseAgentName}）` : agent.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>聊天名称</span>
            <input
              className="field"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="例如：讨论模型配置"
              autoFocus
            />
          </label>
          {selectedAgent && selectedAgent.kind !== "mock" && (
            <label>
              <span>模型（可选，留空用 agent 默认）</span>
              {selectedAgent.supportsModelSelection ? (
                <select className="field" value={model} onChange={(event) => setModel(event.target.value)} disabled={loadingModels}>
                  <option value="">{loadingModels ? "加载中…" : "（默认）"}</option>
                  {modelOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input className="field" value={model} onChange={(event) => setModel(event.target.value)} placeholder="留空用默认模型" />
              )}
            </label>
          )}
          {selectedAgent?.supportsMcp && mcpServers.length > 0 && (
            <label>
              <span>MCP server（可选，这次聊天能用到的几个）</span>
              <div className="multi-agent-plan-skills">
                {mcpServers.map((server) => (
                  <label key={server.id} className="multi-agent-plan-skill-chip">
                    <input type="checkbox" checked={mcpServerIds.includes(server.id)} onChange={() => toggleMcpServer(server.id)} />
                    <span>{server.name}</span>
                  </label>
                ))}
              </div>
            </label>
          )}
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button className="btn" type="button" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" type="button" onClick={submit} disabled={submitting || availableAgents.length === 0}>
            {submitting ? "创建中..." : "创建聊天"}
          </button>
        </div>
      </div>
    </div>
  );
}
