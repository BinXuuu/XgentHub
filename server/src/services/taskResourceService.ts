import { getAdapter } from "../adapters/registry.ts";
import { listMcpServers } from "./mcpServerService.ts";
import { listKnowledgeGroups } from "./knowledgeService.ts";
import { getResourceLibraryItemsByIds } from "./resourceLibraryService.ts";
import { getWorkspace } from "./workspaceService.ts";
import type { Task } from "../types.ts";

// 任务能用的知识组 / MCP / 工具 / Skill 不再按任务各自勾选：
// 实际生效 = 任务所在工作区的配置 ∪ 任务 Agent 是角色时角色自带的配置。运行时和界面只读展示都走这里。

export interface EffectiveResources {
  knowledgeGroupIds: string[];
  mcpServerIds: string[];
  toolIds: string[];
  skillIds: string[];
}

type Source = "workspace" | "role";

export interface ResourceItemView {
  id: string;
  name: string;
  sources: Source[];
}

export interface TaskResourcesView {
  workspace: { id: string; name: string } | null;
  role: { id: string; name: string } | null;
  knowledgeGroups: (ResourceItemView & { entryCount: number })[];
  mcpServers: ResourceItemView[];
  tools: ResourceItemView[];
  skills: ResourceItemView[];
}

const union = (...lists: string[][]) => [...new Set(lists.flat())];

export function resolveEffectiveResources(task: Pick<Task, "workspaceId" | "agentId">): EffectiveResources {
  const workspace = getWorkspace(task.workspaceId);
  const role = getAdapter(task.agentId)?.roleInfo ?? null;
  return {
    knowledgeGroupIds: union(workspace?.knowledgeGroupIds ?? [], role?.knowledgeGroupIds ?? []),
    mcpServerIds: union(workspace?.mcpServerIds ?? [], role?.mcpServerIds ?? []),
    toolIds: union(workspace?.toolIds ?? [], role?.toolIds ?? []),
    skillIds: union(workspace?.skillIds ?? [], role?.skillIds ?? []),
  };
}

/** 给任务详情页只读展示用：每一项标明来自工作区还是角色；已经被删掉的条目不显示。 */
export function describeTaskResources(task: Pick<Task, "workspaceId" | "agentId">): TaskResourcesView {
  const workspace = getWorkspace(task.workspaceId) ?? null;
  const adapter = getAdapter(task.agentId);
  const role = adapter?.roleInfo ?? null;
  const tag = (id: string, fromWorkspace: string[], fromRole: string[]): Source[] => [
    ...(fromWorkspace.includes(id) ? (["workspace"] as const) : []),
    ...(fromRole.includes(id) ? (["role"] as const) : []),
  ];
  const effective = resolveEffectiveResources(task);

  const mcpById = new Map(listMcpServers().map((server) => [server.id, server]));
  const mcpServers = effective.mcpServerIds
    .map((id) => mcpById.get(id))
    .filter((server): server is NonNullable<typeof server> => Boolean(server) && server!.enabled)
    .map((server) => ({ id: server.id, name: server.name, sources: tag(server.id, workspace?.mcpServerIds ?? [], role?.mcpServerIds ?? []) }));

  const libraryView = (kind: "tool" | "skill", ids: string[], fromWorkspace: string[], fromRole: string[]) =>
    getResourceLibraryItemsByIds(kind, ids).map((item) => ({ id: item.id, name: item.title, sources: tag(item.id, fromWorkspace, fromRole) }));

  const groupById = new Map(listKnowledgeGroups().map((group) => [group.id, group]));
  const knowledgeGroups = effective.knowledgeGroupIds
    .map((id) => groupById.get(id))
    .filter((group): group is NonNullable<typeof group> => Boolean(group))
    .map((group) => ({ id: group.id, name: group.name, entryCount: group.entryCount, sources: tag(group.id, workspace?.knowledgeGroupIds ?? [], role?.knowledgeGroupIds ?? []) }));

  return {
    workspace: workspace ? { id: workspace.id, name: workspace.name } : null,
    role: role && adapter ? { id: role.roleId, name: adapter.name } : null,
    knowledgeGroups,
    mcpServers,
    tools: libraryView("tool", effective.toolIds, workspace?.toolIds ?? [], role?.toolIds ?? []),
    skills: libraryView("skill", effective.skillIds, workspace?.skillIds ?? [], role?.skillIds ?? []),
  };
}
