import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { copyText } from "../utils/clipboard";
import type {
  AgentDiagnosticStatus,
  ConfigExportResult,
  MachineConfigApplyResult,
  MachineConfigDiscovery,
  MachineConfigDiscoveryStatus,
  OnboardingOverview,
  PostInstallStatus,
  RemoteAccessStatus,
  ShortcutStatus,
  StartupTaskStatus,
  SystemCommandResult,
  SystemPathKind,
} from "../api/types";

interface Props {
  onBack: () => void;
  onSelectAgent: (agentId: string) => void;
  onCreateAgent: () => void;
  onCreateTask: () => void;
  initialStep?: WizardStepId;
}

type WizardStepId = "doctor" | "migration" | "machine" | "agents" | "startup" | "test" | "finish";

const STATUS_LABEL: Record<AgentDiagnosticStatus, string> = {
  ok: "可用",
  warn: "需配置",
  error: "不可用",
};

const WIZARD_STEPS: { id: WizardStepId; title: string; desc: string }[] = [
  { id: "doctor", title: "1. 环境自检", desc: "检查 Node、依赖、脚本、常见 CLI 和本地服务。" },
  { id: "migration", title: "2. 配置迁移", desc: "导出或导入 Xgent Hub 配置，密钥默认不打包。" },
  { id: "machine", title: "3. 本机发现", desc: "自动发现 CLI 路径和本地服务，并写入缺失配置。" },
  { id: "agents", title: "4. 添加 Agent", desc: "把 CLI、API 中转站和本地模型服务接进来。" },
  { id: "startup", title: "5. 开机启动", desc: "为这台电脑安装或移除后台启动任务。" },
  { id: "test", title: "6. 创建任务测试", desc: "用一个短任务确认模型、工作区和审批链路。" },
  { id: "finish", title: "7. 安装收尾", desc: "重启服务、打开日志/备份目录，确认安装后的下一步。" },
];

const MACHINE_STATUS_LABEL: Record<MachineConfigDiscoveryStatus, string> = {
  configured: "已配置",
  recommended: "建议写入",
  different: "可覆盖",
  not_found: "未发现",
  manual: "手动配置",
};

function formatTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function statusClass(status: AgentDiagnosticStatus): string {
  return `diagnostic-status ${status}`;
}

function commandText(result: SystemCommandResult | null): string {
  if (!result) return "";
  const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n\n");
  return output || "没有输出。";
}

interface DoctorFinding {
  level: "FAIL" | "WARN";
  name: string;
  text: string;
}

// doctor.ps1 的输出是英文、一行一项；把要处理的 FAIL/WARN 挑出来，翻成一句中文放在最上面。
function doctorFindings(output: string): { findings: DoctorFinding[]; passCount: number } {
  const findings: DoctorFinding[] = [];
  let passCount = 0;
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\[(PASS|WARN|FAIL)\]\s+(.+?)\s+-\s+(.*)$/);
    if (!match) continue;
    const [, level, name, detail] = match;
    if (level === "PASS") {
      passCount += 1;
      continue;
    }
    findings.push({ level: level as DoctorFinding["level"], name, text: explainDoctorLine(name, detail) });
  }
  return { findings, passCount };
}

function explainDoctorLine(name: string, detail: string): string {
  const cli = name.match(/^(.+) CLI$/);
  if (cli && /Not found/i.test(detail)) return `没找到 ${cli[1]} 的命令行工具。不用这个 Agent 可以忽略；要用的话到 Agent 配置页按步骤安装。`;
  if (name === "ADMIN_TOKEN") return "登录令牌没设置：任何能打开这个端口的人都能直接使用。在安装目录的 .env 里设置 ADMIN_TOKEN。";
  if (name === "Xgent Hub health") return "Xgent Hub 服务没在运行（或 .env 里的端口不对）。";
  if (name === "Web build") return "网页还没构建：在安装目录运行 npm run build。";
  if (name === "Dependencies") return "依赖没装：在安装目录运行 npm install。";
  if (name === "Data backup") return `数据备份：${detail}`;
  if (name === "Ollama API") return "Ollama 服务没在运行。不用本地模型可以忽略。";
  if (name === "HOST") return `监听地址：${detail}`;
  return `${name}：${detail}`;
}

function commandStatus(result: SystemCommandResult | null): AgentDiagnosticStatus {
  if (!result) return "warn";
  return result.ok ? "ok" : "error";
}

