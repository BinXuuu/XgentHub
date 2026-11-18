import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { Workspace, WorkspaceResourcesInput } from "../api/types";
import { KnowledgeGroupsTab, McpTab, SkillsTab, ToolsTab } from "./SelectionTabs";
import { confirmDialog, errorDialog, promptDialog } from "../utils/dialog";

interface Props {
  workspace: Workspace;
  onBack: () => void;
  onWorkspacesChanged: () => void;
  onOpenResources: () => void;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}

function samePath(a: string, b: string): boolean {
  return a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();
}

function normalizePathList(paths: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of paths) {
    const value = raw.trim();
    if (!value) continue;
    const key = value.replace(/[\\/]+$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(value);
  }
  return normalized;
}

export function WorkspaceDetailPanel({ workspace, onBack, onWorkspacesChanged, onOpenResources }: Props) {
  const [prompt, setPrompt] = useState("");
  const [promptLoading, setPromptLoading] = useState(false);
  const [promptSaving, setPromptSaving] = useState(false);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [promptSavedAt, setPromptSavedAt] = useState<string | null>(null);
  const [savedPrompt, setSavedPrompt] = useState("");
  const promptDirty = prompt !== savedPrompt;

  useEffect(() => {
    if (!promptDirty) return;
    const preventUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", preventUnload);
    return () => window.removeEventListener("beforeunload", preventUnload);
  }, [promptDirty]);

  const [accessPaths, setAccessPaths] = useState<string[]>([]);
  const [newAccessPath, setNewAccessPath] = useState("");
  const [accessSaving, setAccessSaving] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [accessSaved, setAccessSaved] = useState(false);
  const [pathSaving, setPathSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPrompt("");
    setSavedPrompt("");
    setPromptSavedAt(null);
    setPromptError(null);
    setPromptLoading(true);
    api
      .getWorkspacePrompt(workspace.id)
      .then((result) => {
        if (cancelled) return;
        setPrompt(result.content);
        setSavedPrompt(result.content);
        setPromptSavedAt(result.updatedAt);
      })
      .catch((err) => {
        if (!cancelled) setPromptError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setPromptLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // 路径或资源变化不应重新加载并覆盖正在编辑的上下文。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id]);

  useEffect(() => {
    setAccessPaths((workspace.accessPaths ?? [workspace.path]).filter((item) => !samePath(item, workspace.path)));
    setNewAccessPath("");
    setAccessError(null);
    setAccessSaved(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id, workspace.path, (workspace.accessPaths ?? []).join("|")]);

  async function saveResources(input: WorkspaceResourcesInput) {
    await api.updateWorkspaceResources(workspace.id, input);
    onWorkspacesChanged();
  }

  function addAccessPath(path?: string | null) {
    const value = (path ?? newAccessPath).trim();
    if (!value) return;
    if (samePath(value, workspace.path)) {
      setAccessError("主工作区目录已经默认允许，不需要重复添加");
      return;
    }
    setAccessPaths((prev) => normalizePathList([...prev, value]).filter((item) => !samePath(item, workspace.path)));
    setNewAccessPath("");
    setAccessError(null);
    setAccessSaved(false);
  }

  async function pickAccessPath() {
    setAccessError(null);
    try {
      const result = await api.pickFolder();
      if (result.path) addAccessPath(result.path);
    } catch (err) {
      setAccessError((err as Error).message);
    }
  }

  function removeAccessPath(path: string) {
    setAccessPaths((prev) => prev.filter((item) => !samePath(item, path)));
    setAccessSaved(false);
  }

  async function saveAccessPaths() {
    setAccessSaving(true);
    setAccessError(null);
    setAccessSaved(false);
    try {
      const updated = await api.updateWorkspaceAccessPaths(workspace.id, normalizePathList([workspace.path, ...accessPaths]));
      setAccessPaths((updated.accessPaths ?? []).filter((item) => !samePath(item, updated.path)));
      setAccessSaved(true);
      onWorkspacesChanged();
    } catch (err) {
      setAccessError((err as Error).message);
    } finally {
      setAccessSaving(false);
    }
  }

  async function changeMainPath(next: string) {
    const value = next.trim();
    if (!value || samePath(value, workspace.path)) return;
    const ok = await confirmDialog(
      `新目录：${value}\n\n任务记录、上下文和勾选的资源都保留；没在运行的任务下一轮对话会在新目录里重新开始（之前的撤销快照可能用不了）。`,
      { title: "修改主工作区目录？", confirmText: "修改" },
    );
    if (!ok) return;
    setPathSaving(true);
    setAccessError(null);
    try {
      await api.updateWorkspacePath(workspace.id, value);
      onWorkspacesChanged();
    } catch (err) {
      setAccessError((err as Error).message);
    } finally {
      setPathSaving(false);
    }
  }

  async function pickMainPath() {
    setAccessError(null);
    try {
      const result = await api.pickFolder();
      if (result.path) await changeMainPath(result.path);
    } catch (err) {
      setAccessError((err as Error).message);
    }
  }

  async function typeMainPath() {
    const value = await promptDialog("填写新的主工作区目录（本机路径）", { title: "修改主工作区目录", defaultValue: workspace.path, singleLine: true });
    if (value) await changeMainPath(value);
  }

  async function savePrompt() {
    setPromptSaving(true);
    setPromptError(null);
    try {
      const result = await api.updateWorkspacePrompt(workspace.id, prompt);
      setPrompt(result.content);
      setSavedPrompt(result.content);
      setPromptSavedAt(result.updatedAt);
    } catch (err) {
      setPromptError((err as Error).message);
    } finally {
      setPromptSaving(false);
    }
  }

  async function deleteWorkspace() {
    if (!(await confirmDialog("它下面的任务记录也会一并删除，本机文件不受影响。", { title: `删除工作区「${workspace.name}」？`, danger: true }))) return;
    try {
      await api.deleteWorkspace(workspace.id);
      onBack();
      onWorkspacesChanged();
    } catch (err) {
      void errorDialog(err);
    }
  }

  return (
    <div className="workspace-detail">
      <header className="workspace-detail-header">
        <div>
          <div className="workspace-detail-kicker">工作区</div>
          <h2>{workspace.name}</h2>
          <div className="workspace-detail-path" title={workspace.path}>
            {workspace.path}
          </div>
        </div>
        <div className="workspace-detail-actions">
          <button className="btn" type="button" onClick={onOpenResources}>
            知识库
          </button>
          <button className="btn" type="button" onClick={onBack}>
            返回
          </button>
          <button className="btn btn-danger" type="button" onClick={() => void deleteWorkspace()}>
            删除工作区
          </button>
        </div>
      </header>

      <section className="workspace-meta-grid">
        <div className="workspace-meta-card">
          <span>可用 Agent</span>
          <strong>{workspace.allowedAgentKinds.length ? `${workspace.allowedAgentKinds.length} 类` : "全部"}</strong>
        </div>
        <div className="workspace-meta-card">
          <span>知识组 / MCP / 工具 / Skill</span>
          <strong>
            {workspace.knowledgeGroupIds.length} / {workspace.mcpServerIds.length} / {workspace.toolIds.length} / {workspace.skillIds.length}
          </strong>
        </div>
        <div className="workspace-meta-card">
          <span>创建时间</span>
          <strong>{formatDate(workspace.createdAt)}</strong>
        </div>
      </section>

      <div className="workspace-detail-grid">
        <section className="workspace-detail-section workspace-linkage-section">
          <div className="workspace-section-head">
            <div>
              <h3>联动方式</h3>
              <span>知识库负责统一管理，这里负责当前工作区的细节。</span>
            </div>
          </div>
          <div className="workspace-linkage-list">
            <div>
              <strong>上下文</strong>
              <span>长期项目背景和固定约束，会随该工作区任务一起注入。</span>
            </div>
            <div>
              <strong>可用资源</strong>
              <span>下面勾选的知识组、MCP、工具、Skill 对这个工作区里的所有任务生效；任务里只能查看，改要回到这里。</span>
            </div>
            <div>
              <strong>知识库入口</strong>
              <span>知识条目按知识组统一管理，一个组可以被多个工作区共用。</span>
            </div>
          </div>
          <button className="btn btn-primary" type="button" onClick={onOpenResources}>
            打开知识库
          </button>
        </section>

        <section className="workspace-detail-section workspace-access-section">
          <div className="workspace-section-head">
            <div>
              <h3>允许访问空间</h3>
              <span>给这个工作区追加可访问目录，例如网络盘、备份目录、共享素材目录。</span>
            </div>
            <button className="btn btn-primary" type="button" disabled={accessSaving} onClick={() => void saveAccessPaths()}>
              {accessSaving ? "保存中..." : "保存空间"}
            </button>
          </div>

          <div className="workspace-access-list">
            <div className={`workspace-access-row locked${workspace.pathExists === false ? " missing" : ""}`}>
              <div>
                <strong>主工作区{workspace.pathExists === false && <span className="workspace-path-missing">找不到这个目录（可能挪了位置），点「修改目录」换成新位置</span>}</strong>
                <span>{workspace.path}</span>
              </div>
              <div className="workspace-access-row-actions">
                <button className="btn btn-sm" type="button" disabled={pathSaving} onClick={() => void pickMainPath()}>
                  {pathSaving ? "修改中..." : "修改目录"}
                </button>
                <button className="btn btn-ghost btn-sm" type="button" disabled={pathSaving} onClick={() => void typeMainPath()}>
                  手动填写
                </button>
              </div>
            </div>
            {accessPaths.map((path) => (
              <div className="workspace-access-row" key={path}>
                <div>
                  <strong>额外空间</strong>
                  <span>{path}</span>
                </div>
                <button className="btn btn-ghost btn-sm" type="button" onClick={() => removeAccessPath(path)}>
                  删除
                </button>
              </div>
            ))}
          </div>

          <div className="workspace-access-add">
            <input
              className="field"
              value={newAccessPath}
              onChange={(event) => {
                setNewAccessPath(event.target.value);
                setAccessSaved(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addAccessPath();
                }
              }}
              placeholder="例如 D:\备份\网站 或 \\NAS\共享\备份"
            />
            <button className="btn" type="button" onClick={() => void pickAccessPath()}>
              选择目录
            </button>
            <button className="btn" type="button" onClick={() => addAccessPath()}>
              添加
            </button>
          </div>
          <p className="workspace-access-note">
            保存后，非运行中的任务会在下一次对话重新初始化 CLI 会话，并把这些路径作为允许访问空间传给 Agent。正在运行的任务不会原地热更新。
          </p>
          {accessSaved && <div className="save-hint">允许访问空间已保存</div>}
          {accessError && <div className="login-error">{accessError}</div>}
        </section>

        <section className="workspace-detail-section workspace-context-section">
          <div className="workspace-section-head">
            <div>
              <h3>上下文</h3>
              <span>{promptDirty ? "有未保存的修改" : promptSavedAt ? `上次保存 ${formatDate(promptSavedAt)}` : "保存项目背景、长期约束与注意事项"}</span>
            </div>
            <button className="btn btn-primary" type="button" disabled={promptSaving || promptLoading || !promptDirty} onClick={() => void savePrompt()}>
              {promptSaving ? "保存中..." : "保存上下文"}
            </button>
          </div>
          {promptLoading ? (
            <div className="workspace-loading">读取中...</div>
          ) : (
            <textarea
              className="field workspace-context-editor"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="项目背景、偏好命令、长期约束、注意事项"
            />
          )}
          {promptError && <div className="login-error">{promptError}</div>}
        </section>

        <section className="workspace-detail-section workspace-resources-section" id="workspace-resources">
          <div className="workspace-section-head">
            <div>
              <h3>可用资源</h3>
              <span>对这个工作区里的所有任务生效（任务的 Agent 是角色时，再叠加角色自带的）；改完下一轮对话生效。</span>
            </div>
          </div>
          <KnowledgeGroupsTab selectedIds={workspace.knowledgeGroupIds} onSave={(ids) => saveResources({ knowledgeGroupIds: ids })} />
          <McpTab
            scope="工作区"
            agentName=""
            supportsMcp
            selectedIds={workspace.mcpServerIds}
            onSave={(ids) => saveResources({ mcpServerIds: ids })}
          />
          <ToolsTab scope="工作区" selectedIds={workspace.toolIds} onSave={(ids) => saveResources({ toolIds: ids })} />
          <SkillsTab scope="工作区" selectedIds={workspace.skillIds} onSave={(ids) => saveResources({ skillIds: ids })} />
        </section>
      </div>
    </div>
  );
}
