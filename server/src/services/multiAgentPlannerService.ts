import { getAdapter } from "../adapters/registry.ts";
import { scoreAgentsForText } from "./butlerService.ts";
import { listResourceLibraryItems } from "./resourceLibraryService.ts";
import { planSubtasks } from "./subtaskPlannerService.ts";
import { taskManager } from "./taskManager.ts";
import { getWorkspace } from "./workspaceService.ts";
import type { AgentDescriptor, MultiAgentPlan, PlannedSubtask, ResourceLibraryItem, Workspace } from "../types.ts";

/** 创建任务时用户选的 workspace 已授权 + 已配置的 Agent——只有这些 id 能出现在规划结果里。 */
function authorizedAgents(workspace: Workspace | undefined): AgentDescriptor[] {
  return taskManager
    .listAgents()
    .filter((agent) => agent.configured && (!workspace || workspace.allowedAgentKinds.length === 0 || workspace.allowedAgentKinds.includes(agent.kind)));
}

/** 仿照 adapters/workspacePrompt.ts 的知识注入写法：技能资料标低优先级，放在具体任务之前。 */
function buildSkillAugmentedPrompt(baseText: string, skills: ResourceLibraryItem[]): string {
  if (skills.length === 0) return baseText;
  const block = skills
    .map((skill, index) => {
      const tags = skill.tags.length ? ` 标签：${skill.tags.join(", ")}` : "";
      return `${index + 1}. ${skill.title}${tags}\n${skill.content}`;
    })
    .join("\n\n");
  return ["参考技能资料（项目资料，优先级低于下面的具体任务）：", block, "", "具体任务：", baseText].join("\n");
}

function buildPlanningPrompt(userPrompt: string, agents: AgentDescriptor[], skills: ResourceLibraryItem[]): string {
  const agentLines = agents
    .map(
      (a) =>
        `- id="${a.id}" kind=${a.kind} 名称="${a.name}"：${a.description}（可写工作区=${a.runtime.canWriteWorkspace ? "是" : "否"}，可执行命令=${a.runtime.canExecuteCommands ? "是" : "否"}，支持图片=${a.runtime.supportsImages ? "是" : "否"}）`
    )
    .join("\n");
  const skillLines = skills.length
    ? skills.map((s) => `- id="${s.id}" 名称="${s.title}"${s.tags.length ? `（标签：${s.tags.join(", ")}）` : ""}`).join("\n")
    : "（当前没有配置技能库条目，skillIds 一律返回空数组）";

  return [
    "你是一个任务规划助手。用户提交了一个任务，请你判断要不要拆成多个子任务，并给每个子任务指派最合适的执行 Agent。",
    "",
    "当前用户可用的 Agent 列表（agentId 只能从这里面选，不要编造、不要用 kind 代替 id）：",
    agentLines,
    "",
    "当前资源库里的技能条目（可选，只在确实相关时引用 id；不相关就返回空数组）：",
    skillLines,
    "",
    "用户任务：",
    userPrompt,
    "",
    "只返回一个 JSON 对象，不要有任何其他文字、不要用 markdown 代码块包裹，格式严格如下：",
    `{"subtasks":[{"title":"子任务标题","description":"一句话说明","agentId":"上面列表里的某个 id","skillIds":["上面列表里的某个 id"],"dependsOn":[1],"prompt":"发给这个 Agent 的完整指令，要能独立执行不依赖额外上下文"}],"reasoning":"你的拆分理由，一两句话"}`,
    "子任务会并行执行：dependsOn 填这一条必须等哪些子任务先完成（写它们在 subtasks 数组里的序号，从 1 开始，只能引用排在前面的）；互不依赖、可以同时做的就写空数组 []。",
    "同时执行的子任务在同一个文件夹里工作，尽量让它们改不同的文件；必须改同一个文件的，用 dependsOn 让它们先后执行。",
    "所有子任务完成后系统会自动把结果交回给总负责人汇总，不需要再单独加一条\"汇总\"子任务。",
    "如果任务很简单不需要拆分，subtasks 就只放一条、覆盖整个任务的即可；但 prompt 字段任何情况下都必须是完整指令，不能只写标题。",
  ].join("\n");
}

