import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { ResourceLibraryItem, SkillGroup } from "../api/types";
import { SelectTab } from "./SelectTab";
import { SkillPicker } from "./SkillPicker";

type Scope = "工作区" | "聊天";

interface SelectionProps {
  scope: Scope;
  selectedIds: string[];
  onSave: (ids: string[]) => Promise<void>;
}

export function McpTab({ scope, agentName, supportsMcp, selectedIds, onSave }: SelectionProps & { agentName: string; supportsMcp: boolean }) {
  return (
    <SelectTab
      title={`这个${scope}能用的 MCP server`}
      hint="勾选后下一轮对话生效，不影响正在跑的这次。"
      emptyText="还没有注册任何 MCP server，去左侧「MCP」页添加。"
      unsupportedText={supportsMcp ? null : `当前 Agent（${agentName}）还不支持 MCP。`}
      loadOptions={async () =>
        (await api.listMcpServers())
          .filter((server) => server.enabled)
          .map((server) => ({ id: server.id, label: server.name }))
      }
      selectedIds={selectedIds}
      onSave={onSave}
    />
  );
}

export function ToolsTab({ scope, selectedIds, onSave }: SelectionProps) {
  return (
    <SelectTab
      title={`这个${scope}能用的工具`}
      hint="勾选的工具（名称、命令和说明）会在每一轮带给 Agent，下一轮生效。增删工具在左侧「工具」页。"
      emptyText="工具库还是空的，去左侧「工具」页添加。"
      loadOptions={async () =>
        (await api.listResourceLibraryItems("tool")).map((tool) => ({
          id: tool.id,
          label: tool.title,
          detail: [tool.command, tool.content].filter(Boolean).join("\n"),
        }))
      }
      selectedIds={selectedIds}
      onSave={onSave}
    />
  );
}

export function SkillsTab({ scope, selectedIds, onSave }: SelectionProps) {
  const [data, setData] = useState<{ skills: ResourceLibraryItem[]; groups: SkillGroup[] } | null>(null);
  const [draft, setDraft] = useState(selectedIds);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const selectedKey = JSON.stringify(selectedIds);
  useEffect(() => setDraft(selectedIds), [selectedKey]);
  useEffect(() => {
    let cancelled = false;
    Promise.all([api.listResourceLibraryItems("skill"), api.listSkillGroups()])
      .then(([skills, groups]) => { if (!cancelled) setData({ skills, groups }); })
      .catch((err) => { if (!cancelled) setError((err as Error).message); });
    return () => { cancelled = true; };
  }, []);
  const dirty = draft.length !== selectedIds.length || draft.some((id) => !selectedIds.includes(id));
  async function save() {
    setSaving(true); setError(""); setMessage("");
    try { await onSave(draft); setMessage("已保存，下一轮对话生效"); }
    catch (err) { setError((err as Error).message); }
    finally { setSaving(false); }
  }
  return (
    <div className="resource-tab">
      <div className="resource-tab-head"><div><strong>{`这个${scope}要遵循的 Skill`}</strong><span>支持整组选入；文件型技能按需读取完整说明。下一轮对话生效。</span></div>
        <button className="btn btn-primary btn-sm" type="button" disabled={saving || !dirty || !data} onClick={() => void save()}>{saving ? "保存中..." : "保存"}</button>
      </div>
      {data ? <SkillPicker {...data} selectedIds={draft} onChange={(ids) => { setDraft(ids); setMessage(""); }} /> : !error && <div className="workspace-loading">正在加载...</div>}
      {error && <div className="form-error">{error}</div>}{message && <div className="resource-tab-note ok">{message}</div>}
    </div>
  );
}

export function ChatKnowledgeTab({ selectedIds, onSave }: Omit<SelectionProps, "scope">) {
  return (
    <SelectTab
      title="这个聊天要参考的知识库"
      hint="聊天不属于工作区，在这里按知识组挑具体条目；勾选的条目会在每一轮带给 Agent。增删条目在左侧「知识库」页。"
      emptyText="还没有任何知识库条目，去左侧「知识库」页添加。"
      loadOptions={async () => {
        const [groups, entries] = await Promise.all([api.listKnowledgeGroups(), api.listKnowledge({ limit: 300 })]);
        const groupName = new Map(groups.map((group) => [group.id, group.name]));
        return entries.map((entry) => ({
          id: entry.id,
          label: entry.title,
          group: groupName.get(entry.groupId) ?? "未分组",
          detail: entry.content,
        }));
      }}
      selectedIds={selectedIds}
      onSave={onSave}
    />
  );
}

/** 工作区详情页用：勾选这个工作区关联哪些知识组。 */
export function KnowledgeGroupsTab({ selectedIds, onSave }: Omit<SelectionProps, "scope">) {
  return (
    <SelectTab
      title="这个工作区使用的知识组"
      hint="小组（总共不超过 3000 字）每一轮整组带给 Agent；大组按消息挑最相关的 5 条。增删组和条目在左侧「知识库」页。"
      emptyText="还没有知识组，去左侧「知识库」页新建。"
      loadOptions={async () =>
        (await api.listKnowledgeGroups()).map((group) => ({
          id: group.id,
          label: `${group.name}（${group.entryCount} 条）`,
          detail: group.description,
        }))
      }
      selectedIds={selectedIds}
      onSave={onSave}
    />
  );
}
