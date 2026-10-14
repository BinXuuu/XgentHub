import { useEffect, useRef, useState } from "react";
import { BellRing, X } from "lucide-react";
import type { AgentDescriptor, Approval, Task } from "../api/types";
import { useSSE } from "../hooks/useSSE";

interface Props {
  tasks: Task[];
  agents: AgentDescriptor[];
  /** 当前正打开的任务：它的审批已经在任务页顶部弹出来了，这里就不再重复提醒。 */
  selectedTaskId: string | null;
  onOpenTask: (taskId: string) => void;
}

interface DashboardEvent {
  kind: string;
  taskId?: string;
  approval?: Approval;
}

const BASE_TITLE = "Xgent Hub";

/** 浏览器只在 https / localhost 下给桌面通知；用 http + 局域网 IP 打开时没有，靠页面提示 + 提示音 + 标题。 */
function desktopNotificationSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window && window.isSecureContext;
}

/** 两声短"叮"：不用音频文件，Web Audio 现场合成。浏览器要求页面先被点过一次，没点过就静默失败。 */
function playChime() {
  try {
    const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    [0, 0.18].forEach((offset, index) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = index === 0 ? 880 : 1175;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + offset + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + offset);
      osc.stop(ctx.currentTime + offset + 0.18);
    });
    window.setTimeout(() => void ctx.close(), 600);
  } catch {
    // 没声音不影响别的提醒
  }
}

/**
 * Agent 停下来等审批时的全局提醒：不管你在哪个页面——右下角卡片 + 提示音、标签页标题带"(N) 待审批"，
 * 能用桌面通知时再弹一条系统通知（标签页在后台时也看得到）。批完/取消后自动消失。
 */
export function ApprovalAlerts({ tasks, agents, selectedTaskId, onOpenTask }: Props) {
  const [alerts, setAlerts] = useState<Approval[]>([]);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(() =>
    desktopNotificationSupported() ? Notification.permission : "unsupported"
  );
  const selectedRef = useRef(selectedTaskId);
  selectedRef.current = selectedTaskId;
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const agentsRef = useRef(agents);
  agentsRef.current = agents;

  const waitingCount = tasks.filter((task) => task.status === "needs_approval").length;

  // 标签页标题：切到别的标签页也能一眼看到有事等你。
  useEffect(() => {
    document.title = waitingCount > 0 ? `(${waitingCount}) 待审批 · ${BASE_TITLE}` : BASE_TITLE;
  }, [waitingCount]);

  // 打开了那个任务，它的审批就在任务页顶部了，右下角的就收起来。
  useEffect(() => {
    if (selectedTaskId) setAlerts((prev) => prev.filter((item) => item.taskId !== selectedTaskId));
  }, [selectedTaskId]);

  function describe(approval: Approval) {
    const task = tasksRef.current.find((item) => item.id === approval.taskId);
    const agentName = agentsRef.current.find((agent) => agent.id === task?.agentId)?.name ?? task?.agentKind ?? "Agent";
    return { taskTitle: task?.title ?? "任务", agentName };
  }

  useSSE<DashboardEvent>("/api/dashboard/stream", "dashboard_event", (event) => {
    if (event.kind !== "approval" || !event.approval) return;
    const approval = event.approval;
    if (approval.status !== "pending") {
      setAlerts((prev) => prev.filter((item) => item.id !== approval.id));
      return;
    }
    const viewingThisTask = selectedRef.current === approval.taskId;
    const pageVisible = document.visibilityState === "visible";
    // 正看着这个任务、页面也在前台：任务页自己的弹出卡片就够了。
    if (viewingThisTask && pageVisible) return;

    playChime();
    if (!viewingThisTask) setAlerts((prev) => (prev.some((item) => item.id === approval.id) ? prev : [...prev, approval]));
    if (desktopNotificationSupported() && Notification.permission === "granted" && (!pageVisible || !viewingThisTask)) {
      const { taskTitle, agentName } = describe(approval);
      const notice = new Notification(`${agentName} 在等你批准`, { body: `「${taskTitle}」：${approval.command}`, tag: approval.id });
      notice.onclick = () => {
        window.focus();
        onOpenTask(approval.taskId);
        notice.close();
      };
    }
  });

  async function enableDesktopNotifications() {
    if (!desktopNotificationSupported()) return;
    setPermission(await Notification.requestPermission());
  }

  if (alerts.length === 0) return null;
  return (
    <div className="approval-alerts" role="status" aria-live="polite">
      {alerts.slice(-3).map((approval) => {
        const { taskTitle, agentName } = describe(approval);
        return (
          <div className="approval-alert" key={approval.id}>
            <BellRing size={18} className="approval-alert-icon" aria-hidden="true" />
            <div className="approval-alert-body">
              <strong>{agentName} 在等你批准</strong>
              <span className="approval-alert-task">「{taskTitle}」</span>
              <code>{approval.command}</code>
              <div className="approval-alert-actions">
                <button
                  className="btn btn-primary btn-sm"
                  type="button"
                  onClick={() => {
                    onOpenTask(approval.taskId);
                    setAlerts((prev) => prev.filter((item) => item.id !== approval.id));
                  }}
                >
                  去批准
                </button>
                {permission === "default" && (
                  <button className="btn btn-ghost btn-sm" type="button" onClick={() => void enableDesktopNotifications()}>
                    开启桌面通知
                  </button>
                )}
              </div>
            </div>
            <button
              className="approval-alert-close"
              type="button"
              aria-label="先不管"
              onClick={() => setAlerts((prev) => prev.filter((item) => item.id !== approval.id))}
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
      {alerts.length > 3 && <div className="approval-alert-more">还有 {alerts.length - 3} 条审批在等</div>}
    </div>
  );
}
