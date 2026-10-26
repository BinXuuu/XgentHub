import { useState } from "react";
import type { ResourceLibraryItem, SkillGroup } from "../api/types";
import { skillSelectionState, toggleSkillSelection } from "../utils/skillSelection";

interface Props {
  skills: ResourceLibraryItem[];
  groups: SkillGroup[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}

export function SkillPicker({ skills, groups, selectedIds, onChange }: Props) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string[]>([]);
  const known = new Set(groups.map((group) => group.id));
  const buckets = [...groups.map((group) => ({ ...group, skills: skills.filter((skill) => skill.groupId === group.id) })),
    { id: "ungrouped", name: "未分组", description: "", source: null, skills: skills.filter((skill) => !skill.groupId || !known.has(skill.groupId)) }]
    .filter((group) => group.skills.length > 0);
  const q = query.trim().toLowerCase();
  const visible = buckets.map((group) => ({ ...group, visible: !q || group.name.toLowerCase().includes(q) ? group.skills
    : group.skills.filter((skill) => [skill.title, skill.content, ...skill.tags].join(" ").toLowerCase().includes(q)) }))
    .filter((group) => group.visible.length > 0);
  return (
    <div className="skill-picker">
      <div className="skill-picker-toolbar">
        <input className="field" aria-label="搜索技能或组" placeholder="搜索技能或组" value={query} onChange={(event) => setQuery(event.target.value)} />
        <span>已选 {skills.filter((skill) => selectedIds.includes(skill.id)).length} / {skills.length}</span>
      </div>
      <p className="config-field-help">勾选组名可整组选中当前全部成员，再单独调整。组内新增技能需重新勾选；搜索时整组选中仍包含隐藏成员。</p>
      {!skills.length && <div className="workspace-empty">Skill 库是空的，去左侧「Skill」页导入或添加。</div>}
      {!!skills.length && !visible.length && <div className="workspace-empty">没有匹配的技能或组</div>}
      <div className="skill-picker-groups">
        {visible.map((group) => {
          const memberIds = group.skills.map((skill) => skill.id);
          const state = skillSelectionState(selectedIds, memberIds);
          const open = !!q || expanded.includes(group.id);
          return <section className={`skill-picker-group ${state.checked ? "selected" : ""}`} key={group.id}>
            <div className="skill-picker-group-head">
              <label title={group.description}>
                <input type="checkbox" aria-label={`整组选中 ${group.name}`} checked={state.checked}
                  aria-checked={state.partial ? "mixed" : state.checked}
                  ref={(input) => { if (input) input.indeterminate = state.partial; }}
                  onChange={() => onChange(toggleSkillSelection(selectedIds, memberIds))} />
                <strong>{group.name}</strong>
                <span className="skill-count">{state.count} / {memberIds.length}</span>
              </label>
              <button className="btn btn-ghost btn-sm" type="button" aria-expanded={open} onClick={() => setExpanded((previous) => previous.includes(group.id) ? previous.filter((id) => id !== group.id) : [...previous, group.id])}>{open ? "收起" : "展开"}</button>
            </div>
            {open && <div className="skill-picker-members">
              {group.visible.map((skill) => <label key={skill.id} title={skill.content} className="skill-picker-member">
                <input type="checkbox" checked={selectedIds.includes(skill.id)} onChange={() => onChange(toggleSkillSelection(selectedIds, [skill.id]))} />
                <span>{group.source?.startsWith("anthropics/") ? skill.title.replace(`anthropic-${group.source.split("/").at(-1)}-`, "") : skill.title}</span>
              </label>)}
            </div>}
          </section>;
        })}
      </div>
    </div>
  );
}
