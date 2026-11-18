import { api } from "../api/client";

// 有的 Agent（Antigravity、Claude Code）查用量是先给本地快照，同时在后台刷新。
// 点「刷新」后如果拿到的还是旧快照，就隔一会儿再查，直到快照时间变了（最多等 4 次）。

const snapshotTime = (text: string | null) => /快照时间：([^\n]+)/.exec(text ?? "")?.[1]?.trim() ?? null;
const refreshingInBackground = (text: string | null) => /后台刷新：已触发|已在后台刷新/.test(text ?? "");

export async function loadAgentUsage(
  agentId: string,
  handlers: { onText: (text: string | null) => void; onWaiting: (waiting: boolean) => void; isActive: () => boolean },
  options: { intervalMs?: number; attempts?: number } = {}
): Promise<void> {
  const first = await api.getAgentUsage(agentId);
  handlers.onText(first.text);
  if (!refreshingInBackground(first.text)) return;
  const before = snapshotTime(first.text);
  handlers.onWaiting(true);
  try {
    for (let attempt = 0; attempt < (options.attempts ?? 4); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 10_000));
      if (!handlers.isActive()) return;
      const next = await api.getAgentUsage(agentId).catch(() => null);
      if (next && (snapshotTime(next.text) !== before || !refreshingInBackground(next.text))) {
        handlers.onText(next.text);
        return;
      }
    }
  } finally {
    handlers.onWaiting(false);
  }
}
