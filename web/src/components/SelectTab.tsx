import { useEffect, useState } from "react";
import { ApiError } from "../api/client";

export interface SelectOption {
  id: string;
  label: string;
  group?: string;
  detail?: string;
}

interface Props {
  title: string;
  hint: string;
  emptyText: string;
  unsupportedText?: string | null;
  loadOptions: () => Promise<SelectOption[]>;
  selectedIds: string[];
  onSave: (ids: string[]) => Promise<void>;
}

// 任务/聊天里"勾选这次能用哪些 MCP / 工具 / 知识库"的通用标签页：勾选 → 保存，下一轮生效。
export function SelectTab({ title, hint, emptyText, unsupportedText, loadOptions, selectedIds, onSave }: Props) {
  const [options, setOptions] = useState<SelectOption[] | null>(null);
  const [draft, setDraft] = useState<string[]>(selectedIds);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (unsupportedText) return;
    loadOptions()
      .then(setOptions)
      .catch((err) => setMessage({ ok: false, text: err instanceof ApiError ? err.message : "列表加载失败" }));
  }, [unsupportedText]);

  const selectedKey = selectedIds.join(",");
  // 任务/聊天对象会随实时事件刷新成新数组，按内容比较，避免把用户还没保存的勾选冲掉。
  useEffect(() => setDraft(selectedIds), [selectedKey]);

  const available = options ?? [];
  const dirty = draft.length !== selectedIds.length || draft.some((id) => !selectedIds.includes(id));
  const allSelected = available.length > 0 && available.every((option) => draft.includes(option.id));
  const groups = [...new Set(available.map((option) => option.group ?? ""))];

  function toggle(id: string) {
    setMessage(null);
    setDraft((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  }

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      await onSave(draft.filter((id) => available.some((option) => option.id === id)));
      setMessage({ ok: true, text: "已保存，下一轮对话生效" });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : "保存失败" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="resource-tab">
      <div className="resource-tab-head">
        <div>
          <strong>{title}</strong>
          <span>{hint}</span>
        </div>
        {!unsupportedText && available.length > 0 && (
          <div className="resource-tab-actions">
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              onClick={() => {
                setMessage(null);
                setDraft(allSelected ? [] : available.map((option) => option.id));
              }}
            >
              {allSelected ? "全不选" : "全选"}
            </button>
            <button className="btn btn-primary btn-sm" type="button" onClick={() => void save()} disabled={saving || !dirty}>
              {saving ? "保存中..." : "保存"}
            </button>
          </div>
        )}
      </div>

      {unsupportedText ? (
        <div className="workspace-empty">{unsupportedText}</div>
      ) : options === null ? (
        <div className="workspace-empty">正在加载...</div>
      ) : available.length === 0 ? (
        <div className="workspace-empty">{emptyText}</div>
      ) : (
        groups.map((group) => (
          <div key={group || "_"} className="resource-tab-group">
            {group && <div className="resource-tab-group-title">{group}</div>}
            <div className="multi-agent-plan-skills">
              {available
                .filter((option) => (option.group ?? "") === group)
                .map((option) => (
                  <label key={option.id} className="multi-agent-plan-skill-chip" title={option.detail}>
                    <input type="checkbox" checked={draft.includes(option.id)} onChange={() => toggle(option.id)} />
                    <span>{option.label}</span>
                  </label>
                ))}
            </div>
          </div>
        ))
      )}
      {message && <div className={message.ok ? "resource-tab-note ok" : "form-error"}>{message.text}</div>}
    </div>
  );
}
