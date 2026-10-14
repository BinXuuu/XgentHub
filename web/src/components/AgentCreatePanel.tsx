import { useState } from "react";
import type { AgentDescriptor, CreateCustomAgentInput, MachineConfigDiscovery, MachineConfigDiscoveryItem } from "../api/types";
import { api } from "../api/client";

type CustomTemplate = CreateCustomAgentInput["template"];

const CUSTOM_TEMPLATES: { value: CustomTemplate; label: string; desc: string }[] = [
  { value: "api", label: "API / 中转站", desc: "OpenAI 兼容接口：Base URL + API Key + 模型名" },
  { value: "cli", label: "通用 CLI", desc: "任意本机命令，通过参数模板把任务交给它" },
  { value: "codex-cli", label: "Codex CLI", desc: "预填 codex exec 模板，可继续改参数" },
  { value: "openclaw-cli", label: "OpenClaw CLI", desc: "预填 openclaw agent 模板；内置 OpenClaw 已在左侧，这里用于创建自定义副本" },
  { value: "claude-code-cli", label: "Claude Code CLI", desc: "预填 claude headless 模板，可手动选择模型" },
  { value: "antigravity-cli", label: "Antigravity CLI", desc: "预填 agy headless 模板，只需要选模型" },
];

const CLI_TEMPLATE_HINT =
  "占位符：{prompt}=含工作区说明的完整任务，{rawPrompt}=原始输入，{workspace}=工作区路径，{accessPaths}=允许空间列表，{addDirArgs}=自动展开为 --add-dir 参数，{model}=模型，{session}=会话 id。";
const CLI_STDIN_HINT = "可选。CLI 支持从 stdin 读取任务时填 {prompt}；参数模板里通常保留 - 作为 stdin 占位。";
const DISCOVERY_TEMPLATE_BY_AGENT: Partial<Record<string, CustomTemplate>> = {
  codex: "codex-cli",
  openclaw: "openclaw-cli",
  "claude-code": "claude-code-cli",
  antigravity: "antigravity-cli",
};

function defaultsForTemplate(template: CustomTemplate): CreateCustomAgentInput {
  if (template === "api") {
    return { template, name: "自定义 API", baseUrl: "https://api.example.com/v1", apiKey: "", defaultModel: "" };
  }
  if (template === "codex-cli") {
    return {
      template,
      name: "自定义 Codex",
      command: "codex",
      argsTemplate: "exec --sandbox workspace-write --skip-git-repo-check {addDirArgs} -C {workspace} -",
      stdinTemplate: "{prompt}",
      modelArgTemplate: "-m {model}",
      defaultModel: "",
    };
  }
  if (template === "openclaw-cli") {
    return {
      template,
      name: "自定义 OpenClaw",
      command: "openclaw",
      argsTemplate: "agent --session-key {session} --message {prompt} --json",
      modelArgTemplate: "--model {model}",
      defaultModel: "",
    };
  }
  if (template === "claude-code-cli") {
    return {
      template,
      name: "自定义 Claude Code",
      command: "claude",
      argsTemplate: "--print --output-format stream-json --verbose {addDirArgs}",
      stdinTemplate: "{prompt}",
      modelArgTemplate: "--model {model}",
      defaultModel: "",
    };
  }
  if (template === "antigravity-cli") {
    return {
      template,
      name: "自定义 Antigravity",
      command: "agy",
      argsTemplate: "--add-dir {workspace} {addDirArgs} --output-format json --print-timeout 15m -p {prompt}",
      modelArgTemplate: "--model {model}",
      defaultModel: "",
    };
  }
  return { template, name: "自定义 CLI", command: "", argsTemplate: "{prompt}", stdinTemplate: "", modelArgTemplate: "", defaultModel: "" };
}

interface Props {
  onBack: () => void;
  onCreated: (agent: AgentDescriptor) => void;
}

