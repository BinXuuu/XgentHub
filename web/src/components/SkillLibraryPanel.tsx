import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api/client";
import type { ResourceLibraryItem, SkillGroup } from "../api/types";
import { confirmDialog } from "../utils/dialog";
import { GithubSkillInstaller } from "./GithubSkillInstaller";

const emptySkill = { title: "", content: "", tags: "", groupId: "" };

export function SkillLibraryPanel() {
  const [skills, setSkills] = useState<ResourceLibraryItem[]>([]);
  const [groups, setGroups] = useState<SkillGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [filter, setFilter] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [moveTarget, setMoveTarget] = useState("");
  const [groupEdit, setGroupEdit] = useState<string | null>(null);
  const [groupName, setGroupName] = useState("");
  const [groupDescription, setGroupDescription] = useState("");
  const [editor, setEditor] = useState<string | null>(null);
  const [draft, setDraft] = useState(emptySkill);
  const [githubOpen, setGithubOpen] = useState(false);

  async function refresh() {
    const [items, groupList] = await Promise.all([api.listResourceLibraryItems("skill"), api.listSkillGroups()]);
    setSkills(items); setGroups(groupList);
    setSelected((ids) => ids.filter((id) => items.some((item) => item.id === id)));
  }
  useEffect(() => { void refresh().catch((err) => setError((err as Error).message)).finally(() => setLoading(false)); }, []);
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await action(); await refresh(); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  const ungrouped = skills.filter((item) => !item.groupId || !groups.some((group) => group.id === item.groupId));
  const currentGroup = groups.find((group) => group.id === filter);
  const visible = skills.filter((item) => !filter || (filter === "ungrouped" ? ungrouped.includes(item) : item.groupId === filter))
    .filter((item) => [item.title, item.content, ...item.tags, groups.find((group) => group.id === item.groupId)?.name ?? ""].join(" ").toLowerCase().includes(query.trim().toLowerCase()));
  function editSkill(item?: ResourceLibraryItem) {
    setEditor(item?.id ?? "new");
    setDraft(item ? { title: item.title, content: item.content, tags: item.tags.join(", "), groupId: item.groupId ?? "" }
      : { ...emptySkill, groupId: currentGroup?.id ?? "" });
  }
  function saveSkill(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const input = { ...draft, groupId: draft.groupId || null, tags: draft.tags.split(/[,，\n]/).map((tag) => tag.trim()).filter(Boolean) };
      if (editor === "new") await api.createResourceLibraryItem("skill", input);
      else await api.updateResourceLibraryItem("skill", editor!, input);
      setEditor(null); setNotice("Skill 已保存");
    });
  }
  function resetGroup() { setGroupEdit(null); setGroupName(""); setGroupDescription(""); }
  function saveGroup(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const input = { name: groupName, description: groupDescription };
      if (groupEdit) await api.updateSkillGroup(groupEdit, input); else await api.createSkillGroup(input);
      resetGroup(); setNotice("技能组已保存");
    });
  }
  async function removeGroup(group: SkillGroup) {
    if (!(await confirmDialog("组内技能会移到「未分组」，已给角色和工作区勾选的技能继续保留。", { title: `删除技能组「${group.name}」？`, danger: true }))) return;
    void run(async () => {
      await api.deleteSkillGroup(group.id);
      if (filter === group.id) setFilter("");
      if (draft.groupId === group.id) setDraft((value) => ({ ...value, groupId: "" }));
      if (moveTarget === group.id) setMoveTarget("");
      if (groupEdit === group.id) resetGroup();
    });
  }
  async function removeSkill(item: ResourceLibraryItem) {
    const downloaded = !!item.sourcePath && item.tags.includes("GitHub");
    if (!(await confirmDialog(downloaded ? "这会移除 Xgent 中的条目和已有选择，并删除当初从 GitHub 下载的文件。" : "这会移除 Xgent 中的条目和已有选择，本机原始技能文件会保留。", { title: `删除 Skill「${item.title}」？`, danger: true }))) return;
    void run(async () => { await api.deleteResourceLibraryItem("skill", item.id); if (editor === item.id) setEditor(null); });
  }
  return <div className="skill-library">
    <div className="skill-library-topbar">
      <div><strong>{groups.length} 个技能组 · {skills.length} 个 Skill</strong><span>按插件管理，在角色中一键整组选入。</span></div>
      <button className="btn" disabled={busy || loading} onClick={() => void run(async () => {
        const result = await api.importInstalledSkills();
        setNotice(`已导入 ${result.imported} 个 Skill，跳过 ${result.skipped} 个已有条目，涉及 ${result.groups} 个组。${result.warnings.length ? ` 提示：${result.warnings.join("；")}` : ""}`);
      })}>{busy ? "处理中..." : "导入已安装的插件 Skill"}</button>
      <button className="btn" disabled={busy || loading} onClick={() => setGithubOpen(true)}>从 GitHub 安装</button>
      <button className="btn btn-primary" disabled={busy || loading} onClick={() => editSkill()}>添加 Skill</button>
    </div>
    <p className="config-field-help">导入本机已安装的 Anthropic、Cinetic、Earshot（含 real-sound）技能；保留完整说明与配套资源的本机入口。外部服务连接和运行依赖需单独配置。</p>
    {error && <div className="form-error" role="alert">{error}</div>}{notice && <div className="resource-tab-note ok" role="status">{notice}</div>}
    {githubOpen && <GithubSkillInstaller groups={groups} onClose={() => setGithubOpen(false)} onDone={async (message) => { setError(""); setNotice(message); await refresh(); }} />}
    <div className="skill-library-grid">
      <aside className="resource-panel skill-group-panel">
        <h3>技能组</h3>
        <nav className="skill-group-nav" aria-label="技能组筛选">
          <button className={filter === "" ? "active" : ""} onClick={() => setFilter("")}>全部技能 <span>{skills.length}</span></button>
          {groups.map((group) => <div className="skill-group-nav-row" key={group.id}>
            <button title={group.description} className={filter === group.id ? "active" : ""} onClick={() => setFilter(group.id)}>{group.name}<span>{group.skillCount}</span></button>
            <button className="btn btn-ghost btn-sm" aria-label={`编辑组 ${group.name}`} disabled={busy} onClick={() => { setGroupEdit(group.id); setGroupName(group.name); setGroupDescription(group.description); }}>编辑</button>
          </div>)}
          <button className={filter === "ungrouped" ? "active" : ""} onClick={() => setFilter("ungrouped")}>未分组 <span>{ungrouped.length}</span></button>
        </nav>
        <form className="resource-form skill-group-form" onSubmit={saveGroup}>
          <h4>{groupEdit ? "编辑技能组" : "新建技能组"}</h4>
          <input className="field" aria-label="技能组名称" placeholder="技能组名称" required value={groupName} onChange={(event) => setGroupName(event.target.value)} />
          <textarea className="field" aria-label="技能组说明" placeholder="说明（可选）" rows={2} value={groupDescription} onChange={(event) => setGroupDescription(event.target.value)} />
          <div className="resource-card-actions"><button className="btn btn-sm" disabled={busy}>{groupEdit ? "保存组" : "新建组"}</button>{groupEdit && <button className="btn btn-ghost btn-sm" type="button" onClick={resetGroup}>取消</button>}
            {groupEdit && <button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={() => void removeGroup(groups.find((group) => group.id === groupEdit)!)}>删除组</button>}</div>
        </form>
      </aside>
      <section className="resource-panel skill-list-panel">
        <div className="workspace-section-head"><div><h3>{currentGroup?.name ?? (filter === "ungrouped" ? "未分组" : "全部技能")}</h3><span>{currentGroup?.description ?? `${visible.length} 个 Skill；可以批量移动到同一个组。`}</span></div></div>
        <input className="field" aria-label="搜索 Skill" placeholder="搜索名称、说明、标签" value={query} onChange={(event) => setQuery(event.target.value)} />
        {!!skills.length && <div className="skill-batch-toolbar">
          <label><input type="checkbox" aria-label="选中当前列表全部 Skill" checked={visible.length > 0 && visible.every((item) => selected.includes(item.id))}
            onChange={() => setSelected((ids) => visible.every((item) => ids.includes(item.id)) ? ids.filter((id) => !visible.some((item) => item.id === id)) : [...new Set([...ids, ...visible.map((item) => item.id)])])} /> 当前列表全选</label>
          <span>已选 {selected.length}</span>
          <select className="field" aria-label="批量移动目标组" value={moveTarget} onChange={(event) => setMoveTarget(event.target.value)}><option value="">未分组</option>{groups.map((group) => <option value={group.id} key={group.id}>{group.name}</option>)}</select>
          <button className="btn btn-sm" disabled={busy || !selected.length} onClick={() => void run(async () => { await api.moveSkillsToGroup(selected, moveTarget || null); setSelected([]); setNotice("已更新技能归组"); })}>移动到该组</button>
        </div>}
        {editor && <form className="resource-form skill-editor" onSubmit={saveSkill}>
          <h4>{editor === "new" ? "添加 Skill" : "编辑 Skill"}</h4>
          <input className="field" aria-label="Skill 名称" placeholder="Skill 名称" required value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
          <select className="field" aria-label="Skill 所属组" value={draft.groupId} onChange={(event) => setDraft({ ...draft, groupId: event.target.value })}><option value="">未分组</option>{groups.map((group) => <option value={group.id} key={group.id}>{group.name}</option>)}</select>
          <textarea className="field" aria-label="Skill 内容或触发说明" placeholder="触发场景、执行步骤、验收标准" rows={6} required value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} />
          {skills.find((item) => item.id === editor)?.sourcePath && <span className="config-field-help">这里修改触发说明；完整技能仍从原 SKILL.md 文件读取。</span>}
          <input className="field" aria-label="Skill 标签" placeholder="标签，用逗号分隔" value={draft.tags} onChange={(event) => setDraft({ ...draft, tags: event.target.value })} />
          <div className="resource-card-actions"><button className="btn btn-primary btn-sm" disabled={busy}>保存 Skill</button><button className="btn btn-ghost btn-sm" type="button" onClick={() => setEditor(null)}>取消</button></div>
        </form>}
        <div className="knowledge-list">
          {loading && <div className="workspace-loading">正在加载...</div>}
          {!loading && !visible.length && <div className="workspace-empty">当前没有 Skill，可导入已安装的插件技能或手动添加。</div>}
          {visible.map((item) => <article className="knowledge-card skill-library-card" key={item.id}>
            <div className="knowledge-card-head"><label><input type="checkbox" checked={selected.includes(item.id)} aria-label={`选择 ${item.title}`} onChange={() => setSelected((ids) => ids.includes(item.id) ? ids.filter((id) => id !== item.id) : [...ids, item.id])} /><strong>{item.title}</strong></label>
              <div className="resource-card-actions"><button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => editSkill(item)}>编辑</button><button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void removeSkill(item)}>删除</button></div></div>
            <div className="resource-card-sub">{groups.find((group) => group.id === item.groupId)?.name ?? "未分组"} · {item.sourcePath ? "本机文件 · 按需加载" : "内置说明"}</div>
            <p className="library-card-summary">{item.content}</p>
            <details><summary>{item.sourcePath ? "查看触发说明与文件入口" : "查看完整说明"}</summary><p className="library-card-detail">{item.content}</p>{item.sourcePath && <code className="skill-source-path">{item.sourcePath}</code>}</details>
          </article>)}
        </div>
      </section>
    </div>
  </div>;
}
