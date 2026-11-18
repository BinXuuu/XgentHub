import { useEffect, useState } from "react";
import type { AlwaysAllowRule, Approval } from "../../api/types";
import { RiskBadge } from "../StatusBadge";
import { api } from "../../api/client";
import { confirmDialog, errorDialog } from "../../utils/dialog";

const APPROVAL_STATUS_LABEL: Record<string, string> = {
  pending: "待处理",
  approved: "已批准",
  denied: "已拒绝",
  always_allowed: "总是允许",
};

export function ApprovalCard({ approval }: { approval: Approval }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function decide(decision: "approve_once" | "approve_always" | "deny") {
    setBusy(true);
    try {
      await api.decideApproval(approval.id, approval.taskId, decision, note.trim() || undefined);
    } catch (err) {
      void errorDialog(err);
    } finally {
      setBusy(false);
    }
  }

  const isPending = approval.status === "pending";

  return (
    <div className="approval-card">
      <div className="approval-head">
        <RiskBadge level={approval.riskLevel} />
        <strong style={{ fontSize: 13 }}>需要审批</strong>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-faint)" }}>
          {new Date(approval.createdAt).toLocaleString("zh-CN", { hour12: false })}
        </span>
      </div>
      <div className="approval-body">
        <div className="cwd">cwd: {approval.cwd}</div>
        <div className="command">{approval.command}</div>
        <div className="reason">原因：{approval.reason}</div>
      </div>
      {isPending ? (
        <div className="approval-actions">
          <input
            className="field"
            placeholder="补充说明（可选）"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => decide("approve_once")}>
            允许一次
          </button>
          <button className="btn btn-sm" disabled={busy} onClick={() => decide("approve_always")}>
            总是允许
          </button>
          <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => decide("deny")}>
            拒绝
          </button>
        </div>
      ) : (
        <div className="approval-resolved-tag">
          已处理：{APPROVAL_STATUS_LABEL[approval.status] ?? approval.status}
          {approval.note ? ` · 备注：${approval.note}` : ""}
        </div>
      )}
    </div>
  );
}

function ApprovalRulesPanel() {
  const [rules, setRules] = useState<AlwaysAllowRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .listApprovalRules()
      .then((value) => {
        if (alive) setRules(value);
      })
      .catch((err) => void errorDialog(err))
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function deleteRule(rule: AlwaysAllowRule) {
    if (!(await confirmDialog(rule.pattern, { title: "删除这条总是允许规则？", danger: true }))) return;
    setDeletingId(rule.id);
    try {
      await api.deleteApprovalRule(rule.id);
      setRules((current) => current.filter((item) => item.id !== rule.id));
    } catch (err) {
      void errorDialog(err);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section className="approval-rules-panel">
      <div className="approval-rules-head">
        <div>
          <strong>总是允许规则</strong>
          <span>按 workspace + agent + 命令精确匹配</span>
        </div>
        <span>{loading ? "加载中" : `${rules.length} 条`}</span>
      </div>
      {!loading && rules.length === 0 && <div className="approval-rules-empty">暂无规则</div>}
      {rules.map((rule) => (
        <div className="approval-rule-row" key={rule.id}>
          <div className="approval-rule-main">
            <div className="approval-rule-command" title={rule.pattern}>
              {rule.pattern}
            </div>
            <div className="approval-rule-meta">
              <span>{rule.agentId}</span>
              <span>{rule.workspaceId}</span>
              <span>{new Date(rule.createdAt).toLocaleString("zh-CN", { hour12: false })}</span>
            </div>
          </div>
          <button className="btn btn-danger btn-sm" disabled={deletingId === rule.id} onClick={() => deleteRule(rule)}>
            删除
          </button>
        </div>
      ))}
    </section>
  );
}

export function ApprovalsTab({ approvals }: { approvals: Approval[] }) {
  const sorted = [...approvals].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return (
    <div>
      {sorted.length === 0 && <div className="empty-state">暂无审批请求</div>}
      {sorted.map((a) => (
        <ApprovalCard key={a.id} approval={a} />
      ))}
      <ApprovalRulesPanel />
    </div>
  );
}
