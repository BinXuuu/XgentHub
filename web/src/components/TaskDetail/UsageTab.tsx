import { useEffect, useState } from "react";
import type { GatewayTaskUsage } from "../../api/types";
import { api } from "../../api/client";

interface Props {
  taskId: string;
}

export function UsageTab({ taskId }: Props) {
  const [usage, setUsage] = useState<GatewayTaskUsage | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .getOfficialGatewayTaskUsage(taskId)
      .then((data) => {
        if (!cancelled) setUsage(data);
      })
      .catch(() => {
        if (!cancelled) setUsage(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  if (loading) return <div className="empty-state">正在读取用量...</div>;
  if (!usage || usage.records.length === 0) {
    return <div className="empty-state">暂无推荐 API 中转站本地用量记录</div>;
  }

  return (
    <div className="usage-tab">
      <div className="usage-summary-grid">
        <div>
          <span>估算费用</span>
          <strong>¥{usage.summary.estimatedCostCny}</strong>
        </div>
        <div>
          <span>总 tokens</span>
          <strong>{usage.summary.totalTokens}</strong>
        </div>
        <div>
          <span>输入 tokens</span>
          <strong>{usage.summary.promptTokens}</strong>
        </div>
        <div>
          <span>输出 tokens</span>
          <strong>{usage.summary.completionTokens}</strong>
        </div>
      </div>

      <div className="gateway-ledger usage-ledger">
        <div className="gateway-ledger-head">
          <strong>调用记录</strong>
          <span>本地估算，真实扣费以 TokenEZGO 为准</span>
        </div>
        {usage.records.map((record) => (
          <div className="usage-record" key={record.id}>
            <div>
              <strong>{record.model}</strong>
              <span>{new Date(record.createdAt).toLocaleString("zh-CN", { hour12: false })}</span>
            </div>
            <div>
              <span>价格规则</span>
              <strong>{record.priceRuleLabel}</strong>
            </div>
            <div>
              <span>Tokens</span>
              <strong>{record.totalTokens}</strong>
            </div>
            <div>
              <span>估算费用</span>
              <strong>¥{record.estimatedCostCny}</strong>
            </div>
            {record.budgetLimitCny && (
              <div className={record.budgetExceeded ? "usage-budget exceeded" : "usage-budget"}>
                预算 ¥{record.budgetLimitCny}
                {record.budgetExceeded ? "，已超过" : ""}
              </div>
            )}
            <p>{record.note}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
