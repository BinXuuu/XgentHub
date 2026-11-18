import { useEffect, useMemo, useState } from "react";
import type { TaskEvent } from "../../api/types";
import { formatDuration, summarizeLiveActivity } from "../../utils/liveActivity";

interface Props {
  /** 这个任务的终端输出事件（带时间） */
  events: TaskEvent[];
  /** 这一轮大概从什么时候开始（最后一条消息的时间），用来挑出这一轮的输出 */
  since: number;
}

/** 多久没有新输出算「很久没动静」：模型想一个大步骤常要一两分钟，Antigravity 某次请求卡住 5 分钟会自动重试 */
const QUIET_MS = 2 * 60 * 1000;

const clock = (at: number) => new Date(at).toLocaleTimeString("zh-CN", { hour12: false });

/**
 * 任务运行时对话页上的「正在处理」：跑了多久、最近一次有动静是什么时候、最近做了哪几步、正在写的内容。
 * 很久没动静时说清楚可能的原因，让人决定继续等还是停止。数据就是「终端」视图里的那些输出，这里只是整理一下。
 */
export function LiveActivity({ events, since }: Props) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // 往前多放 5 秒：消息和启动输出的时间可能差一点点
  const activity = useMemo(() => summarizeLiveActivity(events, since - 5000), [events, since]);
  const startedAt = activity.startedAt ?? since;
  const quietFor = now - (activity.lastAt ?? startedAt);
  const quiet = quietFor >= QUIET_MS;

  return (
    <div className="chat-bubble agent typing-indicator live-activity">
      <div className="role-label">Agent</div>
      <div className="live-activity-head">
        <span className="typing-dots">
          <span />
          <span />
          <span />
        </span>
        <span>正在处理… 已运行 {formatDuration(now - startedAt)}</span>
        <span className={`live-activity-pulse${quiet ? " quiet" : ""}`}>
          {!activity.lastAt ? "还没有输出" : quietFor < 5000 ? "刚刚有新动静" : `${formatDuration(quietFor)}前有新动静`}
        </span>
      </div>

      {activity.steps.length > 0 && (
        <ol className="live-activity-steps">
          {activity.steps.map((step, index) => (
            <li
              key={`${step.at}-${index}`}
              className={[index === activity.steps.length - 1 ? "current" : "", step.warn ? "warn" : ""].filter(Boolean).join(" ") || undefined}
            >
              <time>{clock(step.at)}</time>
              <span title={step.label}>{step.label}</span>
            </li>
          ))}
        </ol>
      )}

      {activity.latestOutput && (
        <div className="live-activity-output" title={activity.latestOutput}>
          {activity.latestOutput}
        </div>
      )}

      {quiet && (
        <div className="live-activity-quiet">
          已经 {formatDuration(quietFor)}没有新动静了：可能在想一个比较大的步骤，也可能某次请求卡住了（Antigravity
          一次请求卡住 5～10 分钟会自己重试，重试时上面会写出原因）。可以接着等；等太久就点右上角「停止」，再发消息让它接着做。
        </div>
      )}
    </div>
  );
}