export function OnboardingPanel({ onBack, onSelectAgent, onCreateAgent, onCreateTask, initialStep = "doctor" }: Props) {
  const [overview, setOverview] = useState<OnboardingOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeStep, setActiveStep] = useState<WizardStepId>(initialStep);
  const [doctorResult, setDoctorResult] = useState<SystemCommandResult | null>(null);
  const [doctorRunning, setDoctorRunning] = useState(false);
  const [exportResult, setExportResult] = useState<ConfigExportResult | null>(null);
  const [exportRunning, setExportRunning] = useState(false);
  const [importBundlePath, setImportBundlePath] = useState("");
  const [restoreSecrets, setRestoreSecrets] = useState(false);
  const [restoreDatabase, setRestoreDatabase] = useState(false);
  const [importResult, setImportResult] = useState<SystemCommandResult | null>(null);
  const [importRunning, setImportRunning] = useState(false);
  const [bundlePicking, setBundlePicking] = useState(false);
  const [machineConfig, setMachineConfig] = useState<MachineConfigDiscovery | null>(null);
  const [machineConfigRunning, setMachineConfigRunning] = useState(false);
  const [machineApplyResult, setMachineApplyResult] = useState<MachineConfigApplyResult | null>(null);
  const [startupStatus, setStartupStatus] = useState<StartupTaskStatus | null>(null);
  const [startupRunning, setStartupRunning] = useState(false);
  const [shortcutStatus, setShortcutStatus] = useState<ShortcutStatus | null>(null);
  const [shortcutRunning, setShortcutRunning] = useState(false);
  const [shortcutResult, setShortcutResult] = useState<SystemCommandResult | null>(null);
  const [postInstallStatus, setPostInstallStatus] = useState<PostInstallStatus | null>(null);
  const [postInstallRunning, setPostInstallRunning] = useState(false);
  const [remoteAccessStatus, setRemoteAccessStatus] = useState<RemoteAccessStatus | null>(null);
  const [remoteAccessRunning, setRemoteAccessRunning] = useState(false);
  const [systemActionResult, setSystemActionResult] = useState<SystemCommandResult | null>(null);
  const [systemActionRunning, setSystemActionRunning] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [nextOverview, nextStartup, nextShortcuts, nextPostInstall, nextMachineConfig, nextRemoteAccess] = await Promise.all([
        api.getOnboardingOverview(),
        api.getStartupTaskStatus().catch(() => null),
        api.getShortcutStatus().catch(() => null),
        api.getPostInstallStatus().catch(() => null),
        api.getMachineConfigDiscovery().catch(() => null),
        api.getRemoteAccessStatus().catch(() => null),
      ]);
      setOverview(nextOverview);
      setStartupStatus(nextStartup);
      setShortcutStatus(nextShortcuts);
      setPostInstallStatus(nextPostInstall);
      setMachineConfig(nextMachineConfig);
      setRemoteAccessStatus(nextRemoteAccess);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function runDoctor() {
    setDoctorRunning(true);
    try {
      setDoctorResult(await api.runDoctor());
    } finally {
      setDoctorRunning(false);
    }
  }

  async function exportConfig() {
    setExportRunning(true);
    try {
      const result = await api.exportSafeConfig();
      setExportResult(result);
      if (result.zipPath) setImportBundlePath(result.zipPath);
    } finally {
      setExportRunning(false);
    }
  }

  async function importConfig() {
    setImportRunning(true);
    try {
      setImportResult(
        await api.importConfig({
          bundlePath: importBundlePath,
          restoreSecrets,
          restoreDatabase,
        })
      );
      await load();
    } finally {
      setImportRunning(false);
    }
  }

  async function pickImportBundle() {
    const startedAt = new Date().toISOString();
    setBundlePicking(true);
    try {
      const result = await api.pickConfigBundle();
      if (result.path) setImportBundlePath(result.path);
    } catch (err) {
      setImportResult({
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: (err as Error).message,
        startedAt,
        finishedAt: new Date().toISOString(),
      });
    } finally {
      setBundlePicking(false);
    }
  }

  async function refreshMachineConfig() {
    setMachineConfigRunning(true);
    try {
      setMachineConfig(await api.getMachineConfigDiscovery());
    } finally {
      setMachineConfigRunning(false);
    }
  }

  async function applyMachineConfig(overwrite = false) {
    setMachineConfigRunning(true);
    try {
      const result = await api.applyMachineConfig({ overwrite });
      setMachineApplyResult(result);
      setMachineConfig(result.discovery);
      await load();
    } finally {
      setMachineConfigRunning(false);
    }
  }

  async function refreshStartupTask() {
    setStartupStatus(await api.getStartupTaskStatus());
  }

  async function installStartupTask() {
    setStartupRunning(true);
    try {
      await api.installStartupTask();
      await refreshStartupTask();
    } finally {
      setStartupRunning(false);
    }
  }

  async function uninstallStartupTask() {
    setStartupRunning(true);
    try {
      await api.uninstallStartupTask();
      await refreshStartupTask();
    } finally {
      setStartupRunning(false);
    }
  }

  async function refreshShortcuts() {
    setShortcutStatus(await api.getShortcutStatus());
    setPostInstallStatus(await api.getPostInstallStatus().catch(() => null));
  }

  async function installShortcuts() {
    setShortcutRunning(true);
    try {
      setShortcutResult(await api.installShortcuts());
      await refreshShortcuts();
    } finally {
      setShortcutRunning(false);
    }
  }

  async function uninstallShortcuts() {
    setShortcutRunning(true);
    try {
      setShortcutResult(await api.uninstallShortcuts());
      await refreshShortcuts();
    } finally {
      setShortcutRunning(false);
    }
  }

  async function refreshPostInstallStatus() {
    setPostInstallRunning(true);
    try {
      setPostInstallStatus(await api.getPostInstallStatus());
    } finally {
      setPostInstallRunning(false);
    }
  }

  async function refreshRemoteAccessStatus() {
    setRemoteAccessRunning(true);
    try {
      setRemoteAccessStatus(await api.getRemoteAccessStatus());
    } finally {
      setRemoteAccessRunning(false);
    }
  }

  async function requestRestart() {
    setSystemActionRunning(true);
    try {
      setSystemActionResult(await api.restartAgentHub());
    } finally {
      setSystemActionRunning(false);
    }
  }

  async function openPath(kind: SystemPathKind) {
    setSystemActionRunning(true);
    try {
      setSystemActionResult(await api.openSystemPath({ kind }));
    } finally {
      setSystemActionRunning(false);
    }
  }

  async function copyWithLabel(label: string, text: string) {
    const ok = await copyText(text);
    setCopied(ok ? `已复制：${label}` : `复制失败，请手动选择复制：${text}`);
    window.setTimeout(() => setCopied(null), ok ? 1800 : 8000);
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    setActiveStep(initialStep);
  }, [initialStep]);

  const agentNameLookup = useMemo(() => {
    const map = new Map<string, string>();
    overview?.agents.forEach((item) => map.set(item.agent.id, item.agent.name));
    return map;
  }, [overview]);

  const usableAgents = overview?.agents.filter((item) => item.diagnostics.status !== "error") ?? [];
  const failingAgents = overview?.agents.filter((item) => item.diagnostics.status === "error") ?? [];
  const importCommand = "xgent.bat import-config -BundlePath D:\\path\\XgentHub-config.zip";
  const trustedImportCommand = "xgent.bat import-config -BundlePath D:\\path\\XgentHub-config.zip -RestoreSecrets";
  const recommendedMachineItems = machineConfig?.items.filter((item) => item.status === "recommended") ?? [];
  const differentMachineItems = machineConfig?.items.filter((item) => item.status === "different") ?? [];
  const activeStepIndex = Math.max(0, WIZARD_STEPS.findIndex((step) => step.id === activeStep));
  const previousStep = WIZARD_STEPS[activeStepIndex - 1];
  const nextStep = WIZARD_STEPS[activeStepIndex + 1];
  const postInstallCounts = (postInstallStatus?.checks ?? []).reduce(
    (counts, item) => {
      counts[item.status] += 1;
      return counts;
    },
    { ok: 0, warn: 0, error: 0 } as Record<AgentDiagnosticStatus, number>
  );
  const machineActionCount = machineConfig?.summary.applicable ?? 0;
  const installIssueCount = postInstallCounts.warn + postInstallCounts.error;
  const nextSetupAction = overview?.counts.error
    ? {
        status: "error" as AgentDiagnosticStatus,
        title: `${overview.counts.error} 个 Agent 不可用`,
        description: "先打开 Agent 配置，补齐 CLI 路径、API 地址或密钥。",
        step: "agents" as WizardStepId,
      }
    : machineActionCount > 0
      ? {
          status: "warn" as AgentDiagnosticStatus,
          title: `${machineActionCount} 项本机配置可写入`,
          description: "把自动发现到的 CLI 路径和本地服务地址写入配置。",
          step: "machine" as WizardStepId,
        }
      : installIssueCount > 0
        ? {
            status: "warn" as AgentDiagnosticStatus,
            title: `${installIssueCount} 个安装项待确认`,
            description: "检查快捷方式、开机启动、生产服务和常用目录状态。",
            step: "finish" as WizardStepId,
          }
        : {
            status: "ok" as AgentDiagnosticStatus,
            title: "基础配置已就绪",
            description: "可以创建一个短任务，验证模型、工作区和审批链路。",
            step: "test" as WizardStepId,
          };
  const nextStepLabel = nextStep?.title.replace(/^\d+\.\s*/, "") ?? "完成";

  return (
    <div className="detail-pane onboarding-pane">
      <div className="detail-header">
        <div className="title-row">
          <button className="btn btn-ghost btn-sm back-btn" onClick={onBack}>
            ← 返回
          </button>
          <h2>配置中心</h2>
          <span className="config-state warn">首次启动向导</span>
        </div>
        <div className="meta-row">
          <span>把新电脑从自检、迁移、Agent 接入、开机启动一路串到可测试状态。</span>
          {overview && <span>更新于 {formatTime(overview.updatedAt)}</span>}
        </div>
      </div>

      <div className="onboarding-content">
        <div className="onboarding-actions">
          <button className="btn btn-primary" onClick={load} disabled={loading}>
            {loading ? "扫描中..." : "重新扫描"}
          </button>
          <button className="btn" onClick={onCreateAgent}>
            + 添加 Agent
          </button>
        </div>

        {error && <div className="login-error">配置中心加载失败：{error}</div>}
        {loading && !overview && <div className="onboarding-loading">正在扫描本机 Agent、CLI 和模型列表，这可能需要几十秒...</div>}

        {overview && (
          <section className="onboarding-command-center">
            <div className="onboarding-next-action">
              <span className={statusClass(nextSetupAction.status)}>{STATUS_LABEL[nextSetupAction.status]}</span>
              <div>
                <strong>{nextSetupAction.title}</strong>
                <p>{nextSetupAction.description}</p>
              </div>
              <button className="btn btn-primary btn-sm" onClick={() => setActiveStep(nextSetupAction.step)}>
                处理
              </button>
            </div>
            <div className="onboarding-health-strip">
              <button type="button" onClick={() => setActiveStep("agents")}>
                <span>Agent</span>
                <strong>{overview.counts.ok}/{overview.counts.total} 可用</strong>
                <small>{overview.counts.error > 0 ? `${overview.counts.error} 个不可用` : `${overview.counts.warn} 个需配置`}</small>
              </button>
              <button type="button" onClick={() => setActiveStep("machine")}>
                <span>本机发现</span>
                <strong>{machineConfig ? `${machineConfig.summary.configured} 已配置` : "未读取"}</strong>
                <small>{machineConfig ? `${machineActionCount} 项可应用` : "等待扫描"}</small>
              </button>
              <button type="button" onClick={() => setActiveStep("finish")}>
                <span>安装收尾</span>
                <strong>{postInstallStatus ? `${postInstallCounts.ok}/${postInstallStatus.checks.length} 通过` : "未读取"}</strong>
                <small>{postInstallStatus ? `${installIssueCount} 项待确认` : "等待检查"}</small>
              </button>
            </div>
          </section>
        )}

        <section className="config-section onboarding-section">
          <div className="config-section-head">
            <div>
              <h3>向导流程</h3>
              <p>按步骤处理新机器初始化；需要高权限或账号登录的动作仍然由你确认。</p>
            </div>
          </div>
          <div className="wizard-layout">
            <div className="wizard-step-list">
              {WIZARD_STEPS.map((step) => (
                <button
                  className={`wizard-step-button ${activeStep === step.id ? "active" : ""}`}
                  key={step.id}
                  onClick={() => setActiveStep(step.id)}
                  type="button"
                >
                  <strong>{step.title}</strong>
                  <span>{step.desc}</span>
                </button>
              ))}
            </div>

            <div className="wizard-panel">
              {activeStep === "doctor" && (
                <>
                  <div className="wizard-panel-head">
                    <div>
                      <h4>环境自检</h4>
                      <p>运行项目内的 doctor，不会改配置，只读取环境和服务状态。</p>
                    </div>
                    <button className="btn btn-primary" disabled={doctorRunning} onClick={runDoctor}>
                      {doctorRunning ? "检查中..." : "运行自检"}
                    </button>
                  </div>
                  {doctorResult && (
                    <>
                      <div className="diagnostic-summary-row">
                        <span className={statusClass(commandStatus(doctorResult))}>{doctorResult.ok ? "通过" : "失败"}</span>
                        <span>退出码 {doctorResult.exitCode ?? "未知"}</span>
                        <span>完成于 {formatTime(doctorResult.finishedAt)}</span>
                      </div>
                      {(() => {
                        const { findings, passCount } = doctorFindings(commandText(doctorResult));
                        return (
                          <div className="doctor-findings">
                            {findings.length === 0 ? (
                              <p className="doctor-findings-ok">{passCount} 项检查全部通过。</p>
                            ) : (
                              <>
                                <p>
                                  {passCount} 项通过，{findings.length} 项需要看一下：
                                </p>
                                <ul>
                                  {findings.map((item) => (
                                    <li key={item.name} className={item.level === "FAIL" ? "error" : "warn"}>
                                      <span className={statusClass(item.level === "FAIL" ? "error" : "warn")}>
                                        {item.level === "FAIL" ? "必须处理" : "注意"}
                                      </span>
                                      {item.text}
                                    </li>
                                  ))}
                                </ul>
                              </>
                            )}
                          </div>
                        );
                      })()}
                      <details className="doctor-raw">
                        <summary>查看完整自检输出</summary>
                        <pre className="wizard-output">{commandText(doctorResult)}</pre>
                      </details>
                    </>
                  )}
                </>
              )}

              {activeStep === "migration" && (
                <>
                  <div className="wizard-panel-head">
                    <div>
                      <h4>配置迁移</h4>
                      <p>默认只生成安全配置包，API Key 和 Token 会被打码。</p>
                    </div>
                    <button className="btn btn-primary" disabled={exportRunning} onClick={exportConfig}>
                      {exportRunning ? "生成中..." : "生成安全配置包"}
                    </button>
                  </div>
                  <div className="wizard-path-grid">
                    <button className="wizard-path-card" type="button" onClick={() => setActiveStep("machine")}>
                      <strong>新电脑快速接入</strong>
                      <span>没有旧配置包时，先自动发现 CLI 路径和本地服务。</span>
                    </button>
                    <button className="wizard-path-card" type="button" onClick={() => document.getElementById("import-bundle-path")?.focus()}>
                      <strong>从旧电脑恢复</strong>
                      <span>把旧机器导出的 zip 路径填进来，再选择是否恢复密钥。</span>
                    </button>
                    <button className="wizard-path-card" type="button" disabled={exportRunning} onClick={exportConfig}>
                      <strong>把当前电脑做成模板</strong>
                      <span>导出安全配置包，后续复制到其他电脑快速导入。</span>
                    </button>
                  </div>
                  {exportResult && (
                    <div className="wizard-callout">
                      <strong>{exportResult.ok ? "已生成配置包" : "生成失败"}</strong>
                      <span>{exportResult.zipPath ?? exportResult.bundlePath}</span>
                      {exportResult.ok && (
                        <div className="wizard-callout-actions">
                          <button className="btn btn-sm" disabled={systemActionRunning} onClick={() => openPath("backups")}>
                            打开导出目录
                          </button>
                          {exportResult.zipPath && (
                            <button className="btn btn-sm" onClick={() => copyWithLabel("配置包路径", exportResult.zipPath ?? "")}>
                              复制路径
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                  <div className="wizard-import-box">
                    <label className="field-label" htmlFor="import-bundle-path">
                      导入配置包路径
                    </label>
                    <div className="wizard-inline-form">
                      <input
                        id="import-bundle-path"
                        className="field"
                        value={importBundlePath}
                        onChange={(event) => setImportBundlePath(event.target.value)}
                        placeholder="D:\path\XgentHub-config-xxxx.zip"
                      />
                      <button className="btn" disabled={bundlePicking || importRunning} onClick={pickImportBundle}>
                        {bundlePicking ? "选择中..." : "选择配置包"}
                      </button>
                      <button className="btn btn-primary" disabled={importRunning || !importBundlePath.trim()} onClick={importConfig}>
                        {importRunning ? "导入中..." : "导入配置"}
                      </button>
                    </div>
                    <div className="wizard-checkbox-row">
                      <label>
                        <input type="checkbox" checked={restoreSecrets} onChange={(event) => setRestoreSecrets(event.target.checked)} />
                        恢复密钥
                      </label>
                      <label>
                        <input type="checkbox" checked={restoreDatabase} onChange={(event) => setRestoreDatabase(event.target.checked)} />
                        恢复任务数据库
                      </label>
                    </div>
                    <p className="wizard-note">导入前会把当前 `.env` 和 Agent JSON 备份到 `backups/import-before-*`。</p>
                  </div>
                  {importResult && (
                    <>
                      <div className="diagnostic-summary-row">
                        <span className={statusClass(commandStatus(importResult))}>{importResult.ok ? "导入完成" : "导入失败"}</span>
                        <span>退出码 {importResult.exitCode ?? "未知"}</span>
                        <span>完成于 {formatTime(importResult.finishedAt)}</span>
                      </div>
                      <pre className="wizard-output compact">{commandText(importResult)}</pre>
                    </>
                  )}
                  <div className="wizard-command-list">
                    <div>
                      <strong>导入安全配置包</strong>
                      <code>{importCommand}</code>
                      <button className="btn btn-sm" onClick={() => copyWithLabel("导入命令", importCommand)}>
                        复制命令
                      </button>
                    </div>
                    <div>
                      <strong>个人可信迁移包</strong>
                      <code>{trustedImportCommand}</code>
                      <button className="btn btn-sm" onClick={() => copyWithLabel("可信迁移命令", trustedImportCommand)}>
                        复制命令
                      </button>
                    </div>
                  </div>
                  {copied && <div className="save-state">{copied}</div>}
                </>
              )}

              {activeStep === "machine" && (
                <>
                  <div className="wizard-panel-head">
                    <div>
                      <h4>本机配置发现</h4>
                      <p>扫描 PATH、常见安装目录和本地服务，把 Codex、OpenClaw、Claude Code、Antigravity、Ollama 等基础配置写入 `.env`。</p>
                    </div>
                    <button className="btn" disabled={machineConfigRunning} onClick={refreshMachineConfig}>
                      {machineConfigRunning ? "扫描中..." : "重新发现"}
                    </button>
                  </div>

                  {machineConfig ? (
                    <>
                      <div className="machine-summary">
                        <span>已配置 {machineConfig.summary.configured}</span>
                        <span>建议写入 {machineConfig.summary.recommended}</span>
                        <span>可覆盖 {machineConfig.summary.different}</span>
                        <span>未发现 {machineConfig.summary.notFound}</span>
                        <span>手动项 {machineConfig.summary.manual}</span>
                      </div>

                      <div className="machine-config-list">
                        {machineConfig.items.map((item) => (
                          <div className={`machine-config-row ${item.status}`} key={item.id}>
                            <div className="machine-config-main">
                              <span className={`diagnostic-status ${item.status === "not_found" ? "error" : item.status === "configured" ? "ok" : "warn"}`}>
                                {MACHINE_STATUS_LABEL[item.status]}
                              </span>
                              <strong>{item.label}</strong>
                              <span>{item.envKey}</span>
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
                            <p>{item.note}{item.source ? ` 来源：${item.source}` : ""}</p>
                          </div>
                        ))}
                      </div>

                      <div className="wizard-actions-row">
                        <button
                          className="btn btn-primary"
                          disabled={machineConfigRunning || recommendedMachineItems.length === 0}
                          onClick={() => applyMachineConfig(false)}
                        >
                          应用推荐配置
                        </button>
                        <button
                          className="btn"
                          disabled={machineConfigRunning || differentMachineItems.length === 0}
                          onClick={() => applyMachineConfig(true)}
                        >
                          覆盖为发现路径
                        </button>
                        <span className="wizard-note">推荐配置只写入缺失或不可用项；覆盖会把已可用但不同的路径也改成发现路径。</span>
                      </div>
                    </>
                  ) : (
                    <div className="wizard-callout">
                      <strong>尚未完成本机发现</strong>
                      <span>点击“重新发现”，或使用页面右上角“重新扫描”。</span>
                    </div>
                  )}

                  {machineApplyResult && (
                    <>
                      <div className="diagnostic-summary-row">
                        <span className={statusClass(commandStatus(machineApplyResult))}>{machineApplyResult.ok ? "已应用" : "失败"}</span>
                        <span>写入 {machineApplyResult.applied.length} 项</span>
                        <span>跳过 {machineApplyResult.skipped.length} 项</span>
                      </div>
                      <pre className="wizard-output compact">{commandText(machineApplyResult)}</pre>
                    </>
                  )}
                </>
              )}

              {activeStep === "agents" && (
                <>
                  <div className="wizard-panel-head">
                    <div>
                      <h4>添加和修复 Agent</h4>
                      <p>先处理不可用 Agent，再补齐 API 类 Agent 的 Key 和默认模型。</p>
                    </div>
                    <button className="btn btn-primary" onClick={onCreateAgent}>
                      + 添加 Agent
                    </button>
                  </div>
                  {failingAgents.length > 0 ? (
                    <div className="wizard-agent-list">
                      {failingAgents.map(({ agent, diagnostics }) => (
                        <button className="wizard-agent-row" key={agent.id} onClick={() => onSelectAgent(agent.id)}>
                          <span className="check-dot error" />
                          <strong>{agent.name}</strong>
                          <span>{diagnostics.nextSteps[0] ?? diagnostics.summary}</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="wizard-callout">
                      <strong>没有不可用 Agent</strong>
                      <span>如果要接入新的中转站或 CLI，可以直接点“添加 Agent”。</span>
                    </div>
                  )}
                </>
              )}

              {activeStep === "startup" && (
                <>
                  <div className="wizard-panel-head">
                    <div>
                      <h4>开机后台启动</h4>
                      <p>使用 Windows 任务计划程序，在当前用户登录时启动 Xgent Hub。</p>
                    </div>
                    <span className={statusClass(startupStatus?.installed ? "ok" : "warn")}>
                      {startupStatus?.installed ? "已安装" : "未安装"}
                    </span>
                  </div>
                  <div className="wizard-actions-row">
                    <button className="btn btn-primary" disabled={startupRunning} onClick={installStartupTask}>
                      安装开机启动
                    </button>
                    <button className="btn" disabled={startupRunning} onClick={refreshStartupTask}>
                      刷新状态
                    </button>
                    <button className="btn btn-danger" disabled={startupRunning || !startupStatus?.installed} onClick={uninstallStartupTask}>
                      移除开机启动
                    </button>
                  </div>
                  <pre className="wizard-output compact">{startupStatus?.detail ?? "正在读取开机启动状态..."}</pre>
                  <div className="wizard-subpanel">
                    <div className="wizard-panel-head">
                      <div>
                        <h4>桌面和开始菜单快捷方式</h4>
                        <p>生成给最终用户点击的入口，默认指向生产模式启动。</p>
                      </div>
                      <span className={statusClass(shortcutStatus?.installed ? "ok" : "warn")}>
                        {shortcutStatus?.installed ? "已创建" : "未创建"}
                      </span>
                    </div>
                    <div className="wizard-actions-row">
                      <button className="btn btn-primary" disabled={shortcutRunning} onClick={installShortcuts}>
                        创建快捷方式
                      </button>
                      <button className="btn" disabled={shortcutRunning} onClick={refreshShortcuts}>
                        刷新状态
                      </button>
                      <button className="btn btn-danger" disabled={shortcutRunning || !shortcutStatus?.installed} onClick={uninstallShortcuts}>
                        移除快捷方式
                      </button>
                    </div>
                    <div className="wizard-shortcut-status">
                      <span>桌面：{shortcutStatus?.desktopInstalled ? "已创建" : "未创建"}</span>
                      <span>开始菜单：{shortcutStatus?.startMenuInstalled ? "已创建" : "未创建"}</span>
                      {shortcutStatus?.desktopShortcut && <code>{shortcutStatus.desktopShortcut}</code>}
                      {shortcutStatus?.startMenuDir && <code>{shortcutStatus.startMenuDir}</code>}
                    </div>
                    {shortcutResult && <pre className="wizard-output compact">{commandText(shortcutResult)}</pre>}
                  </div>
                </>
              )}

              {activeStep === "test" && (
                <>
                  <div className="wizard-panel-head">
                    <div>
                      <h4>创建任务测试</h4>
                      <p>建议先用短提示测试一个可用 Agent，确认模型、工作区和审批链路。</p>
                    </div>
                    <button className="btn btn-primary" onClick={onCreateTask} disabled={usableAgents.length === 0}>
                      + 新建任务
                    </button>
                  </div>
                  <div className="wizard-agent-list">
                    {usableAgents.slice(0, 8).map(({ agent, diagnostics }) => (
                      <button className="wizard-agent-row" key={agent.id} onClick={() => onSelectAgent(agent.id)}>
                        <span className={`check-dot ${diagnostics.status}`} />
                        <strong>{agent.name}</strong>
                        <span>{diagnostics.summary}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}

              {activeStep === "finish" && (
                <>
                  <div className="wizard-panel-head">
                    <div>
                      <h4>安装后下一步</h4>
                      <p>确认生产构建、服务健康、快捷方式、开机启动和常用目录，后续 NSIS 安装器也会复用这些入口。</p>
                    </div>
                    <button className="btn" disabled={postInstallRunning} onClick={refreshPostInstallStatus}>
                      {postInstallRunning ? "刷新中..." : "刷新清单"}
                    </button>
                  </div>

                  {postInstallStatus && (
                    <div className="post-install-summary">
                      <span>通过 {postInstallCounts.ok}</span>
                      <span>需确认 {postInstallCounts.warn}</span>
                      <span>失败 {postInstallCounts.error}</span>
                      <span>检查于 {formatTime(postInstallStatus.updatedAt)}</span>
                    </div>
                  )}

                  <div className="post-install-grid">
                    {postInstallStatus?.checks.map((item) => (
                      <div className={`post-install-item ${item.status}`} key={item.id}>
                        <span className={`check-dot ${item.status}`} />
                        <div>
                          <strong>{item.title}</strong>
                          <p>{item.description}</p>
                        </div>
                      </div>
                    )) ?? <div className="wizard-callout"><strong>尚未读取安装后状态</strong><span>点击“刷新清单”重新检查。</span></div>}
                  </div>

                  {postInstallStatus && (
                    <div className="wizard-shortcut-status">
                      <span>项目目录</span>
                      <code>{postInstallStatus.root}</code>
                      <span>日志目录</span>
                      <code>{postInstallStatus.logsDir}</code>
                      <span>备份目录</span>
                      <code>{postInstallStatus.backupsDir}</code>
                      <span>生产入口</span>
                      <code>{postInstallStatus.webUrl}</code>
                    </div>
                  )}

                  <div className="wizard-subpanel remote-access-panel">
                    <div className="wizard-panel-head">
                      <div>
                        <h4>手机 / 局域网访问</h4>
                        <p>复制同一网络下可访问的地址；远程访问前先确认登录令牌和绑定方式。</p>
                      </div>
                      <button className="btn" disabled={remoteAccessRunning} onClick={refreshRemoteAccessStatus}>
                        {remoteAccessRunning ? "刷新中..." : "刷新访问地址"}
                      </button>
                    </div>
                    {remoteAccessStatus ? (
                      <>
                        <div className="remote-access-meta">
                          <span className={statusClass(remoteAccessStatus.adminTokenConfigured ? "ok" : "warn")}>
                            {remoteAccessStatus.adminTokenConfigured ? "令牌已配置" : "令牌需配置"}
                          </span>
                          <span className={statusClass(remoteAccessStatus.boundForLan ? "ok" : "warn")}>
                            {remoteAccessStatus.boundForLan ? "允许局域网绑定" : "仅本机绑定"}
                          </span>
                          <code>HOST={remoteAccessStatus.host}</code>
                          <code>PORT={remoteAccessStatus.port}</code>
                        </div>
                        <div className="remote-access-list">
                          <div>
                            <span>本机入口</span>
                            <code>{remoteAccessStatus.localUrl}</code>
                            <button className="btn btn-sm" onClick={() => copyWithLabel("本机入口", remoteAccessStatus.localUrl)}>
                              复制
                            </button>
                          </div>
                          {remoteAccessStatus.lanUrls.map((item) => (
                            <div key={`${item.name}-${item.address}`}>
                              <span>{item.name}</span>
                              <code>{item.url}</code>
                              <button className="btn btn-sm" onClick={() => copyWithLabel(item.name, item.url)}>
                                复制
                              </button>
                            </div>
                          ))}
                        </div>
                        {copied && <div className="save-state">{copied}</div>}
                        {(remoteAccessStatus.warnings.length > 0 || remoteAccessStatus.notes.length > 0) && (
                          <div className="remote-access-notes">
                            {remoteAccessStatus.warnings.map((item) => (
                              <p className="warn" key={item}>{item}</p>
                            ))}
                            {remoteAccessStatus.notes.map((item) => (
                              <p key={item}>{item}</p>
                            ))}
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="wizard-callout">
                        <strong>尚未读取远程访问状态</strong>
                        <span>点击“刷新访问地址”重新读取本机网络信息。</span>
                      </div>
                    )}
                  </div>

                  <div className="wizard-actions-row">
                    <button className="btn btn-primary" disabled={systemActionRunning} onClick={requestRestart}>
                      安全重启生产服务
                    </button>
                    <button className="btn" disabled={systemActionRunning} onClick={() => openPath("logs")}>
                      打开日志目录
                    </button>
                    <button className="btn" disabled={systemActionRunning} onClick={() => openPath("backups")}>
                      打开备份目录
                    </button>
                    <button className="btn" disabled={systemActionRunning} onClick={() => openPath("root")}>
                      打开项目目录
                    </button>
                  </div>
                  <p className="wizard-note">安全重启会先让请求返回，再延迟重启 prod 服务；当前页面可能会短暂断开，需要刷新后继续使用。</p>
                  {systemActionResult && (
                    <>
                      <div className="diagnostic-summary-row">
                        <span className={statusClass(commandStatus(systemActionResult))}>{systemActionResult.ok ? "已执行" : "失败"}</span>
                        <span>退出码 {systemActionResult.exitCode ?? "未知"}</span>
                        <span>完成于 {formatTime(systemActionResult.finishedAt)}</span>
                      </div>
                      <pre className="wizard-output compact">{commandText(systemActionResult)}</pre>
                    </>
                  )}
                </>
              )}
              <div className="wizard-step-footer">
                <button className="btn" disabled={!previousStep} onClick={() => previousStep && setActiveStep(previousStep.id)}>
                  上一步
                </button>
                <span>
                  第 {activeStepIndex + 1} / {WIZARD_STEPS.length} 步
                </span>
                <button className="btn btn-primary" disabled={!nextStep} onClick={() => nextStep && setActiveStep(nextStep.id)}>
                  下一步：{nextStepLabel}
                </button>
              </div>
            </div>
          </div>
        </section>

        {overview && (
          <>
            <section className="onboarding-summary-grid">
              <div className="onboarding-summary-card">
                <span>总 Agent</span>
                <strong>{overview.counts.total}</strong>
              </div>
              <div className="onboarding-summary-card ok">
                <span>可用</span>
                <strong>{overview.counts.ok}</strong>
              </div>
              <div className="onboarding-summary-card warn">
                <span>需配置</span>
                <strong>{overview.counts.warn}</strong>
              </div>
              <div className="onboarding-summary-card error">
                <span>不可用</span>
                <strong>{overview.counts.error}</strong>
              </div>
            </section>

            <section className="config-section onboarding-section">
              <div className="config-section-head">
                <div>
                  <h3>从零配置顺序</h3>
                  <p>按这个顺序处理，能最快让一台新电脑进入可用状态。</p>
                </div>
              </div>
              <div className="onboarding-flow">
                {overview.checklist.map((step) => (
                  <div className="onboarding-flow-row" key={step.id}>
                    <span className={`check-dot ${step.status}`} />
                    <div>
                      <div className="onboarding-flow-title">
                        <strong>{step.title}</strong>
                        <span className={statusClass(step.status)}>{STATUS_LABEL[step.status]}</span>
                      </div>
                      <p>{step.description}</p>
                      {step.agentIds.length > 0 && (
                        <div className="onboarding-agent-links">
                          {step.agentIds.slice(0, 6).map((agentId) => (
                            <button className="btn btn-ghost btn-sm" key={agentId} onClick={() => onSelectAgent(agentId)}>
                              {agentNameLookup.get(agentId) ?? agentId}
                            </button>
                          ))}
                          {step.agentIds.length > 6 && <span>+{step.agentIds.length - 6}</span>}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="config-section onboarding-section">
              <div className="config-section-head">
                <div>
                  <h3>Agent 准备度</h3>
                  <p>优先处理红色不可用项，再处理黄色配置项。</p>
                </div>
              </div>
              <div className="readiness-grid">
                {overview.agents.map(({ agent, diagnostics }) => (
                  <article className={`readiness-card ${diagnostics.status}`} key={agent.id}>
                    <div className="readiness-head">
                      <div>
                        <strong>{agent.name}</strong>
                        <span>{agent.description}</span>
                      </div>
                      <span className={statusClass(diagnostics.status)}>{STATUS_LABEL[diagnostics.status]}</span>
                    </div>
                    <p>{diagnostics.summary}</p>
                    <div className="readiness-metrics">
                      <span>模型 {diagnostics.models?.count ?? 0}</span>
                      <span>子 Agent {diagnostics.subAgents?.count ?? 0}</span>
                      {diagnostics.usage && <span>{diagnostics.usage}</span>}
                    </div>
                    <div className="readiness-next">
                      {diagnostics.nextSteps[0] ?? "当前没有必须处理的问题，可以直接创建任务测试。"}
                    </div>
                    <div className="readiness-actions">
                      <button className="btn btn-primary btn-sm" onClick={() => onSelectAgent(agent.id)}>
                        打开配置
                      </button>
                      {diagnostics.setupSteps.length > 0 && <span>{diagnostics.setupSteps.length} 个配置步骤</span>}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
