import { useEffect, useRef, useState } from "react";
import type {
  AgentConfigResponse,
  AgentDescriptor,
  AgentDiagnostics,
  AgentSetupAction,
  GatewayBillingSettings,
  GatewayCloudAccountStatus,
  GatewayModelPriceRule,
  GatewayOverview,
  ModelOption,
} from "../api/types";
import { api } from "../api/client";
import { loadAgentUsage } from "../utils/agentUsage";
import { copyText } from "../utils/clipboard";
import { confirmDialog } from "../utils/dialog";
import { agentDisplayName } from "../utils/agentAccount";
import { AccountSection } from "./AccountSection";

interface Props {
  agent: AgentDescriptor;
  onBack: () => void;
  onAgentsChanged: () => unknown;
  onAgentCreated: (agent: AgentDescriptor) => void;
  onDeleted: () => void;
}

type GatewaySettingInputKey = Exclude<keyof GatewayBillingSettings, "modelPriceRules">;

export function AgentConfigPanel({ agent, onBack, onAgentsChanged, onAgentCreated, onDeleted }: Props) {
  const isAddedAccount = Boolean(agent.account && !agent.account.isDefault);
  const [config, setConfig] = useState<AgentConfigResponse | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [usage, setUsage] = useState<string | null | undefined>(undefined);
  const [usageWaiting, setUsageWaiting] = useState(false); // 显示的是旧快照，正在等后台刷新出新的
  const usageAgentRef = useRef(agent.id);
  useEffect(() => {
    usageAgentRef.current = agent.id;
    setUsageWaiting(false);
    return () => { usageAgentRef.current = ""; };
  }, [agent.id]);
  const [deleting, setDeleting] = useState(false);
  const [diagnostics, setDiagnostics] = useState<AgentDiagnostics | null>(null);
  const [loadingDiagnostics, setLoadingDiagnostics] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [gatewayOverview, setGatewayOverview] = useState<GatewayOverview | null>(null);
  const [gatewaySettings, setGatewaySettings] = useState<Record<GatewaySettingInputKey, string>>({
    defaultTaskBudgetCny: "",
    monthlyBudgetCny: "",
    inputPriceCnyPer1K: "",
    outputPriceCnyPer1K: "",
  });
  const [modelPriceRules, setModelPriceRules] = useState<GatewayModelPriceRule[]>([]);
  const [cloudAccount, setCloudAccount] = useState<GatewayCloudAccountStatus | null>(null);
  const [savingGateway, setSavingGateway] = useState(false);
  const [gatewayMessage, setGatewayMessage] = useState<string | null>(null);

  function applyGatewayOverview(overview: GatewayOverview) {
    setGatewayOverview(overview);
    setGatewaySettings({
      defaultTaskBudgetCny: String(overview.settings.defaultTaskBudgetCny || ""),
      monthlyBudgetCny: String(overview.settings.monthlyBudgetCny || ""),
      inputPriceCnyPer1K: String(overview.settings.inputPriceCnyPer1K || ""),
      outputPriceCnyPer1K: String(overview.settings.outputPriceCnyPer1K || ""),
    });
    setModelPriceRules(overview.settings.modelPriceRules ?? []);
  }

  async function refreshGatewayOverview(refreshBalance = false) {
    if (agent.id !== "tokenezgo") return;
    try {
      applyGatewayOverview(await api.getOfficialGatewayOverview(refreshBalance));
      setCloudAccount(await api.getOfficialGatewayCloudAccount());
    } catch {
      setGatewayOverview(null);
      setCloudAccount(null);
    }
  }

  async function reloadConfig() {
    setLoading(true);
    setError(null);
    setSaved(null);
    setModels([]);
    setUsage(undefined);
    setDiagnostics(null);
    try {
      const res = await api.getAgentConfig(agent.id);
      setConfig(res);
      setValues(Object.fromEntries(res.fields.map((field) => [field.key, field.value])));
      void refreshDiagnostics();
      void refreshGatewayOverview();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function refreshDiagnostics() {
    setLoadingDiagnostics(true);
    try {
      setDiagnostics(await api.diagnoseAgent(agent.id));
    } catch {
      setDiagnostics(null);
    } finally {
      setLoadingDiagnostics(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      setSaved(null);
      setModels([]);
      setUsage(undefined);
      setDiagnostics(null);
      setGatewayOverview(null);
      setGatewayMessage(null);
      try {
        const res = await api.getAgentConfig(agent.id);
        if (cancelled) return;
        setConfig(res);
        setValues(Object.fromEntries(res.fields.map((field) => [field.key, field.value])));
        api.diagnoseAgent(agent.id)
          .then((diag) => {
            if (!cancelled) setDiagnostics(diag);
          })
          .catch(() => {
            if (!cancelled) setDiagnostics(null);
          })
          .finally(() => {
            if (!cancelled) setLoadingDiagnostics(false);
          });
        setLoadingDiagnostics(true);
        if (agent.id === "tokenezgo") {
          Promise.all([api.getOfficialGatewayOverview(), api.getOfficialGatewayCloudAccount()])
            .then(([overview, account]) => {
              if (cancelled) return;
              applyGatewayOverview(overview);
              setCloudAccount(account);
            })
            .catch(() => {
              if (!cancelled) {
                setGatewayOverview(null);
                setCloudAccount(null);
              }
            });
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [agent.id]);

  function setValue(key: string, value: string) {
    setSaved(null);
    setActionMessage(null);
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function setGatewayValue(key: GatewaySettingInputKey, value: string) {
    setGatewayMessage(null);
    setGatewaySettings((prev) => ({ ...prev, [key]: value }));
  }

  function setPriceRule(index: number, patch: Partial<GatewayModelPriceRule>) {
    setGatewayMessage(null);
    setModelPriceRules((prev) => prev.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));
  }

  function addPriceRule() {
    setGatewayMessage(null);
    setModelPriceRules((prev) => [
      ...prev,
      {
        id: `rule-${Date.now()}`,
        label: "",
        pattern: "",
        inputPriceCnyPer1K: 0,
        outputPriceCnyPer1K: 0,
        enabled: true,
      },
    ]);
  }

  function removePriceRule(index: number) {
    setGatewayMessage(null);
    setModelPriceRules((prev) => prev.filter((_, i) => i !== index));
  }


  async function runSetupAction(action: AgentSetupAction) {
    setActionMessage(null);
    if (action.kind === "copy_command" || action.kind === "copy_value") {
      if (!action.value) return;
      const ok = await copyText(action.value);
      setActionMessage(ok ? `已复制：${action.label}` : `复制失败，请手动选择复制：${action.value}`);
      return;
    }

    if (action.kind === "config_field") {
      if (!action.fieldKey) return;
      const target = document.querySelector<HTMLElement>(`[data-config-field="${action.fieldKey}"]`);
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.classList.add("field-highlight");
        setTimeout(() => target.classList.remove("field-highlight"), 1200);
        setActionMessage(`已定位：${action.label}`);
      } else {
        setActionMessage(`当前配置页没有找到字段：${action.fieldKey}`);
      }
      return;
    }

    if (action.kind === "open_url" && action.url) {
      window.open(action.url, "_blank", "noopener,noreferrer");
    }
  }

  async function save() {
    if (!config) return;
    setSaving(true);
    setError(null);
    setSaved(null);
    try {
      const next = await api.updateAgentConfig(agent.id, values);
      setConfig(next);
      setValues(Object.fromEntries(next.fields.map((field) => [field.key, field.value])));
      setSaved("已保存");
      onAgentsChanged();
      if (agent.supportsModelSelection) setModels([]);
      void refreshDiagnostics();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function saveGatewaySettings() {
    setSavingGateway(true);
    setGatewayMessage(null);
    setError(null);
    try {
      const cleanRules = modelPriceRules
        .map((rule, index) => ({
          ...rule,
          id: rule.id?.trim() || `rule-${index + 1}`,
          label: rule.label?.trim() || rule.pattern?.trim() || `规则 ${index + 1}`,
          pattern: rule.pattern?.trim() || "",
          inputPriceCnyPer1K: Number(rule.inputPriceCnyPer1K || 0),
          outputPriceCnyPer1K: Number(rule.outputPriceCnyPer1K || 0),
          enabled: rule.enabled !== false,
        }))
        .filter((rule) => rule.pattern);
      const next = await api.updateOfficialGatewaySettings({
        defaultTaskBudgetCny: Number(gatewaySettings.defaultTaskBudgetCny || 0),
        monthlyBudgetCny: Number(gatewaySettings.monthlyBudgetCny || 0),
        inputPriceCnyPer1K: Number(gatewaySettings.inputPriceCnyPer1K || 0),
        outputPriceCnyPer1K: Number(gatewaySettings.outputPriceCnyPer1K || 0),
        modelPriceRules: cleanRules,
      });
      applyGatewayOverview(next);
      setGatewayMessage("已保存推荐网关预算设置");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingGateway(false);
    }
  }

  async function refreshModels() {
    setLoadingModels(true);
    setError(null);
    try {
      setModels(await api.listModels(agent.id, true));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingModels(false);
    }
  }

  async function queryUsage() {
    setUsage(undefined);
    const agentId = agent.id;
    const active = () => usageAgentRef.current === agentId;
    try {
      await loadAgentUsage(agentId, {
        onText: (text) => { if (active()) setUsage(text); },
        onWaiting: (value) => { if (active()) setUsageWaiting(value); },
        isActive: active,
      });
    } catch {
      if (active()) setUsage(null);
    }
  }

  async function removeAgent() {
    if (agent.locked) {
      setError("推荐接入不能删除或隐藏。");
      return;
    }
    const action = isAddedAccount ? "删除账号" : agent.custom ? "删除自定义 Agent" : "从左侧列表隐藏内置 Agent";
    const note = isAddedAccount
      ? `已有任务记录不会删除。账号目录（含登录信息）会留在 ${agent.account!.home}，不需要的话可以自己删掉。`
      : agent.custom
        ? "已有任务记录不会删除，但这个接入将不再出现在列表里。"
        : "已有任务记录不会删除；如果以后想恢复，需要从数据文件恢复隐藏项或重新加一个自定义 Agent。";
    if (!(await confirmDialog(note, { title: `${action}「${agent.name}」？`, danger: true, confirmText: agent.custom ? "删除" : "隐藏" }))) return;
    setDeleting(true);
    setError(null);
    try {
      await api.deleteAgent(agent.id);
      onDeleted();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="detail-pane agent-config-pane">
      <div className="detail-header">
        <div className="title-row">
          <button className="btn btn-ghost btn-sm back-btn" onClick={onBack}>
            ← 返回
          </button>
          <div className="agent-config-title-block">
            <h2>{agentDisplayName(agent)} 配置</h2>
            <div className="agent-config-title-badges">
              {agent.official && <span className="official-badge">推荐</span>}
              <span className={`config-state ${agent.configured ? "ok" : "warn"}`}>{agent.configured ? "已配置" : "未配置"}</span>
            </div>
          </div>
        </div>
        <div className="meta-row">
          <span>{agent.kind}</span>
          {agent.configHint && <span>{agent.configHint}</span>}
        </div>
      </div>

      <div className="agent-config-content">
        {agent.official && agent.billingUrl && (
          <section className="config-section official-agent-section">
            <div className="config-section-head">
              <div>
                <h3>推荐 API 中转站</h3>
                <p>
                  这里预置的是 Xgent Hub 推荐的模型额度入口。客户到 TokenEZGO 充值后获取 API Key，再把 Key
                  填到下面的 TOKENEZGO_API_KEY 即可使用。
                </p>
              </div>
              <div className="config-tools">
                <button className="btn btn-primary btn-sm" type="button" onClick={() => window.open(agent.billingUrl, "_blank", "noopener,noreferrer")}>
                  {agent.billingLabel ?? "打开充值页面"}
                </button>
                <button className="btn btn-sm" type="button" onClick={() => void copyText("https://tokenezgo.com/v1")}>
                  复制 Base URL
                </button>
                <button className="btn btn-sm" type="button" onClick={() => void refreshGatewayOverview(true)}>
                  刷新余额
                </button>
              </div>
            </div>
            {gatewayOverview && (
              <>
                <div className="gateway-overview-grid">
                  <div>
                    <span>API Key</span>
                    <strong>{gatewayOverview.apiKeyConfigured ? "已配置" : "未配置"}</strong>
                  </div>
                  <div>
                    <span>余额</span>
                    <strong>{gatewayOverview.balanceLabel}</strong>
                    {gatewayOverview.balanceDetail && <small>{gatewayOverview.balanceDetail}</small>}
                  </div>
                  <div>
                    <span>本月本地估算</span>
                    <strong>¥{gatewayOverview.month.estimatedCostCny}</strong>
                    <small>{gatewayOverview.month.totalTokens} tokens / {gatewayOverview.month.recordCount} 次</small>
                  </div>
                  <div>
                    <span>月度提醒预算</span>
                    <strong>{gatewayOverview.settings.monthlyBudgetCny > 0 ? `¥${gatewayOverview.settings.monthlyBudgetCny}` : "未设置"}</strong>
                  </div>
                </div>

                <div className="gateway-settings-grid">
                  <label className="config-field">
                    <span className="config-label-row">
                      <span>默认单任务预算（元）</span>
                    </span>
                    <input
                      className="field"
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="0 表示不默认限制"
                      value={gatewaySettings.defaultTaskBudgetCny}
                      onChange={(e) => setGatewayValue("defaultTaskBudgetCny", e.target.value)}
                    />
                  </label>
                  <label className="config-field">
                    <span className="config-label-row">
                      <span>月度提醒预算（元）</span>
                    </span>
                    <input
                      className="field"
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="0 表示不拦截"
                      value={gatewaySettings.monthlyBudgetCny}
                      onChange={(e) => setGatewayValue("monthlyBudgetCny", e.target.value)}
                    />
                  </label>
                  <label className="config-field">
                    <span className="config-label-row">
                      <span>输入单价（元 / 1K tokens）</span>
                    </span>
                    <input
                      className="field"
                      type="number"
                      min="0"
                      step="0.0001"
                      placeholder="用于本地估算"
                      value={gatewaySettings.inputPriceCnyPer1K}
                      onChange={(e) => setGatewayValue("inputPriceCnyPer1K", e.target.value)}
                    />
                  </label>
                  <label className="config-field">
                    <span className="config-label-row">
                      <span>输出单价（元 / 1K tokens）</span>
                    </span>
                    <input
                      className="field"
                      type="number"
                      min="0"
                      step="0.0001"
                      placeholder="用于本地估算"
                      value={gatewaySettings.outputPriceCnyPer1K}
                      onChange={(e) => setGatewayValue("outputPriceCnyPer1K", e.target.value)}
                    />
                  </label>
                </div>

                <div className="gateway-rule-editor">
                  <div className="gateway-rule-head">
                    <div>
                      <strong>按模型估算价格规则</strong>
                      <span>第一条匹配规则优先；pattern 支持 *，例如 claude-* 或 gpt-4.1*</span>
                    </div>
                    <button className="btn btn-sm" type="button" onClick={addPriceRule}>
                      + 添加规则
                    </button>
                  </div>
                  {modelPriceRules.length === 0 ? (
                    <div className="sidebar-help">暂无模型规则。没有匹配规则时，会使用上面的默认估算单价。</div>
                  ) : (
                    <div className="gateway-rule-table">
                      <div className="gateway-rule-row header">
                        <span>启用</span>
                        <span>名称</span>
                        <span>模型匹配</span>
                        <span>输入元/1K</span>
                        <span>输出元/1K</span>
                        <span />
                      </div>
                      {modelPriceRules.map((rule, index) => (
                        <div className="gateway-rule-row" key={rule.id || index}>
                          <label className="toggle-cell">
                            <input type="checkbox" checked={rule.enabled !== false} onChange={(e) => setPriceRule(index, { enabled: e.target.checked })} />
                          </label>
                          <input className="field" value={rule.label} placeholder="Claude 系列" onChange={(e) => setPriceRule(index, { label: e.target.value })} />
                          <input className="field" value={rule.pattern} placeholder="claude-*" onChange={(e) => setPriceRule(index, { pattern: e.target.value })} />
                          <input
                            className="field"
                            type="number"
                            min="0"
                            step="0.0001"
                            value={rule.inputPriceCnyPer1K || ""}
                            onChange={(e) => setPriceRule(index, { inputPriceCnyPer1K: Number(e.target.value || 0) })}
                          />
                          <input
                            className="field"
                            type="number"
                            min="0"
                            step="0.0001"
                            value={rule.outputPriceCnyPer1K || ""}
                            onChange={(e) => setPriceRule(index, { outputPriceCnyPer1K: Number(e.target.value || 0) })}
                          />
                          <button className="btn btn-ghost btn-sm" type="button" onClick={() => removePriceRule(index)}>
                            删除
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="config-field-help">这里只用于本地预算提醒，不代表 TokenEZGO 实际价格；保存时会自动忽略没有填写模型匹配的空行。</div>
                </div>

                <div className="config-actions">
                  <button className="btn btn-primary btn-sm" type="button" onClick={saveGatewaySettings} disabled={savingGateway}>
                    {savingGateway ? "保存中..." : "保存预算设置"}
                  </button>
                  {gatewayMessage && <span className="save-state">{gatewayMessage}</span>}
                </div>

                <div className="gateway-notices">
                  {gatewayOverview.notices.map((notice) => (
                    <div key={notice}>{notice}</div>
                  ))}
                </div>

                <div className="gateway-price-table">
                  <div className="gateway-ledger-head">
                    <strong>价格表预览</strong>
                    <span>按顺序匹配模型名</span>
                  </div>
                  {gatewayOverview.priceTable.map((row) => (
                    <div className={`gateway-price-row ${row.enabled ? "" : "disabled"}`} key={row.id}>
                      <span>{row.label}</span>
                      <code>{row.pattern}</code>
                      <span>输入 ¥{row.inputPriceCnyPer1K}/1K</span>
                      <span>输出 ¥{row.outputPriceCnyPer1K}/1K</span>
                    </div>
                  ))}
                </div>

                {cloudAccount && (
                  <div className="gateway-cloud-box">
                    <div>
                      <strong>{cloudAccount.accountLabel}</strong>
                      <span>{cloudAccount.balanceLabel}</span>
                    </div>
                    <button className="btn btn-sm" type="button" onClick={() => window.open(cloudAccount.billingUrl, "_blank", "noopener,noreferrer")}>
                      打开 TokenEZGO
                    </button>
                    <div className="gateway-cloud-capabilities">
                      {cloudAccount.reservedCapabilities.map((item) => (
                        <span key={item}>{item}</span>
                      ))}
                    </div>
                    {cloudAccount.notes.map((note) => (
                      <p key={note}>{note}</p>
                    ))}
                  </div>
                )}

                <div className="gateway-ledger">
                  <div className="gateway-ledger-head">
                    <strong>最近本地用量</strong>
                    <span>真实扣费以 TokenEZGO 为准</span>
                  </div>
                  {gatewayOverview.recentRecords.length === 0 ? (
                    <div className="meta">暂无记录</div>
                  ) : (
                    gatewayOverview.recentRecords.map((record) => (
                      <div className="gateway-ledger-row" key={record.id}>
                        <span>{new Date(record.createdAt).toLocaleString("zh-CN", { hour12: false })}</span>
                        <span>{record.model}</span>
                        <span>{record.totalTokens} tokens</span>
                        <strong>¥{record.estimatedCostCny}</strong>
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
          </section>
        )}

        {agent.account && !agent.role && (
          <AccountSection
            agent={agent}
            onAgentsChanged={onAgentsChanged}
            onAgentCreated={onAgentCreated}
            onLoginChanged={refreshDiagnostics}
          />
        )}

        <section className="config-section diagnostic-section">
          <div className="config-section-head">
            <div>
              <h3>自动探测</h3>
              <p>检查 CLI / API / 登录状态 / 模型列表，判断这个 Agent 当前能不能直接用。</p>
            </div>
            <div className="config-tools">
              <button className="btn btn-sm" onClick={refreshDiagnostics} disabled={loadingDiagnostics}>
                {loadingDiagnostics ? "探测中..." : "重新探测"}
              </button>
            </div>
          </div>

          {loadingDiagnostics && !diagnostics && <div className="empty-state">正在探测...</div>}
          {!loadingDiagnostics && !diagnostics && <div className="empty-state">暂无探测结果</div>}
          {diagnostics && (
            <div className="diagnostic-panel">
              <div className="diagnostic-summary-row">
                <span className={`diagnostic-status ${diagnostics.status}`}>{diagnostics.status === "ok" ? "可用" : diagnostics.status === "warn" ? "需注意" : "不可用"}</span>
                <strong>{diagnostics.summary}</strong>
                <span className="meta">更新时间：{new Date(diagnostics.updatedAt).toLocaleTimeString()}</span>
              </div>

              <div className="diagnostic-stats">
                {diagnostics.models && (
                  <div className="diagnostic-stat">
                    <span>模型</span>
                    <strong>{diagnostics.models.count}</strong>
                    {diagnostics.models.sample.length > 0 && <small>{diagnostics.models.sample.join("、")}</small>}
                  </div>
                )}
                {diagnostics.subAgents && (
                  <div className="diagnostic-stat">
                    <span>子 Agent</span>
                    <strong>{diagnostics.subAgents.count}</strong>
                    {diagnostics.subAgents.sample.length > 0 && <small>{diagnostics.subAgents.sample.join("、")}</small>}
                  </div>
                )}
              </div>

              <div className="diagnostic-checks">
                {diagnostics.checks.map((check, index) => (
                  <div className="diagnostic-check" key={`${check.label}-${index}`}>
                    <span className={`check-dot ${check.status}`} />
                    <span className="check-label">{check.label}</span>
                    <span className="check-detail">{check.detail}</span>
                  </div>
                ))}
              </div>

              {diagnostics.usage && <div className="agent-usage-panel">{diagnostics.usage}</div>}

              {diagnostics.setupSteps.length > 0 && (
                <div className="setup-guide">
                  <div className="setup-guide-head">
                    <h4>配置向导</h4>
                    {actionMessage && <span className="save-state">{actionMessage}</span>}
                  </div>
                  {diagnostics.setupSteps.map((setupStep) => (
                    <div className="setup-step" key={setupStep.title}>
                      <div className="setup-step-main">
                        <span className={`check-dot ${setupStep.status}`} />
                        <div>
                          <strong>{setupStep.title}</strong>
                          <p>{setupStep.description}</p>
                        </div>
                      </div>
                      {setupStep.actions.length > 0 && (
                        <div className="setup-actions">
                          {setupStep.actions.map((action) => (
                            <button
                              className="btn btn-sm"
                              type="button"
                              key={`${setupStep.title}-${action.label}`}
                              title={action.description || action.value || action.url}
                              onClick={() => void runSetupAction(action)}
                            >
                              {action.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div className="diagnostic-next">
                <h4>下一步</h4>
                {diagnostics.nextSteps.map((step) => (
                  <div key={step}>{step}</div>
                ))}
              </div>
            </div>
          )}
        </section>

        <section className="config-section">
          <div className="config-section-head">
            <div>
              <h3>{agent.name}</h3>
              <p>{agent.description}</p>
            </div>
            <div className="config-tools">
              <button className="btn btn-ghost btn-sm" onClick={reloadConfig}>
                重新读取
              </button>
            </div>
          </div>

          {loading && <div className="empty-state">加载中...</div>}
          {!loading && error && <div className="login-error">{error}</div>}
          {!loading && config && !config.editable && <div className="empty-state">{config.note}</div>}

          {!loading && config?.editable && (
            <div className="config-form">
              {config.fields.map((field) => (
                <label className="config-field" key={field.key} data-config-field={field.key}>
                  <span className="config-label-row">
                    <span>{field.label}</span>
                    {field.type === "password" && field.hasValue && <span className="meta">已设置</span>}
                  </span>
                  {field.type === "select" ? (
                    <select className="field" value={values[field.key] ?? ""} onChange={(e) => setValue(field.key, e.target.value)}>
                      {field.options?.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  ) : field.key.includes("TEMPLATE") || field.key.includes("PROMPT") ? (
                    <textarea
                      className="field"
                      rows={field.key.includes("PROMPT") ? 4 : 3}
                      value={values[field.key] ?? ""}
                      placeholder={field.placeholder}
                      onChange={(e) => setValue(field.key, e.target.value)}
                    />
                  ) : (
                    <input
                      className="field"
                      type={field.type === "password" ? "password" : field.type === "number" ? "number" : "text"}
                      value={values[field.key] ?? ""}
                      placeholder={field.placeholder}
                      onChange={(e) => setValue(field.key, e.target.value)}
                    />
                  )}
                  {field.help && <span className="config-field-help">{field.help}</span>}
                  <span className="config-env-key">{field.key}</span>
                </label>
              ))}

              <div className="config-actions">
                <button className="btn btn-primary" onClick={save} disabled={saving}>
                  {saving ? "保存中..." : "保存配置"}
                </button>
                {saved && <span className="save-state">{saved}</span>}
              </div>
            </div>
          )}
        </section>

        {(agent.supportsModelSelection || agent.supportsUsage) && (
          <section className="config-section">
            <div className="config-section-head">
              <div>
                <h3>连接状态</h3>
                <p>模型和用量会按当前配置实时查询。</p>
              </div>
              <div className="config-tools">
                {agent.supportsUsage && (
                  <button className="btn btn-sm" onClick={queryUsage} disabled={usageWaiting}>
                    {usageWaiting ? "等待新快照..." : "查询用量"}
                  </button>
                )}
                {agent.supportsModelSelection && (
                  <button className="btn btn-sm" onClick={refreshModels} disabled={loadingModels}>
                    {loadingModels ? "刷新中..." : "刷新模型"}
                  </button>
                )}
              </div>
            </div>

            {usage !== undefined && (
              <div className="agent-usage-panel">{usage === null ? "查不到用量信息" : usage}</div>
            )}

            {agent.supportsModelSelection && (
              <div className="model-preview">
                {models.length === 0 && !loadingModels && <span className="meta">暂无模型结果</span>}
                {models.length > 0 && (
                  <>
                    <div className="model-count">共 {models.length} 个模型</div>
                    <div className="model-chip-list">
                      {models.slice(0, 24).map((model) => (
                        <span className="model-chip" key={model.id} title={model.id}>
                          {model.label}
                        </span>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </section>
        )}

        {agent.locked ? (
          <section className="config-section locked-section">
            <div className="config-section-head">
              <div>
                <h3>推荐接入保护</h3>
                <p>这个接入是 Xgent Hub 的推荐 API 中转站入口，会固定显示在 Agent 列表顶部，不能隐藏或删除。</p>
              </div>
            </div>
          </section>
        ) : (
          <section className="config-section danger-section">
            <div className="config-section-head">
              <div>
                <h3>危险操作</h3>
                <p>
                  {isAddedAccount
                    ? "删除这个账号。历史任务记录会保留；账号目录不会自动删除。"
                    : agent.custom
                    ? "删除这个自定义 Agent。历史任务记录会保留，但它不会再出现在左侧 Agent 列表里。"
                    : "隐藏这个内置 Agent。历史任务记录会保留，但它不会再出现在左侧 Agent 列表里。"}
                </p>
              </div>
              <div className="config-tools">
                <button className="btn btn-danger btn-sm" onClick={removeAgent} disabled={deleting}>
                  {deleting ? "处理中..." : isAddedAccount ? "删除账号" : agent.custom ? "删除 Agent" : "隐藏 Agent"}
                </button>
              </div>
            </div>
          </section>
        )}

        {config?.envPath && <div className="config-path">配置文件：{config.envPath}</div>}
      </div>
    </div>
  );
}
