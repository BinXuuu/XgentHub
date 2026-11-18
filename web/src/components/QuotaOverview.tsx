import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { AgentDescriptor } from "../api/types";
import { agentDisplayName } from "../utils/agentAccount";

// 工作台上「账号额度」这一行：每个能查用量的 Agent 账号一张卡片，每项额度画一个圆环，显示还剩多少。
// 数据就是左边栏「剩余用量」那段文字（服务端拼好的「xxx：剩余 N%，… 重置」），这里只解析出百分比来画。

interface Gauge {
  label: string;
  remaining: number;
  reset: string | null;
}

interface Parsed {
  gauges: Gauge[];
  balance: string | null;
}

/** Ark CLI 的用量是原样输出的 JSON，画不了圆环，不放进来。 */
const SKIPPED_KINDS = new Set(["ark-cli"]);
const CACHE_MS = 2 * 60 * 1000;
const cache = new Map<string, { text: string | null; at: number }>();

export function parseUsageGauges(text: string | null): Parsed {
  const gauges: Gauge[] = [];
  let balance: string | null = null;
  for (const raw of (text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    // 「5 小时额度：剩余 55%，2026/11/4 15:36 重置」「Gemini 模型：本周额度剩余 99%，… 重置」
    const m = line.match(/^(.+?)：(.*?)剩余\s*(\d+(?:\.\d+)?)%(?:，(.+?)\s*重置)?/);
    if (m) {
      const label = `${m[1]!.replace(/模型$/, "").replace(/额度/g, "")} ${m[2]!.replace(/额度/g, "")}`.replace(/\s+/g, " ").trim();
      // 圆环下面地方小：去掉时区和年份，「2026/11/4 21:38」「11月4日 21:38」都写成「11/4 21:38」。
      const reset = m[4]?.replace(/（[^）]*）/g, "").replace(/^\d{4}\//, "").replace(/(\d+)月(\d+)日/, "$1/$2").trim() || null;
      gauges.push({ label, remaining: Math.max(0, Math.min(100, Number(m[3]))), reset });
      continue;
    }
    const money = line.match(/^余额：(.+)$/);
    if (money) balance = money[1]!.trim();
  }
  return { gauges, balance };
}

function Ring({ gauge }: { gauge: Gauge }) {
  const radius = 26;
  const circumference = 2 * Math.PI * radius;
  // 先画成空环，下一帧再设成目标值，让 CSS 过渡把圆环「转」到剩余的位置。
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(gauge.remaining));
    return () => cancelAnimationFrame(frame);
  }, [gauge.remaining]);
  const level = gauge.remaining >= 50 ? "ok" : gauge.remaining >= 20 ? "warn" : "low";
  return (
    <div className={`quota-ring ${level}`} title={gauge.reset ? `${gauge.label}：剩余 ${gauge.remaining}%，${gauge.reset} 重置` : `${gauge.label}：剩余 ${gauge.remaining}%`}>
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <circle className="quota-ring-track" cx="32" cy="32" r={radius} />
        <circle
          className="quota-ring-value"
          cx="32"
          cy="32"
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - shown / 100)}
        />
      </svg>
      <strong>{Math.round(gauge.remaining)}%</strong>
      <span>{gauge.label}</span>
      {gauge.reset && <small>{gauge.reset} 重置</small>}
    </div>
  );
}

export function QuotaOverview({ agents, colors }: { agents: AgentDescriptor[]; colors: Record<string, string> }) {
  const targets = agents.filter((agent) => agent.supportsUsage && agent.configured && !agent.role && !SKIPPED_KINDS.has(agent.kind));
  const ids = targets.map((agent) => agent.id).join(",");
  const [texts, setTexts] = useState<Record<string, string | null | undefined>>({});
  const [loading, setLoading] = useState(false);

  async function load(force = false) {
    if (!ids) return;
    setLoading(true);
    await Promise.all(ids.split(",").map(async (id) => {
      const hit = cache.get(id);
      if (!force && hit && Date.now() - hit.at < CACHE_MS) {
        setTexts((current) => ({ ...current, [id]: hit.text }));
        return;
      }
      try {
        const { text } = await api.getAgentUsage(id);
        cache.set(id, { text, at: Date.now() });
        setTexts((current) => ({ ...current, [id]: text }));
      } catch {
        setTexts((current) => ({ ...current, [id]: null }));
      }
    }));
    setLoading(false);
  }
  useEffect(() => { void load(); }, [ids]);

  const cards = targets
    .map((agent) => ({ agent, text: texts[agent.id], parsed: parseUsageGauges(texts[agent.id] ?? null) }))
    // 还在读的先占位；读完了既没有百分比也没有余额的（没登录、查不到）就不显示。
    .filter(({ text, parsed }) => text === undefined || parsed.gauges.length > 0 || parsed.balance);
  if (!targets.length || !cards.length) return null;

  return (
    <section>
      <div className="section-title">
        账号额度
        <button className="btn btn-ghost btn-sm quota-refresh" type="button" disabled={loading} onClick={() => void load(true)}>
          {loading ? "读取中..." : "刷新"}
        </button>
      </div>
      <div className="quota-grid">
        {cards.map(({ agent, text, parsed }) => (
          <div className="quota-card" key={agent.id}>
            <div className="quota-card-head">
              <span className="task-agent-dot" style={{ background: colors[agent.kind] ?? "#6b7280" }} />
              <strong title={agentDisplayName(agent)}>{agentDisplayName(agent)}</strong>
            </div>
            {text === undefined ? (
              <div className="quota-card-empty">读取中...</div>
            ) : parsed.gauges.length ? (
              <div className="quota-rings">
                {parsed.gauges.map((gauge) => <Ring key={gauge.label} gauge={gauge} />)}
              </div>
            ) : (
              <div className="quota-balance"><span>余额</span><strong>{parsed.balance}</strong></div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
