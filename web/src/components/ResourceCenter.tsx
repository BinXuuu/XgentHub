import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api } from "../api/client";
import { fileToKnowledgeEntries, IMPORTABLE_EXTENSIONS, isImportableFile } from "../utils/knowledgeImport";
import { confirmDialog } from "../utils/dialog";
import { SkillLibraryPanel } from "./SkillLibraryPanel";
import type {
  KnowledgeEntry,
  KnowledgeGroup,
  McpServerDefinition,
  McpServerUsage,
  McpTransport,
  ResourceLibraryItem,
  ResourceLibraryKind,
  Workspace,
} from "../api/types";

interface Props {
  mode: "knowledge" | "skills" | "tools" | "mcp";
  workspaces: Workspace[];
  onOpenWorkspace: (workspaceId: string) => void;
}

function describeMcpUsage(usage: McpServerUsage | undefined): string[] {
  if (!usage) return [];
  return [
    ...usage.workspaces.map((ref) => `工作区「${ref.title}」`),
    ...usage.roles.map((ref) => `角色「${ref.title}」`),
    ...usage.chats.map((ref) => `聊天「${ref.title}」`),
  ];
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}

function compactText(value: string, maxLength = 180): string {
  const text = value.replace(/^来源：.*?\n\n/s, "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function parseTags(value: string): string[] {
  return value
    .split(/[,，\n]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function libraryKindFromMode(mode: Props["mode"]): ResourceLibraryKind | null {
  if (mode === "skills") return "skill";
  if (mode === "tools") return "tool";
  return null;
}

function parseLines(value: string): string[][] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf("=");
      return idx > 0 ? [line.slice(0, idx).trim(), line.slice(idx + 1).trim()] : [line, ""];
    });
}

function parseKeyValueLines(value: string): Record<string, string> {
  return Object.fromEntries(parseLines(value).filter(([key]) => key));
}

