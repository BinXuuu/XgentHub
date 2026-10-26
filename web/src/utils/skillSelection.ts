/** 组操作只改变该组当前成员，保留其它组和不可见的既有选择。 */
export function toggleSkillSelection(selected: string[], members: string[]): string[] {
  const all = members.length > 0 && members.every((id) => selected.includes(id));
  const memberSet = new Set(members);
  return all ? selected.filter((id) => !memberSet.has(id)) : [...new Set([...selected, ...members])];
}

export function skillSelectionState(selected: string[], members: string[]) {
  const count = members.filter((id) => selected.includes(id)).length;
  return { count, checked: members.length > 0 && count === members.length, partial: count > 0 && count < members.length };
}
