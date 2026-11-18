import { useState, type FormEvent, type ReactNode } from "react";
import { api } from "../api/client";
import type { ResourceGroup, ResourceGroupKind } from "../api/types";
import { confirmDialog, promptDialog } from "../utils/dialog";

// 工具页、MCP 页列表上方的「分组筛选 + 搜索 + 批量移动」，和 Skill 页的技能组是同一套思路：
// 点分组只看这一组，搜索在当前分组里过滤，勾选后可以一起移到某个组；「管理分组」里新建、改名、删除。

interface Props {
  kind: ResourceGroupKind;
  /** 「工具」「MCP server」 */
  noun: string;
  groups: ResourceGroup[];
  total: number;
  ungrouped: number;
  filter: string;
  browsing: boolean;
  onFilter: (filter: string) => void;
  query: string;
  onQuery: (query: string) => void;
  visibleIds: string[];
  selected: string[];
  onSelected: (ids: string[]) => void;
  /** 分组或归组变了：重新读分组和列表。 */
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
  children: ReactNode;
}

export function ResourceGroupBar({ kind, noun, groups, total, ungrouped, filter, browsing, onFilter, query, onQuery, visibleIds, selected, onSelected, onChanged, onError, children }: Props) {
  const [managing, setManaging] = useState(false);
  const [newName, setNewName] = useState("");
  const [moveTarget, setMoveTarget] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try { await action(); await onChanged(); }
    catch (err) { onError((err as Error).message); }
    finally { setBusy(false); }
  }

  function addGroup(event: FormEvent) {
    event.preventDefault();
    if (!newName.trim()) return;
    void run(async () => { await api.createResourceGroup(kind, { name: newName.trim() }); setNewName(""); });
  }

  async function renameGroup(group: ResourceGroup) {
    const name = await promptDialog("新的分组名称", { title: `改名「${group.name}」`, defaultValue: group.name, singleLine: true });
    if (!name?.trim() || name.trim() === group.name) return;
    void run(async () => { await api.updateResourceGroup(kind, group.id, { name: name.trim(), description: group.description }); });
  }

  async function removeGroup(group: ResourceGroup) {
    if (!(await confirmDialog(`组里的${noun}会移到「未分组」，已经在工作区、角色里勾选的不受影响。`, { title: `删除分组「${group.name}」？`, danger: true }))) return;
    void run(async () => {
      await api.deleteResourceGroup(kind, group.id);
      if (filter === group.id) onFilter("");
      if (moveTarget === group.id) setMoveTarget("");
    });
  }

  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.includes(id));
  return <div className="resource-library-grid">
    <aside className="resource-category-panel">
    <div className="workspace-section-head"><h3>分类</h3><button className="btn btn-ghost btn-sm" type="button" aria-expanded={managing} onClick={() => setManaging((value) => !value)}>{managing ? "完成" : "管理"}</button></div>
    <nav className="resource-category-nav" aria-label={`${noun}分组筛选`}>
      <button type="button" className={filter === "" && browsing ? "active" : ""} onClick={() => onFilter("")}>全部 <span>{total}</span></button>
      {groups.map((group) => <div className="resource-category-row" key={group.id}><button type="button" title={group.description || undefined} className={filter === group.id ? "active" : ""} onClick={() => onFilter(group.id)}>{group.name} <span>{group.count}</span></button>
        {managing && <><button className="btn btn-ghost btn-sm" type="button" aria-label={`重命名分类 ${group.name}`} disabled={busy} onClick={() => void renameGroup(group)}>改名</button><button className="btn btn-ghost btn-sm" type="button" aria-label={`删除分类 ${group.name}`} disabled={busy} onClick={() => void removeGroup(group)}>删除</button></>}
      </div>)}
      <button type="button" className={filter === "ungrouped" ? "active" : ""} onClick={() => onFilter("ungrouped")}>未分组 <span>{ungrouped}</span></button>
    </nav>
      <form className="resource-category-create" onSubmit={addGroup}>
        <input className="field" aria-label="新分类名称" placeholder="新分类名称" value={newName} onChange={(event) => setNewName(event.target.value)} />
        <button className="btn btn-sm" disabled={busy || !newName.trim()}>新建分类</button>
      </form>
    </aside>
    <div className="resource-category-content">
    <input className="field" aria-label={`搜索${noun}`} placeholder="搜索名称、命令、说明、标签" value={query} onChange={(event) => onQuery(event.target.value)} />
    {browsing && total > 0 && <div className="skill-batch-toolbar">
      <label><input type="checkbox" aria-label={`选中当前列表全部${noun}`} checked={allVisibleSelected}
        onChange={() => onSelected(allVisibleSelected ? selected.filter((id) => !visibleIds.includes(id)) : [...new Set([...selected, ...visibleIds])])} /> 当前列表全选</label>
      <span>已选 {selected.length}</span>
      {selected.length > 0 && <><select className="field" aria-label="批量移动目标分组" value={moveTarget} onChange={(event) => setMoveTarget(event.target.value)}>
        <option value="">未分组</option>
        {groups.map((group) => <option value={group.id} key={group.id}>{group.name}</option>)}
      </select>
      <button className="btn btn-sm" type="button" disabled={busy || !selected.length} onClick={() => void run(async () => { await api.moveResourcesToGroup(kind, selected, moveTarget || null); onSelected([]); })}>移动到该组</button></>}
    </div>}
    {children}
    </div>
  </div>;
}
