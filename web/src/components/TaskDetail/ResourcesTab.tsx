import type { ResourceItemView, TaskResourcesView } from "../../api/types";

export type ResourceKind = "mcp" | "tools" | "skills" | "knowledge";

interface Props {
  kind: ResourceKind;
  resources: TaskResourcesView | null;
  error: string | null;
  /** 当前 Agent 是否支持 MCP；只对 kind="mcp" 有意义。 */
  supportsMcp: boolean;
  agentName: string;
  onOpenWorkspace: (workspaceId: string) => void;
}

const KIND_COPY: Record<ResourceKind, { label: string; hint: string; empty: string }> = {
  mcp: { label: "MCP server", hint: "这一轮会把这些 MCP 交给 Agent。", empty: "这个工作区还没勾选 MCP。" },
  tools: { label: "工具", hint: "工具的名称和命令会作为索引带给 Agent，消息提到时再展开说明。", empty: "这个工作区还没勾选工具。" },
  skills: { label: "Skill", hint: "勾选的 Skill 每一轮都会完整带给 Agent。", empty: "这个工作区还没勾选 Skill。" },
  knowledge: { label: "知识组", hint: "小组（总共不超过 3000 字）每一轮整组带上，大组按消息挑最相关的 5 条。", empty: "这个工作区还没关联知识组。" },
};

function itemsOf(kind: ResourceKind, resources: TaskResourcesView): (ResourceItemView & { entryCount?: number })[] {
  if (kind === "mcp") return resources.mcpServers;
  if (kind === "tools") return resources.tools;
  if (kind === "skills") return resources.skills;
  return resources.knowledgeGroups;
}

// 任务里的 MCP / 工具 / Skill / 知识库只读视图：实际生效的 = 工作区配置 ∪ 角色自带。改要回工作区。
export function ResourcesTab({ kind, resources, error, supportsMcp, agentName, onOpenWorkspace }: Props) {
  const copy = KIND_COPY[kind];
  const workspace = resources?.workspace ?? null;
  const items = resources ? itemsOf(kind, resources) : [];

  return (
    <div className="resource-tab">
      <div className="resource-tab-head">
        <div>
          <strong>这个任务实际能用的{copy.label}</strong>
          <span>
            {copy.hint}
            由工作区{workspace ? `「${workspace.name}」` : ""}统一配置
            {resources?.role ? `，再加上角色「${resources.role.name}」自带的` : ""}；任务里只能查看。
          </span>
        </div>
        {workspace && (
          <div className="resource-tab-actions">
            <button className="btn btn-primary btn-sm" type="button" onClick={() => onOpenWorkspace(workspace.id)}>
              去工作区修改
            </button>
          </div>
        )}
      </div>

      {kind === "mcp" && !supportsMcp && <div className="resource-tab-note warn">当前 Agent（{agentName}）还不支持 MCP，下面的 MCP 这次不会生效。</div>}

      {error ? (
        <div className="form-error">{error}</div>
      ) : !resources ? (
        <div className="workspace-empty">正在加载...</div>
      ) : items.length === 0 ? (
        <div className="workspace-empty">{copy.empty}</div>
      ) : (
        <div className="resource-readonly-list">
          {items.map((item) => (
            <div className="resource-readonly-item" key={item.id}>
              <span className="resource-readonly-name">{item.name}</span>
              {typeof item.entryCount === "number" && <span className="resource-readonly-meta">{item.entryCount} 条</span>}
              {item.sources.map((source) => (
                <span key={source} className={`resource-source-badge ${source}`}>
                  {source === "workspace" ? "工作区" : "角色"}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