export function AgentCreatePanel({ onBack, onCreated }: Props) {
  const [template, setTemplate] = useState<CustomTemplate>("api");
  const [values, setValues] = useState<CreateCustomAgentInput>(() => defaultsForTemplate("api"));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discovery, setDiscovery] = useState<MachineConfigDiscovery | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const selectedTemplate = CUSTOM_TEMPLATES.find((item) => item.value === template);
  const isApi = template === "api";

  function changeTemplate(next: CustomTemplate) {
    setTemplate(next);
    setValues(defaultsForTemplate(next));
    setError(null);
  }

  function setField<K extends keyof CreateCustomAgentInput>(key: K, value: CreateCustomAgentInput[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  async function scanLocalAgents() {
    setDiscovering(true);
    setDiscoveryError(null);
    try {
      setDiscovery(await api.getMachineConfigDiscovery());
    } catch (err) {
      setDiscoveryError((err as Error).message);
    } finally {
      setDiscovering(false);
    }
  }

  function applyDiscoveryItem(item: MachineConfigDiscoveryItem) {
    const nextTemplate = item.agentId ? DISCOVERY_TEMPLATE_BY_AGENT[item.agentId] : undefined;
    if (!nextTemplate) return;
    const defaults = defaultsForTemplate(nextTemplate);
    setTemplate(nextTemplate);
    setValues({
      ...defaults,
      name: `自定义 ${item.label.replace(/\s*CLI$/, "")}`,
      command: item.discoveredValue || defaults.command,
    });
    setError(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const created = await api.createCustomAgent({ ...values, template });
      onCreated(created);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="detail-pane agent-create-pane">
      <div className="detail-header">
        <div className="title-row">
          <button className="btn btn-ghost btn-sm back-btn" onClick={onBack}>
            ← 返回
          </button>
          <h2>新增 Agent</h2>
          <span className="config-state warn">自定义接入</span>
        </div>
        <div className="meta-row">
          <span>选择一种接入方式，然后填写右侧配置。创建后会出现在左侧 Agent 列表里。</span>
        </div>
      </div>

      <div className="agent-config-content">
        <section className="config-section">
          <div className="config-section-head">
            <div>
              <h3>本机发现</h3>
              <p>扫描 PATH、常见安装目录和本地服务。内置 Agent 已经在左侧列表里；这里主要用于快速创建第二套自定义 CLI 接入。</p>
            </div>
            <div className="config-tools">
              <button className="btn btn-sm" type="button" onClick={scanLocalAgents} disabled={discovering}>
                {discovering ? "扫描中..." : "扫描本机"}
              </button>
            </div>
          </div>

          {discoveryError && <div className="login-error">{discoveryError}</div>}
          {!discovery && !discoveryError && <div className="sidebar-help">还没有扫描结果。点击“扫描本机”后，会列出 Codex、OpenClaw、Antigravity、Claude Code、Ark CLI、Ollama 等基础配置。</div>}
          {discovery && (
            <div className="machine-config-list compact">
              {discovery.items
                .filter((item) => item.agentId || item.id === "ollama-base-url")
                .map((item) => {
                  const canApply = item.agentId ? Boolean(DISCOVERY_TEMPLATE_BY_AGENT[item.agentId]) : false;
                  return (
                    <div className={`machine-config-row ${item.status}`} key={item.id}>
                      <div className="machine-config-main">
                        <span className={`check-dot ${item.status === "not_found" ? "error" : item.status === "manual" ? "warn" : "ok"}`} />
                        <strong>{item.label}</strong>
                        <span>{item.status === "not_found" ? "未发现" : item.status === "manual" ? "手动配置" : item.status === "configured" ? "已配置" : "可套用"}</span>
                      </div>
                      <div className="machine-config-values">
                        <div>
                          <span>当前</span>
                          <code>{item.currentValue || "(空)"}</code>
                        </div>
                        <div>
                          <span>发现</span>
                          <code>{item.discoveredValue || "(无)"}</code>
                        </div>
                      </div>
                      <p>{canApply ? "可用发现到的路径预填自定义 CLI 模板。" : item.note}</p>
                      {canApply && (
                        <div className="wizard-callout-actions">
                          <button className="btn btn-sm" type="button" onClick={() => applyDiscoveryItem(item)}>
                            套用模板
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          )}
        </section>

        <section className="config-section">
          <div className="config-section-head">
            <div>
              <h3>接入类型</h3>
              <p>API 适合中转站和模型服务；CLI 适合像 Codex / OpenClaw / Antigravity 这种本机命令。</p>
            </div>
          </div>

          <div className="agent-template-grid">
            {CUSTOM_TEMPLATES.map((item) => (
              <button
                className={`agent-template-card ${template === item.value ? "selected" : ""}`}
                key={item.value}
                type="button"
                onClick={() => changeTemplate(item.value)}
              >
                <strong>{item.label}</strong>
                <span>{item.desc}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="config-section">
          <div className="config-section-head">
            <div>
              <h3>{selectedTemplate?.label ?? "接入配置"}</h3>
              <p>{selectedTemplate?.desc}</p>
            </div>
          </div>

          <form className="config-form agent-create-form" onSubmit={submit}>
            <label className="config-field">
              <span className="config-label-row">
                <span>名称</span>
              </span>
              <input className="field" value={values.name ?? ""} onChange={(e) => setField("name", e.target.value)} />
            </label>

            {isApi ? (
              <>
                <label className="config-field">
                  <span className="config-label-row">
                    <span>Base URL</span>
                  </span>
                  <input
                    className="field"
                    placeholder="https://api.example.com/v1"
                    value={values.baseUrl ?? ""}
                    onChange={(e) => setField("baseUrl", e.target.value)}
                  />
                  <span className="config-field-help">API 模式默认调用 /chat/completions，刷新模型时调用 /models。</span>
                </label>
                <label className="config-field">
                  <span className="config-label-row">
                    <span>API Key</span>
                  </span>
                  <input
                    className="field"
                    type="password"
                    placeholder="sk-..."
                    value={values.apiKey ?? ""}
                    onChange={(e) => setField("apiKey", e.target.value)}
                  />
                </label>
                <label className="config-field">
                  <span className="config-label-row">
                    <span>默认模型</span>
                  </span>
                  <input
                    className="field"
                    placeholder="例如 gpt-4.1 / claude-sonnet-4-5"
                    value={values.defaultModel ?? ""}
                    onChange={(e) => setField("defaultModel", e.target.value)}
                  />
                </label>
              </>
            ) : (
              <>
                <label className="config-field">
                  <span className="config-label-row">
                    <span>CLI 命令 / exe 路径</span>
                  </span>
                  <input
                    className="field"
                    placeholder="codex / openclaw / C:\\path\\tool.exe"
                    value={values.command ?? ""}
                    onChange={(e) => setField("command", e.target.value)}
                  />
                </label>
                <label className="config-field">
                  <span className="config-label-row">
                    <span>参数模板</span>
                  </span>
                  <textarea
                    className="field"
                    rows={4}
                    value={values.argsTemplate ?? ""}
                    onChange={(e) => setField("argsTemplate", e.target.value)}
                  />
                  <span className="config-field-help">{CLI_TEMPLATE_HINT}</span>
                </label>
                <label className="config-field">
                  <span className="config-label-row">
                    <span>标准输入模板</span>
                  </span>
                  <textarea
                    className="field"
                    rows={3}
                    value={values.stdinTemplate ?? ""}
                    onChange={(e) => setField("stdinTemplate", e.target.value)}
                  />
                  <span className="config-field-help">{CLI_STDIN_HINT}</span>
                </label>
                <label className="config-field">
                  <span className="config-label-row">
                    <span>默认模型</span>
                  </span>
                  <input
                    className="field"
                    placeholder="可留空，或填 CLI 支持的模型名"
                    value={values.defaultModel ?? ""}
                    onChange={(e) => setField("defaultModel", e.target.value)}
                  />
                </label>
                <label className="config-field">
                  <span className="config-label-row">
                    <span>模型参数模板</span>
                  </span>
                  <input
                    className="field"
                    placeholder="例如 -m {model} 或 --model {model}"
                    value={values.modelArgTemplate ?? ""}
                    onChange={(e) => setField("modelArgTemplate", e.target.value)}
                  />
                </label>
              </>
            )}

            {error && <div className="login-error">{error}</div>}
            <div className="config-actions">
              <button className="btn btn-primary" type="submit" disabled={saving || !values.name?.trim()}>
                {saving ? "创建中..." : "创建 Agent"}
              </button>
              <button className="btn btn-ghost" type="button" onClick={onBack}>
                取消
              </button>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}