function formatKeyValueLines(record: Record<string, string>): string {
  return Object.entries(record)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function resourceCopy(mode: Props["mode"]) {
  if (mode === "knowledge") {
    return {
      kicker: "知识库",
      title: "统一知识库",
      desc: "知识按组管理。在工作区里勾选要用的知识组，小组（总共不超过 3000 字）每一轮整组带给 Agent，大组按消息挑最相关的几条。",
    };
  }
  if (mode === "skills") {
    return {
      kicker: "Skill",
      title: "Skill 管理",
      desc: "同一个插件的 Skill 按组管理，在 Agent 角色、工作区或聊天中一键整组选入，也可以逐项调整。",
    };
  }
  if (mode === "mcp") {
    return {
      kicker: "MCP",
      title: "MCP 管理",
      desc: "统一注册 MCP server，在工作区里勾选要用的几个，Claude Code / Codex / OpenClaw 都能接上。",
    };
  }
  return {
    kicker: "工具",
    title: "工具管理",
    desc: "记录常用命令、脚本入口、服务地址和排障工具。当前先做统一管理，不自动执行命令。",
  };
}

export function ResourceCenter({ mode, workspaces, onOpenWorkspace }: Props) {
  const copy = resourceCopy(mode);
  const libraryKind = libraryKindFromMode(mode);

  const [groups, setGroups] = useState<KnowledgeGroup[]>([]);
  const [targetGroupId, setTargetGroupId] = useState("");
  const [filterGroupId, setFilterGroupId] = useState("");
  const [newGroupName, setNewGroupName] = useState("");
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editGroupName, setEditGroupName] = useState("");
  const [editGroupDesc, setEditGroupDesc] = useState("");
  const [query, setQuery] = useState("");
  const [knowledgeEntries, setKnowledgeEntries] = useState<KnowledgeEntry[]>([]);
  const [editingKnowledgeId, setEditingKnowledgeId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const [importDragOver, setImportDragOver] = useState(false);
  const [libraryItems, setLibraryItems] = useState<ResourceLibraryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [command, setCommand] = useState("");
  const [libraryEditingId, setLibraryEditingId] = useState<string | null>(null);
  const [expandedLibraryId, setExpandedLibraryId] = useState<string | null>(null);

  const [mcpServers, setMcpServers] = useState<McpServerDefinition[]>([]);
  const [mcpEditingId, setMcpEditingId] = useState<string | null>(null);
  const [mcpName, setMcpName] = useState("");
  const [mcpTransport, setMcpTransport] = useState<McpTransport>("stdio");
  const [mcpCommand, setMcpCommand] = useState("");
  const [mcpArgs, setMcpArgs] = useState("");
  const [mcpEnvText, setMcpEnvText] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [mcpHeadersText, setMcpHeadersText] = useState("");
  const [mcpTesting, setMcpTesting] = useState(false);
  const [mcpTestResult, setMcpTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const groupById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);

  function resetMcpForm() {
    setMcpEditingId(null);
    setMcpName("");
    setMcpTransport("stdio");
    setMcpCommand("");
    setMcpArgs("");
    setMcpEnvText("");
    setMcpUrl("");
    setMcpHeadersText("");
    setMcpTestResult(null);
  }

  useEffect(() => {
    setQuery("");
    setError(null);
    setTitle("");
    setContent("");
    setTags("");
    setCommand("");
    setLibraryEditingId(null);
    setEditingKnowledgeId(null);
    setExpandedLibraryId(null);
    resetMcpForm();
  }, [mode]);

  useEffect(() => {
    if (groups.length === 0) {
      if (targetGroupId) setTargetGroupId("");
    } else if (!groupById.has(targetGroupId)) {
      setTargetGroupId(groups[0].id);
    }
  }, [groups, groupById, targetGroupId]);

  async function refreshGroups() {
    const next = await api.listKnowledgeGroups();
    setGroups(next);
    if (filterGroupId && !next.some((group) => group.id === filterGroupId)) setFilterGroupId("");
  }

  async function refreshKnowledge(nextQuery = query, groupId = filterGroupId) {
    setLoading(true);
    setError(null);
    try {
      setKnowledgeEntries(
        await api.listKnowledge({ groupId: groupId || undefined, query: nextQuery.trim() || undefined, limit: 200 })
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function selectGroup(groupId: string) {
    setFilterGroupId(groupId);
    if (groupId) setTargetGroupId(groupId);
    void refreshKnowledge(query, groupId);
  }

  async function addGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!newGroupName.trim()) {
      setError("请填写知识组名称");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const group = await api.createKnowledgeGroup({ name: newGroupName.trim() });
      setNewGroupName("");
      await refreshGroups();
      setTargetGroupId(group.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function startGroupEdit(group: KnowledgeGroup) {
    setEditingGroupId(group.id);
    setEditGroupName(group.name);
    setEditGroupDesc(group.description);
  }

  async function saveGroupEdit(group: KnowledgeGroup) {
    if (!editGroupName.trim()) {
      setError("组名不能为空");
      return;
    }
    setError(null);
    try {
      await api.updateKnowledgeGroup(group.id, { name: editGroupName.trim(), description: editGroupDesc.trim() });
      setEditingGroupId(null);
      await refreshGroups();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function removeGroup(group: KnowledgeGroup) {
    const usedBy = workspaces.filter((workspace) => workspace.knowledgeGroupIds.includes(group.id));
    const usageNote = usedBy.length ? `正在被 ${usedBy.map((workspace) => `「${workspace.name}」`).join("、")} 使用，删除后这些工作区不再引用它。` : "";
    if (!(await confirmDialog(`它下面的 ${group.entryCount} 条知识会一起删除。${usageNote}此操作不能撤销。`, { title: `删除知识组「${group.name}」？`, danger: true }))) return;
    setError(null);
    try {
      await api.deleteKnowledgeGroup(group.id);
      const nextFilter = filterGroupId === group.id ? "" : filterGroupId;
      setFilterGroupId(nextFilter);
      await refreshGroups();
      await refreshKnowledge(query, nextFilter);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function refreshLibrary(nextQuery = query) {
    if (!libraryKind) return;
    setLoading(true);
    setError(null);
    try {
      const items = await api.listResourceLibraryItems(libraryKind, { query: nextQuery.trim() || undefined });
      setLibraryItems(items);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function refreshMcpServers() {
    setLoading(true);
    setError(null);
    try {
      setMcpServers(await api.listMcpServers());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (mode === "skills") return;
    if (mode === "knowledge") {
      setFilterGroupId("");
      void refreshGroups().catch((err) => setError((err as Error).message));
      void refreshKnowledge("", "");
      return;
    }
    if (mode === "mcp") {
      void refreshMcpServers();
      return;
    }
    void refreshLibrary("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  function editMcpServer(item: McpServerDefinition) {
    setMcpEditingId(item.id);
    setMcpName(item.name);
    setMcpTransport(item.transport);
    setMcpCommand(item.command ?? "");
    setMcpArgs(item.args.join(" "));
    setMcpEnvText(formatKeyValueLines(item.env));
    setMcpUrl(item.url ?? "");
    setMcpHeadersText(formatKeyValueLines(item.headers));
    setMcpTestResult(null);
  }

  function buildMcpFormInput() {
    return {
      name: mcpName.trim(),
      transport: mcpTransport,
      command: mcpTransport === "stdio" ? mcpCommand.trim() : null,
      args: mcpTransport === "stdio" ? mcpArgs.split(/\s+/).filter(Boolean) : [],
      env: mcpTransport === "stdio" ? parseKeyValueLines(mcpEnvText) : {},
      url: mcpTransport === "http" ? mcpUrl.trim() : null,
      headers: mcpTransport === "http" ? parseKeyValueLines(mcpHeadersText) : {},
    };
  }

  async function saveMcpServer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!mcpName.trim()) {
      setError("请填写名字");
      return;
    }
    if (mcpTransport === "stdio" && !mcpCommand.trim()) {
      setError("stdio 类型需要填启动命令");
      return;
    }
    if (mcpTransport === "http" && !mcpUrl.trim()) {
      setError("http 类型需要填 URL");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const input = buildMcpFormInput();
      if (mcpEditingId) await api.updateMcpServer(mcpEditingId, input);
      else await api.createMcpServer(input);
      resetMcpForm();
      await refreshMcpServers();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function testMcpConnection() {
    if (mcpTransport === "stdio" && !mcpCommand.trim()) {
      setMcpTestResult({ ok: false, message: "先填启动命令再测试" });
      return;
    }
    if (mcpTransport === "http" && !mcpUrl.trim()) {
      setMcpTestResult({ ok: false, message: "先填 URL 再测试" });
      return;
    }
    setMcpTesting(true);
    setMcpTestResult(null);
    try {
      const result = await api.testMcpServer(buildMcpFormInput());
      setMcpTestResult(result);
    } catch (err) {
      setMcpTestResult({ ok: false, message: (err as Error).message });
    } finally {
      setMcpTesting(false);
    }
  }

  async function toggleMcpEnabled(item: McpServerDefinition) {
    setError(null);
    try {
      await api.updateMcpServer(item.id, { enabled: !item.enabled });
      await refreshMcpServers();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function deleteMcpServerItem(item: McpServerDefinition) {
    const refs = describeMcpUsage(item.usage);
    const usageNote = refs.length ? `目前被 ${refs.join("、")} 引用，删除后会从这些地方一起去掉。` : "目前没有工作区、角色或聊天在用它。";
    if (!(await confirmDialog(usageNote || "删除后用到它的地方会自动去掉。", { title: `删除 MCP「${item.name}」？`, danger: true }))) return;
    setError(null);
    try {
      await api.deleteMcpServer(item.id);
      if (mcpEditingId === item.id) resetMcpForm();
      await refreshMcpServers();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function addKnowledge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!targetGroupId) {
      setError("请先新建并选择一个知识组");
      return;
    }
    if (!title.trim() || !content.trim()) {
      setError("请填写标题和内容");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const input = { groupId: targetGroupId, title: title.trim(), content: content.trim(), tags: parseTags(tags) };
      if (editingKnowledgeId) await api.updateKnowledge(editingKnowledgeId, input);
      else await api.createKnowledge(input);
      resetKnowledgeForm();
      await Promise.all([refreshGroups(), refreshKnowledge(query)]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  /** 批量导入：每个 .md / .txt 文件变成一条知识（太长自动拆成几条），放进当前选中的知识组。 */
  async function importKnowledgeFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList);
    if (files.length === 0) return;
    if (!targetGroupId) {
      setError("请先新建并选择一个知识组，再导入");
      return;
    }
    const skipped = files.filter((file) => !isImportableFile(file.name)).map((file) => file.name);
    const accepted = files.filter((file) => isImportableFile(file.name));
    setImporting(true);
    setError(null);
    setImportResult(null);
    let created = 0;
    const failed: string[] = [];
    const empty: string[] = [];
    for (const file of accepted) {
      try {
        const entries = fileToKnowledgeEntries(file.name, await file.text());
        if (entries.length === 0) empty.push(file.name);
        for (const entry of entries) {
          await api.createKnowledge({ groupId: targetGroupId, title: entry.title, content: entry.content, tags: ["导入"], source: `import:${file.name}` });
          created += 1;
        }
      } catch (err) {
        failed.push(`${file.name}（${(err as Error).message}）`);
      }
    }
    const groupName = groupById.get(targetGroupId)?.name ?? "知识组";
    setImportResult(
      [
        `已从 ${accepted.length - failed.length - empty.length} 个文件导入 ${created} 条到「${groupName}」`,
        empty.length ? `空文件跳过：${empty.join("、")}` : null,
        skipped.length ? `不支持的格式跳过：${skipped.join("、")}（只支持 ${IMPORTABLE_EXTENSIONS.join(" / ")}）` : null,
        failed.length ? `失败：${failed.join("、")}` : null,
      ]
        .filter(Boolean)
        .join("；")
    );
    setImporting(false);
    await Promise.all([refreshGroups(), refreshKnowledge(query)]);
  }

  function resetKnowledgeForm() {
    setEditingKnowledgeId(null);
    setTitle("");
    setContent("");
    setTags("");
  }

  /** 把这条知识带到左边表单里改；改完点「保存修改」。 */
  function editKnowledge(entry: KnowledgeEntry) {
    setEditingKnowledgeId(entry.id);
    setTargetGroupId(entry.groupId);
    setTitle(entry.title);
    setContent(entry.content);
    setTags(entry.tags.join(", "));
    setError(null);
    document.querySelector(".knowledge-add-head")?.scrollIntoView({ block: "start" });
  }

  async function addLibraryItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!libraryKind) return;
    if (!title.trim() || !content.trim()) {
      setError("请填写标题和内容");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const input = {
        title: title.trim(),
        content: content.trim(),
        tags: parseTags(tags),
        command: mode === "tools" || libraryEditingId ? command.trim() || null : null,
      };
      if (libraryEditingId) await api.updateResourceLibraryItem(libraryKind, libraryEditingId, input);
      else await api.createResourceLibraryItem(libraryKind, input);
      resetLibraryForm();
      await refreshLibrary(query);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function resetLibraryForm() {
    setLibraryEditingId(null);
    setTitle("");
    setContent("");
    setTags("");
    setCommand("");
  }

  function editLibraryItem(item: ResourceLibraryItem) {
    setLibraryEditingId(item.id);
    setExpandedLibraryId(item.id);
    setTitle(item.title);
    setContent(item.content);
    setTags(item.tags.join(", "));
    setCommand(item.command ?? "");
    setError(null);
  }

  async function deleteKnowledge(entry: KnowledgeEntry) {
    if (!(await confirmDialog("此操作不能撤销。", { title: `删除知识条目「${entry.title}」？`, danger: true }))) return;
    setError(null);
    try {
      await api.deleteKnowledge(entry.id);
      if (editingKnowledgeId === entry.id) resetKnowledgeForm();
      await Promise.all([refreshGroups(), refreshKnowledge(query)]);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function deleteLibraryItem(item: ResourceLibraryItem) {
    if (!(await confirmDialog("删除后用到它的地方会自动去掉。", { title: `删除${mode === "skills" ? "Skill" : "工具"}「${item.title}」？`, danger: true }))) return;
    setError(null);
    try {
      await api.deleteResourceLibraryItem(item.kind, item.id);
      if (libraryEditingId === item.id) resetLibraryForm();
      if (expandedLibraryId === item.id) setExpandedLibraryId(null);
      await refreshLibrary(query);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const isKnowledge = mode === "knowledge";
  const itemLabel = mode === "skills" ? "Skill" : "工具";

  return (
    <div className="resource-center">
      <header className="resource-hero">
        <div>
          <div className="dashboard-kicker">{copy.kicker}</div>
          <h1>{copy.title}</h1>
          <p>{copy.desc}</p>
        </div>
      </header>

      {mode === "skills" ? <SkillLibraryPanel /> : isKnowledge ? (
        <div className="resource-grid">
          <section className="resource-panel">
            <div className="workspace-section-head">
              <div>
                <h3>知识组</h3>
                <span>{groups.length} 个组。在工作区里勾选要用的组，一个组可以给多个工作区共用。</span>
              </div>
            </div>
            <div className="knowledge-group-list">
              {groups.length === 0 && <div className="workspace-empty">还没有知识组，先在下面新建一个</div>}
              {groups.map((group) => {
                const usedBy = workspaces.filter((workspace) => workspace.knowledgeGroupIds.includes(group.id));
                const active = filterGroupId === group.id;
                return (
                  <article className={`knowledge-card knowledge-group-card ${active ? "active" : ""}`} key={group.id}>
                    {editingGroupId === group.id ? (
                      <form
                        className="resource-form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void saveGroupEdit(group);
                        }}
                      >
                        <input className="field" value={editGroupName} onChange={(event) => setEditGroupName(event.target.value)} placeholder="组名" autoFocus />
                        <input
                          className="field"
                          value={editGroupDesc}
                          onChange={(event) => setEditGroupDesc(event.target.value)}
                          placeholder="说明（可选）"
                        />
                        <div className="resource-card-actions">
                          <button className="btn btn-ghost btn-sm" type="button" onClick={() => setEditingGroupId(null)}>
                            取消
                          </button>
                          <button className="btn btn-primary btn-sm" type="submit">
                            保存
                          </button>
                        </div>
                      </form>
                    ) : (
                      <>
                        <div className="knowledge-card-head">
                          <button className="knowledge-group-name" type="button" onClick={() => selectGroup(active ? "" : group.id)}>
                            <strong>{group.name}</strong>
                            <span>{group.entryCount} 条</span>
                          </button>
                          <div className="resource-card-actions">
                            <button className="btn btn-ghost btn-sm" type="button" onClick={() => startGroupEdit(group)}>
                              改名
                            </button>
                            <button className="btn btn-ghost btn-sm" type="button" onClick={() => void removeGroup(group)}>
                              删除
                            </button>
                          </div>
                        </div>
                        {group.description && <div className="resource-card-sub">{group.description}</div>}
                        <div className="resource-card-sub">
                          {usedBy.length === 0 ? (
                            "还没有工作区在用"
                          ) : (
                            <>
                              在用：
                              {usedBy.map((workspace, index) => (
                                <span key={workspace.id}>
                                  {index > 0 && "、"}
                                  <button className="link-button" type="button" onClick={() => onOpenWorkspace(workspace.id)}>
                                    {workspace.name}
                                  </button>
                                </span>
                              ))}
                            </>
                          )}
                        </div>
                      </>
                    )}
                  </article>
                );
              })}
            </div>
            <form className="resource-form knowledge-group-create" onSubmit={(event) => void addGroup(event)}>
              <div className="knowledge-form-row">
                <input className="field" value={newGroupName} onChange={(event) => setNewGroupName(event.target.value)} placeholder="新知识组名称，比如 部署手册" />
                <button className="btn" type="submit" disabled={saving}>
                  新建组
                </button>
              </div>
            </form>

            <div className="workspace-section-head knowledge-add-head">
              <div>
                <h3>{editingKnowledgeId ? "编辑知识" : "添加知识"}</h3>
                <span>
                  {editingKnowledgeId
                    ? "改完点「保存修改」；换知识组就是把这条移到别的组。"
                    : "条目放进哪个组，就会被用这个组的工作区里的任务检索到。"}
                </span>
              </div>
            </div>
            <form className="resource-form" onSubmit={(event) => void addKnowledge(event)}>
              <label>
                <span>{editingKnowledgeId ? "所在知识组" : "放进知识组"}</span>
                <select className="field" value={targetGroupId} onChange={(event) => setTargetGroupId(event.target.value)}>
                  {groups.length === 0 && <option value="">先新建一个知识组</option>}
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </select>
              </label>
              <input className="field" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="标题" />
              <textarea className="field" rows={6} value={content} onChange={(event) => setContent(event.target.value)} placeholder="内容" />
              <div className="knowledge-form-row">
                <input className="field" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="标签，用逗号分隔" />
                <button className="btn btn-primary" type="submit" disabled={saving || groups.length === 0}>
                  {saving ? "保存中..." : editingKnowledgeId ? "保存修改" : "添加知识"}
                </button>
              </div>
              {editingKnowledgeId && (
                <button className="btn btn-ghost" type="button" onClick={resetKnowledgeForm}>
                  取消编辑
                </button>
              )}
            </form>

            <label
              className={`knowledge-import ${importDragOver ? "drag-over" : ""} ${importing ? "busy" : ""}`}
              onDragOver={(event) => {
                event.preventDefault();
                setImportDragOver(true);
              }}
              onDragLeave={() => setImportDragOver(false)}
              onDrop={(event) => {
                event.preventDefault();
                setImportDragOver(false);
                if (!importing) void importKnowledgeFiles(event.dataTransfer.files);
              }}
            >
              <input
                type="file"
                multiple
                accept={IMPORTABLE_EXTENSIONS.join(",")}
                disabled={importing || groups.length === 0}
                onChange={(event) => {
                  if (event.target.files) void importKnowledgeFiles(event.target.files);
                  event.target.value = "";
                }}
              />
              <strong>{importing ? "导入中..." : "批量导入"}</strong>
              <span>把 .md / .txt 文件拖到这里，或点这里选择（可多选）。每个文件变成一条知识，放进上面选的知识组；太长的会自动拆成几条。</span>
            </label>
            {importResult && <div className="resource-tab-note ok">{importResult}</div>}
            {error && <div className="login-error">{error}</div>}
          </section>

          <section className="resource-panel resource-list-panel">
            <div className="workspace-section-head">
              <div>
                <h3>知识条目</h3>
                <span>{knowledgeEntries.length} 条记录</span>
              </div>
            </div>
            <div className="resource-toolbar">
              <select className="field" value={filterGroupId} onChange={(event) => selectGroup(event.target.value)}>
                <option value="">全部知识组</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
              <input
                className="field"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void refreshKnowledge();
                }}
                placeholder="搜索标题、内容或标签"
              />
              <button className="btn" type="button" disabled={loading} onClick={() => void refreshKnowledge()}>
                搜索
              </button>
            </div>
            <div className="knowledge-list">
              {loading && <div className="workspace-loading">读取中...</div>}
              {!loading && knowledgeEntries.length === 0 && <div className="workspace-empty">暂无知识条目</div>}
              {!loading &&
                knowledgeEntries.map((entry) => (
                  <article className="knowledge-card" key={entry.id}>
                    <div className="knowledge-card-head">
                      <strong>{entry.title}</strong>
                      <div className="resource-card-actions">
                        <button className="btn btn-ghost btn-sm" type="button" onClick={() => editKnowledge(entry)}>
                          {editingKnowledgeId === entry.id ? "编辑中" : "编辑"}
                        </button>
                        <button className="btn btn-ghost btn-sm" type="button" onClick={() => void deleteKnowledge(entry)}>
                          删除
                        </button>
                      </div>
                    </div>
                    <div className="resource-card-sub">
                      {groupById.get(entry.groupId)?.name ?? "未知分组"} · {formatDate(entry.updatedAt)}
                    </div>
                    {entry.tags.length > 0 && (
                      <div className="knowledge-tags">
                        {entry.tags.map((tag) => (
                          <span key={tag}>{tag}</span>
                        ))}
                      </div>
                    )}
                    <p>{entry.content}</p>
                  </article>
                ))}
            </div>
          </section>
        </div>
      ) : mode === "mcp" ? (
        <div className="resource-grid">
          <section className="resource-panel">
            <div className="workspace-section-head">
              <div>
                <h3>{mcpEditingId ? "编辑 MCP server" : "添加 MCP server"}</h3>
                <span>统一注册一次，在工作区里勾选要用的几个，Claude Code / Codex / OpenClaw 都能接上。</span>
              </div>
            </div>
            <form className="resource-form" onSubmit={(event) => void saveMcpServer(event)}>
              <input className="field" value={mcpName} onChange={(event) => setMcpName(event.target.value)} placeholder="名字，比如 CAD 绘图" />
              <div className="resource-radio-row">
                <label>
                  <input type="radio" checked={mcpTransport === "stdio"} onChange={() => setMcpTransport("stdio")} /> stdio（本地命令）
                </label>
                <label>
                  <input type="radio" checked={mcpTransport === "http"} onChange={() => setMcpTransport("http")} /> http（远程地址）
                </label>
              </div>
              {mcpTransport === "stdio" ? (
                <>
                  <input className="field" value={mcpCommand} onChange={(event) => setMcpCommand(event.target.value)} placeholder="启动命令，比如 python" />
                  <input className="field" value={mcpArgs} onChange={(event) => setMcpArgs(event.target.value)} placeholder="参数，用空格分隔，比如 -m cad_mcp.server" />
                  <textarea
                    className="field"
                    rows={3}
                    value={mcpEnvText}
                    onChange={(event) => setMcpEnvText(event.target.value)}
                    placeholder={"环境变量，每行一个 KEY=VALUE（可选）"}
                  />
                </>
              ) : (
                <>
                  <input className="field" value={mcpUrl} onChange={(event) => setMcpUrl(event.target.value)} placeholder="https://..." />
                  <textarea
                    className="field"
                    rows={3}
                    value={mcpHeadersText}
                    onChange={(event) => setMcpHeadersText(event.target.value)}
                    placeholder={"请求头，每行一个 KEY=VALUE（可选）"}
                  />
                </>
              )}
              <div className="resource-card-actions">
                <button className="btn btn-ghost" type="button" onClick={() => void testMcpConnection()} disabled={mcpTesting}>
                  {mcpTesting ? "测试中..." : "测试连接"}
                </button>
                {mcpEditingId && (
                  <button className="btn btn-ghost" type="button" onClick={resetMcpForm}>
                    取消编辑
                  </button>
                )}
                <button className="btn btn-primary" type="submit" disabled={saving}>
                  {saving ? "保存中..." : mcpEditingId ? "保存修改" : "添加 MCP server"}
                </button>
              </div>
              {mcpTestResult && (
                <div className={mcpTestResult.ok ? "mcp-test-result ok" : "mcp-test-result fail"}>
                  {mcpTestResult.ok ? "✓ " : "✗ "}
                  {mcpTestResult.message}
                </div>
              )}
            </form>
            {error && <div className="login-error">{error}</div>}
          </section>

          <section className="resource-panel resource-list-panel">
            <div className="workspace-section-head">
              <div>
                <h3>MCP server 列表</h3>
                <span>{mcpServers.length} 条记录</span>
              </div>
            </div>
            <div className="knowledge-list">
              {loading && <div className="workspace-loading">读取中...</div>}
              {!loading && mcpServers.length === 0 && <div className="workspace-empty">暂无 MCP server</div>}
              {!loading &&
                mcpServers.map((item) => (
                  <article className="knowledge-card" key={item.id}>
                    <div className="knowledge-card-head">
                      <strong>{item.name}</strong>
                      <div className="resource-card-actions">
                        <button className="btn btn-ghost btn-sm" type="button" onClick={() => void toggleMcpEnabled(item)}>
                          {item.enabled ? "停用" : "启用"}
                        </button>
                        <button className="btn btn-ghost btn-sm" type="button" onClick={() => editMcpServer(item)}>
                          编辑
                        </button>
                        <button className="btn btn-ghost btn-sm" type="button" onClick={() => void deleteMcpServerItem(item)}>
                          删除
                        </button>
                      </div>
                    </div>
                    <div className="resource-card-sub">
                      {item.transport === "stdio" ? "stdio" : "http"} · {item.enabled ? "已启用" : "已停用"} · {formatDate(item.updatedAt)} ·{" "}
                      {describeMcpUsage(item.usage).length ? `被 ${describeMcpUsage(item.usage).length} 处引用` : "暂无引用"}
                    </div>
                    <code className="resource-command">
                      {item.transport === "stdio" ? [item.command, ...item.args].filter(Boolean).join(" ") : item.url}
                    </code>
                    {describeMcpUsage(item.usage).length > 0 && (
                      <div className="resource-card-sub">{describeMcpUsage(item.usage).join("、")}</div>
                    )}
                  </article>
                ))}
            </div>
          </section>
        </div>
      ) : (
        <div className="resource-grid">
          <section className="resource-panel">
            <div className="workspace-section-head">
              <div>
                <h3>{libraryEditingId ? `编辑${itemLabel}` : `添加${itemLabel}`}</h3>
                <span>记录常用命令、脚本或服务入口。</span>
              </div>
            </div>
            <form className="resource-form" onSubmit={(event) => void addLibraryItem(event)}>
              <input className="field" value={title} onChange={(event) => setTitle(event.target.value)} placeholder={`${itemLabel}名称`} />
              {mode === "tools" && (
                <input
                  className="field"
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                  placeholder="命令 / URL / 脚本路径（可选）"
                />
              )}
              <textarea
                className="field"
                rows={7}
                value={content}
                onChange={(event) => setContent(event.target.value)}
                placeholder="写下用途、参数说明、注意事项。"
              />
              <div className="knowledge-form-row">
                <input className="field" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="标签，用逗号分隔" />
                <button className="btn btn-primary" type="submit" disabled={saving}>
                  {saving ? "保存中..." : libraryEditingId ? "保存修改" : `添加${itemLabel}`}
                </button>
              </div>
              {libraryEditingId && (
                <button className="btn btn-ghost" type="button" onClick={resetLibraryForm}>
                  取消编辑
                </button>
              )}
            </form>
            {error && <div className="login-error">{error}</div>}
          </section>

          <section className="resource-panel resource-list-panel">
            <div className="workspace-section-head">
              <div>
                <h3>{itemLabel}列表</h3>
                <span>{libraryItems.length} 条记录</span>
              </div>
            </div>
            <div className="resource-toolbar resource-toolbar-compact">
              <input
                className="field"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void refreshLibrary();
                }}
                placeholder={`搜索${itemLabel}`}
              />
              <button className="btn" type="button" disabled={loading} onClick={() => void refreshLibrary()}>
                搜索
              </button>
            </div>
            <div className="knowledge-list">
              {loading && <div className="workspace-loading">读取中...</div>}
              {!loading && libraryItems.length === 0 && <div className="workspace-empty">暂无{itemLabel}</div>}
              {!loading &&
                libraryItems.map((item) => (
                  <article
                    className={`knowledge-card library-card ${expandedLibraryId === item.id ? "expanded" : ""}`}
                    key={item.id}
                    onClick={() => setExpandedLibraryId(expandedLibraryId === item.id ? null : item.id)}
                  >
                    <div className="knowledge-card-head">
                      <strong>{item.title}</strong>
                      <div className="resource-card-actions">
                        <button
                          className="btn btn-ghost btn-sm"
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            editLibraryItem(item);
                          }}
                        >
                          编辑
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void deleteLibraryItem(item);
                          }}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                    <div className="resource-card-sub">{formatDate(item.updatedAt)}</div>
                    {item.command && <code className="resource-command">{item.command}</code>}
                    {item.tags.length > 0 && (
                      <div className="knowledge-tags">
                        {item.tags.map((tag) => (
                          <span key={tag}>{tag}</span>
                        ))}
                      </div>
                    )}
                    {expandedLibraryId === item.id ? (
                      <p className="library-card-detail">{item.content}</p>
                    ) : (
                      <p className="library-card-summary">{compactText(item.content)}</p>
                    )}
                  </article>
                ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