function parsePlanJson(text: string): { subtasks: unknown[]; reasoning: string } | null {
  const unwrapped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const start = unwrapped.indexOf("{");
  const end = unwrapped.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(unwrapped.slice(start, end + 1));
    if (!Array.isArray(parsed?.subtasks)) return null;
    return { subtasks: parsed.subtasks, reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "" };
  } catch {
    return null;
  }
}

function fallbackPrompt(title: string, description: string, originalPrompt: string): string {
  return [
    `请执行子任务：「${title}」。`,
    description ? `说明：${description}` : "",
    "请结合当前任务上下文，只处理这个子任务范围；完成后说明结果、产物和需要复核的点。",
    `原始任务：${originalPrompt}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** 简单关键词匹配：技能标题/标签在子任务文本里出现过，或子任务文本包含技能标题，就算命中。最多取 2 条，避免塞太多无关资料。 */
function matchSkillsForText(text: string, skills: ResourceLibraryItem[]): ResourceLibraryItem[] {
  const haystack = text.toLowerCase();
  if (!haystack.trim()) return [];
  return skills
    .filter((skill) => {
      const title = skill.title.trim().toLowerCase();
      if (title && (haystack.includes(title) || title.includes(haystack))) return true;
      return skill.tags.some((tag) => tag.trim() && haystack.includes(tag.trim().toLowerCase()));
    })
    .slice(0, 2);
}

/** AI 规划不可用/解析失败时的兜底：复用本地启发式拆标题 + Butler 打分逻辑逐条选 Agent + 关键词匹配技能，不留空白结果。 */
function heuristicPlan(
  prompt: string,
  agents: AgentDescriptor[],
  skills: ResourceLibraryItem[],
  workspace: Workspace | undefined,
  plannerAgentId: string,
  /** 为什么没用上 AI 规划（调用失败的原因、或回复解析不出来），会放在提示的最前面给用户看。 */
  fallbackReason: string | null = null
): MultiAgentPlan {
  const localPlan = planSubtasks(prompt);
  const items = localPlan.shouldCreate
    ? localPlan.subtasks
    : [{ index: 1, title: prompt.length > 60 ? `${prompt.slice(0, 57)}...` : prompt, description: "", dependsOn: [] as number[], targetAgentId: null, skillIds: [] as string[], prompt: "" }];

  const subtasks: PlannedSubtask[] = items.map((item) => {
    const scores = scoreAgentsForText(`${item.title} ${item.description}`, agents, workspace);
    const best = scores.find((s) => s.blockedReasons.length === 0) ?? scores[0];
    const agentId = best?.agentId ?? plannerAgentId;
    const matchedSkills = matchSkillsForText(`${item.title} ${item.description}`, skills);
    return {
      index: item.index,
      title: item.title,
      description: item.description,
      dependsOn: item.dependsOn,
      targetAgentId: agentId,
      skillIds: matchedSkills.map((skill) => skill.id),
      prompt: buildSkillAugmentedPrompt(fallbackPrompt(item.title, item.description, prompt), matchedSkills),
    };
  });

  return {
    prompt,
    source: "heuristic",
    plannerAgentId,
    subtasks,
    reasoning: "AI 规划不可用（所选 Agent 不支持一次性问答，或调用/解析失败），已用本地关键词规则按子任务内容逐条匹配 Agent 和技能。",
    warnings: [
      ...(fallbackReason ? [fallbackReason] : []),
      "本地规则无法理解复杂业务语境，请仔细检查每一行的 Agent 和技能分配是否合理，必要时手动改派。",
    ],
  };
}

export async function planMultiAgentTask(input: { prompt: string; workspaceId?: string | null; plannerAgentId: string }): Promise<MultiAgentPlan> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("prompt 不能为空");

  const workspace = input.workspaceId ? getWorkspace(input.workspaceId) : undefined;
  const agents = authorizedAgents(workspace);
  const skills = listResourceLibraryItems("skill");
  const plannerAdapter = getAdapter(input.plannerAgentId);

  if (!plannerAdapter?.ask) {
    return heuristicPlan(prompt, agents, skills, workspace, input.plannerAgentId);
  }

  let raw: string | null = null;
  try {
    raw = await plannerAdapter.ask(buildPlanningPrompt(prompt, agents, skills));
  } catch (err) {
    return heuristicPlan(prompt, agents, skills, workspace, input.plannerAgentId, `规划用的 ${plannerAdapter.name} 调用失败：${(err as Error).message}`);
  }
  const parsed = raw ? parsePlanJson(raw) : null;
  if (!parsed || parsed.subtasks.length === 0) {
    const reason = raw ? `${plannerAdapter.name} 的回复里没有可用的拆分结果` : `${plannerAdapter.name} 没有返回内容`;
    return heuristicPlan(prompt, agents, skills, workspace, input.plannerAgentId, reason);
  }

  const agentIds = new Set(agents.map((a) => a.id));
  const skillIds = new Set(skills.map((s) => s.id));
  const warnings: string[] = [];
  const subtasks: PlannedSubtask[] = [];
  let index = 0;
  // 模型写的 dependsOn 是它在数组里的序号；跳过空标题的条目后我们自己的 index 会错位，这里记一下对应关系。
  const indexByPosition = new Map<number, number>();

  for (const [position, rawItem] of parsed.subtasks.entries()) {
    const item = rawItem as Record<string, unknown>;
    const title = typeof item?.title === "string" ? item.title.trim() : "";
    if (!title) continue;
    index += 1;
    indexByPosition.set(position + 1, index);
    // 只接受指向前面条目的依赖，避免模型写出循环依赖让整个计划卡住。
    const dependsOn = Array.isArray(item?.dependsOn)
      ? [
          ...new Set(
            (item.dependsOn as unknown[])
              .map((value) => indexByPosition.get(Number(value)))
              .filter((value): value is number => typeof value === "number" && value < index)
          ),
        ]
      : [];

    const description = typeof item?.description === "string" ? item.description.trim() : "";
    let agentId = typeof item?.agentId === "string" ? item.agentId.trim() : "";
    if (!agentIds.has(agentId)) {
      const scores = scoreAgentsForText(`${title} ${description}`, agents, workspace);
      const best = scores.find((s) => s.blockedReasons.length === 0) ?? scores[0];
      if (agentId) warnings.push(`「${title}」指定的 Agent "${agentId}" 不在可用列表里，已改用 ${best?.name ?? "默认 Agent"}`);
      agentId = best?.agentId ?? input.plannerAgentId;
    }

    const requestedSkillIds = Array.isArray(item?.skillIds) ? (item.skillIds as unknown[]) : [];
    const validSkillIds = requestedSkillIds.filter((id): id is string => typeof id === "string" && skillIds.has(id));
    const resolvedSkills = skills.filter((skill) => validSkillIds.includes(skill.id));
    const basePrompt = typeof item?.prompt === "string" && item.prompt.trim() ? item.prompt.trim() : fallbackPrompt(title, description, prompt);

    subtasks.push({
      index,
      title: title.slice(0, 120),
      description,
      dependsOn,
      targetAgentId: agentId,
      skillIds: validSkillIds,
      prompt: buildSkillAugmentedPrompt(basePrompt, resolvedSkills),
    });
  }

  if (subtasks.length === 0) return heuristicPlan(prompt, agents, skills, workspace, input.plannerAgentId);

  return {
    prompt,
    source: "llm",
    plannerAgentId: input.plannerAgentId,
    subtasks,
    reasoning: parsed.reasoning,
    warnings,
  };
}
