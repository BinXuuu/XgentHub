import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Download, Loader2, RefreshCw, X, XCircle } from "lucide-react";
import { api } from "../api/client";
import type { UpdateInfo, UpdateStatus } from "../api/types";
import { confirmDialog, errorDialog } from "../utils/dialog";

const STEP_LABEL: Record<string, string> = {
  queued: "准备更新",
  stopping: "停止服务",
  backup: "备份当前版本",
  downloading: "下载新版本",
  applying: "替换程序文件",
  installing: "安装依赖",
  building: "构建",
  starting: "启动服务",
  restoring: "出错了，正在恢复原来的版本",
  done: "完成",
};
const STEP_ORDER = ["queued", "stopping", "backup", "downloading", "applying", "installing", "building", "starting", "done"];

interface Props {
  info: UpdateInfo | null;
  checking: boolean;
  onCheck: () => void;
  onClose: () => void;
}

/** 版本和在线更新：看有没有新版本、更新说明，点"更新"后跟进进度（服务会重启，期间接口会断开一会儿）。 */
export function UpdateCenter({ info, checking, onCheck, onClose }: Props) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [serverDown, setServerDown] = useState(false);
  const [starting, setStarting] = useState(false);
  const pollRef = useRef<number | null>(null);

  const updating = status?.state === "running";

  function stopPolling() {
    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = null;
  }

  function startPolling() {
    stopPolling();
    pollRef.current = window.setInterval(async () => {
      try {
        const next = await api.getUpdateStatus();
        setServerDown(false);
        setStatus(next);
        if (next.state !== "running") stopPolling();
      } catch {
        // 更新过程中服务会停一会儿，接口连不上是正常的
        setServerDown(true);
      }
    }, 2000);
  }

  useEffect(() => {
    // 打开面板时如果上一次更新还在进行（比如刷新了页面），接着跟进度。
    void api
      .getUpdateStatus()
      .then((current) => {
        setStatus(current);
        if (current.state === "running") startPolling();
      })
      .catch(() => undefined);
    return stopPolling;
  }, []);

  async function runUpdate() {
    if (!info?.latestVersion) return;
    const ok = await confirmDialog(
      "更新时服务会停一两分钟：先备份当前版本，再下载新版本、安装依赖、重新构建后自动重启。你的配置、数据和日志不会动；更新失败会自动恢复原来的版本。",
      { title: `更新到 v${info.latestVersion}？`, confirmText: "开始更新" }
    );
    if (!ok) return;
    setStarting(true);
    try {
      await api.startUpdate();
      setStatus({ state: "running", step: "queued", fromVersion: info.currentVersion, toVersion: info.latestVersion });
      startPolling();
    } catch (err) {
      void errorDialog(err, "没法开始更新");
    } finally {
      setStarting(false);
    }
  }

  const stepIndex = status?.step ? STEP_ORDER.indexOf(status.step) : -1;

  return (
    <div className="modal-overlay update-center-overlay" onMouseDown={(event) => event.target === event.currentTarget && !updating && onClose()}>
      <div className="modal-card update-center" role="dialog" aria-modal="true" aria-label="版本与更新">
        <div className="update-center-head">
          <h2>版本与更新</h2>
          {!updating && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="关闭">
              <X size={16} />
            </button>
          )}
        </div>

        <div className="update-center-versions">
          <div>
            <span>当前版本</span>
            <strong>v{info?.currentVersion ?? "…"}</strong>
          </div>
          <div>
            <span>最新版本</span>
            <strong>{info?.latestVersion ? `v${info.latestVersion}` : checking ? "检查中…" : "—"}</strong>
          </div>
        </div>

        {status && status.state !== "idle" && (status.state === "running" || status.toVersion) && (
          <div className={`update-progress state-${status.state}`}>
            {status.state === "running" && (
              <>
                <div className="update-progress-title">
                  <Loader2 size={16} className="spin" />
                  正在更新到 v{status.toVersion}：{STEP_LABEL[status.step ?? ""] ?? status.step}
                </div>
                <div className="update-progress-bar">
                  <span style={{ width: `${Math.max(5, ((stepIndex + 1) / STEP_ORDER.length) * 100)}%` }} />
                </div>
                <p className="update-progress-hint">
                  {serverDown ? "服务正在重启，暂时连不上是正常的，稍等一下……" : "请不要关闭电脑。更新完成前服务会停一会儿。"}
                </p>
              </>
            )}
            {status.state === "done" && (
              <>
                <div className="update-progress-title ok">
                  <CheckCircle2 size={16} />
                  已更新到 v{status.toVersion}
                </div>
                <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
                  刷新页面，用上新版本
                </button>
              </>
            )}
            {status.state === "failed" && (
              <>
                <div className="update-progress-title error">
                  <XCircle size={16} />
                  更新到 v{status.toVersion} 没有成功，已恢复到原来的版本
                </div>
                <p className="update-progress-hint">原因：{status.error || "未知"}</p>
                {status.log && <p className="update-progress-hint">详细日志：{status.log}</p>}
              </>
            )}
          </div>
        )}

        {!updating && info && (
          <>
            {info.mode === "dev" && <p className="update-note">{info.modeReason}</p>}
            {info.error && <p className="update-note error">{info.error}</p>}
            {!info.error && info.mode !== "dev" && !info.available && info.latestVersion && <p className="update-note ok">已经是最新版本。</p>}
            {info.available && (
              <div className="update-notes">
                <strong>v{info.latestVersion} 更新内容</strong>
                <pre>{info.notes || "（这个版本没有写更新说明）"}</pre>
              </div>
            )}
            <div className="modal-actions">
              <button type="button" className="btn" onClick={onCheck} disabled={checking}>
                <RefreshCw size={14} className={checking ? "spin" : ""} />
                {checking ? "检查中…" : "检查更新"}
              </button>
              {info.available && info.mode !== "dev" && (
                <button type="button" className="btn btn-primary" onClick={() => void runUpdate()} disabled={starting}>
                  <Download size={14} />
                  {starting ? "准备中…" : `更新到 v${info.latestVersion}`}
                </button>
              )}
            </div>
            <p className="update-meta">
              更新源：github.com/{info.repo} · 上次检查 {new Date(info.checkedAt).toLocaleString("zh-CN", { hour12: false })}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
