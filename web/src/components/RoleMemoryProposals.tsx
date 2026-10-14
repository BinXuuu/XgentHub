import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { RoleMemory } from "../api/types";

interface Props {
  roleId: string;
  roleName: string;
  /** 变化时重新拉取（比如消息条数），角色每次回复都可能提出新记忆。 */
  refreshKey: number;
}

/** 角色在回复里提出的"【记住】…"，在对话里逐条让用户确认。 */
export function RoleMemoryProposals({ roleId, roleName, refreshKey }: Props) {
  const [pending, setPending] = useState<RoleMemory[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    api
      .listRoleMemories(roleId)
      .then((items) => setPending(items.filter((item) => item.status === "pending")))
      .catch(() => setPending([]));
  }, [roleId, refreshKey]);

  async function decide(memory: RoleMemory, keep: boolean) {
    setBusyId(memory.id);
    try {
      if (keep) await api.approveRoleMemory(roleId, memory.id);
      else await api.deleteRoleMemory(roleId, memory.id);
      setPending((items) => items.filter((item) => item.id !== memory.id));
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  if (pending.length === 0) return null;
  return (
    <div className="role-memory-proposals">
      {pending.map((memory) => (
        <div key={memory.id} className="role-memory-proposal">
          <span>
            <strong>{roleName} 想记住：</strong>
            {memory.content}
          </span>
          <div className="role-memory-proposal-actions">
            <button className="btn btn-primary btn-sm" type="button" disabled={busyId === memory.id} onClick={() => void decide(memory, true)}>
              记住
            </button>
            <button className="btn btn-ghost btn-sm" type="button" disabled={busyId === memory.id} onClick={() => void decide(memory, false)}>
              不用
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
